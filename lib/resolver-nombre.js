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
//  1. La coincidencia EXACTA (sin mayúsculas, tildes, espacios ni puntuación) cuenta, pero SIN
//     prioridad: desde la cuarta vuelta, "uber" con Uber y Uber Eats pregunta.
//  2. Y por PALABRA ENTERA: todas las palabras del nombre dicho, iguales, también las
//     cortas. "Luis" no es "Luisa", "lina" no es "gasolina", "Carlos M" no es "Carlos R", "Lucas" no
//     es "Luca"; "uber" sí es "Uber Eats".
//  3. Un solo NOMBRE coincide → ese. Si ese nombre tiene varias filas, decide cada handler: las
//     deudas con la misma persona son de ella (la más reciente, o todas en "salda todo"); dos
//     espacios o dos miembros que se llaman igual son entidades distintas y se pregunta.
//  4. Varios nombres distintos coinciden → se pregunta, listándolos. Nunca se elige uno.
//  5. Ninguno coincide → no se escribe nada y se dice qué hay. Nunca se cae a la más reciente.
//  6. Sin nombre: con una sola fila, esa; con varias, se pregunta. Las excepciones ("restaura",
//     "corrige el último") las decide su handler, porque por definición apuntan a lo último.
//
// Las operaciones EN LOTE (retroaplicar una regla pedida con "siempre") usan `filasQueNombra`, que
// devuelve el conjunto de los pasos 1 y 2 sin preguntar: "todo lo de pedidosya" quiere sus variantes.

const { normalizar: normalizarTexto } = require('./orden-edicion');

// Los apóstrofes se van ANTES de normalizar: "McDonald's" es "mcdonalds", no "mcdonald s" (en
// WhatsApp casi nadie escribe el apóstrofe; revisión de 3cd1ba1).
const normalizar = (t) => normalizarTexto(String(t == null ? '' : t).replace(/['’´`]/g, ''));
const { textoDicho, palabrasClave, VACIAS } = require('./datos-dichos');

// Artículos al inicio de un comercio o de una persona ("el uber", "la Lucha"): no nombran a nadie.
const ARTICULOS = new Set(['el', 'la', 'los', 'las']);
// "mi mamá" es Mamá, pero SOLO por coincidencia exacta y solo con "mi"/"mis": "su mamá" es la de
// otro (revisión de 89690c0). Por palabra, "mi banco" alcanzaría a "Banco Pichincha" (revisión de
// 469e728), así que ahí "mi" sigue contando; y en un LOTE tampoco se quita ("Mi Banco" no es "BANCO").
const POSESIVOS = new Set(['mi', 'mis']);
function sinPosesivo(dicho) {
  const palabras = normalizar(dicho).split(' ').filter(Boolean);
  let i = 0;
  while (i < palabras.length - 1 && (ARTICULOS.has(palabras[i]) || POSESIVOS.has(palabras[i]))) i++;
  return palabras.slice(i).join(' ');
}

/**
 * Las palabras del nombre dicho que nombran CUÁL.
 *
 * Con `ignorar` (metas, espacios, presupuestos: cosas que la persona nombra con el tipo delante) se
 * quitan las palabras del dominio y las vacías: "la meta viaje" → "viaje", "la meta" → "".
 *
 * Sin `ignorar` (comercios y personas) solo se quitan los ARTÍCULOS del inicio. La revisión de
 * 469e728 lo midió: quitando "mi", "Mi Banco" se retroaplicaba a Banco Pichincha y a Banco de la
 * Nación, y "lo de mi banco" movía el Pichincha. En un nombre propio "mi" es parte del nombre.
 */
function sinPalabrasDelDominio(dicho, ignorar) {
  const palabras = normalizar(dicho).split(' ').filter(Boolean);
  if (ignorar) return palabras.filter((p) => !ignorar.has(p) && !VACIAS.has(p)).join(' ');
  let i = 0;
  while (i < palabras.length - 1 && ARTICULOS.has(palabras[i])) i++;
  return palabras.slice(i).join(' ');
}

/**
 * ¿La fila se llama exactamente así? Entero o (no en lotes) sin el posesivo. "Sin las palabras del
 * dominio" ya no hace falta acá: sin prioridad del exacto, la coincidencia por palabra lo cubre.
 */
function esExacta(nombreFila, dicho, { conPosesivo = true } = {}) {
  const n = normalizar(nombreFila);
  return n.length > 0 && (n === normalizar(dicho) || (conPosesivo && n === sinPosesivo(dicho)));
}

/**
 * ¿TODAS las palabras del nombre dicho están, enteras e iguales, en el nombre de la fila?
 *
 * Sin largo mínimo y sin tolerar la "s" final, a diferencia de `textoDicho`: la revisión de 469e728
 * midió que la palabra corta es justo la que distingue ("Carlos M" abonaba a "Carlos R", "viaje a NY"
 * a Viaje Cusco) y que la "s" une personas distintas ("Lucas" abonaba a Luca, "Marcos" saldaba a
 * Marco). El costo: "taxis" no encuentra "Taxi" y Neto lo ofrece en vez de moverlo.
 */
function esPorPalabra(nombreFila, limpio, ignorar) {
  if (!limpio) return false;
  const fila = new Set(normalizar(nombreFila).split(' '));
  // En metas, espacios y presupuestos (sustantivos comunes: "fondo de emergencias" es la meta "Fondo
  // de emergencia") la "s" final se tolera. En personas y comercios, nunca: Lucas no es Luca.
  const esta = (p) => fila.has(p) || (!!ignorar && (fila.has(p + 's') || (p.length > 3 && p.endsWith('s') && fila.has(p.slice(0, -1)))));
  return limpio.split(' ').every(esta);
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
  const exactas = dicho ? lista.filter((f) => esExacta(nombreDe(f), dicho)) : [];
  if (!dicho || (normalizar(dicho) === '') || (limpio === '' && exactas.length === 0)) {
    return { estado: 'sin_nombre', filas: lista };
  }
  // Sin prioridad del exacto (cuarta vuelta, decisión de Favio del 02-oct): "uber" con Uber y Uber
  // Eats, o "juan" con Juan y Juan Jr, son DOS nombres que contienen lo dicho, y se pregunta. Con
  // prioridad, un nombre más corto que el que dijo la persona ganaba contra la fila que nombró.
  const elegidas = lista.filter((f) => exactas.includes(f) || esPorPalabra(nombreDe(f), limpio, ignorar));
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
  return (filas || []).filter((f) => esExacta(nombreDe(f), dicho, { conPosesivo: false }) || esPorPalabra(nombreDe(f), limpio, ignorar));
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
  // `normalizar` deja solo [a-z0-9 ]: nada que escapar en la regex. Entre letra y letra, un apóstrofe
  // opcional: "donofrio" tiene que traer "D'Onofrio" (en la fila el apóstrofe sigue ahí).
  return base.split('').map((c) => CLASES[c] || c).join("['’´`]?");
}

/** El nombre como se muestra en WhatsApp: sin `*`, `_` ni `~`, que abren y cierran el formato. */
const mostrable = (nombre) => String(nombre || '').replace(/[*_~]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "*A*", "*A* y *B*", "*A*, *B* y *C*" (con tope). */
function listaNombres(nombres, tope = 6) {
  const n = (nombres || []).map(mostrable).filter(Boolean);
  const vistos = n.slice(0, tope).map((x) => '*' + x + '*');
  const resto = n.length - vistos.length;
  if (resto > 0) vistos.push(resto + ' más');
  if (vistos.length <= 1) return vistos.join('');
  return vistos.slice(0, -1).join(', ') + ' y ' + vistos[vistos.length - 1];
}

/**
 * El texto para cuando el nombre no resolvió a una fila. `ninguna` es la frase de "no encontré"
 * ("ninguna meta") y `cosas` el plural ("metas").
 *
 * Sin ejemplos con un nombre puesto, en ninguno de los tres casos: "elimina la meta Laptop" es una
 * orden destructiva lista para copiar sobre una fila que la persona no eligió (revisión de 469e728).
 */
function mensajeNoResuelto(r, { ninguna, cosas, dicho, nombreDe }) {
  if (r.estado === 'varios') {
    return 'Tienes varias ' + cosas + ' que coinciden con *' + mostrable(dicho) + '*: ' + listaNombres(r.nombres)
      + '. ¿Cuál? Dime el nombre completo.';
  }
  if (r.estado === 'ninguno') {
    return 'No encontré ' + ninguna + ' *' + mostrable(dicho) + '*, así que no cambié nada.'
      + (r.disponibles.length ? ' Tienes: ' + listaNombres(r.disponibles) + '.' : '');
  }
  // `sin_nombre` con varias filas: se pregunta cuál.
  const nombres = agrupar(r.filas, nombreDe).map((g) => g.nombre).filter(Boolean);
  return '¿Cuál de tus ' + cosas + '? Tienes ' + listaNombres(nombres) + '. Dime su nombre.';
}

/**
 * Dos METAS que se llaman igual son dos metas distintas (`crear_meta` no lo impide y un Pro tiene
 * metas ilimitadas): escribir en "la más reciente" era elegir una a ciegas (revisión de 3cd1ba1).
 * Con el mismo nombre no hay cómo distinguirlas por WhatsApp, así que se manda a la app.
 */
function mensajeHomonimas(r) {
  return 'Tienes ' + r.filas.length + ' metas que se llaman *' + mostrable(r.nombre) + '*, así que no cambié nada para no '
    + 'equivocarme de meta. Cámbiale el nombre a una desde la app: https://app.neto.pe/dashboard/metas';
}

// Las palabras que nombran el TIPO de cosa y no cuál: "la meta viaje" es la meta Viaje. Un nombre
// hecho solo de éstas ("elimina la meta") cuenta como sin nombre.
const PALABRAS_DEL_DOMINIO = Object.freeze({
  meta: new Set(['meta', 'metas', 'plan', 'planes', 'ahorro', 'ahorros', 'objetivo', 'objetivos']),
  espacio: new Set(['espacio', 'espacios', 'grupo', 'grupos']),
  presupuesto: new Set(['presupuesto', 'presupuestos', 'limite', 'limites', 'tope', 'topes', 'categoria']),
});

module.exports = {
  PALABRAS_DEL_DOMINIO, resolverNombre, filasQueNombra, nombresParecidos, patronAmplio, listaNombres, mostrable, mensajeNoResuelto, mensajeHomonimas,
};
