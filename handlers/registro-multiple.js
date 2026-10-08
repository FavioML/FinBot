const log = require('../lib/logger');
const { colaConfirmacionGasto } = require('../lib/trial');
const { subcategoriaUtil } = require('../lib/subcategoria');
const { resolverDiaSemanaPasado, resolverFechaRelativa } = require('../lib/dates');
const { montosDeMovimiento, montoEscritoEnMensaje, tipoContradiceElMensaje, sentidosDelTexto } = require('../lib/nlp-guards');
const { validarMonto } = require('../lib/validators');

/**
 * Un mensaje que anota VARIOS movimientos (07-oct-2026): se registran TODOS, o no se registra
 * ninguno y se le dice a la persona cuáles vio y por qué no los anotó.
 *
 * Lo que había antes, medido en producción (30 días, 4 usuarios reales): el clasificador maestro
 * llama UNA herramienta, `parsearRegistroManual` devuelve UN objeto, y la persona recibía "✅ S/2.00"
 * por "Gaste 2 soles más en pasajes, gaste 1.30 en cigarros y preste 118 soles". Los otros dos se
 * perdían sin aviso. Los dos detectores regex de `message-processor` (`detectarMultiGasto`,
 * `detectarIngresoMasGastos`) sólo cubrían "verbo + monto + preposición", fijaban la moneda en PEN y
 * respondían con los ítems que SÍ entraban.
 *
 * Por qué todo o nada y no "anoto los que entendí y te pregunto el resto": la persona que recibe
 * una respuesta parcial vuelve a mandar el mensaje entero, y los que ya entraron se duplican. Con
 * nada escrito, reenviar es seguro.
 *
 * Cómo se decide, y qué no puede hacer cada pieza:
 *  1. `montosDeMovimiento` (determinístico) cuenta los montos, en dos capas: la segura decide si
 *     el mensaje viene acá, la fina (con heurísticas) sólo puede dejar afuera un número si el
 *     separador también lo dejó afuera.
 *  2. `separarMovimientos` (un llamado aparte, que no decide plata) corta el mensaje en un texto por
 *     movimiento. Los textos tienen que ser una PARTICIÓN del mensaje (`validarSeparacion`): ventanas
 *     en orden que lo cubren entero, con un monto cada una.
 *  3. Cada texto pasa por `parsearRegistroManual` tal como está —el prompt validado decide tipo,
 *     moneda y si se registra— y por las mismas invariantes que el camino de un solo movimiento.
 *  4. En paralelo, el mensaje ENTERO pasa por el mismo parser: si dice que no es un movimiento (un
 *     saldo "yape 156.40 y Plin 100", una corrección "me pasé por S/32.50, era 80.6") se respeta,
 *     porque partirlo le quita el contexto que lo volvía un saldo o una corrección.
 */

// Lo que dice la confirmación cuando un movimiento no se anota. Sin ejemplos con palabras
// concretas: un ejemplo de rechazo se "pega" (docs/DEFECTOS.md, 30-sep).
const MOTIVOS = {
  tipo_dudoso: 'no sé si esa plata entró o salió. Escríbelo con el verbo: "gasté…" o "me pagaron…".',
  no_es_movimiento: 'no parece plata que ya entró o salió.',
  sin_monto: 'no pude leer bien el monto.',
  monto: 'no pude leer bien el monto.',
  error: 'no pude leer bien el monto.',
  moneda_no_soportada: 'por ahora solo anoto soles y dólares.',
  moneda: 'no supe si eran soles o dólares.',
  fecha: 'no sé de qué día es. Mándamelo con su fecha.',
};

const RE_FECHA_EXPLICITA = /\bayer\b|\bantier\b|\banteayer\b|\bhoy\b|\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\bla\s+semana\s+pasada\b|hace\s+\d+\s*(d[ií]a|hora|semana|mes)|\bel\s+\d{1,2}(\s+de\s+\w+)?\b|\b\d{1,2}\s*\/\s*\d{1,2}\b|\b\d{1,2}-\d{1,2}\b/i;

/**
 * La fecha del registro después de los tres guards post-modelo (día de semana, fecha relativa y
 * la fecha inventada sin mención). Es el bloque que vivía inline en `registrar_manual`; se movió
 * acá sin cambios para que el camino de varios movimientos aplique EXACTAMENTE los mismos.
 */
function ajustarFechaRegistro(texto, fechaModelo, fechaHoy) {
  let fecha = fechaModelo;
  const corregida = resolverDiaSemanaPasado(texto, fecha, fechaHoy);
  if (corregida) {
    log.info({ tag: 'WEEKDAY_GUARD', fechaModelo: fecha, fechaCorregida: corregida, msg: (texto || '').substring(0, 80) }, 'Ajuste post-OpenAI: weekday del msg no coincide con fecha del parser');
    fecha = corregida;
  }
  const relativa = resolverFechaRelativa(texto, fecha, fechaHoy);
  if (relativa) {
    log.info({ tag: 'RELATIVE_DATE_GUARD', fechaModelo: fecha, fechaCorregida: relativa, msg: (texto || '').substring(0, 80) }, 'Ajuste post-OpenAI: marcador relativo del msg no coincide con fecha del parser');
    fecha = relativa;
  }
  // El modelo a veces alucina una fecha pasada: sólo se respeta si el texto nombra una.
  if (fecha && fecha !== fechaHoy && !RE_FECHA_EXPLICITA.test((texto || '').toLowerCase())) {
    log.warn({ tag: 'TZ_GUARD_REGISTRO', fechaModelo: fecha, fechaHoy, msg: (texto || '').substring(0, 80) }, 'Modelo extrajo fecha pasada sin mencion del usuario — forzando hoy');
    fecha = fechaHoy;
  }
  return fecha;
}

const fmtNumero = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const nombrarMonto = (m) => (m.valor == null ? m.token : (m.moneda === 'USD' ? '$' : 'S/') + fmtNumero(m.valor));
function listaMontos(montos) {
  const ns = montos.map(nombrarMonto);
  return ns.length > 1 ? ns.slice(0, -1).join(', ') + ' y ' + ns[ns.length - 1] : ns[0];
}

// Minúsculas y sin tildes, carácter por carácter: los índices del texto normalizado son los del
// original, así un monto del mensaje (que trae su `index`) se ubica entre los tokens.
const normalizarIgualLargo = (s) => Array.from(String(s)).map((ch) => {
  const b = ch.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return b.length === 1 ? b : ch.toLowerCase();
}).join('');
const RE_TOKEN = /s\/\.?|\$|\d+(?:[.,]\s?\d+)*|[a-zñ]+/g;
const tokens = (s) => [...normalizarIgualLargo(s).matchAll(RE_TOKEN)].map((m) => ({ t: m[0], start: m.index, end: m.index + m[0].length }));
const igualesEn = (a, b, desde) => a.every((x, i) => b[desde + i] && (b[desde + i].t || b[desde + i]) === x);

// Lo único que puede quedar FUERA de toda ventana: lo que separa un movimiento de otro.
const SEPARADORES = new Set(['y', 'e', 'pero', 'tambien', 'luego', 'despues', 'ademas', 'aparte']);
// Lo que corta una cláusula dentro de la ventana: si una ventana con DOS números tiene esto entre
// medio, son dos movimientos ("taxi 8, recargué la línea 10").
const RE_CORTE_DE_CLAUSULA = /[,;\n]|(?:^|[^a-zñ])(?:y|e|pero|tambien|luego|despues|ademas|aparte)(?![a-zñ])/;
// Lo que el PARSER puede recibir prestado de otro movimiento: la FECHA dicha una vez (adelante: "ayer
// gasté 20 en taxi y 30 en cine"; atrás: "gasté 20 en taxi y 30 en cine ayer") y palabras funcionales.
// NO el verbo: la tercera revisión adversarial del 07-oct mostró que "Cobré 1500 de sueldo y 80 de luz"
// partido en "Cobré 1500…" y "Cobré 80 de luz" escribía la luz como INGRESO, y no hay forma de saber
// si el verbo que se repite es el que la persona elidió. Sin verbo, "80 de luz" se decide solo.
const PALABRAS_PRESTABLES = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'en', 'hoy', 'ayer', 'antier', 'anteayer', 'anoche',
  'pasado', 'pasada', 'semana', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'esta', 'manana', 'tarde', 'noche']);
// El SEPARADOR, en cambio, sí puede repetir el verbo en su texto: el modelo lo hace aunque el prompt
// diga que no (la sonda del 07-oct, "gasté $20 en taxi y $5 en café" → "gasté $5 en café", 2 de 2), y
// rechazar eso rebotaba listas buenas. Se acepta en la validación y se QUITA antes del parser.
const RE_VERBO_DE_PREFIJO = /^(?:gast|pag|compr|cobr|recib|ingres|deposit|yape|plin|transfer|abon|invert|prest|bot|vend|gan|dier|mand|registr|anot|apunt)[a-zñ]*$/;
const PALABRAS_DE_VERBO = new Set(['me', 'he', 'se', 'mi', 'un', 'una', 'uno', 'y']);
const esPrefijoAceptable = (X) => X.every((t) => PALABRAS_PRESTABLES.has(t) || PALABRAS_DE_VERBO.has(t) || RE_VERBO_DE_PREFIJO.test(t));
const esSufijoAceptable = (X) => X.every((t) => PALABRAS_PRESTABLES.has(t));
const FUNCIONALES_DE_FECHA = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'en']);
const RE_FECHA_EXTRA = '\\banoche\\b|\\besta\\s+(?:ma[ñn]ana|tarde|noche)\\b';
const RE_FECHA_PROPIA = new RegExp(RE_FECHA_EXPLICITA.source + '|' + RE_FECHA_EXTRA, 'i');
const RE_FECHA_EN_MENSAJE = new RegExp(RE_FECHA_EXPLICITA.source + '|' + RE_FECHA_EXTRA, 'gi');
const soloPrestable = (X) => X.filter((t) => PALABRAS_PRESTABLES.has(t));

/**
 * ¿Los textos del separador son una PARTICIÓN del mensaje? Devuelve, para cada texto, el monto del
 * mensaje que le toca y los números de su ventana que NO se anotan (`{ texto, montoMsg, otros }`),
 * o null.
 *
 * Tres revisiones adversariales del 07-oct rompieron las versiones anteriores (una bolsa de palabras,
 * después listas de verbos y fechas). Lo que quedó es estructural:
 *  · cada texto es una VENTANA contigua del mensaje, en orden y sin pisarse con las otras;
 *  · entre ventanas sólo quedan separadores ("y", "pero"…): una palabra que nadie cubre ("le di",
 *    "anoche") hace rebotar;
 *  · una ventana no sigue después de su monto con un separador y más palabras ("cobré 500 y gasté");
 *  · lo repetido de otro movimiento es un prefijo copiado del texto INMEDIATAMENTE anterior (verbo,
 *    fecha, palabras funcionales) o un sufijo del inmediatamente siguiente (sólo fecha). Al parser le
 *    llega la ventana con la fecha prestada y SIN el verbo prestado (`paraParser`);
 *  · cada ventana tiene UN monto: el único que ve el contador fino, o si no ve ninguno, el único que
 *    hay. Si la ventana tiene OTRO número además, no puede haber un corte de cláusula (coma, salto de
 *    línea, "y") en la ventana —serían dos movimientos y el separador y la heurística de "número de
 *    nombre" se equivocan JUNTOS, porque el prompt del separador dice lo mismo que la heurística—, y
 *    ese número se nombra en la confirmación: nunca queda afuera en silencio;
 *  · la moneda pegada al monto en el texto no puede contradecir la del mensaje.
 */
function validarSeparacion(textos, msg) {
  if (!Array.isArray(textos) || !textos.length) return null;
  const M = tokens(msg);
  const tokDe = (m) => M.findIndex((x) => x.start <= m.index && m.index < x.end);
  const amplios = montosDeMovimiento(msg, { soloSeguras: true }).map((m) => ({ ...m, tok: tokDe(m) }));
  const finos = new Set(montosDeMovimiento(msg).map(tokDe));
  const textosTok = textos.map((t) => tokens(t).map((x) => x.t));
  const cubierto = new Array(M.length).fill(false);
  const resultado = [];
  let finAnterior = -1;
  for (let n = 0; n < textos.length; n++) {
    const F = textosTok[n];
    const anterior = n > 0 ? textosTok[n - 1] : null;
    const siguiente = n + 1 < textos.length ? textosTok[n + 1] : null;
    let elegido = null;
    for (let k = 0; k < F.length && !elegido; k++) {
      const P = F.slice(0, k);
      if (P.length && (!anterior || !esPrefijoAceptable(P) || !igualesEn(P, anterior, 0))) continue;
      for (let q = 0; k + q < F.length && !elegido; q++) {
        const Q = F.slice(F.length - q);
        if (Q.length && (!siguiente || !esSufijoAceptable(Q) || !igualesEn(Q, siguiente, siguiente.length - q))) continue;
        const S = F.slice(k, F.length - q);
        for (let j = finAnterior + 1; j + S.length <= M.length && !elegido; j++) {
          if (!igualesEn(S, M, j)) continue;
          const adentro = amplios.filter((a) => a.tok >= j && a.tok < j + S.length);
          const finosAdentro = adentro.filter((a) => finos.has(a.tok));
          // Un número que sólo ve el contador amplio ("alquiler depa 800") vale como monto únicamente
          // si CIERRA su ventana: pegado a una palabra ("Compré 2 pollos" | "a la brasa 70") es una
          // cantidad que un corte forzado convertía en un gasto fantasma (cuarta revisión, 07-oct).
          const soloAmplio = !finosAdentro.length && adentro.length === 1 && adentro[0].tok === j + S.length - 1 ? adentro[0] : null;
          const monto = finosAdentro.length === 1 ? finosAdentro[0] : soloAmplio;
          if (!monto) continue;
          const iMonto = monto.tok - j;
          const despues = S.slice(iMonto + 1);
          if (despues.some((t, i) => SEPARADORES.has(t) && i < despues.length - 1)) continue;
          const otros = adentro.filter((a) => a !== monto);
          if (otros.length && RE_CORTE_DE_CLAUSULA.test(normalizarIgualLargo(msg.slice(M[j].start, M[j + S.length - 1].end)))) continue;
          elegido = { j, len: S.length, monto, otros, prestadoAntes: soloPrestable(P), prestadoDespues: soloPrestable(Q) };
        }
      }
    }
    if (!elegido) return null;
    // La moneda pegada al monto en el texto no puede ser otra que la del mensaje.
    const propio = montosDeMovimiento(textos[n], { soloSeguras: true })
      .find((m) => (m.valor == null ? elegido.monto.valor == null : Math.abs(m.valor - (elegido.monto.valor || 0)) < 0.005));
    if (propio && propio.moneda && propio.moneda !== elegido.monto.moneda) return null;
    for (let i = elegido.j; i < elegido.j + elegido.len; i++) cubierto[i] = true;
    finAnterior = elegido.j + elegido.len - 1;
    // Lo que se le muestra a la persona es su propia ventana; lo que decide el parser es esa ventana
    // con la fecha prestada y SIN el verbo prestado.
    const ventana = msg.slice(M[elegido.j].start, M[elegido.j + elegido.len - 1].end).trim();
    // Una ventana que ya dice su fecha no recibe otra: "ayer gasté 20 en taxi y hoy 30 en cine"
    // partido en "ayer gasté hoy 30 en cine" guardaba el cine ayer (cuarta revisión, 07-oct).
    // "en la noche" a secas NO es fecha propia: es del día que se dijo antes ("ayer almuerzo 15 y en la
    // noche pollo 30"). "esta noche" sí (es hoy).
    const tieneFecha = RE_FECHA_PROPIA.test(ventana);
    const prestado = [...elegido.prestadoAntes, ...elegido.prestadoDespues];
    const paraParser = tieneFecha ? ventana : [...elegido.prestadoAntes, ventana, ...elegido.prestadoDespues].join(' ');
    const recibioFecha = !tieneFecha && prestado.some((t) => !FUNCIONALES_DE_FECHA.has(t));
    resultado.push({ texto: ventana, paraParser, montoMsg: elegido.monto, otros: elegido.otros, sinFecha: !tieneFecha && !recibioFecha });
  }
  // Ninguna palabra fuera de las ventanas salvo separadores. Con esto, ningún monto que el contador
  // fino ve se queda sin dueño: un número fuera de toda ventana no pasa (no es un separador), y uno
  // adentro es el monto de su ventana o la ventana tiene dos y no se eligió.
  if (M.some((x, i) => !cubierto[i] && !SEPARADORES.has(x.t))) return null;
  // La fecha dicha UNA vez (quinta revisión, 07-oct): el separador no siempre la repite ("ayer menú
  // 12, gaseosa 3" → "gaseosa 3", 3 de 3 con el modelo real) y la gaseosa salía con fecha de hoy. Si
  // el mensaje dice UNA sola fecha y la dice ANTES del primer monto, vale para todos y se presta acá,
  // sin depender del modelo. "hoy" y "esta noche" CUENTAN para decidir si fue una sola (sin eso, "ayer
  // menú 12, hoy taxi 5 y gaseosa 3" le prestaba "ayer" a la gaseosa: revisión del arreglo), pero no se
  // prestan: si todas las fechas son de hoy, no hay nada que hacer. Una fecha pegada a un monto ("el 20
  // de luz") no es fecha, y una con "para" delante ("para el sábado") es de otra cosa: no se presta.
  // Con cualquier otra cosa, una ventana sin fecha no se anota: se le pregunta.
  const fechas = [...msg.matchAll(RE_FECHA_EN_MENSAJE)]
    .filter((m) => !amplios.some((a) => a.index < m.index + m[0].length && m.index < a.index + String(a.token).length))
    .map((m) => ({
      index: m.index,
      texto: (/antes\s+de\s+$/i.test(msg.slice(0, m.index)) ? 'antes de ' : '') + m[0].trim(),
      paraOtraCosa: /(?:^|\s)para\s+(?:el\s+|la\s+)?$/i.test(msg.slice(0, m.index)),
    }));
  const esDeHoy = (f) => /^(?:hoy|esta\s+(?:ma[ñn]ana|tarde|noche))$/i.test(f.texto);
  const primerMonto = Math.min(...resultado.map((r) => r.montoMsg.index));
  const prestable = fechas.length === 1 && fechas[0].index < primerMonto && !fechas[0].paraOtraCosa ? fechas[0] : null;
  for (const r of resultado) {
    if (!r.sinFecha || fechas.every(esDeHoy)) continue;
    if (prestable) r.paraParser = prestable.texto + ' ' + r.paraParser;
    else r.fechaDudosa = true;
  }
  return resultado;
}

/**
 * Por qué un movimiento no se puede anotar, o null si se puede. Mismas invariantes y en el mismo
 * orden que el camino de un solo movimiento de `registrar_manual`, más la moneda contra la que está
 * PEGADA al monto en el mensaje original (el fanout viejo fijaba 'PEN' y "$20 en taxi" entraba
 * como S/20).
 */
function motivoDeRechazo(parsed, texto, montoMsg, msg) {
  if (!parsed) return 'error';
  if (parsed.moneda && parsed.moneda !== 'PEN' && parsed.moneda !== 'USD') return 'moneda_no_soportada';
  if (parsed.decision === 'tipo_dudoso') return 'tipo_dudoso';
  if (parsed.decision === 'no_es_movimiento') return 'no_es_movimiento';
  if (!parsed.ok || !parsed.monto || parsed.monto <= 0) return 'sin_monto';
  // El mismo validador que `guardarTransaccion`: un monto que ahí lanza no puede pasar acá y dejar
  // una escritura a medias con "mándamelo de nuevo" que vuelve a fallar.
  if (validarMonto(parsed.monto) === null) return 'monto';
  if (montoMsg.valor != null ? Math.abs(parsed.monto - montoMsg.valor) >= 0.005 : !montoEscritoEnMensaje(parsed.monto, texto)) return 'monto';
  if (tipoContradiceElMensaje(parsed.tipo, texto)) return 'tipo_dudoso';
  // Un pedazo puede perder al separarse la palabra que le daba el signo: la sonda del 07-oct vio
  // "uno de 500 soles en regalos" (de "Registra un ingreso de 200 USD y también uno de 500 soles
  // en regalos") entrar como GASTO en 2 de 3 corridas. Si el mensaje entero nombra un solo
  // sentido, ningún movimiento sale del otro. Con los dos, cada pedazo trae el suyo.
  const sentidos = sentidosDelTexto(msg);
  if (sentidos.ingreso !== sentidos.gasto && parsed.tipo === (sentidos.ingreso ? 'gasto' : 'ingreso')) return 'tipo_dudoso';
  const moneda = parsed.moneda || 'PEN';
  if (montoMsg.moneda && moneda !== montoMsg.moneda) return 'moneda';
  // Sin moneda pegada, dólares sólo si el mensaje los nombra en algún lado.
  if (!montoMsg.moneda && moneda === 'USD' && !/\$|usd|d[oó]lar|verdes/i.test(msg)) return 'moneda';
  return null;
}

/**
 * @returns {Promise<string>} la respuesta para la persona. Marca `ctx.registroMultiple` cuando
 *   resolvió el mensaje entero, para que la continuación multi-intent no lo vuelva a registrar.
 */
async function registrarVariosMovimientos({ msg, montos, usuario, ctx }) {
  const {
    parsearRegistroManual, guardarTransaccion, detectarCategoriaIA, verificarAlertaPresupuesto,
    asegurarCategoriaUsuario, crearSubcategoriaLibreUsuario, fechaHoyPeru, formatFecha,
  } = ctx;
  const parsers = require('../services/parsers');
  // Del ctx si viene (los tests lo inyectan), del módulo si no: así no hay que tocar el ctx de
  // `message-processor`, que se arma una vez por mensaje con todo el resto.
  const separarMovimientos = ctx.separarMovimientos || parsers.separarMovimientos;
  const { COPY_NO_ES_MOVIMIENTO, COPY_MONEDA_NO_SOPORTADA } = require('./intents/transacciones');
  const analytics = require('../lib/analytics');
  // Desde acá el mensaje entero es de este camino, pase lo que pase: la continuación de
  // `message-processor` partiría "gasté 50 en taxi y gasté 30 en cine" y registraría la segunda
  // mitad otra vez.
  ctx.registroMultiple = true;
  const fechaHoy = fechaHoyPeru();
  // Sin los usuarios de prueba: el harness y el qa-agent mandan justo estos mensajes, y contarlos
  // ensucia el número que esto existe para medir (la lección de la tabla `errores`, 13-ago).
  const medir = (resultado, extra) => {
    if (usuario.is_test_user) return;
    analytics.capture(usuario.id, 'wa_multi_movimiento', { resultado, montos: montos.length, ...(extra || {}) });
  };

  const [entero, textos] = await Promise.all([
    parsearRegistroManual(msg, fechaHoy).catch((e) => {
      log.warn({ tag: 'MULTI_MOVIMIENTO', err: e.message }, 'El parser del mensaje entero falló: se decide por partes');
      return null;
    }),
    separarMovimientos(msg).catch((e) => {
      log.warn({ tag: 'MULTI_MOVIMIENTO', err: e.message }, 'No se pudo separar el mensaje');
      return null;
    }),
  ]);

  if (entero && entero.decision === 'no_es_movimiento') {
    log.info({ tag: 'MULTI_MOVIMIENTO', resultado: 'no_es_movimiento', msg: msg.substring(0, 80) }, 'El mensaje entero no es un movimiento');
    medir('no_es_movimiento');
    return COPY_NO_ES_MOVIMIENTO;
  }
  if (entero && entero.moneda && entero.moneda !== 'PEN' && entero.moneda !== 'USD') {
    medir('moneda_no_soportada');
    return COPY_MONEDA_NO_SOPORTADA;
  }

  const separados = Array.isArray(textos) ? textos : [];
  const particion = validarSeparacion(separados, msg);
  if (!particion) {
    // Se nombran los montos que ve el contador fino si son dos o más; si no, los que llegaron acá.
    const finos = montosDeMovimiento(msg);
    const vistos = finos.length >= 2 ? finos : montos;
    log.warn({ tag: 'MULTI_MOVIMIENTO', resultado: 'no_separa', montos: montos.length, textos: separados, msg: msg.substring(0, 120) }, 'La separación no es una partición del mensaje: no se anota ninguno');
    medir('no_separa', { textos: separados.length });
    return 'Vi ' + vistos.length + ' montos en tu mensaje (' + listaMontos(vistos) + ') y no supe separarlos bien, así que no anoté ninguno para que no quede a medias. Mándamelos uno por mensaje, así: "pasajes 2".';
  }
  const asignados = particion.map((p) => p.montoMsg);
  // Los números de una ventana que no son su monto ("Pago 847 de 3 celulares"): se nombran en la
  // confirmación. El separador y la heurística pueden equivocarse juntos, y si era plata la persona
  // tiene que poder verlo.
  // Una CANTIDAD ("2 polos 60", "847 de 3 celulares": entero chico pegado a una palabra que no es
  // moneda) no se nombra: es casi siempre eso, y la nota en cada forma corta era ruido (cuarta
  // revisión). Sí se nombra el número que va DESPUÉS de una palabra ("línea 10", "Julio 50").
  const esCantidad = (o) => /^\d{1,2}$/.test(o.token)
    && /^\s+[a-záéíóúñ]{3,}/i.test(msg.slice(o.index + o.token.length))
    && !/^\s+(?:sol(?:es)?|lucas?|d[oó]lares?|cocos?|mangos?)(?![a-záéíóúñ])/i.test(msg.slice(o.index + o.token.length));
  const ignorados = particion.map((p) => ({ ...p, nombrables: p.otros.filter((o) => !esCantidad(o)) }))
    .filter((p) => p.nombrables.length)
    .map((p) => p.nombrables.map((o) => o.token).join(' y ') + ' de «' + p.texto + '»');

  // Cada movimiento con el parser validado y su categoría, todos a la vez.
  // Lo que decide es `paraParser` (la ventana del mensaje con la fecha prestada y sin el verbo
  // prestado); `texto` es la ventana, que es lo que se le nombra a la persona.
  const items = await Promise.all(particion.map(async ({ texto, paraParser, montoMsg, fechaDudosa }) => {
    const [parsed, detCat] = await Promise.all([
      parsearRegistroManual(paraParser, fechaHoy).catch((e) => {
        log.warn({ tag: 'MULTI_MOVIMIENTO', err: e.message, texto }, 'El parser falló en un movimiento');
        return null;
      }),
      detectarCategoriaIA(paraParser, usuario.id).catch(() => ({ categoria: null })),
    ]);
    return { texto, paraParser, parsed, detCat: detCat || {}, montoMsg, motivo: motivoDeRechazo(parsed, paraParser, montoMsg, msg) || (fechaDudosa ? 'fecha' : null) };
  }));
  // Una ventana SIN verbo de plata propio sigue el tipo del movimiento anterior del mensaje: el parser
  // la lee sola y, sin verbo, la forma corta es gasto. "Me yapearon 50 de la cena y 30 del taxi" o "me
  // reembolsaron clínica 80, farmacia 20" escribían el segundo como GASTO (cuarta y quinta revisión,
  // 07-oct; la segunda con el separador y el parser reales). Se compara contra lo que el parser ya
  // decidió para el anterior, no contra una lista de verbos: "reembolsaron" no está en ninguna. El
  // costo, aceptado: "me pagaron 300, almuerzo 20" pide el verbo en vez de anotarse.
  for (let i = 1; i < items.length; i++) {
    const it = items[i];
    const previo = items[i - 1].parsed;
    if (it.motivo || !it.parsed || !previo || !previo.tipo) continue;
    const propio = sentidosDelTexto(it.texto);
    if (!propio.ingreso && !propio.gasto && it.parsed.tipo !== previo.tipo) it.motivo = 'tipo_dudoso';
  }

  const rechazados = items.filter((it) => it.motivo);
  if (rechazados.length) {
    log.info({ tag: 'MULTI_MOVIMIENTO', resultado: 'rechazo', motivos: rechazados.map((r) => r.motivo), msg: msg.substring(0, 120) }, 'Un movimiento no se puede anotar: no se anota ninguno');
    medir('rechazo', { motivos: rechazados.map((r) => r.motivo) });
    return (asignados.length > 1
      ? 'No anoté ninguno de los ' + asignados.length + ' movimientos de tu mensaje (' + listaMontos(asignados) + '), para que no quede a medias.\n\n'
      : 'No anoté lo de tu mensaje (' + listaMontos(asignados) + ').\n\n')
      + rechazados.map((r) => '• «' + r.texto + '»: ' + MOTIVOS[r.motivo]).join('\n')
      + '\n\nMándamelos uno por mensaje y los anoto.';
  }

  // Todos se pueden anotar. De acá en adelante sólo puede fallar la base, y eso se nombra
  // movimiento por movimiento: no hay forma de deshacer los anteriores sin riesgo (el dedup de
  // `guardarTransaccion` puede devolver una fila que ya existía, y borrarla sería borrar plata
  // que la persona anotó antes).
  const lineas = [];
  const ids = new Set();
  let conteo = 0;
  let txTrial = null;
  let fallidos = 0;
  for (const it of items) {
    const datos = {
      ...it.parsed,
      moneda: it.parsed.moneda || 'PEN',
      fecha: ajustarFechaRegistro(it.paraParser, it.parsed.fecha, fechaHoy),
    };
    if (it.detCat.categoria) {
      datos.categoria = it.detCat.categoria;
      if (it.detCat.subcategoria) datos.subcategoria = it.detCat.subcategoria;
    }
    let tx;
    try {
      if (datos.categoria) {
        const sub = subcategoriaUtil(datos.subcategoria);
        asegurarCategoriaUsuario(usuario.id, datos.categoria)
          .then(() => (sub ? crearSubcategoriaLibreUsuario(usuario.id, datos.categoria, sub) : null))
          .catch(() => {});
      }
      tx = await guardarTransaccion(usuario.id, datos);
    } catch (e) {
      log.error({ tag: 'MULTI_MOVIMIENTO', err: e.message, texto: it.texto }, 'No se pudo guardar un movimiento');
      tx = null;
    }
    if (!tx) {
      fallidos++;
      lineas.push('⚠️ «' + it.texto + '» no lo pude guardar. Mándamelo de nuevo.');
      continue;
    }
    // El dedup de `guardarTransaccion` (mismo día, monto, comercio y tipo en 10 segundos) devuelve
    // la fila anterior: dos movimientos idénticos en un mensaje quedan en UNA fila, y se dice.
    if (tx.id && ids.has(tx.id)) {
      lineas.push('⚠️ «' + it.texto + '» salió igual al anterior y lo anoté una sola vez. Si fueron dos, mándamelo aparte.');
      continue;
    }
    if (tx.id) ids.add(tx.id);
    if (tx.conteoTx) conteo = tx.conteoTx;
    if (tx.trialIniciado) {
      txTrial = tx;
      ctx.trialRecienIniciado = { vence: tx.trialVence || null };
    }
    const esIngreso = datos.tipo === 'ingreso';
    const montoStr = (datos.moneda === 'USD' ? '$' : 'S/') + Number(datos.monto).toFixed(2);
    const cat = tx.categoria || datos.categoria || 'Otros';
    const sub = subcategoriaUtil(tx.subcategoria || datos.subcategoria);
    let linea = '✅ ' + montoStr + ' en ' + (esIngreso ? 'Ingresos' : (sub ? cat + ' > ' + sub : cat)) + ' · ' + formatFecha(datos.fecha);
    if (!esIngreso && datos.categoria) {
      try {
        const alerta = await verificarAlertaPresupuesto(usuario, datos.categoria, datos.subcategoria || null);
        if (alerta) linea += '\n' + alerta;
      } catch (_) { /* la alerta es best-effort */ }
    }
    lineas.push(linea);
  }
  log.info({ tag: 'MULTI_MOVIMIENTO', resultado: fallidos ? 'escritura_parcial' : 'registrado', n: items.length, fallidos }, 'Varios movimientos en un mensaje');
  medir(fallidos ? 'escritura_parcial' : 'registrado', { fallidos });
  let resp = lineas.join('\n');
  if (ignorados.length) {
    resp += '\n\nNo anoté como plata el ' + ignorados.join(', el ') + ': lo leí como parte del detalle. Si era otro gasto, mándamelo aparte.';
  }
  // La cola es cosmética y las filas ya están escritas: si lanza, la persona igual tiene que ver
  // qué se anotó. Un error acá terminaba en el "No pude procesar eso" del catch de
  // `registrar_manual`, y quien reenvía duplica lo que sí entró (revisión adversarial del 07-oct).
  try {
    const nudge = await colaConfirmacionGasto(usuario, txTrial, conteo);
    if (nudge) resp += nudge;
  } catch (e) {
    log.warn({ tag: 'MULTI_MOVIMIENTO', err: e.message }, 'La cola de la confirmación falló; las filas ya estaban escritas');
  }
  return resp;
}

/**
 * ¿El mensaje pide además OTRA operación (editar, borrar)? "gasté 50 en taxi y cambia el de 30 a 40"
 * tiene tres números y uno solo es un gasto nuevo. Ese mensaje no es de este camino: lo resuelve la
 * continuación multi-intent de `message-processor` (registro + `editar_monto`), como antes del
 * 07-oct. Entrar acá apagaba esa continuación y, con un corte forzado, podía escribir "el de 30" y
 * "a 40" como dos gastos (revisión adversarial del 07-oct).
 */
// Sólo la ORDEN: el imperativo al empezar una cláusula y algo que señala un movimiento ("cambia el
// de 30", "borra lo último"). Con la raíz suelta, "el cambio de aceite", "compré borrador" o "por
// corregir el vestido" se iban al camino de uno y perdían el segundo gasto (segunda revisión
// adversarial del 07-oct).
const RE_OTRA_OPERACION = new RegExp([
  // "y cámbiame el de 30", "borra lo último", "porfa elimina el de ayer"
  /(?:^|[,;.]|\by\b|\be\b|\bpero\b|\btambien\b)\s*(?:porfa\s+|por favor\s+)?(?:cambia|corrige|edita|borra|elimina|quita|modifica|actualiza)(?:lo|la|los|las|me)?\s+(?:el|la|lo|los|las|eso|esa|ese|mi|ultimo|ultima|todo)\b/.source,
  /(?:^|[,;.]|\by\b)\s*deshaz/.source,
  // "el de 30 cámbialo a 40": el sujeto primero (tercera revisión adversarial del 07-oct)
  /\b(?:el|la) de \d+[^,.;]*\b(?:cambia|corrige|edita|borra|elimina|quita|modifica|actualiza|pon)(?:lo|la|me)?\b/.source,
].join('|'));
const pideOtraOperacion = (msg) => RE_OTRA_OPERACION.test(normalizarIgualLargo(msg));

module.exports = { registrarVariosMovimientos, ajustarFechaRegistro, validarSeparacion, motivoDeRechazo, pideOtraOperacion };
