import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

// Tests de caracterizacion del comportamiento ACTUAL de detectarSuscripciones y
// matchCatalogo. Fijan el shape que consumen cron/checks.js y services/recommendations.js
// ANTES de modularizar el servicio, para que el movimiento de codigo sea verificable.
// Patron de mocking: inyeccion via require.cache (igual que notifications.test.js).

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

// Estado mutable que cada test configura antes de llamar al servicio.
const state = { txs: [], gteArg: null, error: null };

// Chain de Supabase awaitable. El servicio hace:
//   from('transacciones').select(..).eq('usuario_id',id).eq('tipo','gasto').gte('fecha',desde).order('fecha',..)
// y lo awaitea -> resolvemos { data, error }. Capturamos el arg de .gte para
// caracterizar la ventana temporal de 3 meses.
function makeChain() {
  const chain = {};
  for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
  chain.gte = (_col, val) => { state.gteArg = val; return chain; };
  chain.then = (resolve) => resolve({ data: state.txs, error: state.error });
  return chain;
}

const dbMock = { supabase: { from: vi.fn(() => makeChain()) } };
const txMock = { obtenerTipoCambio: vi.fn().mockResolvedValue({ compra: 3.82, venta: 3.85 }) };

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
const txPath = require.resolve(path.join(projectRoot, 'services/transactions.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: txMock };

// require extensionless: hoy resuelve services/subscriptions.js; tras la particion
// resolvera services/subscriptions/index.js. El mismo test debe pasar en ambos casos.
const { detectarSuscripciones, matchCatalogo } = require('../../services/subscriptions');

function resetState() {
  state.txs = [];
  state.gteArg = null;
  state.error = null;
}

// Helper para construir una transaccion de gasto.
function tx(comercio, monto, fecha, { moneda = 'PEN', monto_pen = null, categoria = 'Otros', subcategoria = 'sin_categoria' } = {}) {
  return { comercio, monto, fecha, moneda, monto_pen, categoria, subcategoria };
}

describe('matchCatalogo — match de comercio contra catalogo', () => {
  it('matchea nombre exacto (Netflix)', () => {
    const m = matchCatalogo('Netflix');
    expect(m).not.toBeNull();
    expect(m.id).toBe('netflix');
    expect(m.moneda).toBe('PEN');
  });

  it('matchea patron con prefijo de pasarela (dlocal*netflix)', () => {
    expect(matchCatalogo('DLOCAL*NETFLIX').id).toBe('netflix');
  });

  it('matchea case-insensitive con espacios (SPOTIFY AB)', () => {
    expect(matchCatalogo('  SPOTIFY AB ').id).toBe('spotify');
  });

  it('devuelve null para comercio desconocido', () => {
    expect(matchCatalogo('La Bodega de la Esquina')).toBeNull();
  });

  it('devuelve null para entrada vacia o falsy', () => {
    expect(matchCatalogo('')).toBeNull();
    expect(matchCatalogo(null)).toBeNull();
    expect(matchCatalogo(undefined)).toBeNull();
  });

  it('caracteriza el quirk patron.includes(lower): comercio corto contenido en un patron matchea', () => {
    // 'ea' esta contenido en el patron 'steam' ('st-EA-m'), que aparece antes en el
    // catalogo -> matchea 'steam', no 'ea_play'. Comportamiento actual (laxo por el
    // includes bidireccional); se fija tal cual, no se corrige en este refactor.
    expect(matchCatalogo('ea').id).toBe('steam');
  });
});

describe('detectarSuscripciones — deteccion por catalogo', () => {
  beforeEach(resetState);

  it('match de catalogo en PEN con 1 solo pago: estado activa, monto_pen == monto_detectado', async () => {
    state.txs = [tx('Netflix', 25.90, '2026-07-05', { moneda: 'PEN', monto_pen: 25.90 })];
    const r = await detectarSuscripciones('u1');

    expect(r.cantidad).toBe(1);
    const sub = r.suscripciones_detectadas[0];
    expect(sub.nombre).toBe('Netflix');
    expect(sub.estado).toBe('activa');
    expect(sub.fuente).toBe('catalogo');
    expect(sub.moneda).toBe('PEN');
    expect(sub.monto_detectado).toBe(25.90);
    expect(sub.monto_pen).toBe(25.90); // sin conversion en PEN
    expect(sub.ultimo_pago).toBe('2026-07-05');
    expect(sub.meses_detectados).toBe(1);
  });

  it('match de catalogo en USD con 2 pagos: convierte monto_pen con TC (venta 3.85)', async () => {
    state.txs = [
      tx('ChatGPT', 20, '2026-07-10', { moneda: 'USD' }),
      tx('ChatGPT', 20, '2026-06-10', { moneda: 'USD' }),
    ];
    const r = await detectarSuscripciones('u1');

    const sub = r.suscripciones_detectadas[0];
    expect(sub.nombre).toBe('ChatGPT Plus');
    expect(sub.moneda).toBe('USD');
    expect(sub.monto_detectado).toBe(20);
    expect(sub.monto_pen).toBe(77); // 20 * 3.85
    expect(sub.meses_detectados).toBe(2);
    expect(sub.estado).toBe('activa');
  });

  it('shape exacto que consume el cron (checkRecordatorioSuscripciones)', async () => {
    state.txs = [tx('Netflix', 25.90, '2026-07-05', { moneda: 'PEN', monto_pen: 25.90 })];
    const r = await detectarSuscripciones('u1');
    const sub = r.suscripciones_detectadas[0];

    // Campos que lee el cron ~L707-732: estado, ultimo_pago, nombre, moneda, monto_detectado
    for (const campo of ['estado', 'ultimo_pago', 'nombre', 'moneda', 'monto_detectado']) {
      expect(sub).toHaveProperty(campo);
    }
    expect(['activa', 'posible']).toContain(sub.estado);
    expect(typeof sub.ultimo_pago).toBe('string');
    expect(typeof sub.monto_detectado).toBe('number');
  });
});

describe('detectarSuscripciones — deteccion por patron (sin catalogo)', () => {
  beforeEach(resetState);

  it('patron recurrente con baja variacion (coefVar<0.3, avg>2): estado posible', async () => {
    state.txs = [
      tx('Gimnasio Local', 80, '2026-07-01'),
      tx('Gimnasio Local', 80, '2026-06-01'),
      tx('Gimnasio Local', 82, '2026-05-01'),
    ];
    const r = await detectarSuscripciones('u1');

    expect(r.cantidad).toBe(1);
    const sub = r.suscripciones_detectadas[0];
    expect(sub.estado).toBe('posible');
    expect(sub.fuente).toBe('patron');
    expect(sub.id).toMatch(/^custom_/);
    expect(sub.meses_detectados).toBe(3);
  });

  it('NO detecta si la variacion es alta (coefVar >= 0.3)', async () => {
    state.txs = [
      tx('Varios Comercio', 10, '2026-07-01'),
      tx('Varios Comercio', 200, '2026-06-01'),
    ];
    const r = await detectarSuscripciones('u1');
    expect(r.cantidad).toBe(0);
  });

  it('NO detecta si el promedio es <= 2 (ruido de micro-montos)', async () => {
    state.txs = [
      tx('Micropago', 1, '2026-07-01'),
      tx('Micropago', 1, '2026-06-01'),
    ];
    const r = await detectarSuscripciones('u1');
    expect(r.cantidad).toBe(0);
  });

  it('NO detecta un comercio no-catalogo con un solo mes de pago', async () => {
    state.txs = [tx('Compra Unica', 150, '2026-07-01')];
    const r = await detectarSuscripciones('u1');
    expect(r.cantidad).toBe(0);
  });
});

describe('detectarSuscripciones — totales y ahorro familiar', () => {
  beforeEach(resetState);

  it('total_mensual_usd suma solo USD; total_mensual_pen convierte USD a PEN', async () => {
    state.txs = [
      tx('Netflix', 25.90, '2026-07-05', { moneda: 'PEN', monto_pen: 25.90 }),
      tx('ChatGPT', 20, '2026-07-10', { moneda: 'USD' }),
    ];
    const r = await detectarSuscripciones('u1');

    expect(r.total_mensual_usd).toBe(20);
    // 25.90 (PEN) + 20*3.85 (USD->PEN) = 25.90 + 77 = 102.90
    expect(r.total_mensual_pen).toBe(102.90);
  });

  it('calcula ahorro familiar cuando familiar/2 < monto individual (Spotify PEN)', async () => {
    // Spotify: precio_referencia (local_pen) 17.90, familiar 33.90 -> compartido 16.95 < 17.90
    state.txs = [tx('Spotify', 17.90, '2026-07-05', { moneda: 'PEN', monto_pen: 17.90 })];
    const r = await detectarSuscripciones('u1');

    expect(r.resumen.ahorro_potencial_familiar).toBeCloseTo(0.95, 2);
  });

  it('convierte el ahorro USD a PEN con TC (Duolingo)', async () => {
    // Duolingo USD: precio_ref 6.99, familiar 9.99 -> compartido 4.995 < 6.99
    // ahorro = (6.99 - 4.995) * 3.85 = 1.995 * 3.85 = 7.68 aprox
    state.txs = [
      tx('Duolingo', 6.99, '2026-07-10', { moneda: 'USD' }),
      tx('Duolingo', 6.99, '2026-06-10', { moneda: 'USD' }),
    ];
    const r = await detectarSuscripciones('u1');
    expect(r.resumen.ahorro_potencial_familiar).toBeGreaterThan(7);
    expect(r.resumen.ahorro_potencial_familiar).toBeLessThan(8);
  });

  it('resumen.por_tipo agrupa y cuenta activas/posibles', async () => {
    state.txs = [
      tx('Netflix', 25.90, '2026-07-05', { moneda: 'PEN', monto_pen: 25.90 }),
      tx('Gimnasio Local', 80, '2026-07-01'),
      tx('Gimnasio Local', 80, '2026-06-01'),
    ];
    const r = await detectarSuscripciones('u1');
    expect(r.resumen.activas).toBe(1);
    expect(r.resumen.posibles).toBe(1);
    expect(r.resumen.por_tipo).toHaveProperty('streaming');
  });
});

describe('detectarSuscripciones — bordes y ventana temporal', () => {
  beforeEach(resetState);

  it('sin transacciones devuelve estructura vacia consistente', async () => {
    state.txs = [];
    const r = await detectarSuscripciones('u1');
    expect(r.suscripciones_detectadas).toEqual([]);
    expect(r.total_mensual_pen).toBe(0);
    expect(r.total_mensual_usd).toBe(0);
  });

  it('ante error de Supabase devuelve estructura vacia (no lanza)', async () => {
    state.txs = null;
    state.error = { message: 'boom' };
    const r = await detectarSuscripciones('u1');
    expect(r.suscripciones_detectadas).toEqual([]);
    expect(r.total_mensual_pen).toBe(0);
  });

  it('consulta la ventana de 3 meses en America/Lima (fija el borde temporal)', async () => {
    state.txs = [];
    await detectarSuscripciones('u1');

    // Recalcula el mismo desde que arma el servicio: hoy America/Lima menos 3 meses.
    const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
    const hace3 = new Date(hoy);
    hace3.setMonth(hace3.getMonth() - 3);
    const esperado = hace3.toISOString().split('T')[0];

    expect(state.gteArg).toBe(esperado);
  });

  it('meses_detectados cuenta meses YYYY-MM distintos, no numero de pagos', async () => {
    state.txs = [
      tx('Gimnasio Local', 80, '2026-07-20'),
      tx('Gimnasio Local', 80, '2026-07-01'), // mismo mes que el anterior
      tx('Gimnasio Local', 80, '2026-06-01'),
    ];
    const r = await detectarSuscripciones('u1');
    // 3 pagos pero solo 2 meses distintos (2026-07 y 2026-06)
    expect(r.suscripciones_detectadas[0].meses_detectados).toBe(2);
  });
});
