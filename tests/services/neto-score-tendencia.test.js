import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

/**
 * "+N vs semana pasada" sin semana pasada (30-sep-2026): 3 de las 5 personas que vieron la
 * tendencia llevaban menos de 7 días. `obtenerTendenciaScore` comparaba contra la fila más
 * VIEJA cuando había menos de 7, y contra `data[6]` aunque las filas diarias tuvieran huecos.
 *
 * El doble devuelve las filas que se le siembran ordenadas como pide la query (period desc) y
 * recortadas al `limit`, así que un cambio en el orden o en el límite de la query se nota.
 */

let filasScore = [];
let llamadas = [];
function makeChain(table) {
  const q = { table, methods: [] };
  const chain = {};
  for (const m of ['eq', 'gte', 'order', 'limit']) {
    chain[m] = (...a) => { q.methods.push([m, ...a]); return chain; };
  }
  chain.select = () => chain;
  chain.then = (resolve, reject) => {
    llamadas.push(q);
    let data = [...filasScore];
    const ord = q.methods.find((m) => m[0] === 'order');
    if (ord) data.sort((a, b) => (ord[2] && ord[2].ascending ? 1 : -1) * a.period.localeCompare(b.period));
    const lim = q.methods.find((m) => m[0] === 'limit');
    if (lim) data = data.slice(0, lim[1]);
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  };
  return chain;
}
const dbMock = { supabase: { from: (t) => ({ select: (...a) => makeChain(t).select(...a) }) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['services/metas.js', { obtenerMetas: vi.fn(), calcularRitmoAhorro: vi.fn() }],
  ['services/recommendations.js', { construirDatosUsuario: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const { obtenerTendenciaScore } = require('../../services/neto-score');

const f = (period, score) => ({ period, score });

beforeEach(() => { filasScore = []; llamadas = []; });

describe('obtenerTendenciaScore: solo compara contra una fila de hace una semana', () => {
  it('2 filas de días seguidos (el caso de prod) → null', async () => {
    filasScore = [f('2026-09-30', 62), f('2026-09-29', 55)];
    await expect(obtenerTendenciaScore('u1')).resolves.toBeNull();
    // antivacuidad: la lectura ocurrió
    expect(llamadas.length).toBe(1);
  });

  it('5 filas en 5 días → null', async () => {
    filasScore = ['2026-09-30', '2026-09-29', '2026-09-28', '2026-09-27', '2026-09-26'].map((p, i) => f(p, 60 - i));
    await expect(obtenerTendenciaScore('u1')).resolves.toBeNull();
  });

  it('serie continua de 8 días → compara contra hace 6 días, igual que antes', async () => {
    filasScore = Array.from({ length: 8 }, (_, i) => f('2026-09-' + String(30 - i).padStart(2, '0'), 70 - i));
    const t = await obtenerTendenciaScore('u1');
    expect(t).toEqual({ current: 70, previous: 64, diff: 6, trend: 'up' });
  });

  it('7 filas con huecos → la más reciente de hace ≥6 días, no data[6]', async () => {
    // 30, 29, 28, 25, 22, 21, 20: data[6] es el 20 (hace 10 días); la correcta es el 22 (hace 8)
    filasScore = [f('2026-09-30', 70), f('2026-09-29', 69), f('2026-09-28', 68), f('2026-09-25', 60),
      f('2026-09-22', 50), f('2026-09-21', 40), f('2026-09-20', 30)];
    const t = await obtenerTendenciaScore('u1');
    expect(t.previous).toBe(50);
    expect(t.diff).toBe(20);
  });

  it('la única fila anterior es de hace 5 días → null (no es "la semana pasada")', async () => {
    filasScore = [f('2026-09-30', 70), f('2026-09-25', 50)];
    await expect(obtenerTendenciaScore('u1')).resolves.toBeNull();
  });

  it('borde: exactamente hace 6 días → compara', async () => {
    filasScore = [f('2026-09-30', 70), f('2026-09-24', 75)];
    await expect(obtenerTendenciaScore('u1')).resolves.toEqual({ current: 70, previous: 75, diff: -5, trend: 'down' });
  });

  it('la única fila anterior es de hace 20 días → null (tampoco es la semana pasada)', async () => {
    filasScore = [f('2026-09-30', 70), f('2026-09-10', 50)];
    await expect(obtenerTendenciaScore('u1')).resolves.toBeNull();
  });

  it('borde: exactamente hace 13 días → compara; 14 → null', async () => {
    filasScore = [f('2026-09-30', 70), f('2026-09-17', 50)];
    expect((await obtenerTendenciaScore('u1')).previous).toBe(50);
    filasScore = [f('2026-09-30', 70), f('2026-09-16', 50)];
    await expect(obtenerTendenciaScore('u1')).resolves.toBeNull();
  });

  it('cruce de mes: 2026-10-02 contra 2026-09-26', async () => {
    filasScore = [f('2026-10-02', 70), f('2026-09-26', 61)];
    expect((await obtenerTendenciaScore('u1')).diff).toBe(9);
  });

  it('una sola fila → null', async () => {
    filasScore = [f('2026-09-30', 70)];
    await expect(obtenerTendenciaScore('u1')).resolves.toBeNull();
  });
});
