import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Patrón del repo (ver tests/setup.js): vi.mock NO intercepta la cadena require de
// CJS, así que cargamos el singleton real de lib/db y parcheamos `supabase.from`.
// budget.js hace `const { supabase } = require('../lib/db')` → sostiene la MISMA
// referencia al objeto, por lo que mutar `.from` propaga a sus queries.
const db = require('../../lib/db');

// Resultado preseteado por tabla. Cada query lo resuelve (builder thenable).
const DB_RESULTS = {};
function makeBuilder(table) {
  const result = DB_RESULTS[table] || { data: [] };
  const builder = {
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    upsert: () => builder,
    eq: () => builder,
    is: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve({ data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data }),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}
db.supabase.from = (table) => makeBuilder(table);

vi.mock('dotenv', () => ({ config: vi.fn() }));

const budget = await import('../../services/budget.js');

beforeEach(() => {
  for (const k of Object.keys(DB_RESULTS)) delete DB_RESULTS[k];
});

describe('services/budget exports', () => {
  it('exporta guardarPresupuesto', () => {
    expect(typeof budget.guardarPresupuesto).toBe('function');
  });

  it('exporta obtenerPresupuestosMes', () => {
    expect(typeof budget.obtenerPresupuestosMes).toBe('function');
  });

  it('exporta verificarAlertaPresupuesto', () => {
    expect(typeof budget.verificarAlertaPresupuesto).toBe('function');
  });

  it('exporta formatearEstadoPresupuesto', () => {
    expect(typeof budget.formatearEstadoPresupuesto).toBe('function');
  });
});

describe('presupuestos: gasto en USD cuenta por monto_pen, no por monto', () => {
  it('un gasto de $100 USD (monto_pen 380) cuenta 380 soles contra el presupuesto', async () => {
    // Presupuesto de Comida S/500 y un unico gasto USD: monto=100, monto_pen=380.
    DB_RESULTS['presupuestos'] = { data: [{ categoria: 'Comida', monto_limite: 500 }] };
    DB_RESULTS['transacciones'] = { data: [{ monto: 100, monto_pen: 380, categoria: 'Comida' }] };

    const msg = await budget.formatearEstadoPresupuesto('user-1');

    // Debe reflejar 380 (soles convertidos), NO 100 (monto en dolares).
    expect(msg).toContain('S/ 380.00');
    expect(msg).not.toContain('S/ 100.00');
    // Resta = 500 - 380 = 120.
    expect(msg).toContain('S/ 120.00');
  });

  it('cae a monto cuando monto_pen es null (filas viejas / PEN sin convertir)', async () => {
    DB_RESULTS['presupuestos'] = { data: [{ categoria: 'Comida', monto_limite: 500 }] };
    DB_RESULTS['transacciones'] = { data: [{ monto: 250, monto_pen: null, categoria: 'Comida' }] };

    const msg = await budget.formatearEstadoPresupuesto('user-1');

    expect(msg).toContain('S/ 250.00');
  });

  it('verificarAlertaPresupuesto usa monto_pen para el % del límite', async () => {
    // Límite S/300, gasto USD monto=100 / monto_pen=380 → 126% → alerta de superado.
    DB_RESULTS['presupuestos'] = { data: [{ categoria: 'Comida', monto_limite: 300, alerta_porcentaje: 80 }] };
    DB_RESULTS['transacciones'] = { data: [{ monto: 100, monto_pen: 380, categoria: 'Comida', subcategoria: null }] };

    // La firma pide la FILA del usuario, no su id: la alerta es una lectura agregada y se
    // gatea contra el muro dentro de la propia función (B9). Un Pro pagado la ve.
    const alerta = await budget.verificarAlertaPresupuesto(
      { id: 'user-1', plan: 'premium', trial_estado: 'convertido' }, 'Comida', null);

    // Con monto_pen (380) supera el límite (300); con monto (100) no llegaría al 80%.
    expect(alerta).toContain('superado');
    expect(alerta).toContain('S/ 380.00');
  });
});

describe('guardarPresupuesto — guard de monto (era el único write de dinero sin validarMonto)', () => {
  it('rechaza montos inválidos sin escribir a la DB', async () => {
    let upsertLlamado = false;
    const original = db.supabase.from;
    db.supabase.from = () => ({ upsert: () => { upsertLlamado = true; return makeBuilder('presupuestos'); } });
    try {
      for (const malo of [-500, 0, 1000000, Infinity, NaN, 'abc']) {
        await expect(budget.guardarPresupuesto('u1', 'Comida', malo)).rejects.toThrow(/inválido/i);
      }
      expect(upsertLlamado).toBe(false);
    } finally {
      db.supabase.from = original;
    }
  });

  it('acepta los límites válidos y persiste el monto redondeado a 2 decimales', async () => {
    const payloads = [];
    const original = db.supabase.from;
    db.supabase.from = () => ({
      upsert: (p) => { payloads.push(p); return { select: () => ({ single: () => Promise.resolve({ data: { id: 'p1' }, error: null }) }) }; },
    });
    try {
      await budget.guardarPresupuesto('u1', 'Comida', 999999.99);
      await budget.guardarPresupuesto('u1', 'Comida', '123.456');
      expect(payloads[0].monto_limite).toBe(999999.99);
      expect(payloads[1].monto_limite).toBe(123.46);
    } finally {
      db.supabase.from = original;
    }
  });
});
