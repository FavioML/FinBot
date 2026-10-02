import { describe, it, expect } from 'vitest';
import { todasLasFilas, TAMANO_PAGINA } from './todas-las-filas';

type Fila = { id: number };

/** Un "servidor" con `n` filas que corta cada respuesta en `maxRows`, como PostgREST. */
function servidor(n: number, maxRows = TAMANO_PAGINA, { conCount = true, countInformado = n } = {}) {
  const filas: Fila[] = Array.from({ length: n }, (_, i) => ({ id: i }));
  const pedidos: Array<[number, number, boolean]> = [];
  const construir = async (desde: number, hasta: number, primera: boolean) => {
    pedidos.push([desde, hasta, primera]);
    if (pedidos.length > 50) throw new Error('loop sin fin');
    const pedido = filas.slice(desde, hasta + 1);
    return { data: pedido.slice(0, maxRows), error: null, count: conCount && primera ? countInformado : null };
  };
  return { construir, pedidos };
}

describe('todasLasFilas', () => {
  it('trae más de 1000 filas (el caso que PostgREST cortaba), pidiendo el conteo solo la primera vez', async () => {
    const { construir, pedidos } = servidor(2535);
    const { data, error } = await todasLasFilas(construir);
    expect(error).toBeNull();
    expect(data).toHaveLength(2535);
    expect(new Set(data!.map((f) => f.id)).size).toBe(2535);
    expect(pedidos).toEqual([[0, 999, true], [1000, 1999, false], [2000, 2999, false]]);
  });

  it('con menos de una página hace un solo pedido', async () => {
    const { construir, pedidos } = servidor(12);
    expect((await todasLasFilas(construir)).data).toHaveLength(12);
    expect(pedidos).toHaveLength(1);
  });

  it('justo 1000 filas: no se queda pidiendo páginas vacías de más', async () => {
    const { construir, pedidos } = servidor(1000);
    expect((await todasLasFilas(construir)).data).toHaveLength(1000);
    expect(pedidos).toHaveLength(1);
  });

  it('si el servidor corta en MENOS que la página, igual trae todo (corta por el conteo)', async () => {
    // Con la regla "página incompleta = terminé" esto devolvía 500 filas y se daba por bueno.
    // Y con un offset fijo de a 1000 se salteaba las filas 500-999.
    const { construir } = servidor(1200, 500);
    const { data } = await todasLasFilas(construir);
    expect(data!.map((f) => f.id)).toEqual(Array.from({ length: 1200 }, (_, i) => i));
  });

  it('sin conteo, cae a "página incompleta = terminé"', async () => {
    const { construir } = servidor(1500, TAMANO_PAGINA, { conCount: false });
    expect((await todasLasFilas(construir)).data).toHaveLength(1500);
  });

  it('si el conteo quedó alto (se borraron filas después de contarlas), es un error y termina', async () => {
    // Hasta el 01-oct devolvía las 1000 como lista completa. Un borrado entre páginas corre todo un
    // lugar y la fila del borde no llega: lo honesto es decir que faltan.
    const { construir, pedidos } = servidor(1000, TAMANO_PAGINA, { countInformado: 1003 });
    const { data, error } = await todasLasFilas(construir);
    expect(data).toBeNull();
    expect(String(error)).toMatch(/llegaron 1000 filas distintas y el conteo dijo 1003/);
    expect(pedidos.length).toBeLessThanOrEqual(2);
  });

  it('un fetch que repite la página 1 (memoiza por ruta) es un error, no 1000 filas', async () => {
    const tabla = Array.from({ length: 1105 }, (_, i) => ({ id: i }));
    let pedidos = 0;
    const construir = async (_desde: number, hasta: number, primera: boolean) => {
      if (++pedidos > 10) throw new Error('loop sin fin');
      return { data: tabla.slice(0, Math.min(hasta + 1, 1000)), error: null, count: primera ? tabla.length : null };
    };
    const { data, error } = await todasLasFilas(construir, (f) => f.id);
    expect(data).toBeNull();
    expect(String(error)).toMatch(/llegaron 1000 filas distintas y el conteo dijo 1105/);
  });

  it('una página cuyo filtro depende de `primera` (cuenta más de lo que trae) es un error', async () => {
    const todas = Array.from({ length: 1105 }, (_, i) => ({ id: i, hoy: i < 20 }));
    const construir = async (desde: number, hasta: number, primera: boolean) => {
      const vista = primera ? todas : todas.filter((f) => !f.hoy);
      return { data: vista.slice(desde, hasta + 1), error: null, count: primera ? vista.length : null };
    };
    const { data, error } = await todasLasFilas(construir, (f) => f.id);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it('una clave que no es única (un select sin id) es un error, no una fila', async () => {
    const { construir } = servidor(1105);
    const { data, error } = await todasLasFilas(construir, () => undefined);
    expect(data).toBeNull();
    expect(String(error)).toMatch(/llegaron 1 filas distintas y el conteo dijo 1105/);
  });

  it('un borrado entre páginas es un error (la fila del borde se habría salteado)', async () => {
    const base = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    let tabla = base;
    let n = 0;
    const construir = async (desde: number, hasta: number, primera: boolean) => {
      if (n++ === 1) tabla = base.filter((f) => f.id !== 3);
      return { data: tabla.slice(desde, hasta + 1), error: null, count: primera ? tabla.length : null };
    };
    const { data, error } = await todasLasFilas(construir, (f) => f.id);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it('una fila insertada entre dos páginas no se cuenta dos veces', async () => {
    // Orden `fecha desc`: el gasto nuevo entra primero y corre todo un lugar, así que la última
    // fila de la página 1 vuelve a venir al principio de la página 2.
    const base: Fila[] = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    let tabla = base;
    let n = 0;
    const construir = async (desde: number, hasta: number, primera: boolean) => {
      if (n++ === 1) tabla = [{ id: -1 }, ...base];
      return { data: tabla.slice(desde, hasta + 1), error: null, count: primera ? tabla.length : null };
    };
    const { data } = await todasLasFilas(construir, (f) => f.id);
    const ids = data!.map((f) => f.id);
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids).toHaveLength(1500);
  });

  it('devuelve el error de cualquier página en vez de una lista corta que parezca completa', async () => {
    let n = 0;
    const construir = async () => {
      n++;
      if (n === 2) return { data: null, error: { message: 'boom' }, count: null };
      return { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null, count: 3000 };
    };
    const { data, error } = await todasLasFilas(construir);
    expect(error).toEqual({ message: 'boom' });
    // Ni siquiera las 1000 que llegaron: un llamador que no mira `error` sumaría una lista corta
    // con cara de completa (ataque E3 del 01-oct). Con `null` el tipo lo obliga a decidir.
    expect(data).toBeNull();
  });
});
