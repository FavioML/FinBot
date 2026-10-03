// ¿Qué fila nombra la persona? (02-oct-2026)
//
// La guarda de `lib/datos-dichos.js` responde si el dato salió del mensaje. Esta responde la otra
// pregunta, la que esa guarda declara fuera de su alcance: dado un nombre que la persona SÍ dijo,
// ¿a qué fila apunta? Hasta hoy cada handler lo resolvía a su manera y todos fallaban igual:
//
//  - un nombre que no coincidía con nada caía a "la más reciente": "elimina la meta moto", con
//    Laptop y Viaje Cusco, borraba Laptop; "recupera el gasto de la pizza" restauraba otro;
//  - la búsqueda era por SUBCADENA (`includes`, `ilike '%x%'`): "salda todo con Luis" saldaba
//    también a Luisa, y la regla "lina" se retroaplicaba a "gasolina" y "medicina catalina"
//    (medido en prod: 153 de 926 reglas alcanzan otro comercio por subcadena).
//
// LA REGLA, decidida por Favio el 02-oct-2026:
//
//  1. Primero la coincidencia EXACTA (sin mayúsculas, tildes, espacios ni puntuación).
//  2. Si no hay exacta, por PALABRA ENTERA: todas las palabras clave del nombre dicho, con o sin la
//     "s" final. "Luis" no es "Luisa", "lina" no es "gasolina", "uber" sí es "Uber Eats".
//  3. Un solo NOMBRE coincide → ese. Si ese nombre tiene varias filas, decide la política de cada
//     handler (la más reciente, o todas en "salda todo"): eso es otra pregunta.
//  4. Varios nombres distintos coinciden → se pregunta, listándolos. Nunca se elige uno.
//  5. Ninguno coincide → no se escribe nada y se dice qué hay. Nunca se cae a la más reciente.
//  6. Sin nombre: con una sola fila, esa; con varias, se pregunta. Las excepciones ("restaura",
//     "corrige el último") las decide su handler, porque por definición apuntan a lo último.
//
// Las operaciones EN LOTE (retroaplicar una regla pedida con "siempre") usan `filasQueNombra`, que
// devuelve el conjunto de los pasos 1 y 2 sin preguntar: "todo lo de pedidosya" quiere sus variantes.

const { normalizar } = require('./orden-edicion');
const { textoDicho, palabrasClave, VACIAS } = require('./datos-dichos');

/**
 * Las palabras del nombre dicho que nombran CUÁL: sin las del dominio ni las vacías ("la meta viaje"
 * → "viaje", "la meta" → ""). Las cortas que no son vacías se quedan: "Bo" es un nombre.
 */
function sinPalabrasDelDominio(dicho, ignorar) {
  const ign = ignorar || new Set();
  return normalizar(dicho).split(' ').filter((p) => p && !ign.has(p) && !VACIAS.has(p)).join(' ');
}

/** ¿La fila se llama exactamente así? Con el nombre entero o sin las palabras del dominio. */
function esExacta(nombreFila, dicho, limpio) {
  const n = normalizar(nombreFila);
  return n.length > 0 && (n === normalizar(dicho) || n === limpio);
}

/** ¿Todas las palabras clave del nombre dicho están, enteras, en el nombre de la fila? */
function esPorPalabra(nombreFila, limpio) {
  return limpio.length > 0 && textoDicho(limpio, nombreFila, { todas: true });
}

/** Agrupa por nombre normalizado, en el orden de `filas` (el llamador ordena por recencia). */
function agrupar(filas, nombreDe) {
  const grupos = new Map();
  for (const f of filas) {
    const k = normalizar(nombreDe(f));
    if (!grupos.has(k)) grupos.set(k, { nombre: String(nombreDe(f) || '').trim(), filas: [] });
    grupos.get(k).filas.push(f);
  }
  return [...grupos.values()];
}

/**
 * Resuelve un nombre dicho contra las filas candidatas.
 *
 * @param {string|null} dicho     el nombre que la persona dijo (o el selector que el modelo extrajo y
 *                                la guarda de datos-dichos ya verificó contra el mensaje)
 * @param {object[]}   filas      las candidatas, ORDENADAS como el handler quiera elegir dentro de un
 *                                mismo nombre (normalmente, la más reciente primero)
 * @param {object}     opciones   `nombreDe(fila)` y `ignorar` (Set de palabras del dominio)
 * @returns {{ estado: 'uno', nombre: string, filas: object[] }
 *          | { estado: 'varios', nombres: string[] }
 *          | { estado: 'ninguno', disponibles: string[] }
 *          | { estado: 'sin_nombre', filas: object[] }}
 */
function resolverNombre(dicho, filas, { nombreDe, ignorar } = {}) {
  const lista = filas || [];
  const limpio = sinPalabrasDelDominio(dicho, ignorar);
  const exactas = dicho ? lista.filter((f) => esExacta(nombreDe(f), dicho, limpio)) : [];
  if (!dicho || (normalizar(dicho) === '') || (limpio === '' && exactas.length === 0)) {
    return { estado: 'sin_nombre', filas: lista };
  }
  const elegidas = exactas.length > 0 ? exactas : lista.filter((f) => esPorPalabra(nombreDe(f), limpio));
  const grupos = agrupar(elegidas, nombreDe);
  if (grupos.length === 1) return { estado: 'uno', nombre: grupos[0].nombre, filas: grupos[0].filas };
  if (grupos.length > 1) return { estado: 'varios', nombres: grupos.map((g) => g.nombre) };
  return { estado: 'ninguno', disponibles: agrupar(lista, nombreDe).map((g) => g.nombre).filter(Boolean) };
}

/**
 * Para operaciones en LOTE: todas las filas que el nombre dicho alcanza por los pasos 1 y 2 (exacta
 * o por palabra entera). Nunca por subcadena. Sin palabras clave, solo las exactas.
 */
function filasQueNombra(dicho, filas, { nombreDe, ignorar } = {}) {
  if (!dicho || normalizar(dicho) === '') return [];
  const limpio = sinPalabrasDelDominio(dicho, ignorar);
  return (filas || []).filter((f) => esExacta(nombreDe(f), dicho, limpio) || esPorPalabra(nombreDe(f), limpio));
}

/**
 * Los nombres que comparten ALGUNA palabra clave con lo dicho: para ofrecer "¿te refieres a X?"
 * cuando no hubo coincidencia. Solo se ofrecen; nunca se escribe sobre ellos.
 */
function nombresParecidos(dicho, filas, { nombreDe, ignorar } = {}) {
  const claves = palabrasClave(sinPalabrasDelDominio(dicho, ignorar));
  if (claves.length === 0) return [];
  const parecidas = (filas || []).filter((f) => claves.some((c) => textoDicho(c, nombreDe(f))));
  return agrupar(parecidas, nombreDe).map((g) => g.nombre).filter(Boolean);
}

// Las vocales y la ñ con sus variantes, para que el filtro del servidor no dependa de las tildes:
// `ilike` y `~*` de Postgres distinguen "cafe" de "café". La decisión la toma `resolverNombre` en JS.
const CLASES = { a: '[aáàâä]', e: '[eéèêë]', i: '[iíìîï]', o: '[oóòôö]', u: '[uúùûü]', n: '[nñ]' };

/**
 * Un patrón AMPLIO para pedirle al servidor solo las filas que pueden coincidir: la palabra clave
 * más larga, sin la "s" final, sin tildes, como regex POSIX para `.filter(col, 'imatch', patron)`.
 * Es un superconjunto a propósito (subcadena): lo que elige es `resolverNombre`. Nunca `ilike`,
 * que en PostgREST convierte `*` en `%` del lado del servidor (memoria feedback_ilike_no_es_match_exacto).
 * Devuelve null si lo dicho no tiene letras ni dígitos.
 */
function patronAmplio(dicho, ignorar) {
  const limpio = sinPalabrasDelDominio(dicho, ignorar);
  const claves = palabrasClave(limpio);
  let base = claves.length > 0 ? claves.reduce((a, b) => (b.length > a.length ? b : a)) : limpio.split(' ').reduce((a, b) => (b.length > a.length ? b : a), '');
  if (!base) return null;
  if (base.length > 3 && base.endsWith('s')) base = base.slice(0, -1);
  // `normalizar` deja solo [a-z0-9 ]: nada que escapar en la regex.
  return base.split('').map((c) => CLASES[c] || c).join('');
}

/** "*A*", "*A* y *B*", "*A*, *B* y *C*" (con tope). */
function listaNombres(nombres, tope = 6) {
  const n = (nombres || []).filter(Boolean);
  const vistos = n.slice(0, tope).map((x) => '*' + x + '*');
  const resto = n.length - vistos.length;
  if (resto > 0) vistos.push(resto + ' más');
  if (vistos.length <= 1) return vistos.join('');
  return vistos.slice(0, -1).join(', ') + ' y ' + vistos[vistos.length - 1];
}

/**
 * El texto para cuando el nombre no resolvió a una fila. `ninguna` es la frase de "no encontré"
 * ("ninguna meta"), `cosas` el plural ("metas"), `ejemplo(nombre)` una orden que se pueda copiar.
 */
function mensajeNoResuelto(r, { ninguna, cosas, dicho, ejemplo, nombreDe }) {
  const ej = (nombre) => (ejemplo && nombre ? '\n\n_Por ejemplo: "' + ejemplo(nombre) + '"_' : '');
  if (r.estado === 'varios') {
    return 'Tienes varias ' + cosas + ' que coinciden con *' + dicho + '*: ' + listaNombres(r.nombres)
      + '. ¿Cuál? Dime el nombre completo.' + ej(r.nombres[0]);
  }
  if (r.estado === 'ninguno') {
    // Sin ejemplo a propósito: con el nombre de OTRA fila puesto, "elimina la meta Laptop" es una
    // orden destructiva lista para copiar sobre algo que la persona no pidió.
    return 'No encontré ' + ninguna + ' *' + dicho + '*, así que no cambié nada.'
      + (r.disponibles.length ? ' Tienes: ' + listaNombres(r.disponibles) + '.' : '');
  }
  // `sin_nombre` con varias filas: se pregunta cuál.
  const nombres = agrupar(r.filas, nombreDe).map((g) => g.nombre).filter(Boolean);
  return '¿Cuál de tus ' + cosas + '? Tienes ' + listaNombres(nombres) + '. Dime su nombre.' + ej(nombres[0]);
}

// Las palabras que nombran el TIPO de cosa y no cuál: "la meta viaje" es la meta Viaje. Un nombre
// hecho solo de éstas ("elimina la meta") cuenta como sin nombre.
const PALABRAS_DEL_DOMINIO = Object.freeze({
  meta: new Set(['meta', 'metas', 'plan', 'planes', 'ahorro', 'ahorros', 'objetivo', 'objetivos']),
  espacio: new Set(['espacio', 'espacios', 'grupo', 'grupos']),
  presupuesto: new Set(['presupuesto', 'presupuestos', 'limite', 'limites', 'tope', 'topes', 'categoria']),
});

module.exports = {
  PALABRAS_DEL_DOMINIO, resolverNombre, filasQueNombra, nombresParecidos, patronAmplio, listaNombres, mensajeNoResuelto,
};
