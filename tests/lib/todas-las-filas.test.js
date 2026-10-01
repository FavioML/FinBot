import { describe, it, expect } from 'vitest';
import * as cjs from '../../lib/todas-las-filas.js';
import * as ts from '../../webapp/src/lib/supabase/todas-las-filas.ts';

/**
 * `lib/todas-las-filas.js` es el espejo CommonJS del paginador de la webapp. Los mismos casos
 * corren contra LAS DOS implementaciones: si una se arregla y la otra no, este archivo se pone
 * rojo en vez de que el backend y la webapp devuelvan totales distintos para el mismo usuario.
 */

/** Un "servidor" con `n` filas que corta cada respuesta en `maxRows`, como PostgREST. */
function servidor(n, maxRows = 1000, { conCount = true, countInformado = n } = {}) {
  const filas = Array.from({ length: n }, (_, i) => ({ id: i }));
  const pedidos = [];
  const construir = async (desde, hasta, primera) => {
    pedidos.push([desde, hasta, primera]);
    if (pedidos.length > 50) throw new Error('loop sin fin');
    const pedido = filas.slice(desde, hasta + 1);
    return { data: pedido.slice(0, maxRows), error: null, count: conCount && primera ? countInformado : null };
  };
  return { construir, pedidos };
}

describe.each([['backend (CJS)', cjs], ['webapp (TS)', ts]])('todasLasFilas — %s', (_n, { todasLasFilas, TAMANO_PAGINA }) => {
  it('la página es 1000, el max_rows de PostgREST en este proyecto', () => {
    expect(TAMANO_PAGINA).toBe(1000);
  });

  it('trae más de 1000 filas, pidiendo el conteo solo la primera vez', async () => {
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

  it('justo 1000 filas: no pide páginas vacías de más', async () => {
    const { construir, pedidos } = servidor(1000);
    expect((await todasLasFilas(construir)).data).toHaveLength(1000);
    expect(pedidos).toHaveLength(1);
  });

  it('si el servidor corta en MENOS que la página, igual trae todo (corta por el conteo)', async () => {
    const { construir } = servidor(1200, 500);
    const { data } = await todasLasFilas(construir);
    expect(data.map((f) => f.id)).toEqual(Array.from({ length: 1200 }, (_, i) => i));
  });

  it('sin conteo, cae a "página incompleta = terminé"', async () => {
    const { construir } = servidor(1500, 1000, { conCount: false });
    expect((await todasLasFilas(construir)).data).toHaveLength(1500);
  });

  it('si el conteo quedó alto (se borraron filas después de contarlas), termina igual', async () => {
    const { construir, pedidos } = servidor(1000, 1000, { countInformado: 1003 });
    expect((await todasLasFilas(construir)).data).toHaveLength(1000);
    expect(pedidos.length).toBeLessThanOrEqual(2);
  });

  it('una fila insertada entre dos páginas no se cuenta dos veces', async () => {
    const base = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    let tabla = base;
    let n = 0;
    const construir = async (desde, hasta, primera) => {
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

it('con error, el backend devuelve data: null (forma supabase-js), nunca la lista parcial', async () => {
  // Divergencia deliberada con la webapp: varios call-sites del backend loguean el error y siguen
  // con `data || []`. Una lista parcial ahí se sumaría como un total completo y más chico.
  let n = 0;
  const construir = async () => {
    n++;
    if (n === 2) return { data: null, error: { message: 'boom' }, count: null };
    return { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null, count: 3000 };
  };
  const r = await cjs.todasLasFilas(construir);
  expect(r).toEqual({ data: null, error: { message: 'boom' } });
});

it('una fila sin clave no se deduplica: un select sin id no colapsa la lista a una fila', async () => {
  const construir = async () => ({ data: [{ monto: 1 }, { monto: 2 }, { monto: 3 }], error: null, count: 3 });
  const { data } = await cjs.todasLasFilas(construir, (t) => t.id);
  expect(data).toHaveLength(3);
});

it('el módulo CJS está congelado: nadie puede pisar el paginador ni la página en tiempo de ejecución', () => {
  const mod = cjs.default;
  expect(Object.isFrozen(mod)).toBe(true);
  expect(() => { mod.TAMANO_PAGINA = 5000; }).toThrow();
  expect(mod.TAMANO_PAGINA).toBe(1000);
});
