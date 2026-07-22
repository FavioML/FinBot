import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

/**
 * Regresion de services/neto-score.js. El score es una media ponderada de 6 factores:
 * si una lectura cae y el factor devuelve su default, el score no falla, se MUEVE, y el
 * cron de las 6am persiste ese numero en neto_scores como si fuera cierto.
 *
 * Medido sobre un usuario modelo (registra casi a diario, dentro de presupuesto, ahorra
 * >20%, metas en ritmo, una deuda VENCIDA sin pagar, usa todas las herramientas):
 *   score sano 90
 *   sin transacciones -> 70 (-20, y el "punto mas debil" pasa a ser Consistencia)
 *   sin deudas        -> 98 (+8: el unico que falla HACIA ARRIBA, premiando la deuda vencida)
 *   sin visibilidad   -> 87/88
 *   todas menos deudas -> 62
 *
 * Ver docs/SESION-escrituras-sobre-lectura-fallida.md.
 */

let router;
function makeChain(table) {
  const q = { table, methods: [], head: false };
  const chain = {};
  for (const m of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in']) {
    chain[m] = (...a) => { q.methods.push([m, ...a]); return chain; };
  }
  chain.select = (cols, opts) => { q.cols = cols; if (opts && opts.head) q.head = true; return chain; };
  chain.single = () => { q.single = true; return chain; };
  chain.maybeSingle = () => { q.single = true; return chain; };
  chain.then = (resolve, reject) => Promise.resolve({ data: null, error: null, count: null, ...(router(q) || {}) }).then(resolve, reject);
  return chain;
}
const dbMock = { supabase: { from: (t) => ({ select: (...a) => makeChain(t).select(...a), upsert: () => makeChain(t) }) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
// Metas y recommendations sanas a proposito: aislamos las lecturas de neto-score.js.
const metasMock = {
  obtenerMetas: vi.fn().mockResolvedValue([{ id: 'm1' }]),
  calcularRitmoAhorro: () => ({ enRitmo: true, pctProgreso: 60 }),
};
const recomMock = {
  construirDatosUsuario: vi.fn().mockResolvedValue({
    presupuestos: [{ porcentaje_usado: 70 }, { porcentaje_usado: 80 }],
    mes_actual: { ingresos: 5000, gastos: 3500 },
  }),
};

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['services/metas.js', metasMock],
  ['services/recommendations.js', recomMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { calcularNetoScore, upsertScore, obtenerHistorialScore, obtenerTendenciaScore, obtenerScoreActual } = require('../../services/neto-score');

const FALLO = { data: null, error: { message: 'read failure', code: '500' }, count: null };
const dias = [];
for (let i = 0; i < 26; i++) { const d = new Date(); d.setDate(d.getDate() - i); dias.push({ fecha: d.toISOString().split('T')[0] }); }

const sano = (q) => {
  if (q.table === 'transacciones') return { data: dias };
  if (q.table === 'deudas') return { data: [{ id: 'd1', tipo: 'debo', monto_original: 1000, monto_pendiente: 1000, estado: 'activa', fecha_vencimiento: '2020-01-01' }] };
  if (q.table === 'presupuestos') return { count: 2 };
  if (q.table === 'metas_ahorro') return { count: 1 };
  if (q.table === 'usuarios') return { data: { gmail_access_token: 'tok', recordatorios_activos: true } };
  if (q.table === 'neto_scores') return { data: [] };
  return {};
};
const conFallo = (tabla) => (q) => q.table === tabla ? FALLO : sano(q);

beforeEach(() => {
  logMock.error.mockClear();
  router = sano;
});

describe('calcularNetoScore', () => {
  it('con todas las lecturas sanas da el score del usuario modelo', async () => {
    const r = await calcularNetoScore('u-1');
    expect(r.score).toBe(90);
    expect(r.factors.consistency).toBe(100);
    // Deuda vencida y sin un sol pagado: el factor tiene que castigar.
    expect(r.factors.debts).toBe(0);
  });

  it('corta si no puede leer las transacciones (restaba 20 puntos)', async () => {
    router = conFallo('transacciones');
    await expect(calcularNetoScore('u-1')).rejects.toThrow(/transacciones/i);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('corta si no puede leer las deudas (el unico que falla hacia arriba)', async () => {
    router = conFallo('deudas');
    await expect(calcularNetoScore('u-1')).rejects.toThrow(/deudas/i);
  });

  for (const tabla of ['presupuestos', 'metas_ahorro', 'usuarios']) {
    it(`corta si no puede leer ${tabla} (visibilidad a medias)`, async () => {
      router = conFallo(tabla);
      await expect(calcularNetoScore('u-1')).rejects.toThrow(/visibilidad/i);
    });
  }

  it('un usuario sin transacciones sigue dando consistencia 0 sin lanzar', async () => {
    router = (q) => q.table === 'transacciones' ? { data: [] } : sano(q);
    const r = await calcularNetoScore('u-1');
    expect(r.factors.consistency).toBe(0);
  });

  it('un usuario sin deudas sigue dando 80 sin lanzar', async () => {
    router = (q) => q.table === 'deudas' ? { data: [] } : sano(q);
    const r = await calcularNetoScore('u-1');
    expect(r.factors.debts).toBe(80);
  });
});

describe('upsertScore', () => {
  it('no persiste nada cuando un factor no se pudo leer', async () => {
    const escrituras = [];
    router = (q) => {
      if (q.table === 'neto_scores') { escrituras.push(q); return { data: { id: 's1' } }; }
      return conFallo('transacciones')(q);
    };
    await expect(upsertScore('u-1')).resolves.toBeNull();
    expect(escrituras).toHaveLength(0);
  });

  it('persiste el score cuando todo se leyo bien', async () => {
    router = (q) => q.table === 'neto_scores' ? { data: { id: 's1', score: 90 } } : sano(q);
    await expect(upsertScore('u-1')).resolves.toEqual({ id: 's1', score: 90 });
  });
});

describe('lecturas de presentacion', () => {
  it('el historial corta en vez de decir "no tienes historial"', async () => {
    router = conFallo('neto_scores');
    await expect(obtenerHistorialScore('u-1')).rejects.toThrow(/historial/i);
  });

  it('el historial vacio de verdad sigue devolviendo []', async () => {
    router = () => ({ data: [] });
    await expect(obtenerHistorialScore('u-1')).resolves.toEqual([]);
  });

  it('la tendencia devuelve null y loguea (no muestra un numero falso)', async () => {
    router = conFallo('neto_scores');
    await expect(obtenerTendenciaScore('u-1')).resolves.toBeNull();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('obtenerScoreActual distingue "todavia no tiene score" de una lectura caida', async () => {
    router = () => ({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
    await expect(obtenerScoreActual('u-1')).resolves.toBeNull();
    router = conFallo('neto_scores');
    await expect(obtenerScoreActual('u-1')).rejects.toThrow(/score/i);
  });
});
