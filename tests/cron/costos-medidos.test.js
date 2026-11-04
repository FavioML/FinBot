import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * La lectura mensual de los costos con medidor (Meta, OpenAI) dentro de `checkRecordatoriosCostos`.
 *
 * Lo que se protege, en orden:
 *  1. Una lectura que falla NO deja monto ni avanza la fecha: un estimado en el P&L se lee igual
 *     que uno medido, y avanzar la fecha perdería ese mes para siempre.
 *  2. El tipo de cambio inventado cuenta como fallo, por el mismo motivo.
 *  3. Un mes ya registrado no se duplica.
 *  4. El fallo se avisa una vez por día, no en cada tick.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

let filas = [];
let errorUpdate = null;
let updates = [];

function chain() {
  const c = {};
  for (const m of ['select', 'eq', 'lte', 'in']) c[m] = () => c;
  c.then = (resolve) => resolve({ data: filas, error: null });
  return c;
}
const dbMock = {
  supabase: {
    from: () => ({
      ...chain(),
      update: (patch) => {
        const u = { patch, ids: null };
        updates.push(u);
        const c = {
          eq: (_col, id) => { u.ids = [id]; return c; },
          in: (_col, ids) => { u.ids = ids; return c; },
          then: (resolve) => resolve({ error: errorUpdate }),
        };
        return c;
      },
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const notificarAdmin = vi.fn();
const medirCosto = vi.fn();
const obtenerTipoCambio = vi.fn();

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/admin-notify.js', { notificarAdmin }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const metersPath = require.resolve(path.join(projectRoot, 'lib/cost-meters.js'));
const metersReal = require(metersPath);
require.cache[metersPath] = { id: metersPath, filename: metersPath, loaded: true, exports: { ...metersReal, medirCosto } };
const txPath = require.resolve(path.join(projectRoot, 'services/transactions.js'));
const txReal = require(txPath);
require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: { ...txReal, obtenerTipoCambio } };

const checks = require('../../cron/checks');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });
const enLima = (iso) => new Date(iso + '-05:00');

const META = {
  id: 'meta', label: 'Meta WhatsApp', meter: 'meta_whatsapp', amount_pen: 0, currency: 'USD',
  amount_original: 0, frequency: 'monthly', next_due_date: '2026-12-01', active: true,
  auto_debit: true, last_reminder_sent_at: null,
  paid_history: [{ paid_at: '2026-11-01', amount_pen: 54.32, marked_by: 'meter:meta_whatsapp' }],
};
const LECTURA = { desde: '2026-11-01', hasta: '2026-12-01', usd: 10, impuesto: 0.18, etiqueta: 'Meta WhatsApp', detalle: '1300 mensajes, 300 cobrados' };

beforeEach(() => {
  vi.setSystemTime(enLima('2026-12-01T09:05:00'));
  filas = [{ ...META }];
  errorUpdate = null;
  updates = [];
  notificarAdmin.mockReset();
  logMock.error.mockClear();
  medirCosto.mockReset().mockResolvedValue({ ...LECTURA });
  obtenerTipoCambio.mockReset().mockResolvedValue({ venta: 3.4, compra: 3.39, fuente: 'dolar.pe' });
});

/** El update que escribió el consumo (el único que trae next_due_date). */
const updateDelConsumo = () => updates.find((u) => 'next_due_date' in u.patch);

describe('lectura mensual de un costo con medidor', () => {
  it('registra el consumo del mes anterior y avanza la fecha un mes', async () => {
    await checks.checkRecordatoriosCostos();
    expect(medirCosto).toHaveBeenCalledTimes(1);
    const u = updateDelConsumo();
    expect(u.ids).toEqual(['meta']);
    // 10 * 1.18 * 3.4 = 40.12
    expect(u.patch.paid_history).toEqual([
      META.paid_history[0],
      { paid_at: '2026-12-01', amount_pen: 40.12, marked_by: 'meter:meta_whatsapp' },
    ]);
    expect(u.patch.next_due_date).toBe('2027-01-01');
    expect(u.patch.amount_pen).toBe(40.12);
    expect(u.patch.amount_original).toBe(11.8);
    const msg = notificarAdmin.mock.calls[0][0];
    expect(msg).toContain('Consumo medido del mes pasado');
    expect(msg).toContain('Meta WhatsApp (2026-11) — S/ 40.12 ($11.80) · 1300 mensajes, 300 cobrados');
  });

  it('no mide antes de su fecha', async () => {
    vi.setSystemTime(enLima('2026-11-30T09:05:00'));
    await checks.checkRecordatoriosCostos();
    expect(medirCosto).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('una lectura que falla no registra ni avanza, y avisa', async () => {
    medirCosto.mockRejectedValue(new Error('Meta: Invalid OAuth access token'));
    await checks.checkRecordatoriosCostos();
    expect(updateDelConsumo()).toBeUndefined();
    const msg = notificarAdmin.mock.calls[0][0];
    expect(msg).toContain('No pude medir');
    expect(msg).toContain('Invalid OAuth access token');
    expect(logMock.error.mock.calls.some((c) => c[0].tag === 'COSTOS_REMIND')).toBe(true);
    // Queda sellado el aviso de hoy, para no repetirlo en otro tick.
    expect(updates.some((u) => 'last_reminder_sent_at' in u.patch && u.ids.includes('meta'))).toBe(true);
  });

  it('un fallo ya avisado hoy no se vuelve a avisar', async () => {
    filas = [{ ...META, last_reminder_sent_at: enLima('2026-12-01T09:00:30').toISOString() }];
    medirCosto.mockRejectedValue(new Error('caído'));
    await checks.checkRecordatoriosCostos();
    expect(notificarAdmin).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('el tipo de cambio inventado es un fallo, no un monto', async () => {
    obtenerTipoCambio.mockResolvedValue({ venta: 3.85, compra: 3.82, fuente: 'fallback' });
    await checks.checkRecordatoriosCostos();
    expect(updateDelConsumo()).toBeUndefined();
    expect(notificarAdmin.mock.calls[0][0]).toContain('sin tipo de cambio real');
  });

  it('un mes ya registrado no se duplica: solo avanza la fecha', async () => {
    filas = [{ ...META, paid_history: [...META.paid_history, { paid_at: '2026-12-01', amount_pen: 39, marked_by: 'admin' }] }];
    await checks.checkRecordatoriosCostos();
    const u = updateDelConsumo();
    expect(u.patch.paid_history).toBeUndefined();
    expect(u.patch.next_due_date).toBe('2027-01-01');
  });

  it('si el guardado falla, avisa el fallo en vez de anunciar el registro', async () => {
    errorUpdate = { message: 'boom' };
    await checks.checkRecordatoriosCostos();
    const msg = notificarAdmin.mock.calls[0][0];
    expect(msg).not.toContain('Consumo medido');
    expect(msg).toContain('no se pudo guardar: boom');
  });

  it('un monto que no es un número no llega al P&L', async () => {
    medirCosto.mockResolvedValue({ ...LECTURA, usd: NaN });
    await checks.checkRecordatoriosCostos();
    expect(updateDelConsumo()).toBeUndefined();
    expect(notificarAdmin.mock.calls[0][0]).toContain('monto inválido');
  });

  it('un mes sin consumo registra cero: es una lectura, no un fallo', async () => {
    medirCosto.mockResolvedValue({ ...LECTURA, usd: 0, detalle: '980 mensajes, 0 cobrados' });
    await checks.checkRecordatoriosCostos();
    expect(updateDelConsumo().patch.paid_history.at(-1)).toEqual({ paid_at: '2026-12-01', amount_pen: 0, marked_by: 'meter:meta_whatsapp' });
  });

  it('una fila pausada no se mide', async () => {
    filas = [{ ...META, active: false }];
    await checks.checkRecordatoriosCostos();
    expect(medirCosto).not.toHaveBeenCalled();
  });
});
