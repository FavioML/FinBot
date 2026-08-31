import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const realTx = require('../../services/transactions');
const handler = require('../../handlers/intents/transacciones');

/**
 * LAS TRES RUTAS QUE REESCRIBEN UN GASTO EN USD (ítem 13 del backlog).
 *
 * `guardarTransaccion` convertía con `validarMonto` y, si el resultado caía fuera de rango,
 * dejaba `monto_pen` y `tipo_cambio` en null a propósito. Las tres rutas de EDICIÓN hacían
 * `parseFloat((monto * tc.venta).toFixed(2))` a mano, sin validar nada — o sea que **editar un
 * gasto en USD podía escribir un `monto_pen` que insertarlo habría rechazado**, y `monto_pen`
 * es lo que alimenta reportes, score y balance.
 *
 * Y había un segundo defecto que el ítem no nombraba, encontrado midiendo: dos de las tres
 * (`editar_monto` y `dividir_gasto`) reescribían `monto_pen` **sin tocar `tipo_cambio`**, así
 * que la fila dejaba de reconciliar (`monto * tipo_cambio ≠ monto_pen`) sin que nada lo dijera.
 * En producción hay 4 filas reales que no reconcilian; son de marzo-2026 y tienen otra causa
 * (el fallback de entonces), pero el camino que las produce de nuevo seguía abierto.
 *
 * LO QUE ESTE ARCHIVO AFIRMA, y que ningún test miraba:
 *   1. el INVARIANTE `monto * tipo_cambio == monto_pen` después de cada edición;
 *   2. que las dos columnas se escriban JUNTAS o queden JUNTAS en null, nunca una sola;
 *   3. que el tipo usado sea el DE LA FILA y no el de hoy (corregir un monto no re-cotiza el
 *      gasto), con el control de que `corregir_monto_moneda` sí cotiza porque cambia la moneda;
 *   4. que un PEN no se contamine con nada de esto.
 *
 * LO QUE NO CUBRE, DECLARADO: la búsqueda de la fila a editar (de eso se ocupa el ítem 9F en
 * `lecturas-de-contenido.test.js`). Acá la fila ya está elegida.
 */

function makeChain(data = [], error = null) {
  const c = {};
  const METHODS = ['select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'ilike', 'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit', 'single', 'maybeSingle'];
  for (const m of METHODS) c[m] = vi.fn().mockReturnValue(c);
  c.then = (ok, ko) => Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null }).then(ok, ko);
  c.catch = () => Promise.resolve({ data, error });
  return c;
}

function makeSupabase(filas) {
  const chains = {};
  return {
    from: vi.fn((t) => { if (!chains[t]) chains[t] = makeChain(filas); return chains[t]; }),
    _chains: chains,
  };
}

const USUARIO = { id: 'user-001', plan: 'premium', trial_estado: 'convertido' };

// Una fila REAL de producción, con el tipo que tenía ese día. `tipo_cambio` llega como STRING
// porque supabase-js devuelve NUMERIC como string — si el fixture lo pusiera como número, el
// caso "se usa el de la fila" pasaría sin ejercitar la conversión que producción sí hace.
const TX_USD = {
  id: 'tx-usd', usuario_id: 'user-001', moneda: 'USD',
  monto: 100, monto_pen: 345.9, tipo_cambio: '3.459',
  comercio: 'Claude.AI Subscription', categoria: 'Suscripciones', tipo: 'gasto',
  fecha: '2026-07-10', created_at: '2026-07-10T12:00:00Z',
};
const TX_PEN = { ...TX_USD, id: 'tx-pen', moneda: 'PEN', monto: 50, monto_pen: 50, tipo_cambio: null };

// El tipo de HOY, distinto del de la fila a propósito: es lo único que permite distinguir
// "usó el de la fila" de "salió a cotizar".
const TC_HOY = 3.339;

function correr(intencion, datos, fila) {
  const sb = makeSupabase([fila]);
  const obtenerTipoCambio = vi.fn().mockResolvedValue({ venta: TC_HOY, fuente: 'dolar.pe' });
  const ctx = {
    supabase: sb, mesActual: 7, anioActual: 2026,
    obtenerUltimaTransaccion: vi.fn().mockResolvedValue(fila),
    recategorizarTransaccion: vi.fn(), guardarReglaComercio: vi.fn(), retroaplicarRegla: vi.fn(),
    corregirTransaccionEspecifica: vi.fn(), guardarTransaccion: vi.fn(),
    obtenerTipoCambio,
    // REALES: son la regla que este ítem unificó. Con un `vi.fn()` acá el archivo entero
    // afirmaría sobre un doble y no sobre el código que corre en producción.
    convertirUsdAPen: realTx.convertirUsdAPen,
    tipoCambioDeLaFila: realTx.tipoCambioDeLaFila,
    verificarAlertaPresupuesto: vi.fn(), asegurarCategoriaUsuario: vi.fn(),
    crearSubcategoriaLibreUsuario: vi.fn(), detectarCategoriaIA: vi.fn(),
    parsearRegistroManual: vi.fn(), parsearCorreccionesMultiples: vi.fn(),
    fechaHoyPeru: () => '2026-08-31', fechaAyerPeru: () => '2026-08-30', formatFecha: (f) => f || '',
  };
  return handler.handle({ intencion, msg: '', datos, usuario: USUARIO, from: '51999', ctx })
    .then((res) => ({
      res,
      updates: (sb._chains.transacciones?.update.mock.calls[0] || [])[0],
      cotizo: obtenerTipoCambio.mock.calls.length > 0,
    }));
}

// Medio centavo es el error MÁXIMO que puede meter redondear a dos decimales, y el 1e-9 es
// holgura de punto flotante y nada más: 25 * 3.339 da 83.475, que en binario es 83.47499...,
// redondea a 83.47 y deja una diferencia de 0.005000000000009663. Sin esa holgura el test
// rojea por cómo se representan los décimos, no por el invariante.
//
// Se compara contra `monto * tipo_cambio` y NO contra `Math.round(monto * tc * 100) / 100`,
// que sería copiar la implementación al test: así el día que el redondeo cambie, el guard
// sigue afirmando lo único que importa (la fila reconcilia) en vez de seguirlo.
const MEDIO_CENTAVO = 0.005 + 1e-9;

// El invariante, escrito una vez: es lo que un lector de la fila puede verificar solo.
function reconcilia(u) {
  expect(u.monto_pen, 'monto_pen no se escribió').not.toBeUndefined();
  expect(u.tipo_cambio, 'tipo_cambio no se escribió junto al monto_pen').not.toBeUndefined();
  expect(Math.abs(u.monto * u.tipo_cambio - u.monto_pen)).toBeLessThanOrEqual(MEDIO_CENTAVO);
}

describe('editar_monto sobre un gasto en USD', () => {
  it('reescribe monto_pen Y tipo_cambio, y la fila reconcilia', async () => {
    const { updates } = await correr('editar_monto', { monto_nuevo: 30 }, TX_USD);
    expect(updates.monto).toBe(30);
    reconcilia(updates);
  });

  it('usa el tipo DE LA FILA, no el de hoy, y por eso ni cotiza', async () => {
    const { updates, cotizo } = await correr('editar_monto', { monto_nuevo: 30 }, TX_USD);
    expect(updates.tipo_cambio).toBe(3.459);
    expect(updates.tipo_cambio).not.toBe(TC_HOY);
    // Corregir "eran 30 y no 20" no cambia el tipo del día en que se gastó. Además ahorra la
    // llamada a dolar.pe en el camino donde no hay nada que preguntar.
    expect(cotizo, 'salió a cotizar teniendo el tipo en la fila').toBe(false);
  });

  it('fuera de rango: las dos en null, no un monto_pen fabricado', async () => {
    // 300000 USD por 3.459 pasa el techo de `validarMonto`. Antes se escribía igual.
    const { updates } = await correr('editar_monto', { monto_nuevo: 300000 }, TX_USD);
    expect(updates.monto_pen).toBeNull();
    expect(updates.tipo_cambio).toBeNull();
  });

  it('CONTROL: sobre un gasto en PEN no aparece ningún tipo de cambio', async () => {
    const { updates, cotizo } = await correr('editar_monto', { monto_nuevo: 30 }, TX_PEN);
    expect(updates.monto_pen).toBe(30);
    expect(updates.tipo_cambio).toBeUndefined();
    expect(cotizo).toBe(false);
  });
});

describe('dividir_gasto sobre un gasto en USD', () => {
  it('divide las dos columnas por las mismas partes, y la fila reconcilia', async () => {
    const { updates } = await correr('dividir_gasto', { partes: 2 }, TX_USD);
    expect(updates.monto).toBe(50);
    reconcilia(updates);
    // "Mi parte" sólo puede querer decir esto: la mitad del gasto, no la mitad re-cotizada.
    expect(updates.monto_pen).toBeCloseTo(TX_USD.monto_pen / 2, 1);
  });

  it('usa el tipo de la fila y no cotiza', async () => {
    const { updates, cotizo } = await correr('dividir_gasto', { partes: 4 }, TX_USD);
    expect(updates.tipo_cambio).toBe(3.459);
    expect(cotizo).toBe(false);
  });

  it('CONTROL: en PEN divide el monto y no toca el tipo', async () => {
    const { updates } = await correr('dividir_gasto', { partes: 2 }, TX_PEN);
    expect(updates.monto).toBe(25);
    expect(updates.monto_pen).toBe(25);
    expect(updates.tipo_cambio).toBeUndefined();
  });
});

describe('corregir_monto_moneda: el único que SÍ debe cotizar', () => {
  it('de PEN a USD sale a la red, porque no hay tipo previo que preservar', async () => {
    const { updates, cotizo } = await correr('corregir_monto_moneda', { moneda: 'USD', monto: 25 }, TX_PEN);
    expect(cotizo, 'no cotizó: la fila era PEN y no tiene tipo que reusar').toBe(true);
    expect(updates.tipo_cambio).toBe(TC_HOY);
    reconcilia(updates);
  });

  it('de USD a PEN limpia el tipo de cambio', async () => {
    const { updates } = await correr('corregir_monto_moneda', { moneda: 'PEN', monto: 40 }, TX_USD);
    expect(updates.monto_pen).toBe(40);
    expect(updates.tipo_cambio).toBeNull();
  });

  it('un monto que no es un número no llega a la base', async () => {
    // `monto` es NOT NULL: el `parseFloat('mucho')` que había daba NaN, se serializaba como
    // null y Postgres rechazaba la fila entera. Fallaba cerrado, sí, pero contestando "no pude
    // corregir la moneda ahora mismo" — o sea mandando a reintentar algo imposible.
    const { updates, res } = await correr('corregir_monto_moneda', { moneda: 'USD', monto: 'mucho' }, TX_PEN);
    expect(updates, 'se intentó escribir un monto que no es un número').toBeUndefined();
    expect(res).toMatch(/Dime el monto/i);
  });

  it('fuera de rango: las dos en null, y aun así confirma sin reventar', async () => {
    // La confirmación imprimía `updates.monto_pen.toFixed(2)`: con null lanzaba TypeError, el
    // catch contestaba "no pude corregir la moneda" y el update YA se había aplicado. O sea
    // que el usuario leía un fallo sobre un cambio que sí ocurrió.
    const { updates, res } = await correr('corregir_monto_moneda', { moneda: 'USD', monto: 400000 }, TX_PEN);
    expect(updates.monto_pen).toBeNull();
    expect(updates.tipo_cambio).toBeNull();
    expect(res).toMatch(/Corregido/i);
    expect(res).not.toMatch(/No pude corregir/i);
  });
});
