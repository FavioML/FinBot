import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * `generarResumenDiario` tiene dos lectores desde el 14-sep-2026: Manos Libres (la salida de
 * siempre) y el cierre del día de la prueba (`{ cierre: true }`).
 *
 * El primer bloque FIJA la salida de Manos Libres byte a byte. No puede fallar contra el código
 * viejo, y no es su trabajo: su trabajo es que la variante nueva no le cambie una coma a quien
 * ya lo recibe todas las noches.
 *
 * El segundo bloque es el que importa del cambio: el pie de Manos Libres dice "para pausar
 * escribe /manoslibres", y ese comando es un toggle — en el cierre de alguien que no lo tiene,
 * esa línea se lo PRENDERÍA.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

let txs = [];

function makeChain() {
  const filtros = [];
  const c = {};
  c.select = () => c;
  c.eq = (col, v) => { filtros.push((f) => f[col] === v); return c; };
  c.then = (ok, ko) => Promise.resolve({ data: txs.filter((f) => filtros.every((p) => p(f))), error: null }).then(ok, ko);
  return c;
}

const dbMock = { supabase: { from: () => makeChain() } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
logMock.child = () => logMock;
for (const [rel, exports] of [['lib/db.js', dbMock], ['lib/logger.js', logMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { generarResumenDiario } = require('../../services/summaries');

const HOY = '2026-09-14';
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-09-15T02:05:00Z')); // 21:05 Lima del 14
afterAll(() => { vi.useRealTimers(); });

const ANA = { id: 'u1', nombre: 'Ana Pérez' };
const gasto = (monto, categoria, comercio, extra = {}) => ({ usuario_id: 'u1', tipo: 'gasto', fecha: HOY, monto, monto_pen: null, categoria, comercio, ...extra });

beforeEach(() => { txs = []; });

describe('Manos Libres: la salida por defecto no cambia', () => {
  it('byte a byte, con dos gastos', async () => {
    txs = [gasto('30.00', 'Alimentación', 'Tambo'), gasto('12.50', 'Transporte', 'Taxi')];
    // La fecha se arma con la MISMA expresión que el código: el nombre del día depende del ICU
    // de la máquina, y lo que se fija acá es el formato, no el ICU.
    const fechaLarga = new Date(HOY + 'T12:00:00').toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'short' });
    expect(await generarResumenDiario(ANA)).toBe(
      '🌙 *Resumen de hoy, Ana*\n' +
      '_' + fechaLarga + '_\n' +
      '---------------\n\n' +
      '💸 *Gastaste:* S/ 42.50 en 2 movimientos\n' +
      '\n' +
      '🥇 Alimentación: *S/ 30.00*\n' +
      '🥈 Transporte: *S/ 12.50*\n' +
      '\n🔝 *Mayor gasto:* Tambo (S/ 30.00)\n' +
      '\n_Si algo está mal, dime "cambia Tambo a [categoría]"._\n' +
      '_Para pausar el resumen diario escribe /manoslibres._',
    );
  });

  it('sin gastos de hoy: null', async () => {
    txs = [gasto('30.00', 'Alimentación', 'Tambo', { fecha: '2026-09-13' })];
    expect(await generarResumenDiario(ANA)).toBeNull();
  });
});

describe('el cierre de la prueba ({ cierre: true })', () => {
  it('con un gasto: una línea, sin podio', async () => {
    txs = [gasto('12.50', 'Transporte', 'Taxi')];
    expect(await generarResumenDiario(ANA, { cierre: true })).toBe(
      '🌙 *Tu cierre de hoy, Ana*\n\nHoy anotaste 1 gasto: *S/ 12.50* en Transporte (Taxi).',
    );
  });

  it('con un gasto sin comercio, sin paréntesis vacíos', async () => {
    txs = [gasto('12.50', 'Transporte', null)];
    expect(await generarResumenDiario(ANA, { cierre: true })).toBe(
      '🌙 *Tu cierre de hoy, Ana*\n\nHoy anotaste 1 gasto: *S/ 12.50* en Transporte.',
    );
  });

  it('con varios: el resumen sin el pie de Manos Libres', async () => {
    txs = [gasto('30.00', 'Alimentación', 'Tambo'), gasto('12.50', 'Transporte', 'Taxi'),
      { usuario_id: 'u1', tipo: 'ingreso', fecha: HOY, monto: '100.00', monto_pen: null }];
    const r = await generarResumenDiario(ANA, { cierre: true });
    expect(r.startsWith('🌙 *Tu cierre de hoy, Ana*')).toBe(true);
    expect(r).toContain('💸 *Gastaste:* S/ 42.50 en 2 movimientos');
    expect(r).toContain('💵 *Ingresos:* S/ 100.00');
    expect(r).toContain('🔝 *Mayor gasto:* Tambo (S/ 30.00)');
    expect(r).not.toContain('/manoslibres');
    expect(r).not.toContain('Si algo está mal');
    expect(r).toBe(r.trimEnd());
  });

  it('sin gastos de hoy: null, igual que Manos Libres', async () => {
    expect(await generarResumenDiario(ANA, { cierre: true })).toBeNull();
  });
});
