const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { registrarError } = require('../lib/error-monitor');
const { notificarErrorAdmin } = require('../lib/admin-notify');
const { hoyPeru } = require('../lib/dates');
const { leerCorreosBancarios } = require('../gmail');
const { parsearCorreoBancario } = require('./parsers');
const { guardarTransaccion } = require('./transactions');
const { obtenerCategoriasUsuario } = require('./categories');
const { esProPagado, linkPanelPro } = require('../lib/trial');
const { notificarUsuario, CANALES } = require('../lib/notify-user');

// Lazy-loaded to avoid circular dependency
let _enviarAlertaTransaccion = null;
function getEnviarAlertaTransaccion() {
  if (!_enviarAlertaTransaccion) {
    _enviarAlertaTransaccion = require('./notifications').enviarAlertaTransaccion;
  }
  return _enviarAlertaTransaccion;
}

// Throttle de notificaciones de auth expirada: máx 1 vez cada 24h por usuario
const authErrorNotifiedAt = new Map();

// Pool de concurrencia simple (sin dependencia externa). Corre `fn` sobre `items`
// con a lo más `concurrency` en vuelo a la vez. JS es single-thread: los contadores
// que mutan las tareas (registradas/ignoradas/resumen) son seguros entre awaits.
async function mapPool(items, concurrency, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));
}

// Cuántos correos parsear en paralelo por sweep. Cada correo hace SELECT dedup +
// 1 llamada GPT-4o-mini + insert; en serie, 100 correos ≈ 100s. Con 5 en vuelo el
// wall-clock cae ~5x sin subir el número de llamadas OpenAI.
const CONCURRENCIA_SWEEP = 5;

async function notificarAuthExpirada(usuario) {
  const last = authErrorNotifiedAt.get(usuario.id) || 0;
  if (Date.now() - last < 24 * 60 * 60 * 1000) return; // ya notificado hoy
  authErrorNotifiedAt.set(usuario.id, Date.now());
  log.warn({ tag: 'AUTH', usuarioId: usuario.id }, 'Gmail desconectado — notificando usuario');
  // Por los dos canales: se rompió la ingesta automática, o sea que el usuario va a dejar
  // de ver gastos sin haber hecho nada. Un aviso que solo vive en WhatsApp no llega a quien
  // justamente confió en que Neto anotaba solo y por eso no escribe hace días.
  // Reconectar es web-only, así que el aviso lleva el enlace en vez de pedir un comando de
  // WhatsApp que ya no conecta nada. El deeplink in-app también cambió: /dashboard/configuracion
  // no tiene una sola línea de Gmail, o sea que el aviso aterrizaba en una pantalla sin botón.
  const linkReconectar = linkPanelPro(usuario);
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id,
    whatsapp: usuario.whatsapp || null,
    tipo: 'gmail_auth_expirada',
    mensaje: '⚠️ *Tu Gmail se desconectó*\n\n' +
      'Neto ya no puede leer tus correos bancarios para registrar tus gastos automáticamente.\n\n' +
      (linkReconectar ? 'Reconéctalo acá y todo vuelve a funcionar:\n' + linkReconectar : 'Reconéctalo desde tu app para que todo vuelva a funcionar.'),
    titulo: 'Tu Gmail se desconectó',
    cuerpo: 'Neto ya no puede leer tus correos bancarios. Reconéctalo para que todo vuelva a funcionar.',
    tipoInApp: 'alerta',
    link: '/dashboard/pro',
  });
}

// opts:
//   scanOpts      → ventana/caps del scan (se pasa tal cual a leerCorreosBancarios)
//   enviarAlertas → si false, NO manda la tarjeta WhatsApp por transacción (para el
//                   barrido histórico, donde 30 días = decenas de correos y sería spam)
//   historico     → cambia el mensaje de resumen final
async function escanearGmailYRegistrar(usuario, opts = {}) {
  // `estado` lo pasa quien necesita saber si algo se saltó por error. Hoy sólo el barrido
  // histórico, y por un motivo que no vale para el incremental: ver `escanearHistoricoInicial`.
  const { scanOpts = {}, enviarAlertas = true, historico = false, estado = null } = opts;
  const { error, mensajes } = await leerCorreosBancarios(usuario.id, scanOpts);
  // **Los dos casos vacios NO son el mismo, y colapsarlos en `null` costo un copy al reves.**
  // `no_auth` significa que `leerCorreosBancarios` no encontro NINGUNA de las dos fuentes
  // (consulta `gmail_cuentas` y recien despues cae al token legacy de `usuarios`), o sea que
  // esta persona no tiene Gmail conectado. `!mensajes.length` significa que si lo tiene y no
  // habia correos nuevos. Los call-sites tenian que adivinar cual de los dos habia sido, y lo
  // adivinaban mirando `usuario.gmail_access_token` — el almacen viejo, vacio para casi todos.
  // Resultado: a quien SI tiene Gmail conectado se le respondia "conectalo en la app".
  //
  // Se devuelve un objeto por el mismo motivo que `{authError:true}`, y el dato ya estaba acá:
  // lo unico que hacia falta era dejar de tirarlo. No cuesta una query nueva.
  if (error === 'no_auth') return { sinCuenta: true };
  if (error === 'AUTH_EXPIRED') return { authError: true };
  // No se pudo AVERIGUAR si tiene cuentas. Cae en `null` —el desenlace mudo— a proposito: es
  // el unico que no afirma nada. Decir `sinCuenta` seria pedirle que conecte Gmail a quien ya
  // lo tiene, que es el bug que `sinCuenta` vino a arreglar, servido por la rama de error.
  if (error === 'lectura_fallida') return null;
  if (!mensajes.length) return null;
  let registradas = 0; let ignoradas = 0; let resumen = '';
  // Fetch categorías custom una sola vez por batch (no por correo)
  let categoriasCustom = null;
  try { categoriasCustom = await obtenerCategoriasUsuario(usuario.id); }
  catch(e) { log.warn({ tag: 'CATS', err: e.message }, 'No se pudieron cargar categorías custom'); }
  // Procesa hasta CONCURRENCIA_SWEEP correos en paralelo (P1: antes era serial, 30d
  // podía tomar ~100s). Cada correo es independiente (distinto msg.id); el pool no
  // introduce race porque el insert va protegido por el índice único de gmail_msg_id.
  await mapPool(mensajes, CONCURRENCIA_SWEEP, async function(msg) {
    try {
      const textoParseo = msg.texto || msg.snippet;
      const claveDedup = msg.id;
      // Pre-check barato por descripcion_original: evita gastar una llamada OpenAI en un
      // correo ya registrado (cubre también filas viejas sin gmail_msg_id). NO es la
      // garantía contra la race de doble barrido — esa la da el índice único parcial
      // (usuario_id, gmail_msg_id) que atrapa dos inserts concurrentes del mismo correo.
      // **Los dos fallan CERRADO, y cada uno por su motivo.** Con el `{ error }` descartado,
      // una caída dejaba las dos variables en null y el correo seguía de largo:
      //
      //   · `transacciones`: el índice único (usuario_id, gmail_msg_id) tapa el caso moderno,
      //     pero este pre-check existe justamente para cubrir **las filas viejas sin
      //     `gmail_msg_id`**, que ese índice no protege. Ahí una lectura caída se convertía en
      //     un gasto DUPLICADO en el dashboard de la persona.
      //   · `gmail_excluidos`: no tiene ninguna red detrás. Un correo que el usuario mandó a
      //     ignorar volvía a registrarse solo.
      //
      // Tirar acá lo toma el `catch` de este mismo `mapPool` —que sí es alcanzable, por
      // `parsearCorreoBancario` y `guardarTransaccion`— así que el correo se saltea con su
      // fila en `errores` y el escaneo de los 15 minutos siguientes lo reintenta. No suma a
      // `ignoradas`: ese contador alimenta el texto "ya estaban registrados", que sería falso.
      // Y de paso no se gasta la llamada a OpenAI sobre un correo que no se va a poder decidir.
      //
      // **`.limit(1)` NO es decorativo, y sin él el arreglo era peor que el bug.** El índice
      // único de `transacciones` es PARCIAL (`WHERE gmail_msg_id IS NOT NULL`), así que sobre
      // `descripcion_original` puede haber DOS filas: una legacy sin `gmail_msg_id` y una
      // moderna con él. `maybeSingle()` sintetiza un PGRST116 cuando vuelven >1 filas
      // (postgrest-js lo fabrica del lado del cliente, no es un error del servidor), y sin el
      // `limit` eso caía en el `throw` de abajo: ese correo fallaría en CADA corrida del cron,
      // cada 15 minutos, para siempre, dejando una fila en `errores` cada vez. Medido el
      // 31-ago-2026: hay 83 grupos `(usuario_id, descripcion_original)` duplicados y 577 filas
      // legacy con forma de msg-id — la trampa está armada aunque hoy no se haya disparado.
      // Misma forma que ya usa `routes/pro.js` para `pagos`. Lo encontró la revisión adversarial.
      const { data: existente, error: errExistente } = await supabase.from('transacciones').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).limit(1).maybeSingle();
      if (errExistente) throw new Error('No se pudo verificar si el correo ya estaba registrado: ' + errExistente.message);
      if (existente) { ignoradas++; return; }
      // Éste no necesita `limit`: `idx_gmail_excluidos_unique` es único y COMPLETO sobre
      // (usuario_id, descripcion_original), verificado contra producción. Va sin él a propósito,
      // para que la diferencia con el de arriba quede a la vista.
      const { data: excluido, error: errExcluido } = await supabase.from('gmail_excluidos').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).maybeSingle();
      if (errExcluido) throw new Error('No se pudo verificar si el correo estaba excluido: ' + errExcluido.message);
      if (excluido) { ignoradas++; return; }
      const resultado = await parsearCorreoBancario(textoParseo, msg.asunto, categoriasCustom);
      if (!resultado.monto) return;
      // esGmail: true → guardarTransaccion salta su dedup de ventana (10s) y el conteo de
      // activación. gmail_msg_id → clave del índice único que cierra la race de doble barrido
      // (sweep 30d + cron 15min solapados) sin poder poner unique sobre descripcion_original.
      // dedupAvisoGmail: solo en el escaneo incremental. En el barrido histórico dos compras
      // legítimas del mismo día se procesan con segundos de diferencia y colapsarían mal.
      const txGuardada = await guardarTransaccion(usuario.id, { ...resultado, fecha: msg.fecha || resultado.fecha, descripcion_original: claveDedup, gmail_msg_id: claveDedup, esGmail: true, dedupAvisoGmail: !historico, recibidoEnMs: msg.recibidoEnMs });
      if (!txGuardada) { ignoradas++; return; } // segundo aviso del mismo cargo
      registradas++;
      // `txGuardada.tipo`, no `resultado.tipo`: guardarTransaccion normaliza, así que el crudo
      // puede decir "Ingreso" sobre una fila guardada como ingreso y este ternario —que compara
      // exacto contra minúscula— la anunciaría como Gasto.
      resumen += '- ' + (txGuardada.tipo === 'ingreso' ? 'Ingreso' : 'Gasto') + ': ' + (resultado.comercio || resultado.banco || 'Sin nombre') + ' S/ ' + resultado.monto + '\n';
      // En el barrido histórico se registran en silencio: nada de una tarjeta por correo.
      if (enviarAlertas) {
        setTimeout(async function() {
          try { await getEnviarAlertaTransaccion()(usuario, txGuardada, resultado); } catch(e) { log.error({ tag: 'ALERTA', err: e.message }, 'Error alerta transacción'); }
        }, 5000);
      }
      // El premio de referidos ya NO se dispara por uso (correos): el modelo dos-lados
      // premia al referrer recién cuando el referido PAGA Pro (ver lib/pro-payment:activarPro).
    } catch (e) {
      if (estado) estado.fallidos++;
      log.error({ tag: 'CORREO', err: e.message }, 'Error procesando correo');
      registrarError('CORREO', e.message, { stack: e.stack, usuarioId: usuario.id });
    }
  });
  if (registradas === 0) {
    if (historico) return null;
    if (ignoradas > 0) return '*Sin correos nuevos*\n\n' + ignoradas + ' correo(s) ya estaban registrados.';
    return null;
  }
  if (historico) {
    // Un solo mensaje de resumen (sin volcar la lista completa: pueden ser decenas).
    return '\uD83D\uDCE5 *\u00A1Listo! Import\u00E9 tus \u00FAltimos 30 d\u00EDas*\n\n' + registradas + ' movimiento(s) agregados a tu dashboard.\n\n\uD83D\uDC49 M\u00EDralos en https://app.neto.pe';
  }
  return '\uD83D\uDCEC Revise tu Gmail \u2014 *' + registradas + ' movimiento(s) nuevo(s)*:\n\n' + resumen + '\n\u00bfLo revisamos?';
}

// Ventana y caps del barrido hist\u00F3rico \u00FAnico (30 d\u00EDas). Caps altos para poblar el
// dashboard pero acotados para no golpear la cuota de Gmail (~2 list + hasta 100 get).
const HISTORICO_SCAN_OPTS = { windowDays: 30, filterDays: 30, maxPerQuery: 100, maxProcess: 50 };

// Barrido hist\u00F3rico \u00FAnico tras la primera conexi\u00F3n de Gmail. Registra en silencio los
// movimientos de los \u00FAltimos 30 d\u00EDas y marca usuarios.historico_importado para no repetir.
async function escanearHistoricoInicial(usuario) {
  if (usuario.historico_importado) return null;
  // Claim at\u00F3mico: pone historico_importado=true SOLO si estaba false y solo si esta ejecuci\u00F3n
  // gana la fila corremos el barrido. Un segundo callback OAuth concurrente (Google reintenta /
  // doble click) recibe null y no duplica los 30 d\u00EDas. Reservamos ANTES del scan; si la auth
  // falla, liberamos para que el usuario pueda reconectar y a\u00FAn merecer el barrido.
  const { data: claim, error: errClaim } = await supabase.from('usuarios')
    .update({ historico_importado: true })
    .eq('id', usuario.id).eq('historico_importado', false)
    .select('id').maybeSingle();
  // Sigue sin correr el barrido —no sabemos si ganamos la fila, y correrlo a ciegas duplica
  // 30 días de movimientos— pero el log deja de mentir: decía "ya reclamado" sobre una
  // escritura que nunca respondió. `historico_importado` queda en false, así que la próxima
  // conexión lo reintenta.
  if (errClaim) { log.error({ tag: 'HIST', err: errClaim.message, usuarioId: usuario.id }, 'No se pudo reclamar el barrido hist\u00F3rico: no se corre'); return null; }
  if (!claim) { log.info({ tag: 'HIST', usuarioId: usuario.id }, 'Barrido hist\u00F3rico ya reclamado, skip'); return null; }
  usuario.historico_importado = true;
  log.info({ tag: 'HIST', usuarioId: usuario.id }, 'Barrido hist\u00F3rico 30d iniciado');
  const estado = { fallidos: 0 };
  const resultado = await escanearGmailYRegistrar(usuario, {
    scanOpts: HISTORICO_SCAN_OPTS,
    enviarAlertas: false,
    historico: true,
    estado,
  });
  if (resultado && resultado.authError) {
    // Si esta liberación no pega, `historico_importado` se queda en true para siempre y esa
    // persona **nunca** va a recibir su import de 30 días, ni reconectando: el `if` del tope
    // de la función la saca antes de llegar acá. No hay nada que reintentar en el momento,
    // pero sin el log el síntoma es invisible.
    const { error: errLiberar } = await supabase.from('usuarios').update({ historico_importado: false }).eq('id', usuario.id);
    if (errLiberar) log.error({ tag: 'HIST', err: errLiberar.message, usuarioId: usuario.id }, 'No se pudo liberar el claim: este usuario queda sin barrido hist\u00F3rico permanentemente');
    usuario.historico_importado = false;
    return resultado;
  }
  // **El claim se LIBERA si algo se saltó, y esto es lo que hace seguro el fail-closed de los
  // pre-checks.** Los dos `throw` de arriba saltean el correo y lo reintenta el cron de los 15
  // minutos... pero ese cron mira una ventana de 2 días (`windowDays = 2` en `gmail.js`), no de
  // 30. O sea que en el barrido histórico un correo salteado no vuelve NUNCA: el claim ya está
  // en `true` y sólo se libera en la rama `authError`, así que ni reconectando. El fail-closed
  // es correcto para el incremental y, sin esta liberación, en el histórico costaba datos.
  //
  // Re-correr el barrido entero es seguro: los que sí entraron quedaron con su `gmail_msg_id`,
  // y el pre-check por `descripcion_original` los reconoce y los saltea. Lo encontró la
  // revisión adversarial; el comentario que justificaba el `throw` decía "lo reintenta el
  // escaneo de los 15 minutos" y eso sólo era cierto para el otro camino.
  if (estado.fallidos > 0) {
    const { error: errReintento } = await supabase.from('usuarios').update({ historico_importado: false }).eq('id', usuario.id);
    usuario.historico_importado = false;
    log.warn({ tag: 'HIST', usuarioId: usuario.id, fallidos: estado.fallidos, errReintento: errReintento && errReintento.message },
      'Barrido hist\u00F3rico con correos salteados: se libera el claim para reintentarlo entero');
    return resultado;
  }
  log.info({ tag: 'HIST', usuarioId: usuario.id }, 'Barrido hist\u00F3rico 30d completado');
  return resultado;
}

async function escaneoAutomatico() {
  log.info({ tag: 'AUTO' }, 'Escaneo automático iniciado');
  try {
    // Bug fix: incluir usuarios con token legacy Y usuarios con cuentas en gmail_cuentas
    const [{ data: usuariosLegacy, error: errLegacy }, { data: cuentasGmail, error: errCuentas }] = await Promise.all([
      supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null),
      supabase.from('gmail_cuentas').select('usuario_id').eq('activa', true),
    ]);
    // **Estas dos definen JUNTAS a quién se le escanea, así que se abortan juntas.** Con el
    // error descartado, cualquiera de las dos caída dejaba su mitad en `[]` y el escaneo
    // corría sobre un subconjunto: los usuarios de la mitad caída simplemente dejaban de
    // recibir sus movimientos, sin una sola línea que lo dijera. Y si caían las dos,
    // `todosLosUsuarios` quedaba vacío y el cron salía por el `return` de más abajo como si
    // hubiera trabajado. Abortar es barato: esto corre cada 15 minutos.
    if (errLegacy || errCuentas) {
      log.error({ tag: 'AUTO', errLegacy: errLegacy && errLegacy.message, errCuentas: errCuentas && errCuentas.message },
        'No se pudo armar la lista de usuarios a escanear: se aborta la corrida (reintenta en el pr\u00F3ximo ciclo)');
      return;
    }

    const idsLegacy = new Set((usuariosLegacy || []).map(u => u.id));
    const idsSoloNuevos = [...new Set((cuentasGmail || []).map(c => c.usuario_id))].filter(id => !idsLegacy.has(id));

    let todosLosUsuarios = usuariosLegacy || [];
    if (idsSoloNuevos.length > 0) {
      // La lapida (migracion 073) conserva su fila de `gmail_cuentas` —es donde vive el
      // `email_hash` que protege el cupo— asi que puede entrar por `idsSoloNuevos`. Hoy la
      // salva que esa fila queda `activa = false`, pero eso es un efecto lateral de otra
      // decision: el filtro explicito no depende de que esa decision no cambie.
      const { data: usuariosNuevos, error: errNuevos } = await supabase.from('usuarios').select('*')
        .in('id', idsSoloNuevos).is('cuenta_borrada_at', null);
      // Esta NO aborta, al revés que las dos de arriba, y la diferencia es que acá los legacy
      // ya están resueltos: tirar la corrida entera les quitaría un escaneo que sí se podía
      // hacer. Los de `gmail_cuentas` entran en el ciclo siguiente.
      if (errNuevos) log.error({ tag: 'AUTO', err: errNuevos.message, cuantos: idsSoloNuevos.length }, 'No se pudieron leer los usuarios de gmail_cuentas: esta corrida escanea solo los legacy');
      todosLosUsuarios = [...todosLosUsuarios, ...(usuariosNuevos || [])];
    }

    if (!todosLosUsuarios.length) return;
    for (const usuario of todosLosUsuarios) {
      try {
        // La LECTURA sigue al mismo predicado que la conexión: si conectar Gmail exige Pro
        // pagado, leer también. El gate viejo era por plan, y durante el trial `plan` vale
        // 'premium' — o sea que a un usuario en prueba con una cuenta heredada (de antes del
        // gate, o de una baja que el barrido todavía no alcanzó) se le seguían leyendo los
        // correos del banco. Es la mitad silenciosa de la misma capability.
        if (!esProPagado(usuario)) continue;
        const resultado = await escanearGmailYRegistrar(usuario);
        // `{sinCuenta:true}` cae solo: no es `authError` ni un string, asi que no dispara
        // ninguna de las dos ramas. Es lo correcto — el barrido automatico no le escribe a
        // nadie por no tener Gmail; para eso esta el filtro de la lista de usuarios.
        if (resultado && resultado.authError) {
          // Gmail desconectado — notificar al usuario (máx 1 vez/24h)
          await notificarAuthExpirada(usuario);
        } else if (resultado && typeof resultado === 'string' && resultado.includes('movimiento')) {
          // Como máximo UNO por día por usuario, con el dedup por tipo+titulo+fecha que ya
          // usan los cuatro avisos de `cron/checks.js`.
          //
          // Este cron corre cada 15 minutos (`INTERVALO_ESCANEO_MS`, default 0.25h) y esta
          // rama escribía una fila por corrida que encontrara movimientos. Medido el
          // 27-ago-2026 sobre 30 días: **209 filas a 2 usuarios**, o sea el 26.7% de TODO el
          // volumen in-app del producto, 4.4 por día en el más activo. Las 4.4 dicen lo mismo
          // y enlazan al mismo sitio.
          //
          // **No se borra el aviso, se colapsa la cadencia**, y la diferencia importa: el
          // `motivo` de acá abajo dice que cada transacción ya manda su tarjeta, pero esa
          // tarjeta es de WHATSAPP — `enviarAlertaTransaccion` no escribe fila in-app salvo en
          // la rama de gasto inusual, y su propio docblock explica que convertirla en
          // `notificarUsuario` sería "una campana de spam". O sea que sin este resumen la
          // campana se queda SIN NADA que cuente que el correo trajo movimientos, y encima
          // para quien está fuera de la ventana de 24h de Meta (448 de 454 fallos de envío)
          // el WhatsApp tampoco llega.
          //
          // Falla CERRADO: si el dedup no se puede leer se asume que ya se avisó. Es al revés
          // que los crons horarios de `checks.js`, y por el volumen: acá "ante la duda mandar"
          // son hasta 96 filas idénticas en un día. El costo de saltarse un resumen es que la
          // persona ve sus movimientos al entrar, que es lo que iba a hacer igual.
          const inicioHoy = new Date(hoyPeru() + 'T00:00:00-05:00').toISOString();
          const { data: yaAviso, error: errDedup } = await supabase.from('notificaciones')
            .select('id').eq('usuario_id', usuario.id).eq('tipo', 'sistema')
            .eq('titulo', 'Escaneo de correo completado').gte('fecha', inicioHoy).limit(1);
          if (errDedup) {
            log.warn({ tag: 'AUTO', usuarioId: usuario.id, err: errDedup.message },
              'dedup del resumen de escaneo ilegible: se asume avisado');
          } else if (!yaAviso || yaAviso.length === 0) {
            await notificarUsuario({
              canales: CANALES.SOLO_IN_APP,
              motivo: 'un WhatsApp de resumen del escaneo era ruido: cada transacción detectada ya manda su propia tarjeta "Nuevo gasto" (enviarAlertaTransaccion, gateada por usuario.alertas_transaccion)',
              usuarioId: usuario.id,
              tipo: 'gmail_escaneo',
              titulo: 'Escaneo de correo completado',
              cuerpo: 'Se detectaron nuevos movimientos en tu correo bancario',
              link: '/dashboard/transacciones',
            });
          }
        }
      } catch (e) { log.error({ tag: 'AUTO', whatsapp: usuario.whatsapp, err: e.message }, 'Error escaneo usuario'); }
    }
  } catch (e) { log.error({ tag: 'AUTO', err: e.message }, 'Error general escaneo'); notificarErrorAdmin('AUTO_SCAN', e.message); registrarError('AUTO_SCAN', e.message, { stack: e.stack }); }
}

module.exports = { escanearGmailYRegistrar, escaneoAutomatico, escanearHistoricoInicial };
