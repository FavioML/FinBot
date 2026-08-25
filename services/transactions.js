const crypto = require('crypto');
const { supabase } = require('../lib/db');
const { validarMonto, normalizarCategoria } = require('../lib/validators');
const { hoyPeru } = require('../lib/dates');
const { esPagoNeto } = require('../lib/config');
const { extraerLast4, normalizarLast4 } = require('./parsers');
const log = require('../lib/logger');
const { subcategoriaUtil } = require('../lib/subcategoria');
const analytics = require('../lib/analytics');

// Dedup window for manual entries (gmail entries dedup separately).
// Short enough that legitimate rapid entries (e.g. 5 taxis of S/50 in a
// row) don't collide; only catches webhook double-fires which retry
// within a few seconds. Was 5min — caused str-001/002 in QA: 5/8 rapid
// duplicate-content entries collapsed to 3 rows.
const DEDUP_WINDOW_MS = 10 * 1000;

// Dos avisos distintos del MISMO cargo: el banco manda dos correos, cada uno con su
// gmail_msg_id, así que el índice único no los ve como duplicados y el dedup por hash
// está desactivado para Gmail. Resultado observado en prod: Smart Fit S/119.90 (20-jul-2026)
// entró dos veces con 1 segundo de diferencia, y antes de eso 18 grupos duplicados.
//
// No sirve un SELECT-antes-de-INSERT: el sweep procesa 5 correos en paralelo, o sea que los
// dos duplicados consultan antes de que cualquiera inserte. Este guard en memoria sí es
// confiable porque el check y la marca ocurren sin `await` en medio (Node es single-thread),
// y el backend corre en instancia única (ver CLAUDE.md).
//
// Discriminador: la hora de llegada del correo (`recibidoEnMs`), NO la hora de proceso.
// Dos avisos del mismo cargo llegan con segundos de diferencia; dos compras iguales reales
// llegan separadas. Solo aplica al escaneo incremental: en el barrido histórico de 30 días
// dos compras legítimas del mismo día se procesan juntas y colapsarían mal.
const GMAIL_DEDUP_VENTANA_MS = 2 * 60 * 1000;
const _gmailDedupVistos = new Map(); // dedupHash -> { recibidoEnMs, expiraEn }

function _gmailDedupCheck(dedupHash, recibidoEnMs) {
  const ahora = Date.now();
  for (const [k, v] of _gmailDedupVistos) { if (v.expiraEn <= ahora) _gmailDedupVistos.delete(k); }
  const previo = _gmailDedupVistos.get(dedupHash);
  if (previo && Math.abs(recibidoEnMs - previo.recibidoEnMs) <= GMAIL_DEDUP_VENTANA_MS) return true;
  _gmailDedupVistos.set(dedupHash, { recibidoEnMs, expiraEn: ahora + 10 * 60 * 1000 });
  return false;
}

// Cache de tipo de cambio
let _tcCache = null;
let _tcCacheTime = 0;

async function obtenerTipoCambio() {
  const FALLBACK = { compra: 3.82, venta: 3.85 };
  const now = Date.now();
  if (_tcCache && (now - _tcCacheTime) < 86400000) return _tcCache;

  async function fetchTCForDate(fecha) {
    const resp = await fetch('https://dolar.pe/api/public/series?pair=USD-PEN&from=' + fecha + '&to=' + fecha, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const serie = json?.series?.['USD-PEN'];
    if (!serie) return null;
    const data = serie.data || [];
    const last = data[data.length - 1];
    if (typeof last === 'number' && last > 3.0 && last < 5.0) return last;
    return null;
  }

  try {
    let venta = await fetchTCForDate(hoyPeru());
    if (!venta) {
      // dolar.pe puede no tener datos del día actual antes de las ~9am Lima
      venta = await fetchTCForDate(require('../lib/dates').ayerPeru());
    }
    if (venta) {
      _tcCache = { compra: parseFloat((venta * 0.998).toFixed(4)), venta: parseFloat(venta.toFixed(4)) };
      _tcCacheTime = now;
      return _tcCache;
    }
    return _tcCache || FALLBACK;
  } catch(e) {
    log.error({ tag: 'TC', err: e.message }, 'Error tipo cambio');
    return _tcCache || FALLBACK;
  }
}

async function guardarTransaccion(usuarioId, datos) {
  const montoValidado = validarMonto(datos.monto);
  if (montoValidado === null) throw new Error('Monto inválido: ' + datos.monto);
  const _moneda = datos.moneda || 'PEN';
  let _montoPen = montoValidado; let _tcUsado = null;
  if (_moneda === 'USD') {
    try {
      const _tc = await obtenerTipoCambio();
      const _pen = validarMonto(montoValidado * _tc.venta);
      // Si la conversión sale fuera de rango (monto USD gigante), NO fabricamos monto_pen con el
      // número USD crudo: dejamos monto_pen/tipo_cambio null (dato honesto) en vez de un PEN falso.
      if (_pen !== null) { _tcUsado = _tc.venta; _montoPen = _pen; }
      else { _montoPen = null; log.warn({ tag: 'TC', monto: montoValidado }, 'Conversión USD→PEN fuera de rango; monto_pen queda null'); }
    } catch(e) {}
  }
  // Limpiar comercios genéricos del parser (ej: "Gasto pendiente de BCP S/5 del 2026-04-02" → "BCP")
  if (datos.comercio && /^(gasto|pago|cargo|operaci[oó]n|consumo)\b/i.test(datos.comercio)) {
    const bancos = ['BCP','BBVA','Interbank','Scotiabank','Yape','Plin','Falabella','Ripley','BanBif','Mibanco'];
    const found = bancos.find(b => datos.comercio.toUpperCase().includes(b.toUpperCase()));
    if (found) datos.comercio = found;
  }
  const fechaTx = datos.fecha || hoyPeru();
  // Últimos 4 de la tarjeta origen: lo que ya trae el parser, o extracción del
  // texto original como red de seguridad (cubre registro manual "tarjeta ...1234").
  const last4 = normalizarLast4(datos.tarjeta_last4) || extraerLast4(datos.descripcion_original);
  const dedupRaw = usuarioId + '|' + fechaTx + '|' + montoValidado + '|' + (datos.comercio || '') + '|' + (datos.tipo || 'gasto');
  const dedupHash = crypto.createHash('md5').update(dedupRaw).digest('hex');
  if (!datos.esGmail) {
    const ventanaInicio = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    // El hash NO incluye el last4 (para no romper paridad con el hash de la webapp
    // ni con las filas ya guardadas). El last4 refina la decisión: un candidato solo
    // es duplicado si su tarjeta coincide o alguno de los dos lado es desconocido.
    // Dos tarjetas distintas con mismo monto/comercio/día ya no colapsan.
    const { data: existente, error: errDedup } = await supabase.from('transacciones').select('id, tarjeta_last4')
      .eq('usuario_id', usuarioId).eq('dedup_hash', dedupHash).gte('created_at', ventanaInicio).limit(5);
    // **Este dedup falla ABIERTO, y va en la direccion CONTRARIA a la de los dedups del cron.**
    // Alla un `data` en null se leia como "todavia no le avisamos" y el arreglo fue cortar el
    // envio. Aca lo que sigue no es un aviso: es el gasto que la persona acaba de escribir.
    // Cortar convierte una caida de 200ms en un gasto perdido, y lo unico que compra es
    // evitar una fila duplicada que ademas necesita que el webhook haya disparado dos veces
    // DENTRO de los 10 segundos de `DEDUP_WINDOW_MS`. Se sigue de largo a proposito.
    //
    // Lo que cambia es que deja de ser invisible: sin este log, el modo de falla mas probable
    // —la lectura cae y el insert pasa— produce una fila duplicada sin una sola linea que
    // explique por que el dedup no la vio.
    if (errDedup) log.error({ tag: 'DEDUP', hash: dedupHash, err: errDedup.message }, 'No se pudo consultar el dedup: el gasto se registra igual (puede duplicar)');
    if (existente && existente.length > 0) {
      const dup = existente.find(e => !last4 || !e.tarjeta_last4 || e.tarjeta_last4 === last4);
      if (dup) {
        log.info({ tag: 'DEDUP', hash: dedupHash, last4 }, 'Transacción duplicada ignorada');
        return dup;
      }
    }
  } else if (datos.dedupAvisoGmail && typeof datos.recibidoEnMs === 'number') {
    // Segundo aviso del mismo cargo dentro del mismo sweep incremental (ver comentario
    // de GMAIL_DEDUP_VENTANA_MS). Devuelve null: el llamador lo cuenta como ignorado.
    if (_gmailDedupCheck(dedupHash, datos.recibidoEnMs)) {
      log.warn({ tag: 'DEDUP_GMAIL_AVISO', hash: dedupHash, comercio: datos.comercio, monto: montoValidado }, 'Segundo aviso del mismo cargo ignorado');
      return null;
    }
  }
  // B28: una categoría CUSTOM del usuario se persiste tal cual en vez de morir en 'Otros'.
  // `normalizarCategoria` sigue mandando en todo lo que el mapa canónico resuelve — incluidos
  // los colapsos con pérdida, que B26 midió y decidió. Ver `resolverCategoriaPersistida`.
  //
  // Pura y síncrona: no consulta el árbol del usuario. Ver el docstring, que explica por qué
  // la versión que sí lo consultaba estaba mal (carrera con el fire-and-forget que crea la
  // raíz). El require es perezoso solo por orden de carga, no por un ciclo.
  let catFinal = require('./categories').resolverCategoriaPersistida(datos.categoria);
  let subFinal = datos.subcategoria || 'sin_categoria';
  if (datos.comercio) {
    const regla = await buscarReglaComercio(usuarioId, datos.comercio);
    if (regla) { catFinal = regla.categoria; if (regla.subcategoria) subFinal = regla.subcategoria; }
  }
  // Normalizar capitalización de subcategoría para consistencia. El centinela se deja tal
  // cual: capitalizarlo acá no cambia nada (el trigger lo hace igual, ver migración 070) y
  // enmascararía que la forma canónica del CÓDIGO es la minúscula.
  if (subcategoriaUtil(subFinal)) {
    subFinal = subFinal.charAt(0).toUpperCase() + subFinal.slice(1);
  }
  // Pago de la suscripción a Neto (Yape S/10 o S/99 a Favio Mendoza) → categoría Suscripciones
  if (esPagoNeto(datos)) {
    datos.comercio = 'Neto';
    catFinal = 'Suscripciones';
    subFinal = 'Software';
  }
  const { data, error } = await supabase.from('transacciones').insert({
    usuario_id: usuarioId, tipo: datos.tipo || 'gasto', monto: montoValidado, moneda: _moneda,
    monto_pen: _montoPen, tipo_cambio: _tcUsado, metodo_pago: datos.metodo_pago || null,
    comercio: datos.comercio, categoria: catFinal,
    subcategoria: subFinal, banco: datos.banco,
    tarjeta_last4: last4 || null,
    fecha: fechaTx,
    descripcion_original: datos.descripcion_original, confirmado: false,
    dedup_hash: dedupHash,
    // Identificador del correo Gmail de origen (null para registros manuales/imagen).
    // Lo respalda el índice único parcial (usuario_id, gmail_msg_id) de la migración 031:
    // cierra la race de doble barrido que descripcion_original no puede (columna compartida).
    gmail_msg_id: datos.gmail_msg_id || null
  }).select().single();
  if (error) {
    // 23505 = violación del índice único de gmail_msg_id: un barrido concurrente (sweep 30d +
    // cron 15min solapados) ya insertó este correo. No es error: devolvemos la fila que ganó.
    if (error.code === '23505' && datos.gmail_msg_id) {
      const { data: yaExiste, error: errYaExiste } = await supabase.from('transacciones').select('*')
        .eq('usuario_id', usuarioId).eq('gmail_msg_id', datos.gmail_msg_id).maybeSingle();
      // Accesoria: el 23505 ya dice que la fila ESTA, asi que aca no se pierde nada — con o
      // sin esta lectura el insert no se repite. Lo unico que decide es si el barrido recibe
      // la fila que gano la carrera o se come el 23505 re-lanzado. Por eso solo log: un corte
      // no salva a nadie y el `throw error` de tres lineas mas abajo ya cierra el camino.
      if (errYaExiste) log.error({ tag: 'DEDUP_GMAIL', gmailMsgId: datos.gmail_msg_id, err: errYaExiste.message }, 'No se pudo recuperar la fila que gano la carrera: se re-lanza el 23505');
      if (yaExiste) {
        log.info({ tag: 'DEDUP_GMAIL', gmailMsgId: datos.gmail_msg_id }, 'Correo ya registrado por barrido concurrente');
        return yaExiste;
      }
    }
    throw error;
  }
  // El trial arranca con el PRIMER GASTO, y este es el chokepoint que lo garantiza para
  // todo lo que escribe desde el backend (WhatsApp texto/foto, multi-gasto, import Excel).
  // El CAS de iniciarTrialSiCorresponde lo hace no-op a partir del segundo, así que no
  // hace falta preguntar antes si corresponde. Se excluye el barrido de Gmail: es Pro-only
  // (nadie elegible para trial llega por ahí) y una importación de 30 días dispararía
  // cientos de updates no-op.
  //
  // `trialIniciado` viaja de vuelta en la fila porque el llamador tiene en memoria un
  // `usuario` con plan='free' YA VIEJO: sin esta señal, la confirmación de su primer gasto
  // le anunciaría el muro un segundo después de haberle dado 14 días de Pro.
  if (!datos.esGmail && data) {
    try {
      const { iniciarTrialSiCorresponde } = require('../lib/trial');
      const r = await iniciarTrialSiCorresponde(usuarioId);
      if (r.iniciado) { data.trialIniciado = true; data.trialVence = r.trialVence; }
    } catch (e) {
      log.error({ tag: 'TRIAL', err: e.message, usuarioId }, 'No se pudo arrancar el trial tras el gasto');
    }
  }
  // Activación: primera transacción del usuario (excluye importación masiva de Gmail).
  // El conteo viaja de vuelta en la fila (`conteoTx`) porque es exactamente lo que
  // necesita la cadencia del empujón a la webapp (lib/activacion.js): "cuántos
  // gastos lleva" es la señal del corte, y calcularlo dos veces sería absurdo.
  if (!datos.esGmail) {
    try {
      const { count, error: errConteo } = await supabase.from('transacciones')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', usuarioId);
      // Accesoria: sin conteo no hay evento de primer gasto ni `conteoTx` para la cadencia del
      // empujon a la webapp, pero el gasto YA esta escrito. El try de afuera dice "nunca romper
      // el registro por analytics" y esto lo respeta: solo log.
      if (errConteo) log.warn({ tag: 'ACTIVACION', usuarioId, err: errConteo.message }, 'No se pudo contar las transacciones: sin conteoTx ni evento de primer gasto');
      if (count === 1) {
        analytics.capture(usuarioId, 'wa_first_transaction', { tipo: data.tipo, categoria: data.categoria });
      }
      if (data && typeof count === 'number') data.conteoTx = count;
    } catch (e) { /* nunca romper el registro por analytics */ }
  }
  return data;
}

async function obtenerGastosMes(usuarioId, fechaMinima) {
  const hoyStr = hoyPeru();
  const parts = hoyStr.split('-');
  const primero = parts[0] + '-' + parts[1] + '-01';
  const desde = fechaMinima && fechaMinima > primero ? fechaMinima : primero;
  const { data, error } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto').gte('fecha', desde).order('fecha', { ascending: false });
  // El hermano exacto de `obtenerGastosSemana`, y por el mismo motivo: un `[]` mudo no produce
  // un total que falta, produce el total EQUIVOCADO. `/mes` responde "Sin movimientos este mes
  // aun" y el saludo anuncia S/ 0.00 — sobre una lectura caida las dos son mentiras sobre la
  // plata de alguien, que es peor que no contestar. Los tres comandos del webhook que la usan
  // atrapan el throw ahi mismo y responden, porque el catch general del webhook no contesta.
  if (error) throw error;
  return data || [];
}

async function obtenerGastosSemana(usuarioId, fechaMinima) {
  const hoyStr = hoyPeru();
  const hoy = new Date(hoyStr + 'T12:00:00');
  hoy.setDate(hoy.getDate() - 7);
  const desdeStr = hoy.toISOString().split('T')[0];
  const desde = fechaMinima && fechaMinima > desdeStr ? fechaMinima : desdeStr;
  const { data, error } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto').gte('fecha', desde).order('fecha', { ascending: false });
  // La alimenta `generarResumenSemanal`, o sea uno de los crons que EMPUJAN, y ahi el `[]`
  // corta con `if (!gastosSemana.length) return null`: el resumen del domingo no sale y no
  // queda una linea. Del lado del usuario es peor todavia — el intent `listar_gastos_semana`
  // le responde "no registraste gastos esta semana", que sobre una lectura caida es falso.
  if (error) throw error;
  return data || [];
}

async function obtenerUltimaTransaccion(usuarioId) {
  const { data, error } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId)
    .order('created_at', { ascending: false }).limit(1).single();
  // `PGRST116` es "cero filas": el usuario todavia no anoto nada. Ese caso lo cubre el
  // `return null` y los doce call-sites lo responden bien ("No hay transacciones recientes
  // para modificar"). Lo que no puede seguir saliendo por esa misma puerta es una caida:
  // "corrige el ultimo gasto" contestaba que no habia ninguno con el gasto ahi.
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function recategorizarTransaccion(usuarioId, comercio, categoriaNueva, subcategoriaNueva) {
  // Las dos lecturas de esta funcion devuelven un resultado DISCRIMINADO en vez de lanzar, y
  // no es una excepcion a la taxonomia sino su consecuencia: esta funcion YA modela el fallo.
  // Su contrato es `{ ok, msg }` y los dos call-sites imprimen `msg` tal cual — uno de ellos
  // es `/cambiar`, un comando del webhook, cuyo catch general no le contesta nada al usuario.
  // Lanzar cambiaria una mentira ("No encontre ninguna transaccion de X") por silencio;
  // devolver el motivo la cambia por la verdad.
  const MSG_ERROR = 'No pude buscar tus gastos de *' + comercio + '* ahora mismo. Intenta de nuevo en un momento.';
  let { data: txs, error: errTxs } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId).ilike('comercio', '%' + comercio + '%')
    .order('created_at', { ascending: false }).limit(5);
  if (errTxs) {
    log.error({ tag: 'RECATEGORIZAR', usuarioId, comercio, err: errTxs.message }, 'No se pudo leer las transacciones del comercio');
    return { ok: false, msg: MSG_ERROR };
  }
  if ((!txs || txs.length === 0) && comercio.length > 3) {
    const palabras = comercio.split(/\s+/).filter(p => p.length >= 3);
    for (const palabra of palabras) {
      const { data: txsPalabra, error: errPalabra } = await supabase.from('transacciones').select('*')
        .eq('usuario_id', usuarioId).ilike('comercio', '%' + palabra + '%')
        .order('created_at', { ascending: false }).limit(5);
      // El reintento palabra por palabra es el ULTIMO recurso antes de "no encontre nada": si
      // esta lectura cae, seguir el bucle y terminar en ese mensaje es afirmar que se busco.
      if (errPalabra) {
        log.error({ tag: 'RECATEGORIZAR', usuarioId, comercio, palabra, err: errPalabra.message }, 'No se pudo leer las transacciones por palabra');
        return { ok: false, msg: MSG_ERROR };
      }
      if (txsPalabra && txsPalabra.length > 0) { txs = txsPalabra; break; }
    }
  }
  if (!txs || txs.length === 0) return { ok: false, msg: 'No encontre ninguna transaccion de *' + comercio + '*.' };
  const tx = txs[0];
  const categoriaAnterior = tx.categoria || 'Sin categoria';
  const updates = { categoria: categoriaNueva };
  if (subcategoriaNueva) updates.subcategoria = subcategoriaNueva;
  // **`corregir_categoria` tiene DOS ramas y esta es la otra.** Cuando el usuario nombra el
  // comercio ("cambia starbucks a transporte"), el UPDATE no vive en el handler sino aca, y
  // aca faltaba lo mismo que 9A-bis cierra alla: postgrest no devuelve `error` cuando el
  // UPDATE no matchea ninguna fila, asi que un borrado concurrente entre `txs[0]` y esta linea
  // devolvia `{ ok: true }`. El handler entonces guarda la regla, la retroaplica y contesta
  // *"Listo! Movi Starbucks (S/45.50)... Aplique el cambio a todos los pagos anteriores"* — la
  // confirmacion falsa MAS la regla escrita sobre un cambio que no ocurrio, que es justo lo que
  // la rama de al lado corta a proposito. Tres entradas de produccion: el intent por NLP, el
  // comando `/cambiar` (webhook.js) y `corregir_multiple`.
  const { data: filasMovidas, error } = await supabase.from('transacciones').update(updates).eq('id', tx.id).select('id');
  if (error) return { ok: false, msg: 'Error actualizando: ' + error.message };
  if (!filasMovidas || filasMovidas.length === 0) {
    log.warn({ tag: 'RECATEGORIZAR', usuarioId, comercio, txId: tx.id }, 'El update de categoria no afecto ninguna fila');
    return { ok: false, msg: 'Ese gasto ya no esta. Puede que lo hayas eliminado hace un momento.' };
  }
  return { ok: true, tx, msg: 'Listo! Movi *' + (tx.comercio || comercio) + '* (S/ ' + tx.monto + ') de *' + categoriaAnterior + '* a *' + categoriaNueva + (subcategoriaNueva ? ' > ' + subcategoriaNueva : '') + '*.' };
}

async function recategorizarPorId(transaccionId, categoriaNueva) {
  const { error } = await supabase.from('transacciones').update({ categoria: categoriaNueva }).eq('id', transaccionId);
  if (error) return { ok: false, msg: 'Error actualizando.' };
  return { ok: true };
}

async function corregirTransaccionEspecifica(usuarioId, comercio, monto, fecha, categoriaNueva, subcategoriaNueva) {
  let query = supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId)
    .ilike('comercio', '%' + comercio + '%')
    .order('fecha', { ascending: false })
    .limit(10);
  const { data: txs, error: errBuscar } = await query;
  // Mismo criterio que `recategorizarTransaccion`, con una razon extra: el call-site es un
  // BUCLE de correcciones multiples. Un throw abortaria las que ya se aplicaron y las que
  // faltan; el motivo discriminado deja que las demas sigan y que esta linea diga la verdad.
  if (errBuscar) {
    log.error({ tag: 'CORREGIR_TX', usuarioId, comercio, err: errBuscar.message }, 'No se pudo leer las transacciones a corregir');
    return { ok: false, comercio, motivo: 'error' };
  }
  if (!txs || txs.length === 0) return { ok: false, comercio };
  let tx = txs[0];
  if (fecha || monto) {
    const match = txs.find(t => {
      const fechaOk = !fecha || (t.fecha && t.fecha.startsWith(fecha));
      const montoOk = !monto || Math.abs(parseFloat(t.monto) - monto) < 0.5;
      return fechaOk && montoOk;
    });
    if (match) tx = match;
  }
  const updates = { categoria: categoriaNueva };
  if (subcategoriaNueva) updates.subcategoria = subcategoriaNueva;
  const { data: filasCorregidas, error } = await supabase.from('transacciones').update(updates).eq('id', tx.id).select('id');
  // El `motivo` va tambien aca, y no solo en la lectura. Sin el, un update rechazado devolvia
  // `{ ok: false, comercio }` —la forma EXACTA de "ese comercio no existe"— y el bucle de
  // correcciones imprimia "no encontre gasto de X" sobre un gasto que acababa de leer. O sea
  // la misma mentira que este commit vino a cerrar, una rama mas abajo. Lo encontro la
  // revision adversarial. `recategorizarTransaccion` ya lo distinguia.
  if (error) {
    log.error({ tag: 'CORREGIR_TX', usuarioId, comercio, err: error.message }, 'El update de la correccion fue rechazado');
    return { ok: false, comercio, motivo: 'error' };
  }
  // Un motivo PROPIO, no `'error'`: son dos desenlaces distintos y el call-site le dice cosas
  // distintas a la persona. "No pude corregirlo ahora mismo" invita a reintentar, y sobre una
  // fila que ya no existe eso es mandarla a repetir algo que no va a funcionar nunca. Sin este
  // tercer valor, la unica alternativa era caer en el `else` generico, que dice "no encontre
  // gasto de X" sobre un gasto que ESTA funcion acaba de leer — la mentira que el `motivo`
  // vino a cerrar, con otra causa.
  if (!filasCorregidas || filasCorregidas.length === 0) {
    log.warn({ tag: 'CORREGIR_TX', usuarioId, comercio, txId: tx.id }, 'El update de la correccion no afecto ninguna fila');
    return { ok: false, comercio, motivo: 'desaparecido' };
  }
  return { ok: true, comercio: tx.comercio || comercio, monto: tx.monto_pen || tx.monto, moneda: tx.moneda || 'PEN' };
}

// --- Reglas de comercio ---

// Una regla PISA la categoria que dedujo la NLP (ver guardarTransaccion), asi que
// una regla que no clasifica nada es peor que no tener regla: condena al comercio
// a caer sin clasificar para siempre, aunque la NLP hubiera acertado. Dos casos:
//
//   - subcategoria 'sin_categoria' / 'null' -> se normaliza a null (la categoria
//     sigue sirviendo: "metro" -> Comida sin sub es una regla util).
//   - categoria "Otros" y ademas sin subcategoria -> no enseña nada. No se guarda.
//     ("Otros / Regalo" si es legitima: es una clasificacion deliberada.)
//
// Espejo de needsReview() en webapp/src/lib/constants.ts — si cambia una, cambia
// la otra (backend CommonJS y webapp TS no comparten modulo).
function normalizarDestinoRegla(categoria, subcategoria) {
  const cat = (categoria || '').trim();
  const sub = (subcategoria || '').trim();
  const subUtil = subcategoriaUtil(sub);
  if (!cat) return null;
  if (cat.toLowerCase() === 'otros' && !subUtil) return null;
  return { categoria: cat, subcategoria: subUtil };
}

/**
 * Guarda (o descarta) la regla comercio → categoría.
 *
 * Antes no devolvía NADA, así que el llamador anunciaba "✅ Regla creada" igual cuando esta
 * función la había descartado. Ahora devuelve un resultado DISCRIMINADO, y la diferencia entre
 * los motivos no es cosmética: "la descarté porque no clasifica nada" pide que el usuario
 * cambie lo que pidió, y "no la pude escribir" pide que reintente lo MISMO. Un `null` pelado
 * para las dos le hacía cambiar de categoría una y otra vez contra un fallo de escritura.
 *
 * @returns {Promise<{ok:true, destino:{categoria:string, subcategoria:string|null}}
 *                 | {ok:false, motivo:'sin-comercio'|'no-clasifica'|'error'}>}
 */
async function guardarReglaComercio(usuarioId, comercio, categoria, subcategoria) {
  if (!comercio) return { ok: false, motivo: 'sin-comercio' };
  const patron = comercio.toLowerCase().trim();
  if (!patron) return { ok: false, motivo: 'sin-comercio' };

  // Hallazgo B30. La categoría de una regla PISA la que dedujo el clasificador (ver
  // `guardarTransaccion`, una línea después de `resolverCategoriaPersistida`), así que
  // entrando cruda la regla es una TERCERA puerta que escribe `transacciones.categoria`
  // sin pasar por el invariante que estableció B28.
  //
  // Medido, no preventivo (12-ago-2026): un usuario real tenía sus gastos de comida
  // partidos exactamente en dos —5 filas en `Alimentacion` y 5 en `Alimentación`— y la
  // línea del corte era esta: las 5 mal escritas eran las de comercios CON regla.
  //
  // Va por `resolverCategoriaPersistida` y NO por `normalizarCategoria`, y esa diferencia
  // es la mitad del hallazgo: normalizar a secas manda a 'Otros' las 77 reglas de 13
  // usuarios con categorías libres legítimas (`Freelance`, `Gastos Hormiga`, `Separación`),
  // o sea reintroduce B28 por la puerta que esto viene a tapar.
  //
  // Y va ANTES de `normalizarDestinoRegla`, no después: resolviendo después, un `Viajes`
  // —colapso con pérdida → 'Otros'— pasaría el filtro como 'Viajes' y se guardaría como
  // 'Otros', que es justo la regla-que-no-clasifica-nada que el filtro rechaza.
  //
  // El ternario preserva el caso `categoria` vacía: `resolverCategoriaPersistida(null)`
  // devuelve 'Otros', y eso convertiría una llamada sin categoría en una regla
  // 'Otros > sub' donde hoy no se guarda nada.
  const { resolverCategoriaPersistida } = require('./categories');
  const catResuelta = categoria ? resolverCategoriaPersistida(categoria) : categoria;

  const destino = normalizarDestinoRegla(catResuelta, subcategoria);
  if (!destino) {
    log.info({ tag: 'REGLA', comercio: patron, categoria, catResuelta, subcategoria }, 'Regla descartada: no clasifica nada');
    return { ok: false, motivo: 'no-clasifica' };
  }

  try {
    // Se LEE el `error`, y no alcanza con el try/catch. postgrest NO lanza cuando el upsert
    // es rechazado (RLS, constraint, payload inválido): devuelve el fallo en `error` y el
    // `await` resuelve normal. Sin esta línea la función devolvía "guardada" ante el modo de
    // fallo más probable, y el llamador creaba la raíz en el árbol, retroaplicaba sobre el
    // histórico y anunciaba "✅ Regla creada" sin una sola fila en `reglas_comercio` — o sea
    // que los gastos futuros de ese comercio seguían sin clasificar y el usuario creía que no.
    // Es la misma lección que `guardarSnapshotEliminacion` (handlers/intents/transacciones.js)
    // ya tiene escrita, y este fix la había vuelto a pisar.
    const { error } = await supabase.from('reglas_comercio').upsert({
      usuario_id: usuarioId, comercio_pattern: patron,
      categoria: destino.categoria, subcategoria: destino.subcategoria,
      updated_at: new Date().toISOString()
    }, { onConflict: 'usuario_id,comercio_pattern' });
    if (error) {
      log.error({ tag: 'REGLA', comercio: patron, err: error.message }, 'El upsert de la regla fue rechazado');
      return { ok: false, motivo: 'error' };
    }
  } catch(e) {
    log.error({ tag: 'REGLA', err: e.message }, 'Error guardando regla comercio');
    return { ok: false, motivo: 'error' };
  }
  return { ok: true, destino };
}

async function buscarReglaComercio(usuarioId, comercio) {
  if (!comercio) return null;
  const patron = comercio.toLowerCase().trim();
  const { data, error } = await supabase.from('reglas_comercio').select('categoria,subcategoria')
    .eq('usuario_id', usuarioId).eq('comercio_pattern', patron).single();
  // Accesoria, y la clasificacion la decide el call-site: la llama `guardarTransaccion` ANTES
  // del insert y sin catch propio. Un throw aca perderia el gasto para salvar su categoria —
  // el trueque exactamente al reves. Sin regla el gasto cae en la categoria que dedujo la NLP,
  // que es recuperable y ademas la regla sigue aplicando a los siguientes.
  //
  // `PGRST116` es el caso NORMAL aca: la mayoria de los comercios no tiene regla.
  if (error && error.code !== 'PGRST116') {
    log.warn({ tag: 'REGLA', usuarioId, comercio: patron, err: error.message }, 'No se pudo leer la regla del comercio: el gasto se clasifica sin ella');
  }
  return data || null;
}

async function retroaplicarRegla(usuarioId, comercio, categoria, subcategoria) {
  if (!comercio || !categoria) return 0;
  try {
    const updates = { categoria };
    if (subcategoria) updates.subcategoria = subcategoria;
    const { count, error } = await supabase.from('transacciones').update(updates, { count: 'exact' })
      .eq('usuario_id', usuarioId).ilike('comercio', '%' + comercio + '%');
    // Se devuelve 0, igual que el catch de abajo, y eso NO es tragarse el fallo: el `update`
    // no aplico, asi que cero es el numero cierto. Lo que faltaba era el log — un `log.info`
    // con `count: null` anunciando 'Regla retroaplicada' es peor que no loguear, porque
    // afirma que se hizo.
    if (error) {
      log.error({ tag: 'RETROAPLICAR', usuarioId, comercio, err: error.message }, 'El update de la retroaplicacion fue rechazado');
      return 0;
    }
    log.info({ tag: 'REGLA', comercio, categoria, subcategoria, count }, 'Regla retroaplicada');
    return count || 0;
  } catch(e) { log.error({ tag: 'RETROAPLICAR', err: e.message }, 'Error retroaplicando regla'); return 0; }
}

module.exports = {
  obtenerTipoCambio, guardarTransaccion,
  obtenerGastosMes, obtenerGastosSemana, obtenerUltimaTransaccion,
  recategorizarTransaccion, recategorizarPorId, corregirTransaccionEspecifica,
  guardarReglaComercio, buscarReglaComercio, retroaplicarRegla,
  DEDUP_WINDOW_MS,
};
