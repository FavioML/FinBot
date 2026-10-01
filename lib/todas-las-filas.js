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
 *   de la página 1 vuelve en la 2. No cubre el caso inverso (un borrado entre páginas puede saltear
 *   una fila); cerrarlo pide keyset.
 *
 * Devuelve `{ data, error }` como supabase-js, y **acá diverge a propósito del original**: con
 * error, `data` es `null`, no "lo que alcanzó a llegar". Los call-sites del backend se escribieron
 * contra la forma de supabase-js, y varios solo loguean el error y siguen con `data || []` (la
 * comparativa de la semana anterior, el historial del gasto inusual, el bloque de presupuesto
 * después de un gasto). Con la lista parcial, un fallo en la página 2 se sumaba como un total
 * completo y más chico; con `null` esos sitios hacen lo mismo que hacían con una lectura caída.
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
    for (const fila of lote) {
      // Una fila SIN clave no se deduplica (otra divergencia con la webapp): con un select sin `id`
      // la clave sale `undefined` para todas y el Set las colapsaba a UNA. El guard ya exige el
      // `id`; esto es para que, si algo se le escapa, el error sea "puede repetir una fila entre
      // páginas" y no "el mes tiene un solo gasto".
      const k = clave ? clave(fila) : undefined;
      if (k !== undefined && k !== null) {
        if (vistas.has(k)) continue;
        vistas.add(k);
      }
      filas.push(fila);
    }
    if (primera) total = count ?? null;
    // Sin conteo (el llamador no pidió `count: 'exact'`) se cae a la regla débil, la única posible.
    const termino = total !== null ? recibidas >= total : lote.length < TAMANO_PAGINA;
    // `lote.length === 0` corta aunque el conteo diga que faltan: si se borraron filas después de
    // contarlas, el conteo queda alto para siempre y sin esto el loop pide páginas vacías sin fin.
    if (termino || lote.length === 0) return { data: filas, error: null };
  }
}

module.exports = Object.freeze({ TAMANO_PAGINA, todasLasFilas });
