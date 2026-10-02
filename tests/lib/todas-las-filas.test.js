import { describe, it, expect } from 'vitest';
import * as cjs from '../../lib/todas-las-filas.js';
import * as ts from '../../webapp/src/lib/supabase/todas-las-filas.ts';

/**
 * `lib/todas-las-filas.js` es el espejo CommonJS del paginador de la webapp. Los mismos casos
 * corren contra LAS DOS implementaciones: si una se arregla y la otra no, este archivo se pone
 * rojo en vez de que el backend y la webapp devuelvan totales distintos para el mismo usuario.
 *
 * Queda UN caso de un solo lado, abajo del `describe.each`: una fila sin clave. La webapp la
 * deduplica (todas a `undefined`, o sea a una) y el invariante lo vuelve error; el backend no la
 * deduplica, porque 34 tests de 6 archivos usan dobles que devuelven filas sin `id`. En producción
 * no se alcanza: el guard exige el `id` en la página de los dos lados. `data: null` con error, la
 * otra divergencia que tuvo el CJS, la adoptó la webapp el 01-oct y ahora es un caso compartido.
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

  it('si el conteo quedó alto (se borraron filas después de contarlas), es un error y termina', async () => {
    // Hasta el 01-oct devolvía las 1000 como lista completa. Un borrado entre páginas corre todo un
    // lugar y la fila del borde no llega: lo honesto es decir que faltan.
    const { construir, pedidos } = servidor(1000, 1000, { countInformado: 1003 });
    const { data, error } = await todasLasFilas(construir);
    expect(data).toBeNull();
    expect(String(error)).toMatch(/llegaron 1000 filas distintas y el conteo dijo 1003/);
    expect(pedidos.length).toBeLessThanOrEqual(2);
  });

  it('un fetch que repite la página 1 (memoiza por ruta) es un error, no 1000 filas', async () => {
    const tabla = Array.from({ length: 1105 }, (_, i) => ({ id: i }));
    let pedidos = 0;
    const construir = async (_desde, hasta, primera) => {
      if (++pedidos > 10) throw new Error('loop sin fin');
      return { data: tabla.slice(0, Math.min(hasta + 1, 1000)), error: null, count: primera ? tabla.length : null };
    };
    const { data, error } = await todasLasFilas(construir, (f) => f.id);
    expect(data).toBeNull();
    expect(String(error)).toMatch(/llegaron 1000 filas distintas y el conteo dijo 1105/);
  });

  it('una página cuyo filtro depende de `primera` (cuenta más de lo que trae) es un error', async () => {
    const todas = Array.from({ length: 1105 }, (_, i) => ({ id: i, hoy: i < 20 }));
    const construir = async (desde, hasta, primera) => {
      const vista = primera ? todas : todas.filter((f) => !f.hoy);
      return { data: vista.slice(desde, hasta + 1), error: null, count: primera ? vista.length : null };
    };
    const { data, error } = await todasLasFilas(construir, (f) => f.id);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it('una clave que se repite entre filas distintas (no es única) es un error, no una lista corta', async () => {
    const { construir } = servidor(1105);
    const { data, error } = await todasLasFilas(construir, (f) => f.id % 7);
    expect(data).toBeNull();
    expect(String(error)).toMatch(/llegaron 7 filas distintas y el conteo dijo 1105/);
  });

  it('una clave que se repite dentro de UNA página también es un error', async () => {
    // Con menos de 1000 filas no hay segunda página: el corte tiene que verse en la primera.
    const construir = async (desde) => ({ data: desde === 0 ? [{ id: 1 }, { id: 1 }, { id: 2 }] : [], error: null, count: 3 });
    const { data, error } = await todasLasFilas(construir, (t) => t.id);
    expect(data).toBeNull();
    expect(String(error)).toMatch(/llegaron 2 filas distintas y el conteo dijo 3/);
  });

  it('un borrado entre páginas es un error (la fila del borde se habría salteado)', async () => {
    const base = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    let tabla = base;
    let n = 0;
    const construir = async (desde, hasta, primera) => {
      if (n++ === 1) tabla = base.filter((f) => f.id !== 3);
      return { data: tabla.slice(desde, hasta + 1), error: null, count: primera ? tabla.length : null };
    };
    const { data, error } = await todasLasFilas(construir, (f) => f.id);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
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

  it('con error de cualquier página devuelve data: null (forma supabase-js), nunca la lista parcial', async () => {
    // Varios call-sites del backend loguean el error y siguen con `data || []`: una lista parcial
    // ahí se sumaría como un total completo y más chico.
    let n = 0;
    const construir = async () => {
      n++;
      if (n === 2) return { data: null, error: { message: 'boom' }, count: null };
      return { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null, count: 3000 };
    };
    expect(await todasLasFilas(construir)).toEqual({ data: null, error: { message: 'boom' } });
  });
});

describe('una fila sin clave (un select sin id): la única divergencia', () => {
  const sinId = () => {
    const filas = Array.from({ length: 1105 }, (_, i) => ({ monto: i }));
    return async (desde, hasta, primera) => ({ data: filas.slice(desde, Math.min(hasta + 1, desde + 1000)), error: null, count: primera ? filas.length : null });
  };

  it('el backend no la deduplica: devuelve las filas, no una', async () => {
    const { data, error } = await cjs.todasLasFilas(sinId(), (t) => t.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1105);
  });

  it('la webapp la colapsa a una y el invariante lo vuelve error', async () => {
    const { data, error } = await ts.todasLasFilas(sinId(), (t) => t.id);
    expect(data).toBeNull();
    expect(String(error)).toMatch(/llegaron 1 filas distintas y el conteo dijo 1105/);
  });
});

it('el módulo CJS está congelado: nadie puede pisar el paginador ni la página en tiempo de ejecución', () => {
  const mod = cjs.default;
  expect(Object.isFrozen(mod)).toBe(true);
  expect(() => { mod.TAMANO_PAGINA = 5000; }).toThrow();
  expect(mod.TAMANO_PAGINA).toBe(1000);
});
