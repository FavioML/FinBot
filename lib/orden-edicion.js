// ¿El mensaje ORDENA corregir el último movimiento? (01-oct-2026, chip 5)
//
// El clasificador lee el historial, y detrás de un gasto recién anotado convierte el gasto
// SIGUIENTE en corrección del anterior. Medido contra prod (toda la historia): 12 ediciones por
// WhatsApp, 5 equivocadas, 3 personas en su día 0-2. "aby 143" renombró "traer tronco"; "Aby
// 143" lo volvió a renombrar; "“145 Aby”" le cambió el monto de S/25 a S/145; "Manos libres" (la
// respuesta al cierre del día 2) renombró un ingreso; "lo pagué con la tarjeta de crédito BCP"
// quedó como comercio. Ninguno de esos mensajes pide cambiar nada.
//
// Descartado midiendo con el clasificador real y el historial real (N=3): que gane el parser
// cuando dice `registrar` (cubre 3 de 5 y duplicaba el S/12 de la tarjeta), exigir que el modelo
// nombre el valor viejo (lo rellena desde el historial) y re-clasificar sin historial ("“145 Aby”"
// sigue editando 3 de 3).
//
// CUARTA VERSIÓN, y por qué. La primera buscaba marcas sueltas ("fue", un verbo, un "no"): la
// revisión adversarial le pasó 50 de 51 gastos nuevos. La segunda pedía la forma de la frase pero
// cada forma tenía un hueco abierto (`el \w+`, "en <lo que sea>", `.+` después del verbo) y
// buscaba la fila por nombre con `ilike`. Dos revisiones seguidas con la misma clase: se cambió el
// enfoque (memoria `feedback_tapar_el_caso_regenera_la_clase`) a una gramática CERRADA y un solo
// destino posible, el último, como el borrado del 14-sep. La tercera revisión encontró lo que
// ninguna gramática ve: "es ingreso" o "fueron 110.70" contestando una pregunta de NETO sobre algo
// que NO se guardó ("¿Esos S/35 entraron o salieron?", "No pude leer el monto") pasaban y editaban
// el último guardado, que es otro. Es la misma mecánica que "Manos libres". De ahí la regla 3.
//
// Las reglas:
//  1. Por WhatsApp se corrige SOLO EL ÚLTIMO movimiento. El mensaje no elige otra fila por
//     nombre, fecha ni monto: `revisarEdicion` borra `datos.comercio` y `datos.fecha_token`. Las
//     7 correcciones legítimas de toda la historia fueron sobre el último. (Decisión de Favio,
//     01-oct-2026: corregir otro movimiento se hace en la app.)
//  2. El mensaje entero es una orden de una gramática cerrada (`FORMAS`). EXPLÍCITA: un verbo
//     ("cambia", "corrige", "márcalo", "divídelo") o el campo nombrado ("el monto es", "la fecha
//     es", "el comercio es"), con objeto de lista cerrada y valor con tipo; texto libre solo
//     después de "el comercio/nombre" + conector.
//  3. ELÍPTICA ("eran 30", "30 no 25", "fue ayer", "300 para ser exacto", "es ingreso", "a
//     medias"): solo si lo ÚLTIMO que dijo NETO, hace menos de 30 minutos, fue la confirmación de
//     un movimiento guardado (`CONFIRMA_MOVIMIENTO`). Ahí la elipsis tiene un único antecedente, y
//     es el último. Detrás de una pregunta, un rebote o nada, pide la orden explícita.
//  4. El valor nuevo está escrito en el mensaje, y no negado ("no fue 30" no dice 30).
//  5. Una pregunta no es una orden, salvo "¿puedes…?". Un emoji es un concepto ("fueron 30 🍕").
//
// Lo que no entra, recibe una pregunta con frases EXPLÍCITAS (fijado en el test). Las 8
// correcciones legítimas de prod pasan (las elípticas, detrás de su confirmación). Fuera,
// declarado: `corregir_categoria`, cuya respuesta legítima es una palabra suelta que contesta una
// pregunta de NETO ("gasolina"); ver docs/DEFECTOS.md, 01-oct.

const EDICIONES = new Set([
  'editar_monto', 'editar_fecha', 'editar_comercio', 'corregir_monto_moneda',
  'marcar_como_ingreso', 'dividir_gasto', 'duplicar_gasto',
]);

function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Piezas, todas cerradas ──────────────────────────────────────────────────────────────────
const MESES = '(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';
const DIAS = '(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)';
const MON = '(?:soles|sol|dolares|dolar|lucas|usd|pen)';
const CIFRA = '\\d+(?: \\d+){0,2}';                       // "1,250.50" normalizado es "1 250 50"
const NUM = '(?:s )?' + CIFRA + '(?: ' + MON + ')?';
const VALOR_MON = '(?:' + CIFRA + ' ' + MON + '|s ' + CIFRA + '|' + MON + ')';
// Una fecha que se reconoce sola: palabra de día, "el 15", "15 de marzo", "15/09". Un número
// pelado ("fueron 25") NO: es un monto. Solo detrás de un verbo con conector ("cámbialo al 19").
const FECHA = '(?:hoy|ayer|antier|anteayer|anoche|antes de ayer|la semana pasada'
  + '|(?:el )?' + DIAS + '(?: \\d{1,2})?(?: pasado)?'
  + '|el \\d{1,2}(?: \\d{1,2})?(?: de)?(?: ' + MESES + ')?(?: \\d{4})?'
  + '|\\d{1,2}(?: de)? ' + MESES + '(?: \\d{4})?|\\d{1,2} \\d{1,2}(?: \\d{4})?)';
const FECHA_TRAS_VERBO = '(?:' + FECHA + '|\\d{1,2})';
// Lo que va antes sin cambiar la orden. "ya" NO ("ya son 200" es un total que se va sumando) y
// "no" tampoco ("no fue 30" niega): "no, 30" entra por `PRECISION`.
const P = '(?:si|ok|perdon|disculpa|error|me equivoque|me confundi|esta mal|estaba mal|puse mal|uy|quiero|quisiera|puedes|podrias|porfa|por favor|oye|oe|mejor)';
const PREVIA = '^(?:' + P + ' )*';
const FINAL = '(?: (?:porfa|porfis|por favor|xfa|plis|pls|please|gracias|pe|nomas|bro|jaja|jeje))*$';
// A cuál: SIEMPRE el último, nombrado de forma deíctica. Nunca un nombre.
const OBJ = '(?:lo|eso|esto|ese|esa|este|esta|el ultimo(?: gasto| registro| movimiento| ingreso)?|la ultima(?: compra| transaccion)?'
  + '|lo ultimo|(?:ese|el) (?:gasto|ingreso|registro|movimiento)|el anterior|lo anterior)';
// "la fecha del gasto", "el monto del último": el campo de lo último, nunca "del taxi".
const DEL_ULTIMO = '(?: (?:del|de) (?:gasto|ingreso|registro|movimiento|ultimo(?: gasto)?|anterior))?';
// Imperativo, infinitivo o "cambio el monto a". Nunca la primera persona del pasado ("cambié 100
// dólares" es un gasto). Sin "pon": "pon/ponlo como gasto 30 de luz" son registros. "cambio" solo
// con campo o conector: "cambio 100" puede ser un gasto (cambio de moneda).
const VERBO = '(?:cambia|cambialo|cambiala|cambiale|cambiar|cambiarlo|cambio(?= (?:el|la|su|a|al)\\b)|corrige|corrigelo|corrigela|corregir|corregirlo'
  + '|edita|editalo|editala|editar|modifica|modificalo|modificar|actualiza|actualizalo|actualizar)';
const VERBO_OBJ = VERBO + '(?: ' + OBJ + ')?';
// "monto" e "importe" solamente: "total 120" y "precio 20" son totales o compras, no correcciones.
const CAMPO_MONTO = '(?:monto|importe)';
const COP = '(?:es|son|era|eran|fue|fueron|seria)';
const DEBE = '(?:' + COP + '|debe ser|deberia ser|debe decir|deberia decir)';
const PRECISION = '(?:para ser exact[oa]|en realidad|mejor dicho|quise decir)';
const NUM_PALABRA = '(?:\\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';
const TIPO = '(?:ingreso|gasto)s?';

const re = (s) => new RegExp(s);
// `e`: explícitas, valen siempre. `l`: elípticas, solo detrás de la confirmación (regla 3).
const FORMAS = {
  editar_monto: {
    e: [
      // "cambia el monto a 20", "editar es 15800", "quiero corregir 256.40", "corrige a S/120"
      re(PREVIA + VERBO_OBJ + '(?: (?:el |su )?' + CAMPO_MONTO + DEL_ULTIMO + ')?(?: (?:a|al|por|es|en))? ' + NUM + FINAL),
      // "el monto es 50", "monto: 30", "el monto correcto eran 30 no 25"
      re(PREVIA + '(?:(?:el|su|ese) )?' + CAMPO_MONTO + '(?: correcto| real)?(?: ' + DEBE + ')?(?: de)? ' + NUM + '(?: no ' + NUM + ')?' + FINAL),
      // La orden sin el valor ("corrige el monto"): el handler lo pide. Un valor que el modelo
      // trajo del historial lo frena `valorNoDicho`.
      re(PREVIA + VERBO_OBJ + '(?: (?:el |su )?' + CAMPO_MONTO + DEL_ULTIMO + ')?' + FINAL),
    ],
    l: [
      // "eran 30", "eso fue 30", "no era 25, era 30", "30 no 25", "300 para ser exacto", "no, 30"
      re(PREVIA + '(?:' + OBJ + ' )?' + COP + ' ' + NUM + '(?: no (?:' + COP + ' )?' + NUM + ')?' + FINAL),
      re(PREVIA + '(?:' + COP + ' )?' + NUM + ' no (?:' + COP + ' )?' + NUM + FINAL),
      re(PREVIA + '(?:no )?' + COP + ' ' + NUM + ' ' + COP + ' ' + NUM + FINAL),
      re(PREVIA + '(?:' + PRECISION + '|no) (?:' + COP + ' )?' + NUM + FINAL),
      re(PREVIA + '(?:' + COP + ' )?' + NUM + ' ' + PRECISION + FINAL),
    ],
  },
  editar_fecha: {
    e: [
      // "cámbialo al 19 de septiembre", "cambiar fecha 29 septiembre", "cambia la fecha a ayer"
      re(PREVIA + VERBO_OBJ + '(?: (?:la |su )?fecha' + DEL_ULTIMO + ')?(?: (?:a|al|para|por|es|en|del))? ' + FECHA_TRAS_VERBO + FINAL),
      // "esa fecha es de 19 setiembre", "la fecha es ayer"
      re(PREVIA + '(?:(?:la|esa|su) )?fecha(?: correcta| real)?(?: ' + DEBE + ')?(?: (?:de|el))? ' + FECHA + FINAL),
      re(PREVIA + VERBO_OBJ + '(?: (?:la |su )?fecha' + DEL_ULTIMO + ')?' + FINAL),
    ],
    l: [
      // "fue ayer", "ese gasto fue el viernes", "fue ayer no hoy", "ayer no hoy"
      re(PREVIA + '(?:' + OBJ + ' )?' + COP + '(?: (?:de|del))? ' + FECHA + '(?: no (?:' + COP + ' )?' + FECHA + ')?' + FINAL),
      re(PREVIA + FECHA + ' no (?:' + COP + ' )?' + FECHA + FINAL),
    ],
  },
  editar_comercio: {
    e: [
      // Texto libre SOLO después del campo y su conector: "cambia el comercio a Plaza Vea".
      // "corregir nombre en reniec 20" o "cambia el nombre de los tacos a…" no tienen conector ahí.
      re(PREVIA + VERBO_OBJ + ' (?:el |su )?(?:comercio|nombre)' + DEL_ULTIMO + ' (?:a|al|por|es) [a-z0-9].*$'),
      // "el comercio es Bembos pe", "el nombre debería decir China Wok"
      // Solo "es / debería ser": el texto que sigue es libre, y "el nombre era muy largo" describe.
      re(PREVIA + '(?:(?:el|su) )?(?:comercio|nombre)(?: correcto| real)? (?:es|debe ser|deberia ser|debe decir|deberia decir)(?: (?:de|en))? [a-z0-9].*$'),
      // "ponle de nombre Wong", "ponle como comercio Pardos Chicken"
      re(PREVIA + '(?:ponle|ponlo) (?:de|como) (?:comercio|nombre) [a-z0-9].*$'),
      re(PREVIA + VERBO_OBJ + '(?: (?:el |su )?(?:comercio|nombre))?' + FINAL),
    ],
    l: [],
  },
  corregir_monto_moneda: {
    e: [
      // "cambia eso a dólares (no soles)", "cámbialo a 25 dólares"
      re(PREVIA + VERBO_OBJ + '(?: (?:la |su )?moneda)? (?:a|en|por) ' + VALOR_MON + '(?: no (?:en )?' + VALOR_MON + ')?' + FINAL),
      re(PREVIA + '(?:la )?moneda (?:' + DEBE + ' )?(?:en )?' + MON + FINAL),
    ],
    l: [
      // "son 25 dólares", "el último fueron 200 dólares no soles", "era en dólares", "en dólares"
      re(PREVIA + '(?:' + OBJ + ' )?' + COP + '(?: en)? ' + VALOR_MON + '(?: no (?:' + COP + ' )?(?:en )?' + VALOR_MON + ')?' + FINAL),
      re(PREVIA + '(?:en )?' + MON + '(?: no (?:en )?' + MON + ')?' + FINAL),
    ],
  },
  marcar_como_ingreso: {
    e: [
      // "márcalo como ingreso", "cámbialo a ingreso pe", "marca el último como ingreso"
      re(PREVIA + '(?:marca|marcalo|marcala|marcar|cambialo|cambiala|cambia|pasalo|pasala|ponlo|ponla)(?: ' + OBJ + ')?(?: (?:como|a|en))?(?: (?:un|una))? ' + TIPO + '(?: no (?:un |una )?' + TIPO + ')?' + FINAL),
    ],
    l: [
      // "es ingreso", "ese era ingreso no gasto", "eso no es gasto, es ingreso", "no es gasto"
      re(PREVIA + '(?:' + OBJ + ' )?' + COP + '(?: (?:un|una))? ' + TIPO + '(?: no (?:un |una )?' + TIPO + ')?(?: (?:cambialo|marcalo))?' + FINAL),
      re(PREVIA + '(?:' + OBJ + ' )?no ' + COP + '(?: (?:un|una))? ' + TIPO + '(?: ' + COP + '(?: (?:un|una))? ' + TIPO + ')?' + FINAL),
    ],
  },
  dividir_gasto: {
    e: [
      // "divídelo entre 3", "divide ese gasto entre tres personas", "divídelo a medias"
      re(PREVIA + '(?:divide|dividelo|dividela|dividir|dividirlo|partelo|partela|parte|partir|partirlo)(?: ' + OBJ + ')?(?: (?:entre|en))? '
        + NUM_PALABRA + '(?: (?:personas|partes))?(?: ' + OBJ + ')?' + FINAL),
      re(PREVIA + '(?:divide|dividelo|dividela|partelo|partela)(?: ' + OBJ + ')? (?:a medias|a la mitad|por la mitad|en dos)' + FINAL),
      // "divídelo entre Juan y yo": nombres, que `valorNoDicho` compara contra `shared_with`.
      re(PREVIA + '(?:divide|dividelo|dividela|partelo|partela)(?: ' + OBJ + ')? (?:entre|con) [a-z]+(?:(?: y|,)? [a-z]+){0,4}' + FINAL),
    ],
    l: [
      re(PREVIA + '(?:a medias|a la mitad|por la mitad|entre ' + NUM_PALABRA + ')' + FINAL),
    ],
  },
  duplicar_gasto: {
    e: [
      // "duplícalo", "repítelo", "duplica el último gasto", "copia ese gasto", "repítelo para ayer".
      // "repite"/"copia" a secas NO: "repite por favor" pide repetir el mensaje. Ni "de/del" +
      // fecha: "copia de ayer" nombra el ORIGEN, y acá el origen es siempre el último.
      re(PREVIA + '(?:duplica|duplicar|repite|repetir|copia)(?: ' + OBJ + ')(?: para ' + FECHA + ')?' + FINAL),
      re(PREVIA + '(?:duplicalo|duplicala|repitelo|repitela|copialo|copiala)(?: para ' + FECHA + ')?' + FINAL),
      re(PREVIA + '(?:haz|hazme) (?:un )?duplicado(?: (?:de|del) ' + OBJ + ')?' + FINAL),
    ],
    l: [],
  },
};

// Un emoji es un concepto ("fueron 30 🍕") y `normalizar` lo borraría.
const PICTOGRAMA = /\p{Extended_Pictographic}/u;

function tieneForma(intencion, msg, { elipticas = true } = {}) {
  const f = FORMAS[intencion];
  if (!f || PICTOGRAMA.test(String(msg || ''))) return false;
  const t = normalizar(msg);
  return f.e.some((r) => r.test(t)) || (elipticas && f.l.some((r) => r.test(t)));
}
function esExplicita(intencion, msg) {
  return tieneForma(intencion, msg, { elipticas: false });
}

// ── Regla 3: ¿lo último que dijo NETO fue la confirmación de un movimiento guardado? ─────────
// Los formatos son los de handlers/intents/transacciones.js: el registro ("✅ S/10.00 en …",
// "✅ $5.00 en …") y las ediciones. NO cuentan las confirmaciones de deudas, metas o presupuestos:
// detrás de "✅ *Abono registrado*", "eran 30" editaría la última TRANSACCIÓN, que es otra cosa.
const CONFIRMA_MOVIMIENTO = /^(?:✅ (?:S\/ ?|\$|US\$ ?)\d|✅ (?:Monto corregido|Fecha corregida|Comercio corregido|Gasto dividido|Gasto duplicado)|✅ \*[^*\n]+\* \([^)\n]*\) ahora está marcado como|Corregido\. \*)/;
const VENTANA_MS = 30 * 60 * 1000;
function confirmacionReciente(historial, ahora = Date.now()) {
  if (!Array.isArray(historial) || historial.length === 0) return false;
  const ultimoNeto = [...historial].reverse().find((h) => h && h.rol === 'neto');
  if (!ultimoNeto || !CONFIRMA_MOVIMIENTO.test(String(ultimoNeto.mensaje || '').trim())) return false;
  const t = Date.parse(ultimoNeto.created_at);
  return Number.isFinite(t) && ahora - t >= 0 && ahora - t <= VENTANA_MS;
}

// ── Lo dicho ────────────────────────────────────────────────────────────────────────────────
// Los números AFIRMADOS del mensaje. "30 no 25" afirma 30; "no fue 30" no afirma nada; "no, 30"
// (con coma) sí afirma 30. "1,500" y "1.500" son mil quinientos (tres cifras tras el separador),
// pero también se admite la lectura cruda (uno con cinco): vale cualquiera de las dos.
const RE_NEGADO = /(?:^|\s)no\s+(?:(?:es|son|era|eran|fue|fueron)\s+)?(?:s\/\s*)?$/;
function numerosDe(msg) {
  const crudo = String(msg || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const out = [];
  const re = /-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|-?\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(crudo))) {
    if (RE_NEGADO.test(crudo.slice(Math.max(0, m.index - 24), m.index))) continue;
    const n = m[0];
    if (/^-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(n)) {
      const dec = /[.,](\d{1,2})$/.exec(n);
      const ent = (dec ? n.slice(0, -dec[0].length) : n).replace(/[.,]/g, '');
      out.push(parseFloat(ent + (dec ? '.' + dec[1] : '')));
    }
    out.push(parseFloat(n.replace(',', '.')));
  }
  return out;
}
function numeroDicho(msg, valor) {
  const v = parseFloat(valor);
  return Number.isFinite(v) && numerosDe(msg).some((n) => Math.abs(n - v) < 0.005 || Math.abs(Math.abs(n) - v) < 0.005);
}
const esNumeroFinito = (v) => Number.isFinite(parseFloat(v));
function textoDicho(msg, valor) {
  const v = normalizar(valor);
  return v.length >= 2 && (' ' + normalizar(msg) + ' ').includes(' ' + v + ' ');
}
const RE_FECHA_DICHA = new RegExp('(?:^| )(?:hoy|ayer|antier|anteayer|anoche|semana|mes|' + DIAS.slice(3, -1) + '|' + MESES.slice(3, -1) + ')(?: |$)|\\d');
const PALABRAS_NUM = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };

/** El valor NUEVO que escribiría el handler, ¿está en el mensaje? Devuelve el campo que falta o null. */
function valorNoDicho(intencion, msg, datos) {
  const t = normalizar(msg);
  switch (intencion) {
    case 'editar_monto':
      // Un monto que ni es un número finito lo rechaza `validarMonto` en el handler, sin escribir.
      return datos.monto_nuevo != null && esNumeroFinito(datos.monto_nuevo) && !numeroDicho(msg, datos.monto_nuevo) ? 'monto_nuevo' : null;
    case 'editar_fecha':
      return datos.fecha_nueva && !RE_FECHA_DICHA.test(t) ? 'fecha_nueva' : null;
    case 'editar_comercio':
      return datos.comercio_nuevo && !textoDicho(msg, datos.comercio_nuevo) ? 'comercio_nuevo' : null;
    case 'corregir_monto_moneda': {
      // Sin moneda en `datos`, el handler escribe USD: el mensaje tiene que decir dólares.
      const usd = /(?:^| )(?:dolar|dolares|usd)(?: |$)/.test(t) || /\$/.test(String(msg || ''));
      const pen = /(?:^| )(?:sol|soles|pen|s)(?: |$)/.test(t);
      return ((datos.moneda || 'USD') === 'USD' ? !usd : !pen) ? 'moneda' : null;
    }
    case 'marcar_como_ingreso': {
      // Vale el tipo afirmado: "es ingreso no gasto" → ingreso. Si solo hay uno negado ("no es
      // gasto"), vale el otro.
      const sinNegados = t.replace(/(?:^| )no (?:es |era |fue )?(?:un |una )?(?:ingreso|gasto)s?(?= |$)/g, '');
      const afirmado = /(?:^| )(ingreso|gasto)s?(?: |$)/.exec(sinNegados);
      const negado = /(?:^| )no (?:es |era |fue )?(?:un |una )?(ingreso|gasto)/.exec(t);
      const dicho = afirmado ? afirmado[1] : negado ? (negado[1] === 'gasto' ? 'ingreso' : 'gasto') : null;
      return dicho !== (datos.tipo_nuevo || 'ingreso') ? 'tipo_nuevo' : null;
    }
    case 'dividir_gasto': {
      const nombres = Array.isArray(datos.shared_with) && datos.shared_with.length > 0;
      if (nombres && !datos.shared_with.every((n) => textoDicho(msg, n))) return 'shared_with';
      if (datos.partes == null) return null;
      const p = parseInt(datos.partes, 10);
      // "entre Ana y yo" son dos partes: las personas nombradas más quien escribe.
      const dicho = numeroDicho(msg, p) || Object.entries(PALABRAS_NUM).some(([w, n]) => n === p && textoDicho(msg, w))
        || (p === 2 && /(?:^| )(?:medias|mitad)(?: |$)/.test(t))
        || (nombres && p === datos.shared_with.length + 1);
      return dicho ? null : 'partes';
    }
    case 'duplicar_gasto':
      return datos.fecha && !RE_FECHA_DICHA.test(t) ? 'fecha' : null;
    default:
      return null;
  }
}

// Una pregunta no es una orden ("el monto fue 50?"), salvo el pedido cortés ("¿puedes cambiar el
// monto a 30?"), que tiene que ABRIR el mensaje. Mismo criterio que el bloqueo de borrados.
function esPreguntaNoPedido(msg) {
  return /[?¿]/.test(String(msg || '')) && !/^(?:me )?(?:puedes|podrias|puede|podria)\b/.test(normalizar(msg));
}

/**
 * Decide si una corrección del último movimiento se ejecuta.
 * @param {{ historial?: Array<{rol:string, mensaje:string, created_at:string}>, ahora?: number }} [contexto]
 *   La ventana de conversación (`ctx.historialConv`). Sin ella, solo valen las formas explícitas.
 * @returns {{ ok: true, datos: object } | { ok: false, motivo: 'pregunta'|'sin_orden'|'eliptica_sin_confirmacion'|'valor_no_dicho', campo?: string }}
 *   Con `ok`, `datos` es una copia SIN lo que elige otra fila (`comercio`, `fecha_token`): el
 *   handler va siempre al último. En la moneda, un monto finito que el mensaje no dice se descarta
 *   y se conserva el de la fila.
 */
function revisarEdicion(intencion, msg, datos = {}, { historial = [], ahora = Date.now() } = {}) {
  if (!EDICIONES.has(intencion)) return { ok: true, datos };
  if (esPreguntaNoPedido(msg)) return { ok: false, motivo: 'pregunta' };
  if (!esExplicita(intencion, msg)) {
    if (!tieneForma(intencion, msg)) return { ok: false, motivo: 'sin_orden' };
    if (!confirmacionReciente(historial, ahora)) return { ok: false, motivo: 'eliptica_sin_confirmacion' };
  }
  const campo = valorNoDicho(intencion, msg, datos);
  if (campo) return { ok: false, motivo: 'valor_no_dicho', campo };
  const limpios = { ...datos };
  delete limpios.comercio;
  delete limpios.fecha_token;
  if (intencion === 'corregir_monto_moneda' && limpios.monto != null && esNumeroFinito(limpios.monto) && !numeroDicho(msg, limpios.monto)) delete limpios.monto;
  return { ok: true, datos: limpios };
}

// Sin estado y sin "sí", por lo mismo que el borrado (`pedirOrdenDeBorrado`): cada salida es una
// frase EXPLÍCITA, que vale sin mirar la conversación (fijado en el test).
const EJEMPLO_NUEVO = '• Si es nuevo, escríbelo con el verbo: _"gasté 20 en almuerzo"_.';
const SOLO_EL_ULTIMO = '\n\n_Por WhatsApp corrijo solo lo último que anotaste._';
const PEDIR_ORDEN = {
  _cambio: '¿Es algo nuevo para anotar, o quieres corregir lo último que anoté?\n\n' + EJEMPLO_NUEVO + '\n'
    + '• Si es una corrección, dime qué cambio y a qué: _"cambia el monto a 20"_, _"el comercio es Wong"_ o _"cambia la fecha a ayer"_.' + SOLO_EL_ULTIMO,
  marcar_como_ingreso: '¿Es algo nuevo para anotar, o quieres cambiar el tipo de lo último que anoté?\n\n' + EJEMPLO_NUEVO + '\n'
    + '• Si lo anoté mal, escribe _"márcalo como ingreso"_ o _"márcalo como gasto"_.' + SOLO_EL_ULTIMO,
  dividir_gasto: '¿Es algo nuevo para anotar, o quieres dividir lo último que anoté?\n\n' + EJEMPLO_NUEVO + '\n'
    + '• Para dividir el último, escribe _"divídelo entre 2"_.' + SOLO_EL_ULTIMO,
  duplicar_gasto: '¿Es algo nuevo para anotar, o quieres repetir lo último que anoté?\n\n' + EJEMPLO_NUEVO + '\n'
    + '• Para repetir el último, escribe _"duplícalo"_.' + SOLO_EL_ULTIMO,
};
function pedirOrden(intencion) {
  return PEDIR_ORDEN[intencion] || PEDIR_ORDEN._cambio;
}

module.exports = {
  EDICIONES, revisarEdicion, tieneForma, esExplicita, valorNoDicho, confirmacionReciente, CONFIRMA_MOVIMIENTO,
  pedirOrden, PEDIR_ORDEN, normalizar, numerosDe,
};
