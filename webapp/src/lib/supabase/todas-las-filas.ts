/**
 * Trae TODAS las filas de una consulta, en páginas, en vez de las primeras 1000.
 *
 * PostgREST corta cada respuesta en `max_rows` (1000 en este proyecto) y no avisa: sin `.range()`
 * la consulta "devuelve" la lista y nada distingue una lista completa de una cortada. Medido el
 * 01-oct-2026: `transacciones` tenía 3535 filas y un select sin filtro devolvía 1000
 * (`content-range: 0-999/3535`). Un usuario ya tenía 1102 transacciones en 2026, así que su vista
 * Anual de Transacciones y el historial que siembra `/api/dashboard` le mostraban totales cortos.
 *
 * Decisiones que no son de estilo:
 * - **Corta por el conteo exacto, no por "la página vino incompleta".** Si `max_rows` bajara de
 *   `TAMANO_PAGINA`, esa regla pararía en la primera página creyendo que terminó, que es el mismo
 *   corte silencioso que esto viene a arreglar. El conteo se pide solo en la primera página
 *   (`primera`): en las demás sería un `count(*)` extra que nadie lee.
 * - **El offset avanza por lo que llegó**, no de a `TAMANO_PAGINA`, por lo mismo.
 * - **`construir` arma la consulta de nuevo en cada página**, con su orden completo, y el orden
 *   tiene que terminar en algo único (el `id`): con empates entre dos páginas, Postgres no
 *   garantiza el mismo orden en dos consultas.
 * - **Deduplica por `clave`.** Paginar por offset no es una foto: si entra una fila nueva entre
 *   dos páginas (el bot registra un gasto de hoy, que cae primero con `fecha desc`), todo se corre
 *   un lugar y la última fila de la página 1 vuelve a venir en la 2. Sin deduplicar, ese gasto
 *   se sumaba dos veces. Y como la que se repite no cuenta, la vuelta sigue hasta tener tantas
 *   filas DISTINTAS como dijo el conteo: con una inserción en el medio pide una página más.
 * - **Si no llegan tantas filas distintas como dijo el conteo, es un error, no una lista.** Una
 *   página vacía antes de completar el conteo, o una página entera de filas repetidas, terminaban
 *   en `{ data: <lo que había>, error: null }`. Tres rondas de ataque al guard sintáctico
 *   (01-oct-2026) llegaron ahí por caminos que la sintaxis no puede ver: un `fetch` del cliente que
 *   memoiza por ruta (la página 2 era una copia de la 1: 1000 de 1105), una página cuyo filtro
 *   depende de `primera` (1085 de 1105), y un `select` sin `id` que deduplicaba todo a una fila.
 *   Los tres terminan igual, con menos filas distintas que el conteo, y eso sí se ve acá. Lo paga
 *   un borrado entre dos páginas, que ahora es un error en vez de una fila salteada en silencio:
 *   el borrado corre todo un lugar y la fila del borde no llega, así que el error dice la verdad.
 *   **Salvo que entre a la vez una fila en la zona que falta leer**: el conteo cuadra y la fila del
 *   borde se pierde igual, con `error: null` (medido el 01-oct-2026 contra el espejo del backend, que
 *   corre el mismo algoritmo). Es el límite de paginar por offset; cerrarlo pide keyset.
 *
 * Devuelve `{ data, error }` como supabase-js, y con error `data` es `null`, igual que en
 * supabase-js y que su espejo del backend (`lib/todas-las-filas.js`). Hasta el 01-oct devolvía lo
 * que había alcanzado a llegar, y un llamador que no miraba `error` sumaba 1000 de 1105 filas sin
 * enterarse: el mismo corte silencioso que esto viene a arreglar, ahora por un 503 transitorio. Con
 * `null` el tipo obliga a cada llamador a decidir qué hace sin la lista.
 */
export const TAMANO_PAGINA = 1000;

interface RespuestaPagina<T> {
  data: T[] | null;
  error: unknown;
  count?: number | null;
}

export async function todasLasFilas<T>(
  construir: (desde: number, hasta: number, primera: boolean) => PromiseLike<RespuestaPagina<T>>,
  clave?: (fila: T) => unknown,
): Promise<{ data: T[] | null; error: unknown }> {
  const filas: T[] = [];
  const vistas = new Set<unknown>();
  let recibidas = 0;
  let total: number | null = null;
  for (let primera = true; ; primera = false) {
    const desde = recibidas;
    const { data, error, count } = await construir(desde, desde + TAMANO_PAGINA - 1, primera);
    if (error) return { data: null, error };
    const lote = data ?? [];
    recibidas += lote.length;
    let nuevas = 0;
    for (const fila of lote) {
      if (clave) {
        const k = clave(fila);
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
