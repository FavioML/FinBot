import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * P′3 de la auditoría del 10-ago: `obtenerCategoriasUsuario` hacía 1+N queries — las raíces,
 * y después UNA POR RAÍZ dentro de un `for`. Con 4.8 raíces de promedio (máx 21 en prod) eso
 * son 5-22 round-trips EN SERIE, y esta función cuelga del camino de cada gasto registrado
 * (la llama `detectarCategoriaIA`).
 *
 * Lo que estos tests fijan NO es "es rápido" sino el comportamiento observable: **una sola
 * query** y el mismo árbol agrupado, con el mismo orden. Revertir a la versión con `for`
 * mata el primero; equivocarse al agrupar mata los otros.
 */

// categories.js destructura `supabase` al cargar, así que hay que reemplazarlo ANTES de requerir.
const filas = { rows: [] };
const llamadas = { from: 0, filtros: [] };

const chain = {};
for (const m of ['select', 'eq', 'is', 'order', 'limit', 'neq', 'not', 'gte', 'lte']) {
  chain[m] = vi.fn((...args) => { llamadas.filtros.push([m, ...args]); return chain; });
}
chain.then = (onF, onR) => Promise.resolve({ data: filas.rows, error: null }).then(onF, onR);

require('../../lib/db').supabase = {
  from: vi.fn(() => { llamadas.from++; return chain; }),
};

const warn = vi.fn();
require('../../lib/logger').warn = warn;

const crearCompletion = vi.fn().mockResolvedValue({
  choices: [{ message: { content: '{"categoria":"Transporte","subcategoria":"taxi"}' } }],
});
require('../../lib/ai').openai = { chat: { completions: { create: crearCompletion } } };

const { obtenerCategoriasUsuario, detectarCategoriaIA } = require('../../services/categories');

const raiz = (id, nombre) => ({ id, nombre, padre_id: null, activa: true, usuario_id: 'u1' });
const sub = (id, nombre, padreId) => ({ id, nombre, padre_id: padreId, activa: true, usuario_id: 'u1' });

beforeEach(() => {
  llamadas.from = 0;
  llamadas.filtros.length = 0;
  filas.rows = [];
  warn.mockClear();
  crearCompletion.mockClear();
});

describe('detectarCategoriaIA — el AbortSignal llega al SDK', () => {
  it('pasa el signal como request option de OpenAI', async () => {
    // Sin esto el `abort()` del llamador no cancela nada y la mitigación es decorativa: el
    // cliente seguiría reintentando (maxRetries 3) una respuesta que ya nadie espera.
    filas.rows = [raiz('r-1', 'Transporte')];
    const ac = new AbortController();
    await detectarCategoriaIA('gaste 20 en taxi', 'u1', { signal: ac.signal });

    expect(crearCompletion).toHaveBeenCalledOnce();
    expect(crearCompletion.mock.calls[0][1]).toEqual({ signal: ac.signal });
  });

  it('sin opts no le inventa request options al SDK', async () => {
    filas.rows = [raiz('r-1', 'Transporte')];
    await detectarCategoriaIA('gaste 20 en taxi', 'u1');
    expect(crearCompletion.mock.calls[0][1]).toBeUndefined();
  });

  it('un abort no rompe el flujo: devuelve la clasificación vacía de siempre', async () => {
    filas.rows = [raiz('r-1', 'Transporte')];
    crearCompletion.mockRejectedValueOnce(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }));
    const res = await detectarCategoriaIA('gaste 20 en taxi', 'u1', { signal: new AbortController().signal });
    expect(res).toEqual({ categoria: null, subcategoria: null });
  });
});

describe('obtenerCategoriasUsuario — una sola query', () => {
  it('no hace una query por raíz: 3 raíces con subs = 1 sola llamada a from()', async () => {
    // Orden global por `nombre`, que es lo que devuelve la query real.
    filas.rows = [
      raiz('r-ali', 'Alimentacion'),
      sub('s-cafe', 'cafeteria', 'r-ali'),
      sub('s-deli', 'delivery', 'r-ali'),
      raiz('r-tra', 'Transporte'),
      raiz('r-viv', 'Vivienda'),
      sub('s-taxi', 'taxi', 'r-tra'),
    ];
    const res = await obtenerCategoriasUsuario('u1');

    expect(llamadas.from).toBe(1);
    expect(res.map(c => c.nombre)).toEqual(['Alimentacion', 'Transporte', 'Vivienda']);
    expect(res[0].subcategorias.map(s => s.nombre)).toEqual(['cafeteria', 'delivery']);
    expect(res[1].subcategorias.map(s => s.nombre)).toEqual(['taxi']);
    expect(res[2].subcategorias).toEqual([]);
  });

  it('no filtra por padre_id en la query: agrupar es cosa de JS', async () => {
    filas.rows = [raiz('r-1', 'Otros')];
    await obtenerCategoriasUsuario('u1');
    // `.is('padre_id', null)` era lo que obligaba a la segunda vuelta de queries.
    expect(llamadas.filtros.some(([m, col]) => m === 'is' && col === 'padre_id')).toBe(false);
    expect(llamadas.filtros.some(([m, col]) => m === 'eq' && col === 'padre_id')).toBe(false);
    // Lo que sí tiene que seguir filtrando.
    expect(llamadas.filtros).toContainEqual(['eq', 'usuario_id', 'u1']);
    expect(llamadas.filtros).toContainEqual(['eq', 'activa', true]);
    expect(llamadas.filtros).toContainEqual(['order', 'nombre']);
  });

  it('preserva el orden por nombre dentro de cada grupo aunque la fila venga intercalada', async () => {
    filas.rows = [
      raiz('r-a', 'Alimentacion'),
      sub('s-1', 'aguacate', 'r-a'),
      sub('s-2', 'bebidas', 'r-b'),
      raiz('r-b', 'Bebidas'),
      sub('s-3', 'zumo', 'r-a'),
    ];
    const res = await obtenerCategoriasUsuario('u1');
    expect(res[0].subcategorias.map(s => s.nombre)).toEqual(['aguacate', 'zumo']);
    expect(res[1].subcategorias.map(s => s.nombre)).toEqual(['bebidas']);
  });

  it('devuelve null sin filas', async () => {
    filas.rows = [];
    expect(await obtenerCategoriasUsuario('u1')).toBe(null);
    expect(llamadas.from).toBe(1);
  });

  it('devuelve null cuando solo hay subcategorías huérfanas (la versión vieja tampoco las veía)', async () => {
    // La primera query filtraba `.is('padre_id', null)`, así que estas filas nunca llegaban.
    // Sin la guarda de raíces vacías esto devolvería [], que NO es lo mismo para el llamador:
    // `detectarCategoriaIA` ramifica con `cats && cats.length > 0` y caería al mismo lado,
    // pero webhook.js/presupuestos.js sí distinguen null de lista vacía.
    filas.rows = [sub('s-1', 'taxi', 'r-borrada'), sub('s-2', 'bus', 'r-borrada')];
    expect(await obtenerCategoriasUsuario('u1')).toBe(null);
  });

  it('avisa cuando la respuesta llega al techo de 1000 filas de PostgREST', async () => {
    // Traer raíces y subcategorías en la MISMA query las hace compartir el techo. PostgREST
    // corta sin señalizarlo (`error` sigue en null), así que un árbol truncado clasificaría mal
    // y en silencio. La versión 1+N no podía truncar así: cada query iba acotada por su padre.
    filas.rows = Array.from({ length: 1000 }, (_, i) => raiz('r-' + i, 'Cat' + String(i).padStart(4, '0')));
    const res = await obtenerCategoriasUsuario('u1');
    expect(res).toHaveLength(1000);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatchObject({ tag: 'CATEGORIAS', filas: 1000 });
  });

  it('no avisa con un árbol de tamaño normal', async () => {
    filas.rows = [raiz('r-1', 'Salud'), sub('s-1', 'farmacia', 'r-1')];
    await obtenerCategoriasUsuario('u1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('una raíz sin subs trae subcategorias: [] y no undefined', async () => {
    filas.rows = [raiz('r-1', 'Salud')];
    const res = await obtenerCategoriasUsuario('u1');
    expect(res).toHaveLength(1);
    expect(res[0].subcategorias).toEqual([]);
    // El consumidor hace `c.subcategorias.length > 0` sin guarda previa.
    expect(() => res[0].subcategorias.length).not.toThrow();
  });
});
