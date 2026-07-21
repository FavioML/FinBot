import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

/**
 * El balance que Neto reporta por WhatsApp ("ver balance espacio") y el que usa
 * el cron de recordatorios de los viernes salen de aca. Antes esta funcion
 * ignoraba por completo `split_rules` y dividia todo en partes iguales, asi que
 * daba numeros distintos a los del dashboard para el mismo espacio.
 *
 * Ahora lee la division congelada de cada gasto. Lo que fija esta suite: los
 * balances de un espacio suman cero, y la deuda de un ex-miembro no se evapora.
 */

// Tabla -> filas. Cada test lo llena antes de llamar.
const TABLAS = {};

function makeChain(tabla) {
  const chain = {};
  for (const m of ['select', 'eq', 'gte', 'neq', 'limit', 'order', 'insert', 'update', 'delete']) {
    chain[m] = () => chain;
  }
  chain.single = () => Promise.resolve({ data: (TABLAS[tabla] || [])[0] || null });
  chain.then = (resolve) => resolve({ data: TABLAS[tabla] || [] });
  return chain;
}

const dbMock = { supabase: { from: vi.fn((tabla) => makeChain(tabla)) } };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue(true) };

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
const waPath = require.resolve(path.join(projectRoot, 'lib/whatsapp.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: waMock };

const { obtenerBalanceEspacio } = require('../../services/shared-spaces');
const { buildSplitSnapshot } = require('../../services/spaces-split');

const sumaBalances = (balances) => balances.reduce((s, b) => s + b.balance, 0);

beforeEach(() => {
  for (const k of Object.keys(TABLAS)) delete TABLAS[k];
});

describe('obtenerBalanceEspacio', () => {
  it('reparte segun la division congelada, no en partes iguales', async () => {
    // Regla 70/30 congelada al registrar. El motor viejo habria dicho 50/50.
    const miembros = [
      { user_id: 'a', split_percentage: 50 },
      { user_id: 'b', split_percentage: 50 },
    ];
    const snapshot = buildSplitSnapshot(100, 'Comida', miembros, [
      { id: 'r1', category: 'Comida', splits: { a: 70, b: 30 } },
    ]);

    TABLAS.space_members = [
      { user_id: 'a', usuarios: { nombre: 'Ana' } },
      { user_id: 'b', usuarios: { nombre: 'Beto' } },
    ];
    TABLAS.space_expenses = [{ paid_by: 'a', amount: '100.00', split_snapshot: snapshot }];
    TABLAS.space_settlements = [];

    const { balances, debts } = await obtenerBalanceEspacio('sp1');
    const porId = Object.fromEntries(balances.map((b) => [b.userId, b.balance]));
    expect(porId.a).toBeCloseTo(30);
    expect(porId.b).toBeCloseTo(-30);
    expect(sumaBalances(balances)).toBeCloseTo(0);
    expect(debts).toEqual([{ from: 'b', fromNombre: 'Beto', to: 'a', toNombre: 'Ana', amount: 30 }]);
  });

  it('la liquidacion deja el espacio en cero y sin deudas', async () => {
    const miembros = [
      { user_id: 'a', split_percentage: 50 },
      { user_id: 'b', split_percentage: 50 },
    ];
    TABLAS.space_members = [
      { user_id: 'a', usuarios: { nombre: 'Ana' } },
      { user_id: 'b', usuarios: { nombre: 'Beto' } },
    ];
    TABLAS.space_expenses = [
      { paid_by: 'a', amount: '100.00', split_snapshot: buildSplitSnapshot(100, null, miembros, []) },
    ];
    TABLAS.space_settlements = [{ from_user: 'b', to_user: 'a', amount: '50.00' }];

    const { balances, debts } = await obtenerBalanceEspacio('sp1');
    expect(sumaBalances(balances)).toBeCloseTo(0);
    expect(debts).toEqual([]);
  });

  it('la deuda de un ex-miembro no se evapora', async () => {
    // Si el balance se armara solo con los miembros ACTUALES, el debito del
    // removido desapareceria y "a" quedaria acreditado por plata que nadie debe.
    const alRegistrar = [
      { user_id: 'a', split_percentage: 50 },
      { user_id: 'removido', split_percentage: 50 },
    ];
    TABLAS.space_members = [{ user_id: 'a', usuarios: { nombre: 'Ana' } }];
    TABLAS.space_expenses = [
      { paid_by: 'a', amount: '100.00', split_snapshot: buildSplitSnapshot(100, null, alRegistrar, []) },
    ];
    TABLAS.space_settlements = [];

    const { balances } = await obtenerBalanceEspacio('sp1');
    const porId = Object.fromEntries(balances.map((b) => [b.userId, b.balance]));
    expect(porId.removido).toBeCloseTo(-50);
    expect(sumaBalances(balances)).toBeCloseTo(0);
  });

  it('con 3 miembros y montos que no dividen exacto sigue sumando cero', async () => {
    const miembros = [
      { user_id: 'a', split_percentage: 50 },
      { user_id: 'b', split_percentage: 30 },
      { user_id: 'c', split_percentage: 20 },
    ];
    TABLAS.space_members = miembros.map((m) => ({ user_id: m.user_id, usuarios: { nombre: m.user_id } }));
    TABLAS.space_expenses = [100.03, 0.01, 33.33].map((amount, i) => ({
      paid_by: ['a', 'b', 'c'][i],
      amount: String(amount),
      split_snapshot: buildSplitSnapshot(amount, null, miembros, []),
    }));
    TABLAS.space_settlements = [];

    const { balances, debts } = await obtenerBalanceEspacio('sp1');
    expect(sumaBalances(balances)).toBeCloseTo(0, 10);
    // Ningun acreedor cobra mas de lo que se le debe.
    for (const b of balances) {
      if (b.balance <= 0) continue;
      const cobra = debts.filter((d) => d.to === b.userId).reduce((s, d) => s + d.amount, 0);
      expect(cobra).toBeLessThanOrEqual(b.balance + 0.01);
    }
  });

  it('un espacio sin miembros no explota', async () => {
    TABLAS.space_members = [];
    TABLAS.space_expenses = [];
    TABLAS.space_settlements = [];
    expect(await obtenerBalanceEspacio('sp1')).toEqual({ balances: [], debts: [] });
  });

  it('un gasto sin snapshot no filtra plata al resto del grupo', async () => {
    // Fila anterior al congelamiento (o escrita por un camino que se lo salto).
    TABLAS.space_members = [
      { user_id: 'a', usuarios: { nombre: 'Ana' } },
      { user_id: 'b', usuarios: { nombre: 'Beto' } },
    ];
    TABLAS.space_expenses = [{ paid_by: 'a', amount: '100.00', split_snapshot: null }];
    TABLAS.space_settlements = [];

    const { balances, debts } = await obtenerBalanceEspacio('sp1');
    expect(sumaBalances(balances)).toBeCloseTo(0);
    expect(debts).toEqual([]);
  });
});
