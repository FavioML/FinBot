import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Los crons de resumen filtraban `plan = premium AND gmail_access_token IS NOT NULL`.
// El resumen se arma con transacciones, presupuestos, metas y deudas: no toca Gmail.
// Ese filtro dejaba sin resumen a la mayoria de usuarios Pro y no habia forma de notarlo
// (el cron corria, no fallaba, simplemente no encontraba a nadie).
// Ver docs/SESION-fallos-silenciosos.md.

let usuariosQuery;   // ultima query hecha sobre la tabla usuarios
let usuariosData;

function makeChain(table) {
  const q = { table, methods: [] };
  const chain = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in']) {
    chain[m] = (...args) => { q.methods.push([m, ...args]); return chain; };
  }
  chain.then = (resolve) => {
    if (table === 'usuarios') { usuariosQuery = q; return resolve({ data: usuariosData, error: null }); }
    return resolve({ data: [], error: null });
  };
  return chain;
}

const dbMock = { supabase: { from: vi.fn((t) => makeChain(t)) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue(true) };
const notifMock = { crearNotificacion: vi.fn().mockResolvedValue(true) };
const summariesMock = {
  generarResumenSemanal: vi.fn().mockResolvedValue('RESUMEN SEMANAL'),
  generarResumenMensual: vi.fn().mockResolvedValue('RESUMEN MENSUAL'),
  generarResumenDiario: vi.fn().mockResolvedValue(null),
};

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/notifications-db.js', notifMock],
  ['services/summaries.js', summariesMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { checkResumenSemanal, checkResumenMensual } = require('../../cron/checks');

const PRO_CON_GMAIL = { id: 'u1', nombre: 'Con Gmail', whatsapp: '51111', plan: 'premium', gmail_access_token: 'ya29.token' };
const PRO_SIN_GMAIL = { id: 'u2', nombre: 'Sin Gmail', whatsapp: '51222', plan: 'premium', gmail_access_token: null };

// Solo falseamos Date: los crons se auto-gatillan por hora y no usamos temporizadores.
vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

beforeEach(() => {
  usuariosQuery = null;
  usuariosData = [PRO_CON_GMAIL, PRO_SIN_GMAIL];
  waMock.enviarWhatsapp.mockClear();
  notifMock.crearNotificacion.mockClear();
  summariesMock.generarResumenSemanal.mockClear();
  summariesMock.generarResumenMensual.mockClear();
});

describe('checkResumenSemanal — a quien le llega', () => {
  // Lunes 08:05 hora Lima (13:05 UTC).
  const LUNES_8AM = '2026-07-20T13:05:00Z';

  it('no hace nada fuera de la ventana horaria', async () => {
    vi.setSystemTime(new Date('2026-07-20T19:00:00Z'));
    await checkResumenSemanal();
    expect(usuariosQuery).toBeNull();
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('NO filtra por gmail_access_token', async () => {
    vi.setSystemTime(new Date(LUNES_8AM));
    await checkResumenSemanal();
    expect(usuariosQuery).not.toBeNull();
    const columnasFiltradas = usuariosQuery.methods.flat();
    expect(columnasFiltradas).not.toContain('gmail_access_token');
  });

  it('sigue restringido al plan premium', async () => {
    vi.setSystemTime(new Date(LUNES_8AM));
    await checkResumenSemanal();
    expect(usuariosQuery.methods).toContainEqual(['eq', 'plan', 'premium']);
  });

  it('envia el resumen al usuario Pro que no tiene Gmail conectado', async () => {
    vi.setSystemTime(new Date(LUNES_8AM));
    await checkResumenSemanal();
    const destinatarios = waMock.enviarWhatsapp.mock.calls.map(c => c[0]);
    expect(destinatarios).toContain(PRO_SIN_GMAIL.whatsapp);
    expect(destinatarios).toContain(PRO_CON_GMAIL.whatsapp);
    expect(notifMock.crearNotificacion).toHaveBeenCalledTimes(2);
  });

  it('no manda nada si el usuario no tiene movimientos (resumen null)', async () => {
    vi.setSystemTime(new Date(LUNES_8AM));
    summariesMock.generarResumenSemanal.mockResolvedValue(null);
    await checkResumenSemanal();
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });
});

describe('checkResumenMensual — a quien le llega', () => {
  // Dia 1 a las 09:05 hora Lima (14:05 UTC).
  const DIA_1_9AM = '2026-07-01T14:05:00Z';

  it('NO filtra por gmail_access_token', async () => {
    vi.setSystemTime(new Date(DIA_1_9AM));
    await checkResumenMensual();
    expect(usuariosQuery).not.toBeNull();
    expect(usuariosQuery.methods.flat()).not.toContain('gmail_access_token');
  });

  it('envia el resumen al usuario Pro que no tiene Gmail conectado', async () => {
    vi.setSystemTime(new Date(DIA_1_9AM));
    await checkResumenMensual();
    const destinatarios = waMock.enviarWhatsapp.mock.calls.map(c => c[0]);
    expect(destinatarios).toContain(PRO_SIN_GMAIL.whatsapp);
  });
});
