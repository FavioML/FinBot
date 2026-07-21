import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Regresion de los 3 bloques opcionales del resumen semanal (deudas, metas, sugerencia
// de meta). Estaban detras de `catch (e) { /* silent */ }`: si dejaban de renderizar,
// el mensaje seguia saliendo bien formado y nadie se enteraba. Ver
// docs/SESION-fallos-silenciosos.md.

// Stub de Supabase: registra la query y delega en un router configurable por test,
// para poder devolver { error } y verificar que ahora deja rastro en el log.
let router;
function makeChain(table) {
  const q = { table, select: null, methods: [] };
  const chain = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in']) {
    chain[m] = (...args) => {
      if (m === 'select') q.select = args[0];
      q.methods.push([m, ...args]);
      return chain;
    };
  }
  chain.then = (resolve) => resolve(router(q));
  return chain;
}

const dbMock = { supabase: { from: vi.fn((t) => makeChain(t)) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const txMock = { obtenerGastosSemana: vi.fn() };
const budgetMock = { obtenerPresupuestosMes: vi.fn().mockResolvedValue([]) };
const recomMock = {
  construirDatosUsuario: vi.fn().mockResolvedValue({}),
  generarMiniRecomendacion: vi.fn().mockReturnValue(null),
  generarRecomendaciones: vi.fn().mockResolvedValue(null),
};

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['services/transactions.js', txMock],
  ['services/budget.js', budgetMock],
  ['services/recommendations.js', recomMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// services/debts.js y services/metas.js corren de verdad (solo con el db stubbeado):
// son justamente el codigo que los catch silenciosos tapaban.
const { generarResumenSemanal } = require('../../services/summaries');

const USUARIO = { id: 'u1', nombre: 'Favio Mendoza', whatsapp: '51999' };

const dia = (offset) => new Date(Date.now() + offset * 86400000).toISOString().split('T')[0];

// Gasta 100 esta semana contra 300 la anterior: habilita el bloque 3 (sugerencia).
const GASTOS_SEMANA = [
  { fecha: dia(-1), monto: 40, monto_pen: 40, categoria: 'Alimentación', comercio: 'Wong' },
  { fecha: dia(-2), monto: 60, monto_pen: 60, categoria: 'Transporte', comercio: 'Uber' },
];
const GASTOS_ANTERIORES = [{ fecha: dia(-10), monto: 300, monto_pen: 300, categoria: 'Otros' }];
const DEUDAS = [
  // Dentro de la ventana [-3, +7] dias que exige el bloque de deudas.
  { id: 'd1', estado: 'activa', tipo: 'debo', contraparte: 'Interbank', monto_pendiente: 250.5, moneda: 'PEN', fecha_vencimiento: dia(2) },
  // Fuera de ventana: no debe aparecer.
  { id: 'd2', estado: 'activa', tipo: 'debo', contraparte: 'Lejana', monto_pendiente: 999, moneda: 'PEN', fecha_vencimiento: dia(40) },
];
const METAS = [{ id: 'm1', nombre: 'Viaje a Cusco', completada: false, monto_actual: 1200, monto_objetivo: 3000, fecha_limite: dia(120), created_at: new Date(Date.now() - 30 * 86400000).toISOString() }];

function routerOk(q) {
  if (q.table === 'transacciones') {
    const esSemanaAnterior = q.methods.some(m => m[0] === 'lt');
    return { data: esSemanaAnterior ? GASTOS_ANTERIORES : [{ monto: 100, monto_pen: 100 }], error: null };
  }
  if (q.table === 'metas_ahorro') return { data: q.select === 'nombre' ? [{ nombre: 'Viaje a Cusco' }] : METAS, error: null };
  if (q.table === 'deudas') return { data: DEUDAS, error: null };
  return { data: [], error: null };
}

beforeEach(() => {
  router = routerOk;
  logMock.error.mockClear();
  txMock.obtenerGastosSemana.mockResolvedValue(GASTOS_SEMANA);
});

describe('generarResumenSemanal — bloques opcionales', () => {
  it('devuelve null si no hubo gastos en la semana', async () => {
    txMock.obtenerGastosSemana.mockResolvedValue([]);
    expect(await generarResumenSemanal(USUARIO)).toBeNull();
  });

  it('renderiza el bloque de deudas solo con las que vencen en la ventana', async () => {
    const msg = await generarResumenSemanal(USUARIO);
    expect(msg).toContain('Deudas esta semana');
    expect(msg).toContain('Le debes a Interbank');
    expect(msg).toContain('250.50');
    expect(msg).not.toContain('Lejana');
  });

  it('renderiza el bloque de metas con el ritmo de ahorro', async () => {
    const msg = await generarResumenSemanal(USUARIO);
    expect(msg).toContain('Metas de ahorro');
    expect(msg).toContain('Viaje a Cusco');
    expect(msg).toContain('40%'); // 1200 / 3000
  });

  it('renderiza la sugerencia de meta cuando se gasto menos que la semana pasada', async () => {
    const msg = await generarResumenSemanal(USUARIO);
    expect(msg).toContain('¿Lo pones en tu meta de Viaje a Cusco?');
    expect(msg).toContain('S/ 200 menos'); // 300 - 100
  });

  it('no loguea errores cuando todo va bien', async () => {
    await generarResumenSemanal(USUARIO);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('generarResumenSemanal — los fallos de query dejan rastro', () => {
  it('loguea si la query de metas falla, y el resumen sigue saliendo', async () => {
    router = (q) => (q.table === 'metas_ahorro' && q.select === '*')
      ? { data: null, error: { message: 'column metas_ahorro.completada does not exist' } }
      : routerOk(q);

    const msg = await generarResumenSemanal(USUARIO);
    expect(msg).toContain('Resumen semanal');
    expect(msg).not.toContain('Metas de ahorro');
    const tags = logMock.error.mock.calls.map(c => c[0].tag);
    expect(tags).toContain('RESUMEN_SEM');
  });

  it('loguea si la query de deudas falla, y el resumen sigue saliendo', async () => {
    router = (q) => q.table === 'deudas'
      ? { data: null, error: { message: 'TypeError: fetch failed' } }
      : routerOk(q);

    const msg = await generarResumenSemanal(USUARIO);
    expect(msg).toContain('Resumen semanal');
    expect(msg).not.toContain('Deudas esta semana');
    const tags = logMock.error.mock.calls.map(c => c[0].tag);
    expect(tags).toContain('DEUDAS');
  });

  it('loguea si la query de la semana anterior falla', async () => {
    router = (q) => (q.table === 'transacciones' && q.methods.some(m => m[0] === 'lt'))
      ? { data: null, error: { message: 'statement timeout' } }
      : routerOk(q);

    const msg = await generarResumenSemanal(USUARIO);
    expect(msg).toContain('Resumen semanal');
    const tags = logMock.error.mock.calls.map(c => c[0].tag);
    expect(tags).toContain('RESUMEN_SEM');
  });
});
