/**
 * Trae TODAS las filas de una consulta, en páginas, en vez de las primeras 1000.
 *
 * Espejo CommonJS de `webapp/src/lib/supabase/todas-las-filas.ts`, que tiene el porqué completo.
 * PostgREST corta cada respuesta en `max_rows` (1000 en este proyecto) y no avisa: sin `.range()`
 * la consulta "devuelve" la lista y nada distingue una lista completa de una cortada. Medido el
 * 01-oct-2026: `transacciones` tenía 3535 filas y un select sin filtro devolvía 1000
 * (`content-range: 0-999/3535`); el usuario real más grande tenía ~1105.
 *
 * Las mismas decisiones que el original, y por los mismos motivos:
 * - **Corta por el conteo exacto** (pedido solo en la primera página, `primera`), no por "la
 *   página vino incompleta": si `max_rows` bajara de `TAMANO_PAGINA`, esa regla pararía en la
 *   primera página creyendo que terminó.
 * - **El offset avanza por lo que llegó**, no de a `TAMANO_PAGINA`.
 * - **`construir` arma la consulta de nuevo en cada página** con su orden completo, y el orden
 *   termina en `id`: con empates entre páginas Postgres no garantiza el mismo orden dos veces.
 * - **Deduplica por `clave`**: una fila insertada entre dos páginas corre todo un lugar y la última
 *   de la página 1 vuelve en la 2. Como la que se repite no cuenta, la vuelta sigue hasta tener
 *   tantas filas DISTINTAS como dijo el conteo.
 * - **Si no llegan tantas filas distintas como dijo el conteo, es un error, no una lista.** Una
 *   página vacía antes de completar el conteo, o una página entera de filas ya vistas, terminaban
 *   en una lista corta con `error: null`. Por ahí llegan los caminos que el guard sintáctico no
 *   puede ver: un `fetch` del cliente que memoiza por ruta (la página 2 es copia de la 1), una
 *   página cuyo filtro depende de `primera`, una clave que no es única y un borrado entre dos
 *   páginas. Los cuatro terminan con menos filas distintas que el conteo. Lo paga el borrado entre
 *   páginas, que antes salteaba una fila en silencio.
 * - **Lo que el invariante NO ve, medido el 01-oct-2026:** un borrado (o un cambio de fecha o de
 *   tipo) en la zona ya leída MÁS una fila nueva en la zona que falta leer. El conteo cuadra, la fila
 *   del borde se saltea y la lista sale con `error: null` (1105 filas, una preexistente de menos).
 *   Es el límite de paginar por offset; cerrarlo pide keyset (`gt('id', ultimo)`). Donde más pesa es
 *   en las lecturas de TODOS los usuarios (`routes/admin.js`), mientras otros escriben.
 *
 * Devuelve `{ data, error }` como supabase-js, y con error `data` es `null`, no "lo que alcanzó a
 * llegar": varios call-sites del backend solo loguean el error y siguen con `data || []` (la
 * comparativa de la semana anterior, el historial del gasto inusual, el bloque de presupuesto
 * después de un gasto), y con la lista parcial un fallo en la página 2 se sumaba como un total
 * completo y más chico.
 *
 * **Una divergencia con la webapp, a propósito: una fila SIN clave no se deduplica** (y cuenta como
 * distinta). Con un `select` sin `id` la clave sale `undefined` para todas; la webapp las colapsa a
 * una y el invariante lo vuelve un error, el backend devuelve las filas. Se probó alinearlo el
 * 01-oct-2026 y rompió 34 tests en 6 archivos (resumen diario, suscripciones, score, gasto inusual,
 * recomendaciones) cuyos dobles devuelven filas sin `id`: en producción no pasa, porque el guard
 * exige el `id` en la página de los dos lados, así que el comportamiento real es el mismo. Lo que
 * cuesta, declarado: con un `select` sin `id` (que ya es un escape del guard) una fila insertada
 * entre dos páginas se repite, y un `fetch` que repite páginas devuelve filas de más en vez de un
 * error. `tests/lib/todas-las-filas.test.js` corre todo lo demás contra las dos implementaciones.
 *
 * El objeto exportado está congelado: el guard
 * (`tests/transacciones-paginacion-callsites.test.js`) confía en que `todasLasFilas` y
 * `TAMANO_PAGINA` sean ESTOS, y en CommonJS cualquiera podía pisarlos con una asignación.
 */
const TAMANO_PAGINA = 1000;

async function todasLasFilas(construir, clave) {
  const filas = [];
  const vistas = new Set();
  let recibidas = 0;
  let total = null;
  for (let primera = true; ; primera = false) {
    const desde = recibidas;
    const { data, error, count } = await construir(desde, desde + TAMANO_PAGINA - 1, primera);
    if (error) return { data: null, error };
    const lote = data ?? [];
    recibidas += lote.length;
    let nuevas = 0;
    for (const fila of lote) {
      // Sin clave no se deduplica (la divergencia con la webapp del docblock): cuenta como distinta.
      const k = clave ? clave(fila) : undefined;
      if (k !== undefined && k !== null) {
        if (vistas.has(k)) continue;
        vistas.add(k);
      }
      filas.push(fila);
      nuevas++;
    }
    if (primera) total = count ?? null;
    if (total !== null && filas.length >= total) return { data: filas, error: null };
    // Sin conteo (el llamador no pidió `count: 'exact'`) se cae a la regla débil, la única posible.
    if (total === null && lote.length < TAMANO_PAGINA) return { data: filas, error: null };
    // Una página vacía, o entera de filas ya vistas, antes de completar el conteo: faltan filas y
    // seguir pidiendo no las trae (y con un fetch que repite, no terminaría nunca).
    if (lote.length === 0 || nuevas === 0) {
      return {
        data: null,
        error: new Error(`todasLasFilas: llegaron ${filas.length} filas distintas y el conteo dijo ${total ?? 'nada'}`),
      };
    }
  }
}

module.exports = Object.freeze({ TAMANO_PAGINA, todasLasFilas });
