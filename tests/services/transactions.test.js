import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

// Inyección de un supabase stub en lib/db vía require.cache — mismo patrón que
// tests/services/recommendations-prompt.test.js. El `vi.mock('@supabase/supabase-js')`
// NO sirve acá: el cliente ya está instanciado dentro de lib/db al cargar, así que
// guardarTransaccion pegaba a la red real (test.supabase.co) en vez del mock.
const require = createRequire(import.meta.url);
const APP = path.join(import.meta.dirname, '..', '..');

// Captura los payloads que llegan a `.insert(...)` para afirmar qué fecha se persiste.
const inserts = [];
function makeStub() {
  const q = {
    select: () => q, update: () => q, upsert: () => q, delete: () => q,
    eq: () => q, ilike: () => q, gte: () => q, lte: () => q, order: () => q,
    neq: () => q, is: () => q, not: () => q,
    insert: (payload) => { inserts.push(payload); return q; },
    limit: () => Promise.resolve({ data: [] }),      // dedup hace await sobre .limit(5)
    single: () => Promise.resolve({ data: null }),
    maybeSingle: () => Promise.resolve({ data: null }),
  };
  return { from: () => q };
}

function loadTx() {
  const dbPath = require.resolve(path.join(APP, 'lib', 'db.js'));
  const txPath = require.resolve(path.join(APP, 'services', 'transactions.js'));
  delete require.cache[txPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: makeStub() } };
  return require(txPath);
}

const { DEDUP_WINDOW_MS, guardarTransaccion } = loadTx();
const { hoyPeru } = require(path.join(APP, 'lib', 'dates.js'));

// Nota: los tests de necesitaConsulta/mensajeConsulta se eliminaron junto con el flujo
// de consultas pendientes (el bot ya no pide categorizar por WhatsApp; la categoria se
// revisa y ajusta en app.neto.pe).

describe('dedup window (str-001/002)', () => {
  it('uses a short dedup window (≤30s) so rapid manual entries are not collapsed', () => {
    // Was 5min (300_000ms); legitimate rapid entries collided into one row.
    // Webhook double-fires retry within seconds, so a much shorter window suffices.
    expect(DEDUP_WINDOW_MS).toBeLessThanOrEqual(30 * 1000);
    expect(DEDUP_WINDOW_MS).toBeGreaterThan(0);
  });
});

// Guard de fecha futura (2026-07-24): Neto registra ACTUALES. Una tx con fecha futura
// (un ingreso tipeado con el año siguiente) se colaba y, sin cota superior de mes en
// construirDatosUsuario, el cron la metía en el mes en curso e inflaba el savings del
// Neto Score. `guardarTransaccion` es el chokepoint único del backend (NLP, manual,
// imagen, Excel, Gmail): clampea a hoy en vez de rechazar para no perder el movimiento.
describe('guardarTransaccion — guard de fecha futura', () => {
  beforeEach(() => { inserts.length = 0; });

  it('clampea una fecha futura al día de hoy (Lima)', async () => {
    await guardarTransaccion('u1', { monto: 5200, tipo: 'ingreso', comercio: 'GORE', fecha: '2099-07-03' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].fecha).toBe(hoyPeru());
  });

  it('NO toca una fecha pasada ni la de hoy', async () => {
    await guardarTransaccion('u1', { monto: 100, tipo: 'gasto', comercio: 'Tienda', fecha: '2020-01-01' });
    expect(inserts[0].fecha).toBe('2020-01-01');
    inserts.length = 0;
    const hoy = hoyPeru();
    await guardarTransaccion('u1', { monto: 100, tipo: 'gasto', comercio: 'Tienda', fecha: hoy });
    expect(inserts[0].fecha).toBe(hoy);
  });

  it('sin fecha usa hoy (comportamiento previo intacto)', async () => {
    await guardarTransaccion('u1', { monto: 100, tipo: 'gasto', comercio: 'Tienda' });
    expect(inserts[0].fecha).toBe(hoyPeru());
  });
});
