// ¿Qué pide un mensaje que llegó a `corregir_categoria`? (08-oct-2026, ítem 45 y DEFECTOS L736(2))
//
// Casos de producción (usuario Pro, 25 y 27-sep), con el clasificador leyendo el historial:
//   "si pero 11.40 a Salud"        → movió BOTICAS Y SALUD (S/ 15.00). El de 11.40 era otro gasto, y
//                                    BOTICAS salió "dicho" porque su nombre tiene la palabra "Salud",
//                                    que era el DESTINO.
//   "y lo de IKF 38 SANTA ANITA 1 ?" → una pregunta; volvió a mover BOTICAS.
//   "a que te refieres con los 15 soles en boticas y salud?" → una pregunta; movió IKF al no haber
//                                    comercio dicho (cae al último), guardó la regla y la retroaplicó
//                                    a los 9 gastos de IKF.
//   "No" (13-ago, otra persona)    → re-movió un taxi a Salud con regla y retroaplicación.
//
// `corregir_categoria` quedó fuera de `lib/orden-edicion.js` a propósito: su respuesta legítima es
// una palabra suelta que contesta una pregunta de NETO ("gasolina"). Por eso acá NO se exige una
// gramática cerrada; se responden cuatro preguntas más chicas, todas sobre el mensaje:
//
//  1. ¿Es una pregunta? Entonces no escribe: contesta dónde está el gasto. Un "?" en cualquier parte
//     (salvo el pedido cortés que ABRE el mensaje, "¿puedes moverlo a salud?") o una apertura
//     interrogativa sin signo ("a que te refieres", "por que", "y lo de X" sin destino).
//  2. ¿Es una respuesta pelada ("no", "sí", "ok")? Tampoco escribe: no trae a dónde ni qué.
//  3. ¿El comercio está dicho FUERA del destino? "Salud" no nombra a "BOTICAS Y SALUD" cuando es la
//     categoría a la que se mueve.
//  4. ¿Qué montos dice? Un monto escrito elige la fila (si dos empatan, se pregunta); dos montos son
//     dos correcciones y van a `corregir_multiple`.

const { normalizar } = require('./orden-edicion');
const { textoDicho, palabrasClave, montoDicho } = require('./datos-dichos');

// Abreviaturas de WhatsApp que esconden un interrogativo ("q paso", "xq lo moviste").
const ABREVIATURAS = { q: 'que', k: 'que', xq: 'por que', pq: 'por que', porq: 'por que', xk: 'por que' };
const expandir = (msg) => normalizar(msg).split(' ').map((p) => ABREVIATURAS[p] || p).join(' ');
const sinPalabras = (texto, de) => {
  const fuera = new Set(normalizar(de || '').split(' ').filter(Boolean));
  return texto.split(' ').filter((p) => p && !fuera.has(p)).join(' ');
};

// Aperturas interrogativas que en WhatsApp se escriben sin "?".
const ABRE_PREGUNTA = /^(?:(?:y|e|pero|oye|neto|osea|o sea|entonces) )?(?:a que te refieres|a que se refiere|que (?:quieres decir|quisiste decir|significa|es|son|fue|fueron|paso|pasa|hay|onda)|por que|cual|cuales|cuanto|cuanta|donde|cuando|como asi|como que|en que|seguro que|osea (?:lo|la|me lo|me la) (?:moviste|pasaste|pusiste|cambiaste))(?: |$)/;
// "y lo de X", "y el X", "y lo del X": la continuación sin destino es una pregunta ("¿y eso?"). Con
// destino ("y el de 11.40 a salud") es una orden. El destino se busca SIN el nombre del comercio:
// "y lo de pollos a la brasa" no tiene destino, tiene un "a" en el nombre.
const Y_EL_DE = /^(?:y|e|pero) (?:lo|el|la|los|las)(?: (?:de|del))? (.+)$/;
const DESTINO = /(?:^| )(?:a|al|en|va|van|ira|es|era|eran|son|fue|fueron|pon\w*|mueve\w*|muevelo|pasa\w*|cambia\w*|corrig\w*)(?: |$)/;
// Con "?" se escribe SOLO si el mensaje ABRE con una orden de mover y dice a dónde: "pasalo a salud?",
// "¿me lo pasas a salud?", "oye puedes mover el ikf a salud?". Gramática cerrada a propósito: la
// segunda revisión del 08-oct encontró que una lista abierta de palabras de pedido ("porfa", "puedes",
// "pasas" en cualquier lugar) dejaba escribir a "por favor dime si lo pasaste a salud?", "puedes
// decirme si el ikf esta en salud?" y "me pasas la lista de lo que hay en salud?", con regla. Es la
// misma decisión que `lib/orden-edicion.js` tomó para las ediciones (memoria
// `feedback_tapar_el_caso_regenera_la_clase`).
const MOVER = '(?:pasa|mueve|pon|cambia|corrige|manda|mete)(?:lo|la|los|las)';
const MOVER_INF = '(?:pasar|mover|poner|cambiar|corregir|mandar|meter)(?:lo|la|los|las)?';
const ORDEN_CON_PREGUNTA = new RegExp('^(?:(?:oye|neto|porfa|por favor|y) )*(?:'
  + MOVER
  + '|(?:me |se )?(?:lo|la|los|las) (?:pasas|mueves|pones|cambias|corriges|mandas)'
  + '|(?:me |se )?(?:lo |la |los |las )?(?:puedes|podrias) ' + MOVER_INF
  + ')(?: |$)');
const A_DONDE = /(?:^| )(?:a|al|en|como)(?: |$)/;
// "pasalo a salud o a comida?" ofrece dos destinos: es una pregunta.
const DOS_DESTINOS = /(?:^| )o (?:a|al|en|como) /;

// Un verbo de mover en PASADO de segunda persona habla de lo que hizo NETO, no ordena: "lo pasaste a
// salud", "ya lo moviste a salud", "todavia esta en comida, no lo pasaste a salud" (tercera revisión).
// Costo aceptado: "lo pusiste en comida, es salud" también pregunta en vez de mover.
const PASADO_DE_NETO = /(?:^| )(?:pasaste|moviste|pusiste|cambiaste|corregiste|mandaste|metiste|anotaste|registraste|clasificaste)(?: |$)/;

/** 1. El mensaje pregunta y no ordena. `comercio` es el que trae el modelo, para leer el destino sin él. */
function esPreguntaSinOrden(msg, comercio = null) {
  const t = expandir(msg);
  if (ABRE_PREGUNTA.test(t) || PASADO_DE_NETO.test(t)) return true;
  const y = Y_EL_DE.exec(t);
  if (y && !DESTINO.test(sinPalabras(y[1], comercio))) return true;
  if (/[?¿]/.test(String(msg || ''))) return !(ORDEN_CON_PREGUNTA.test(t) && A_DONDE.test(sinPalabras(t, comercio)) && !DOS_DESTINOS.test(t));
  return false;
}

// Palabras que no traen ni un gasto ni una categoría. Se comparan también con las letras repetidas
// colapsadas ("nooo", "siii").
const PELADAS = new Set([
  'no', 'si', 'ok', 'okey', 'oki', 'okay', 'ya', 'nop', 'nope', 'claro', 'dale', 'listo', 'gracias', 'muchas',
  'bueno', 'eso', 'esto', 'es', 'asi', 'correcto', 'perfecto', 'exacto', 'tampoco', 'nada', 'mal', 'bien',
  'pero', 'y', 'entonces', 'osea', 'o', 'sea', 'ah', 'aja', 'mmm', 'hm', 'jaja', 'jajaja', 'jeje', 'que', 'tal', 'vez',
  'igual', 'mejor', 'nunca', 'siempre', 'ese', 'esa', 'era', 'eh', 'pe', 'pues', 'neto', 'vale', 'genial', 'chevere',
  'bacan', 'oh', 'uy', 'entendido', 'todo',
]);
// Solo corridas de tres o más: con dos, "perro" colapsaba a "pero" y "Esso" a "eso".
const colapsar = (p) => p.replace(/(.)\1{2,}/g, '$1');
/** 2. "No", "ya pe", "nooo", "👍": nada que mover ni a dónde. Un mensaje sin ninguna palabra también. */
function esRespuestaPelada(msg) {
  const palabras = normalizar(msg).split(' ').filter(Boolean);
  return palabras.every((p) => PELADAS.has(p) || PELADAS.has(colapsar(p)));
}

/**
 * 3. ¿El comercio está dicho sin contar las palabras del DESTINO? `textoDicho` basta con UNA palabra
 * clave, así que "si pero 11.40 a Salud" nombraba a "BOTICAS Y SALUD" por la categoría, y "eso va en
 * farmacia" a "Farmacia Universal" por la subcategoría.
 *
 * Las palabras del destino (categoría y subcategoría) se quitan solo DESPUÉS del primer marcador de
 * destino ("a", "en", "va", "era", "es", "como"…). Antes del marcador son el sujeto: "el taxi era
 * transporte" con subcategoría Taxi sigue nombrando al taxi (quitarlas en cualquier lugar hacía caer
 * esa frase al último gasto, primera revisión del 08-oct). Sin ningún marcador ("salud", "farmacia",
 * "salud pe": la respuesta a "¿A qué categoría muevo X?") todo el mensaje es destino y se quitan en
 * cualquier lugar: "salud" con BOTICAS Y SALUD del historial movía BOTICAS (tercera revisión).
 */
const VACIAS_DESTINO = new Set(['de', 'del', 'la', 'el', 'lo', 'los', 'las']);
const MARCADOR = new Set(['a', 'al', 'en', 'va', 'van', 'es', 'era', 'eran', 'son', 'fue', 'fueron', 'como', 'para']);
function comercioDichoFueraDelDestino(comercio, msg, destinos = []) {
  if (!comercio) return false;
  // `destinos` es [categoría, subcategoría]: se separan porque sin marcador importa cuál aparece.
  const palabrasDe = (d) => {
    const out = new Set();
    for (const p of palabrasClave(d || '')) { const base = p.endsWith('s') ? p.slice(0, -1) : p; out.add(base); out.add(base + 's'); }
    return out;
  };
  const [categoria, ...subs] = [].concat(destinos);
  const deCategoria = palabrasDe(categoria);
  const deSub = new Set(subs.flatMap((d) => [...palabrasDe(d)]));
  const quitar = new Set([...deCategoria, ...deSub]);
  const palabras = normalizar(msg).split(' ').filter(Boolean);
  const desde = palabras.findIndex((p) => MARCADOR.has(p));
  // Sin marcador, solo si el mensaje ENTERO es destino (o relleno): "salud", "farmacia", "mejor salud".
  // Con la subcategoría Y la categoría a la vez ("el taxi, transporte" con sub Taxi, "farmacia salud"),
  // la primera es el sujeto y nombra al comercio, como antes del 08-oct (cuarta revisión).
  const nombraAmbas = palabras.some((p) => deSub.has(p) && !deCategoria.has(p)) && palabras.some((p) => deCategoria.has(p));
  const todoDestino = desde < 0 && !nombraAmbas && palabras.every((p) => quitar.has(p) || PELADAS.has(p) || VACIAS_DESTINO.has(p));
  const resto = desde < 0 ? (todoDestino ? [] : palabras) : palabras.filter((p, i) => i <= desde || !quitar.has(p));
  return textoDicho(comercio, resto.join(' '));
}

// Un monto escrito sin ambigüedad: con céntimos ("11.40", "8,50", "11.4"), o pegado a la moneda ("S/ 15",
// "15 soles", "15 lucas"). Un entero pelado no cuenta: puede ser parte del comercio ("IKF 38") o una
// fecha ("el 15"). Los bordes no aceptan una cifra pegada ni un separador SEGUIDO de cifra
// ("1,234.50"), pero sí la puntuación de la frase ("el de 11.40, a salud").
// Con separador de miles ("S/ 1,234.50") no se lee nada: decide el monto del modelo. Sin el borde, el
// grupo de "s/" leía S/ 1.23.
const RE_MONTO = /(?:s\/\.?\s*(\d{1,6}(?:[.,]\d{1,2})?)(?!\d|[.,]\d))|(?:(?<!\d|\d[.,])(\d{1,6}[.,]\d{1,2})(?!\d|[.,]\d))|(?:(?<!\d|\d[.,])(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:soles|sol|lucas|luquitas|pen)\b)/gi;
// "del 15.09", "el día 15.10": una fecha con punto, no un monto.
const ANTES_DE_FECHA = /(?:^|\s)(?:del|dia|día)\s*$/i;
/** 4a. Los montos distintos escritos en el mensaje, en centavos enteros → soles. */
function montosEnMensaje(msg) {
  const texto = String(msg || '');
  const vistos = new Set();
  for (const m of texto.matchAll(RE_MONTO)) {
    if (m[2] && ANTES_DE_FECHA.test(texto.slice(0, m.index))) continue;
    const crudo = (m[1] || m[2] || m[3]).replace(',', '.');
    const v = Math.round(Number(crudo) * 100);
    if (Number.isFinite(v) && v > 0) vistos.add(v);
  }
  return [...vistos].map((c) => c / 100);
}

/**
 * 4b. El monto que el modelo extrajo, si está escrito y no es un número del nombre del comercio
 * ("IKF 38": el 38 no es un monto). `lib/datos-dichos.js` ya descartó el que vino del historial.
 */
function montoDelModelo(monto, msg, comercio) {
  if (monto === undefined || monto === null || monto === '') return null;
  const v = Number(String(monto).replace(/^s\/\.?\s*/i, '').replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0 || !montoDicho(v, msg)) return null;
  if (comercio && normalizar(comercio).split(' ').includes(String(v))) return null;
  // "lo de ikf 38 era salud" con el comercio "IKF": el número va pegado a una palabra del comercio.
  const palabras = normalizar(msg).split(' ');
  const delComercio = new Set(normalizar(comercio || '').split(' ').filter(Boolean));
  if (palabras.some((p, i) => p === String(v) && i > 0 && delComercio.has(palabras[i - 1]))) return null;
  return Math.round(v * 100) / 100;
}

/**
 * 4c. ¿Hay un monto NEGADO cerca? "no el de 11.40 no, el de 15", "ese de 11.40 no, el otro": el monto
 * escrito es justo el que la persona rechaza, y elegía esa fila (tercera revisión).
 */
function montoNegado(msg) {
  const t = String(msg || '').toLowerCase();
  // Solo el monto seguido de "no" y una pausa: "11.40 no, …". Un "no" antes de la cifra ("no, el de
  // 11.40 va en salud", "no sé, el de 11.40…") y "otra vez" son correcciones claras (cuarta revisión),
  // y "15 no es comida, es salud" niega la categoría, no el monto.
  return /\d\S*\s+(?:\S+\s+)?no(?:\s*[,.;!]|\s*$|\s+(?:el|la|ese|esa)(?:\s|$))/.test(t);
}


// Una fecha NUMÉRICA dicha elige un gasto ("el ikf del 15.09", "el de 15 de setiembre"), y esta rama no
// sabe buscar por fecha: caía al más reciente del comercio con regla. No escribe; contesta. Solo las
// numéricas: "hoy", "ayer" o un día de la semana describen tanto un gasto como un ALCANCE ("de hoy en
// adelante lo de rappi va en delivery", "lo pido todos los viernes"), y delegarlas se comía la regla
// pedida (tercera revisión). Esas siguen como antes del 08-oct.
const RE_FECHA = /\b\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b|\b(?:del|dia)\s*\d{1,2}[./-]\d{1,2}\b/;
/** 4d. ¿El mensaje nombra el día del gasto con números? */
function diceFecha(msg) {
  return RE_FECHA.test(String(msg || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

module.exports = { diceFecha, montoNegado, esPreguntaSinOrden, esRespuestaPelada, comercioDichoFueraDelDestino, montosEnMensaje, montoDelModelo };
