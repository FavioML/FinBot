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
    expect(new Set(data.map((f) => f.id)).size).toBe(2535);
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
    expect(data.map((f) => f.id)).toEqual(Array.from({ length: 1200 }, (_, i) => i));
  });

  it('sin conteo, cae a "página incompleta = terminé"', async () => {
    const { construir } = servidor(1500, TAMANO_PAGINA, { conCount: false });
    expect((await todasLasFilas(construir)).data).toHaveLength(1500);
  });

  it('si el conteo quedó alto (se borraron filas después de contarlas), termina igual', async () => {
    const { construir, pedidos } = servidor(1000, TAMANO_PAGINA, { countInformado: 1003 });
    expect((await todasLasFilas(construir)).data).toHaveLength(1000);
    expect(pedidos.length).toBeLessThanOrEqual(2);
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
    const ids = data.map((f) => f.id);
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
    const { error } = await todasLasFilas(construir);
    expect(error).toEqual({ message: 'boom' });
  });
});
