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
 *   se sumaba dos veces. Lo que esto NO cubre es el caso inverso: un borrado entre dos páginas
 *   puede hacer que se saltee una fila. Es una ventana de milisegundos y solo para quien tiene
 *   más de una página; cerrarla pide paginar por cursor (keyset), que no vale su complejidad hoy.
 *
 * Devuelve `{ data, error }` como supabase-js. Con error, `data` trae lo que alcanzó a llegar y
 * NO es la lista completa: el llamador no debe usarla como si lo fuera.
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
): Promise<{ data: T[]; error: unknown }> {
  const filas: T[] = [];
  const vistas = new Set<unknown>();
  let recibidas = 0;
  let total: number | null = null;
  for (let primera = true; ; primera = false) {
    const desde = recibidas;
    const { data, error, count } = await construir(desde, desde + TAMANO_PAGINA - 1, primera);
    if (error) return { data: filas, error };
    const lote = data ?? [];
    recibidas += lote.length;
    for (const fila of lote) {
      if (clave) {
        const k = clave(fila);
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
