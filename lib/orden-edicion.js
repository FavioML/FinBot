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

const { sumarDias, esFechaReal } = require('./dates');

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
// El cambio de tipo con el monto nombrado ("cambia 9.60 de ingreso como gasto"). Sin "pon": "pon 30 de
// luz como gasto" es un registro.
const VERBO_TIPO_CON_MONTO = '(?:cambia|cambialo|cambiar|cambiarlo|corrige|corrigelo|corregir|corregirlo|marca|marcalo|marcar|marcarlo|pasa|pasalo|pasar|pasarlo)';
// "monto" e "importe" solamente: "total 120" y "precio 20" son totales o compras, no correcciones.
const CAMPO_MONTO = '(?:monto|importe)';
const COP = '(?:es|son|era|eran|fue|fueron|seria)';
const DEBE = '(?:' + COP + '|debe ser|deberia ser|debe decir|deberia decir)';
const PRECISION = '(?:para ser exact[oa]|en realidad|mejor dicho|quise decir)';
const NUM_PALABRA = '(?:\\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';
const TIPO = '(?:ingreso|gasto)s?';

const re = (s) => new RegExp(s);
// `e`: explícitas, valen siempre. `l`: elípticas, solo detrás de la confirmación (regla 3).
const OBJ_DUP = OBJ.replace('|el anterior|lo anterior', '');
if (OBJ_DUP === OBJ) throw new Error('OBJ cambió: revisar OBJ_DUP');

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
      // "márcalo como ingreso", "cámbialo a ingreso pe", "marca el último como ingreso". Con el verbo sin
      // pronombre ("cambia", "marca", "pasar") el conector es OBLIGATORIO: en "quiero cambiar ingreso" o
      // "marca ingreso" el tipo es el OBJETO, no el destino (revisión adversarial del 24-nov).
      re(PREVIA + '(?:marcalo|marcala|marcarlo|marcarla|cambialo|cambiala|cambiarlo|pasalo|pasala|pasarlo|ponlo|ponla|consideralo|considerala)(?: ' + OBJ + ')?(?: (?:como|a|en))?(?: (?:un|una))? ' + TIPO + '(?: no (?:un |una )?' + TIPO + ')?' + FINAL),
      re(PREVIA + '(?:marca|marcar|cambia|cambiar|pasa|pasar)(?: ' + OBJ + ')? (?:como|a|en)(?: (?:un|una))? ' + TIPO + '(?: no (?:un |una )?' + TIPO + ')?' + FINAL),
      // "Corregir como gasto", "Corregir es gasto", "corrígelo: es un ingreso" (ec843051, 16 y
      // 17-nov-2026). Con "corregir" el conector es OBLIGATORIO: "corregir gasto" a secas puede pedir
      // corregir el monto del gasto, no su tipo.
      re(PREVIA + '(?:corrige|corrigelo|corrigela|corregir|corregirlo|corregirla)(?: ' + OBJ + ')? (?:como|a|en|es|era|fue|por)(?: (?:un|una))? ' + TIPO + '(?: no (?:un |una )?' + TIPO + ')?' + FINAL),
      // "Cambia 9.60 de ingreso como gasto", "Cambiar los 9.60 de estacionamiento como gasto". El monto
      // (y hasta tres palabras después de "de") NO elige otra fila (regla 1): el handler los compara con
      // el último, y si no es ese no escribe (`selectorDeTipo`).
      re(PREVIA + VERBO_TIPO_CON_MONTO + '(?: (?:los|las|el|la|lo))? ' + NUM + '(?: de [a-z]+(?: [a-z]+){0,2})? (?:como|a|en|por|es)(?: (?:un|una))? ' + TIPO + FINAL),
    ],
    l: [
      // "es ingreso", "ese era ingreso no gasto", "eso no es gasto, es ingreso", "no es gasto"
      re(PREVIA + '(?:' + OBJ + ' )?' + COP + '(?: (?:un|una))? ' + TIPO + '(?: no (?:un |una )?' + TIPO + ')?(?: (?:cambialo|marcalo|corrige|corrigelo|corregir))?' + FINAL),
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
  // "el anterior" / "lo anterior" NO, sólo acá: al duplicar lo más probable es que nombre el PENÚLTIMO, y
  // el handler copia siempre el último (revisión adversarial del 24-nov, con el reencaminamiento forzándolo).
  duplicar_gasto: {
    e: [
      // "duplícalo", "repítelo", "duplica el último gasto", "copia ese gasto", "repítelo para ayer".
      // "repite"/"copia" a secas NO: "repite por favor" pide repetir el mensaje. Ni "de/del" +
      // fecha: "copia de ayer" nombra el ORIGEN, y acá el origen es siempre el último.
      re(PREVIA + '(?:duplica|duplicar|repite|repetir|copia)(?: ' + OBJ_DUP + ')(?: para ' + FECHA + ')?' + FINAL),
      re(PREVIA + '(?:duplicalo|duplicala|repitelo|repitela|copialo|copiala)(?: para ' + FECHA + ')?' + FINAL),
      re(PREVIA + '(?:haz|hazme) (?:un )?duplicado(?: (?:de|del) ' + OBJ_DUP + ')?' + FINAL),
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
// La captura ("📸 *Gasto registrado*") cuenta desde el 24-nov-2026: hasta ese día su confirmación no
// quedaba en `conversaciones` (handlers/webhook.js la guarda ahora), y "es un ingreso" detrás de una
// captura nunca pasaba esta regla, que es justo donde más se pide.
const CONFIRMA_MOVIMIENTO = /^(?:✅ (?:S\/ ?|\$|US\$ ?)\d|✅ (?:Monto corregido|Fecha corregida|Comercio corregido|Gasto dividido|Gasto duplicado)|✅ \*[^*\n]+\* \([^)\n]*\) ahora está marcado como|Corregido\. \*|📸 \*(?:Gasto|Ingreso) registrado\*)/;
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

/**
 * El tipo al que el mensaje manda el último movimiento: 'gasto', 'ingreso' o null.
 * Vale el ÚLTIMO tipo afirmado, porque en toda forma de la gramática el destino va al final y lo que
 * va antes es el origen: "cambia 9.60 DE INGRESO como GASTO", "corrige EL INGRESO como GASTO", "ese
 * GASTO es INGRESO". Lo negado no cuenta ("es ingreso no gasto"); si solo hay uno negado ("no es
 * gasto"), vale el otro.
 */
function tipoDicho(msg) {
  const t = normalizar(msg);
  // Las mismas cópulas que la gramática (`COP`): con solo "es/era/fue", "no son gastos" salía gasto.
  const NEG = '(?:^| )no (?:' + COP + ' )?(?:un |una )?(ingreso|gasto)s?';
  const afirmados = [...t.replace(new RegExp(NEG + '(?= |$)', 'g'), ' ').matchAll(/(?:^| )(ingreso|gasto)s?(?= |$)/g)].map((m) => m[1]);
  if (afirmados.length) return afirmados[afirmados.length - 1];
  const negado = new RegExp(NEG).exec(t);
  return negado ? (negado[1] === 'gasto' ? 'ingreso' : 'gasto') : null;
}

// "Cambia 9.60 de ingreso como gasto": el monto y las palabras tras "de" NOMBRAN el movimiento. No eligen
// fila (regla 1): el handler los compara con el último y, si no es ese, no escribe.
const RE_SELECTOR_TIPO = new RegExp('^(?:' + P + ' )*' + VERBO_TIPO_CON_MONTO + '(?: (?:los|las|el|la|lo))? ' + NUM
  + '(?: de ([a-z]+(?: [a-z]+){0,2}))? (?:como|a|en|por|es)(?: (?:un|una))? ' + TIPO);
function selectorDeTipo(msg) {
  const m = RE_SELECTOR_TIPO.exec(normalizar(msg));
  if (!m) return null;
  const palabras = (m[1] || '').split(' ').filter((w) => w && !/^(?:un|una|ingresos?|gastos?)$/.test(w));
  return { montos: numerosDe(msg), palabras };
}

/** ¿El movimiento `tx` es el que nombra el selector? Monto exacto al centavo y cada palabra en su nombre. */
function selectorCoincide(selector, tx) {
  if (!selector) return true;
  const monto = parseFloat(tx && tx.monto);
  if (!selector.montos.some((n) => Math.abs(Math.abs(n) - monto) < 0.005)) return false;
  const nombre = ' ' + normalizar([tx.comercio, tx.categoria, tx.subcategoria].filter(Boolean).join(' ')) + ' ';
  return selector.palabras.every((w) => nombre.includes(w));
}

/**
 * Una corrección ELÍPTICA va a lo último que NETO confirmó. Si el último movimiento no es ese (llegaron
 * varias capturas a la vez, o el barrido de Gmail anotó algo en el medio), el monto de la confirmación
 * no es el suyo, y no se escribe.
 */
function confirmacionNombra(historial, tx) {
  if (!Array.isArray(historial) || !tx) return false;
  const ultimoNeto = [...historial].reverse().find((h) => h && h.rol === 'neto');
  const monto = parseFloat(tx.monto);
  if (!ultimoNeto || !Number.isFinite(monto)) return false;
  // Solo el cuerpo de la confirmación: la cola ("Van *S/137.50* este mes", el nudge) trae otros montos.
  // La captura lleva el monto en su segundo párrafo; el resto, en el primero.
  const parrafos = String(ultimoNeto.mensaje || '').split(/\n\s*\n/);
  const cuerpo = parrafos.slice(0, /^📸/.test(parrafos[0] || '') ? 2 : 1).join('\n');
  // "✅ Fecha corregida" y "✅ Comercio corregido" no muestran monto: lo que corrigieron ES el último.
  if (!/\d[.,]\d{2}(?!\d)/.test(cuerpo)) return true;
  // Con borde de número: "S/ 15.59" no contiene al 5.59.
  return new RegExp('(?<![\\d.,])' + monto.toFixed(2).replace('.', '[.,]') + '(?!\\d)').test(cuerpo);
}

/**
 * ¿Lo último que dijo NETO (hace menos de 30 min) es una pregunta sobre algo que NO guardó? ("¿Esos S/35
 * entraron o salieron?", "No anoté nada todavía: … ¿deuda o gasto?"). Detrás de eso, "márcalo como gasto"
 * contesta esa pregunta y no habla del último movimiento guardado (revisión adversarial del 24-nov: es la
 * clase "Manos libres" de la regla 3, con una forma explícita). La pregunta fija de esta misma puerta
 * (`PEDIR_ORDEN`) no cuenta: ella pide justamente esta orden.
 */
function netoPreguntaPendiente(historial, ahora = Date.now()) {
  if (!Array.isArray(historial) || historial.length === 0) return false;
  const ultimoNeto = [...historial].reverse().find((h) => h && h.rol === 'neto');
  if (!ultimoNeto) return false;
  const t = Date.parse(ultimoNeto.created_at);
  if (!Number.isFinite(t) || ahora - t < 0 || ahora - t > VENTANA_MS) return false;
  const m = String(ultimoNeto.mensaje || '').trim();
  if (CONFIRMA_MOVIMIENTO.test(m) || Object.values(PEDIR_ORDEN).some((p) => m.startsWith(p.slice(0, 40)))) return false;
  // Sin los links: el de activación lleva "?t=".
  return /[?¿]/.test(m.replace(/https?:\/\/\S+/g, '')) || /^(?:No anoté|Eso no lo anoté|No pude leer)/.test(m);
}

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
    case 'marcar_como_ingreso':
      // El tipo nuevo lo dice SOLO el mensaje (`tipoDicho`); el de `datos` no se mira. La tool del
      // clasificador nunca trajo `tipo_nuevo`, así que hasta el 24-nov-2026 esto comparaba contra el
      // default 'ingreso' y "márcalo como gasto" —el ejemplo que da la propia pregunta— no pasaba nunca.
      return tipoDicho(msg) ? null : 'tipo_nuevo';
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
 * @returns {{ ok: true, datos: object } | { ok: false, motivo: 'pregunta'|'sin_orden'|'eliptica_sin_confirmacion'|'valor_no_dicho'|'pregunta_pendiente', campo?: string }}
 *   Con `ok`, `datos` es una copia SIN lo que elige otra fila (`comercio`, `fecha_token`): el
 *   handler va siempre al último. En la moneda, un monto finito que el mensaje no dice se descarta
 *   y se conserva el de la fila.
 */
function revisarEdicion(intencion, msg, datos = {}, { historial = [], ahora = Date.now() } = {}) {
  if (!EDICIONES.has(intencion)) return { ok: true, datos };
  if (esPreguntaNoPedido(msg)) return { ok: false, motivo: 'pregunta' };
  const eliptica = !esExplicita(intencion, msg);
  if (eliptica) {
    if (!tieneForma(intencion, msg)) return { ok: false, motivo: 'sin_orden' };
    if (!confirmacionReciente(historial, ahora)) return { ok: false, motivo: 'eliptica_sin_confirmacion' };
  }
  const campo = valorNoDicho(intencion, msg, datos);
  if (campo) return { ok: false, motivo: 'valor_no_dicho', campo };
  const limpios = { ...datos };
  delete limpios.comercio;
  delete limpios.fecha_token;
  if (intencion === 'corregir_monto_moneda' && limpios.monto != null && esNumeroFinito(limpios.monto) && !numeroDicho(msg, limpios.monto)) delete limpios.monto;
  if (intencion === 'marcar_como_ingreso') {
    // Lo que escribe el handler sale del texto, nunca del clasificador.
    limpios.tipo_nuevo = tipoDicho(msg);
    const selector = selectorDeTipo(msg);
    if (selector) limpios.selector = selector; else delete limpios.selector;
    // Sin monto que nombre la fila, detrás de una pregunta de NETO sobre algo no guardado la orden
    // contesta esa pregunta. Con monto, lo frena el handler si no es el último.
    if (!selector && netoPreguntaPendiente(historial, ahora)) return { ok: false, motivo: 'pregunta_pendiente' };
  }
  return { ok: true, datos: limpios, eliptica };
}

/**
 * ¿El mensaje entero es una orden de cambiar el TIPO del último movimiento? Lo usa `dispatchIntent` para
 * mandarlo a `marcar_como_ingreso` diga lo que diga el clasificador (24-nov-2026): "Corregir es gasto"
 * terminó en `registrar_deuda` ("¿Con quién es?") y "Corregir como gasto" en `editar_monto`. Es seguro
 * porque la gramática es cerrada: un mensaje que la cumple no trae monto nuevo, comercio ni persona, así
 * que ningún otro intent tiene con qué escribir. Las elípticas ("es gasto"), solo detrás de la
 * confirmación de un movimiento (regla 3), igual que en `revisarEdicion`.
 */
function esOrdenDeTipo(msg, historial = [], ahora = Date.now()) {
  if (esPreguntaNoPedido(msg) || !tipoDicho(msg)) return false;
  if (!selectorDeTipo(msg) && netoPreguntaPendiente(historial, ahora)) return false;
  if (esExplicita('marcar_como_ingreso', msg)) return true;
  return tieneForma('marcar_como_ingreso', msg) && confirmacionReciente(historial, ahora);
}

// ── La fecha de la COPIA la dice el texto (24-nov-2026) ─────────────────────────────────────
// "duplícalo para el 15/10" duplicaba con la fecha de HOY: el clasificador no manda la fecha de la copia
// (qa-e2e/probe-editar-fecha.mjs --duplicar, 0 de 12 y después 0 de 16, las dos el 24-nov). Y la gramática de
// `duplicar_gasto` ya fija cómo se escribe: "para" + `FECHA`, al final. Así que la fecha se lee de ahí,
// como el tipo en `tipoDicho`, y el modelo deja de importar. Tocar la descripción de `nueva_fecha` en
// NETO_TOOLS subía, en el mejor caso, la tasa de un campo que igual traía el año inventado (2023), y
// cambiaba el prompt de todos los intents.
//
// Devuelve:
//   · undefined — el mensaje no dice para cuándo (la copia va con la de hoy);
//   · null      — lo dice pero no da un día pasado ("para la semana pasada", "para el 31 de febrero", una
//     fecha futura, "el lunes 15" si el 15 no es lunes): se pregunta;
//   · 'YYYY-MM-DD' — la fecha. Con el año no dicho, la última vez que pasó (ver abajo). El handler la
//     pasa igual por `fechaDeLaOrden`, la cadena de `editar_fecha`.
// Un número sin mes ("para el 30") es la última vez que pasó ese día: este mes si ya pasó, si no el
// anterior. Un día de la semana sin número, el último que pasó ANTES de hoy (como `resolverDiaSemanaPasado`).
const DOW = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const MES_NUM = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const RE_PARA = new RegExp(' para (.+?)' + FINAL);
const RE_DIA_SEMANA = new RegExp('^(?:el )?(' + DIAS.slice(3, -1) + ')(?: (\\d{1,2}))?(?: pasado)?$');
const RE_DIA_MES = new RegExp('^(?:el )?(\\d{1,2})(?: (\\d{1,2}))?(?: de)?(?: (' + MESES.slice(3, -1) + '))?(?: (\\d{4}))?$');
const iso = (a, m, d) => a + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
function ultimaVezDelDia(dia, hoy) {
  const [a, m] = hoy.split('-').map(Number);
  const este = iso(a, m, dia);
  if (esFechaReal(este) && este <= hoy) return este;
  const anterior = m === 1 ? iso(a - 1, 12, dia) : iso(a, m - 1, dia);
  return esFechaReal(anterior) ? anterior : null;
}
function fechaDeLaCopia(msg, hoy) {
  if (!esFechaReal(hoy)) return null;
  const para = RE_PARA.exec(normalizar(msg));
  if (!para) return undefined;
  const f = para[1];
  if (f === 'hoy') return hoy;
  if (f === 'ayer' || f === 'anoche') return sumarDias(hoy, -1);
  if (f === 'antier' || f === 'anteayer' || f === 'antes de ayer') return sumarDias(hoy, -2);
  const s = RE_DIA_SEMANA.exec(f);
  if (s) {
    if (s[2]) {
      // "el lunes 16": el número manda, pero si ese día no es lunes no se adivina cuál de los dos vale.
      const f = ultimaVezDelDia(Number(s[2]), hoy);
      if (!f) return null;
      const [fa, fm, fd] = f.split('-').map(Number);
      return new Date(Date.UTC(fa, fm - 1, fd)).getUTCDay() === DOW[s[1]] ? f : null;
    }
    const [a, m, d] = hoy.split('-').map(Number);
    let atras = new Date(Date.UTC(a, m - 1, d)).getUTCDay() - DOW[s[1]];
    if (atras <= 0) atras += 7;
    return sumarDias(hoy, -atras);
  }
  const n = RE_DIA_MES.exec(f);
  if (!n) return null;
  const [, d, mNum, mTxt, anio] = n;
  if (mNum && mTxt) return null;
  if (!mNum && !mTxt) return anio ? null : ultimaVezDelDia(Number(d), hoy);
  const mes = mNum ? Number(mNum) : MES_NUM[mTxt];
  // Con el año dicho tampoco se escribe una copia FUTURA: "15/10/2062" es un typo de 2026, y la fila
  // desaparecería de toda consulta (revisión adversarial del 24-nov).
  if (anio) { const f = iso(anio, mes, Number(d)); return esFechaReal(f) && f <= hoy ? f : null; }
  // Sin año, la última vez que pasó: este año, o el anterior a menos de 120 días (la ventana de
  // `anclarAnioDeEdicion`). Si no, null y se pregunta: "el 15 de octubre" visto el 5 de abril puede ser el
  // de hace 172 días o el que viene, y NADIE dijo cuál. Se resuelve acá y no en `fechaDeLaOrden`, que con
  // un año de hoy lo tomaría como dicho por el modelo y dejaría pasar la fecha futura (revisión del 24-nov).
  const anioHoy = Number(hoy.slice(0, 4));
  const este = iso(anioHoy, mes, Number(d));
  if (esFechaReal(este) && este <= hoy) return este;
  const anterior = iso(anioHoy - 1, mes, Number(d));
  const dias = (Date.UTC(...hoy.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) - Date.UTC(anioHoy - 1, mes - 1, Number(d))) / 86400000;
  return esFechaReal(anterior) && dias <= 120 ? anterior : null;
}

/**
 * ¿El mensaje entero es una orden de DUPLICAR el último? Lo usa `dispatchIntent`, como `esOrdenDeTipo`:
 * "repítelo para el 15 de octubre" llegaba como `editar_fecha` en frío (4 de 4, 24-nov), que la gramática
 * de editar rechaza, y detrás de una confirmación como `registrar_manual` con el monto del historial (4 de
 * 4). Es seguro por lo mismo: la gramática es cerrada y no trae monto, comercio ni persona. "repítelo" o
 * "repite eso" SIN fecha quedan afuera: pueden pedir que NETO repita lo que dijo.
 */
function esOrdenDeDuplicar(msg) {
  if (esPreguntaNoPedido(msg) || !esExplicita('duplicar_gasto', msg)) return false;
  const t = normalizar(msg);
  return RE_PARA.test(t) || !/(?:^| )(?:repite|repetir|repitelo|repitela)(?: |$)/.test(t);
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
  tipoDicho, selectorDeTipo, selectorCoincide, confirmacionNombra, esOrdenDeTipo, netoPreguntaPendiente,
  fechaDeLaCopia, esOrdenDeDuplicar,
};
