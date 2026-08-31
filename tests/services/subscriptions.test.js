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
// `TC_FALLBACK` va porque `detector.js` lo importa desde el 31-ago (dejo de tener su
// propia copia de 3.85 a mano). Sin esto el doble queda incompleto y solo se nota el dia
// que `tcData.venta` venga falsy, que es justo el caso que el fallback existe para cubrir.
const txMock = { obtenerTipoCambio: vi.fn().mockResolvedValue({ compra: 3.82, venta: 3.85 }), TC_FALLBACK: { compra: 3.82, venta: 3.85 } };

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

  it('ya NO matchea por substring inverso: comercio corto contenido en un patron -> null', () => {
    // Antes 'ea' caia dentro del patron 'steam' ('st-EA-m') por el includes bidireccional
    // y marcaba Steam por accidente. Ahora el match es solo hacia adelante (patron dentro
    // del comercio), asi que 'ea' no matchea nada.
    expect(matchCatalogo('ea')).toBeNull();
  });

  it('un pedido de comida (pedidosya) ya NO matchea el plan pedidosya plus', () => {
    // Falso positivo historico: 'pedidosya' (pedido) era substring de 'pedidosya plus' y
    // matcheaba la suscripcion. Solo el cargo con el qualifier del plan debe matchear.
    expect(matchCatalogo('PedidosYa')).toBeNull();
    expect(matchCatalogo('DL*PEDIDOSYA')).toBeNull();
    expect(matchCatalogo('PEDIDOSYA PLUS').id).toBe('pedidosya_plus');
  });

  it('una compra Amazon generica ya NO matchea Amazon Prime', () => {
    // 'amzn' / 'amazon.com' se quitaron del catalogo: eran cualquier compra, no la suscripcion.
    expect(matchCatalogo('AMZN*2H4KL9')).toBeNull();
    expect(matchCatalogo('AMAZON.COM')).toBeNull();
    expect(matchCatalogo('AMAZON PRIME').id).toBe('amazon_prime');
  });
});

describe('detectarSuscripciones — deteccion por catalogo', () => {
  beforeEach(resetState);

  it('match de catalogo en PEN con 1 solo pago: estado POSIBLE (1 mes), monto_pen == monto_detectado', async () => {
    // Regla nueva: un solo mes de pago no confirma recurrencia -> 'posible', no 'activa'.
    // Asi una compra unica en un storefront de catalogo no dispara el recordatorio del cron.
    state.txs = [tx('Netflix', 25.90, '2026-07-05', { moneda: 'PEN', monto_pen: 25.90 })];
    const r = await detectarSuscripciones('u1');

    expect(r.cantidad).toBe(1);
    const sub = r.suscripciones_detectadas[0];
    expect(sub.nombre).toBe('Netflix');
    expect(sub.estado).toBe('posible');
    expect(sub.fuente).toBe('catalogo');
    expect(sub.moneda).toBe('PEN');
    expect(sub.monto_detectado).toBe(25.90);
    expect(sub.monto_pen).toBe(25.90); // sin conversion en PEN
    expect(sub.ultimo_pago).toBe('2026-07-05');
    expect(sub.meses_detectados).toBe(1);
  });

  it('match de catalogo con 2+ meses distintos: estado ACTIVA', async () => {
    state.txs = [
      tx('Netflix', 25.90, '2026-07-05', { moneda: 'PEN', monto_pen: 25.90 }),
      tx('Netflix', 25.90, '2026-06-05', { moneda: 'PEN', monto_pen: 25.90 }),
    ];
    const r = await detectarSuscripciones('u1');
    const sub = r.suscripciones_detectadas[0];
    expect(sub.estado).toBe('activa');
    expect(sub.meses_detectados).toBe(2);
  });

  it('deduplica por catalog id: varias grafias del mismo servicio -> 1 sola entrada', async () => {
    // El bug reportado: "PedidosYa Plus" bajo grafias distintas salia N veces. Ahora se
    // agrupa por catalog id y se reporta una sola vez, con el monto del pago mas reciente.
    state.txs = [
      tx('PedidosYa Plus', 9.90, '2026-07-10', { moneda: 'PEN', monto_pen: 9.90 }),
      tx('PEDIDOSYA PLUS', 9.90, '2026-06-10', { moneda: 'PEN', monto_pen: 9.90 }),
      tx('DL*PEDIDOSYAPLUS', 12.90, '2026-05-10', { moneda: 'PEN', monto_pen: 12.90 }),
    ];
    const r = await detectarSuscripciones('u1');

    expect(r.cantidad).toBe(1);
    const sub = r.suscripciones_detectadas[0];
    expect(sub.id).toBe('pedidosya_plus');
    expect(sub.estado).toBe('activa'); // 3 meses distintos
    expect(sub.meses_detectados).toBe(3);
    expect(sub.monto_detectado).toBe(9.90); // ultimo pago (2026-07-10), no promedio
    expect(sub.ultimo_pago).toBe('2026-07-10');
  });

  it('pedidos de comida sueltos (pedidosya, sin plan) no se reportan como suscripcion', async () => {
    // Montos dispares como son los pedidos reales: no matchea catalogo (ya no existe el
    // patron 'pedidosya' suelto) y el coef. de variacion alto lo descarta de la rama patron.
    state.txs = [
      tx('PedidosYa', 25.00, '2026-07-10', { moneda: 'PEN', monto_pen: 25.00 }),
      tx('PedidosYa', 78.50, '2026-06-10', { moneda: 'PEN', monto_pen: 78.50 }),
    ];
    const r = await detectarSuscripciones('u1');
    expect(r.cantidad).toBe(0);
  });

  it('match de catalogo en USD usa el monto_pen PERSISTIDO, no recompute con TC de hoy (C7)', async () => {
    // Pagos USD registrados cuando el TC era 3.70 -> monto_pen 74. Reconvertir con el TC de
    // hoy (3.85) daria 77: 3 soles de drift. La deteccion debe reflejar lo que se pago.
    state.txs = [
      tx('ChatGPT', 20, '2026-07-10', { moneda: 'USD', monto_pen: 74 }),
      tx('ChatGPT', 20, '2026-06-10', { moneda: 'USD', monto_pen: 74 }),
    ];
    const r = await detectarSuscripciones('u1');

    const sub = r.suscripciones_detectadas[0];
    expect(sub.nombre).toBe('ChatGPT Plus');
    expect(sub.moneda).toBe('USD');
    expect(sub.monto_detectado).toBe(20);
    expect(sub.monto_pen).toBe(74); // persistido (ultimo pago), NO 20*3.85=77
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

  it('patron recurrente categorizado como suscripcion (coefVar<0.3, avg>2): estado posible', async () => {
    // La rama por patron ahora exige que la transaccion este categorizada como suscripcion.
    // Un gimnasio/software no listado en el catalogo pero marcado 'Suscripciones' entra.
    state.txs = [
      tx('Gimnasio Local', 80, '2026-07-01', { categoria: 'Suscripciones', subcategoria: 'Gimnasio' }),
      tx('Gimnasio Local', 80, '2026-06-01', { categoria: 'Suscripciones', subcategoria: 'Gimnasio' }),
      tx('Gimnasio Local', 82, '2026-05-01', { categoria: 'Suscripciones', subcategoria: 'Gimnasio' }),
    ];
    const r = await detectarSuscripciones('u1');

    expect(r.cantidad).toBe(1);
    const sub = r.suscripciones_detectadas[0];
    expect(sub.estado).toBe('posible');
    expect(sub.fuente).toBe('patron');
    expect(sub.id).toMatch(/^custom_/);
    expect(sub.meses_detectados).toBe(3);
  });

  it('reconoce el patron por subcategoria "suscripciones" (Entretenimiento/suscripciones)', async () => {
    state.txs = [
      tx('Servicio Raro', 15, '2026-07-01', { categoria: 'Entretenimiento', subcategoria: 'suscripciones' }),
      tx('Servicio Raro', 15, '2026-06-01', { categoria: 'Entretenimiento', subcategoria: 'suscripciones' }),
    ];
    const r = await detectarSuscripciones('u1');
    expect(r.cantidad).toBe(1);
    expect(r.suscripciones_detectadas[0].fuente).toBe('patron');
  });

  it('NO detecta un gasto recurrente de monto estable si NO esta categorizado como suscripcion', async () => {
    // El false positive de fondo: comida/gasolina/transferencias con monto parecido mes a
    // mes pasaban el filtro de variacion. Ahora sin categoria de suscripcion no entran.
    state.txs = [
      tx('KFC Delivery', 30, '2026-07-01', { categoria: 'Alimentación', subcategoria: 'Delivery' }),
      tx('KFC Delivery', 31, '2026-06-01', { categoria: 'Alimentación', subcategoria: 'Delivery' }),
      tx('KFC Delivery', 30, '2026-05-01', { categoria: 'Alimentación', subcategoria: 'Delivery' }),
    ];
    const r = await detectarSuscripciones('u1');
    expect(r.cantidad).toBe(0);
  });

  it('NO detecta una transferencia recurrente a una persona (alquiler/Yape) como suscripcion', async () => {
    state.txs = [
      tx('Juno Luya — transferencia', 1100, '2026-07-08', { categoria: 'Vivienda', subcategoria: 'Alquiler' }),
      tx('Juno Luya — transferencia', 1100, '2026-06-08', { categoria: 'Vivienda', subcategoria: 'Alquiler' }),
    ];
    const r = await detectarSuscripciones('u1');
    expect(r.cantidad).toBe(0);
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

  it('rama patron USD: monto_pen es el promedio de los persistidos, no recompute con TC (C7)', async () => {
    // Software USD categorizado suscripcion, registrado a TC 3.70 -> monto_pen 37 cada uno.
    // Reconvertir 10 USD con el TC de hoy (3.85) daria 38.5; el persistido es 37.
    state.txs = [
      tx('Software Raro', 10, '2026-07-01', { moneda: 'USD', monto_pen: 37, categoria: 'Suscripciones', subcategoria: 'Software' }),
      tx('Software Raro', 10, '2026-06-01', { moneda: 'USD', monto_pen: 37, categoria: 'Suscripciones', subcategoria: 'Software' }),
    ];
    const r = await detectarSuscripciones('u1');
    const sub = r.suscripciones_detectadas[0];
    expect(sub.fuente).toBe('patron');
    expect(sub.monto_detectado).toBe(10);
    expect(sub.monto_pen).toBe(37); // promedio de monto_pen persistidos, NO 10*3.85
  });

  it('descriptor opaco (Apple = Music + iCloud) surface por su cuota recurrente, no se cae por varianza global', async () => {
    // "Apple" agrupa dos servicios con montos dispares. La varianza GLOBAL de los 5
    // montos es alta (>0.3) y antes tumbaba el grupo entero. Ahora la cuota estable
    // (iCloud ~4.35, único cluster que abarca 2+ meses) surface; los cargos de Music
    // quedan fuera de la cuota. txs en orden fecha-desc (como los entrega la query).
    state.txs = [
      tx('Apple', 4.34, '2026-07-16', { moneda: 'USD', monto_pen: 14.76, categoria: 'Suscripciones', subcategoria: 'Almacenamiento' }),
      tx('Apple', 6.38, '2026-06-20', { moneda: 'USD', monto_pen: 21.54, categoria: 'Suscripciones', subcategoria: 'Musica' }),
      tx('Apple', 4.36, '2026-06-16', { moneda: 'USD', monto_pen: 14.82, categoria: 'Suscripciones', subcategoria: 'Almacenamiento' }),
      tx('Apple', 10.54, '2026-05-30', { moneda: 'USD', monto_pen: 35.84, categoria: 'Suscripciones', subcategoria: 'Musica' }),
      tx('Apple', 12.88, '2026-05-16', { moneda: 'USD', monto_pen: 43.79, categoria: 'Suscripciones', subcategoria: 'Musica' }),
    ];
    const r = await detectarSuscripciones('u1');
    const apple = r.suscripciones_detectadas.find(s => s.nombre === 'Apple');
    expect(apple).toBeDefined();
    expect(apple.fuente).toBe('patron');
    expect(apple.estado).toBe('posible');
    expect(apple.monto_detectado).toBe(4.35); // cuota recurrente (iCloud), no el promedio de los 5
    // Meses del CLUSTER recurrente (jul + jun), no los 3 meses en que aparece el
    // comercio: los cargos de Music quedaron fuera de la cuota, asi que contarlos
    // sobreestimaba la evidencia de un monto que solo se vio 2 veces (B7).
    expect(apple.meses_detectados).toBe(2);
  });
});

describe('detectarSuscripciones — totales y ahorro familiar', () => {
  beforeEach(resetState);

  it('total_mensual_usd suma USD original; total_mensual_pen suma los monto_pen persistidos (C7)', async () => {
    state.txs = [
      tx('Netflix', 25.90, '2026-07-05', { moneda: 'PEN', monto_pen: 25.90 }),
      tx('ChatGPT', 20, '2026-07-10', { moneda: 'USD', monto_pen: 74 }),
    ];
    const r = await detectarSuscripciones('u1');

    expect(r.total_mensual_usd).toBe(20); // figura USD real (no depende del TC)
    // 25.90 (PEN) + 74 (monto_pen persistido del USD) = 99.90 — sin reconvertir con TC de hoy
    expect(r.total_mensual_pen).toBe(99.90);
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
      // Netflix en 2 meses -> activa; Gimnasio (categorizado suscripcion) 2 meses -> posible.
      tx('Netflix', 25.90, '2026-07-05', { moneda: 'PEN', monto_pen: 25.90 }),
      tx('Netflix', 25.90, '2026-06-05', { moneda: 'PEN', monto_pen: 25.90 }),
      tx('Gimnasio Local', 80, '2026-07-01', { categoria: 'Suscripciones', subcategoria: 'Gimnasio' }),
      tx('Gimnasio Local', 80, '2026-06-01', { categoria: 'Suscripciones', subcategoria: 'Gimnasio' }),
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
      tx('Gimnasio Local', 80, '2026-07-20', { categoria: 'Suscripciones', subcategoria: 'Gimnasio' }),
      tx('Gimnasio Local', 80, '2026-07-01', { categoria: 'Suscripciones', subcategoria: 'Gimnasio' }), // mismo mes
      tx('Gimnasio Local', 80, '2026-06-01', { categoria: 'Suscripciones', subcategoria: 'Gimnasio' }),
    ];
    const r = await detectarSuscripciones('u1');
    // 3 pagos pero solo 2 meses distintos (2026-07 y 2026-06)
    expect(r.suscripciones_detectadas[0].meses_detectados).toBe(2);
  });
});
