import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
// `process.cwd()` es la raíz de `app/` cuando corre vitest (su config vive ahí). Se usa en vez
// del truco de `import.meta.url` + regex que hay en otros tests: acá sólo hace falta ubicar
// módulos para inyectarlos en require.cache.
const projectRoot = process.cwd();

/**
 * EL TIPO DE CAMBIO QUE SE INVENTA (ítem 13 del backlog).
 *
 * `obtenerTipoCambio()` puede devolver tres cosas muy distintas y hasta el 31-ago-2026 las
 * tres salían idénticas: lo que contestó dolar.pe, una caché de hace más de 24h, y una
 * CONSTANTE hardcodeada. Nada río abajo podía decidir distinto: ni `guardarTransaccion`, que
 * escribe `monto_pen` en la base, ni `ver_tipo_cambio`, que le muestra el número al usuario
 * firmado "Fuente: dolar.pe".
 *
 * ALCANCE MEDIDO antes de tocarlo, que es lo que el ítem pedía y nadie había hecho: de las
 * 127 transacciones en USD de usuarios reales, 8 tienen `tipo_cambio = 3.85` (el fallback) y
 * las 8 son de marzo-2026, anteriores a `5b13628` ("fix: tipo de cambio siempre muestra
 * valores reales de dolar.pe", 31-mar). De abril a agosto: 0 de 119. O sea que el fallback NO
 * mide "dolar.pe se cae seguido": mide un estado del código que ya no existe.
 *
 * Se marca igual, y ésa es la decisión: el día que se ejerza no hay forma de enterarse.
 *
 * LO QUE NO CUBRE, DECLARADO: la disponibilidad real de dolar.pe. Acá `fetch` está doblado.
 * La frecuencia de fallo se mide sobre `transacciones.tipo_cambio`, que es donde queda el
 * rastro, no en un test.
 */

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
for (const [rel, exports] of [
  ['lib/db.js', { supabase: {} }],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn() }],
  ['lib/analytics.js', { capture: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const RUTA_TX = require.resolve(path.join(projectRoot, 'services/transactions.js'));

// La caché del tipo de cambio es estado de MÓDULO, así que cada caso necesita el módulo recién
// nacido. Sin esto, el primer test que fetchea con éxito deja la caché caliente y el caso del
// fallback nunca llega a su rama: saldría verde midiendo otra cosa.
function txFresco() {
  delete require.cache[RUTA_TX];
  return require('../../services/transactions');
}

const fetchOriginal = globalThis.fetch;
function doblarFetch(impl) { globalThis.fetch = vi.fn(impl); }
const respuestaOk = (valor) => ({ ok: true, json: async () => ({ series: { 'USD-PEN': { data: [valor] } } }) });

beforeEach(() => { logMock.warn.mockClear(); logMock.error.mockClear(); });
afterEach(() => { globalThis.fetch = fetchOriginal; vi.useRealTimers(); });

describe('obtenerTipoCambio declara de dónde salió el número', () => {
  it('dolar.pe contesta: fuente dolar.pe, y el valor es el de la API', async () => {
    doblarFetch(async () => respuestaOk(3.412));
    const tc = await txFresco().obtenerTipoCambio();
    expect(tc.fuente).toBe('dolar.pe');
    expect(tc.venta).toBe(3.412);
  });

  it('dolar.pe se cae SIN caché previa: fuente fallback, y es el inventado', async () => {
    const tx = txFresco();
    doblarFetch(async () => { throw new Error('ECONNRESET'); });
    const tc = await tx.obtenerTipoCambio();
    expect(tc.fuente).toBe('fallback');
    expect(tc.venta).toBe(tx.TC_FALLBACK.venta);
    // Y deja rastro: sin esto el único síntoma es una fila con 3.85 descubierta meses después.
    expect(logMock.error).toHaveBeenCalled();
  });

  it('dolar.pe responde 200 sin serie usable: también es fallback, y avisa', async () => {
    // La rama que NO lanza: `resp.ok` es true y el valor no viene o cae fuera de (3.0, 5.0).
    // Salía por la misma puerta que el éxito y sin ningún log.
    doblarFetch(async () => ({ ok: true, json: async () => ({ series: {} }) }));
    const tc = await txFresco().obtenerTipoCambio();
    expect(tc.fuente).toBe('fallback');
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('con caché previa, una caída NO cae al inventado: usa el número real viejo', async () => {
    const tx = txFresco();
    doblarFetch(async () => respuestaOk(3.401));
    await tx.obtenerTipoCambio();
    doblarFetch(async () => { throw new Error('timeout'); });
    // 25h después la caché venció, así que se fetchea de verdad y se cae.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 25 * 3600 * 1000));
    const tc = await tx.obtenerTipoCambio();
    expect(tc.fuente).toBe('cache_vencida');
    // Un número real de ayer le gana a una constante de hace meses: por eso son dos fuentes
    // distintas y no un único "degradado".
    expect(tc.venta).toBe(3.401);
    expect(tc.venta).not.toBe(tx.TC_FALLBACK.venta);
  });

  it('caché FRESCA no vuelve a salir a la red, y sigue diciendo dolar.pe', async () => {
    const tx = txFresco();
    doblarFetch(async () => respuestaOk(3.35));
    await tx.obtenerTipoCambio();
    const tras = globalThis.fetch.mock.calls.length;
    const tc = await tx.obtenerTipoCambio();
    expect(globalThis.fetch.mock.calls.length).toBe(tras);
    expect(tc.fuente).toBe('dolar.pe');
  });

  it('tcEsInventado separa el inventado de los dos reales', () => {
    const tx = txFresco();
    expect(tx.tcEsInventado({ venta: 3.4, fuente: 'fallback' })).toBe(true);
    expect(tx.tcEsInventado({ venta: 3.4, fuente: 'dolar.pe' })).toBe(false);
    expect(tx.tcEsInventado({ venta: 3.4, fuente: 'cache_vencida' })).toBe(false);
    // Un doble de test viejo (sin `fuente`) NO se lee como inventado: el default cae del lado
    // que no rompe, y eso está elegido a propósito.
    expect(tx.tcEsInventado({ venta: 3.4 })).toBe(false);
  });
});

describe('convertirUsdAPen: monto_pen y tipo_cambio son UNA afirmación', () => {
  const tx = () => require('../../services/transactions');

  it('conversión normal: devuelve las dos, con monto_pen redondeado a centavos', () => {
    expect(tx().convertirUsdAPen(100, { venta: 3.4 })).toEqual({ monto_pen: 340, tipo_cambio: 3.4 });
    expect(tx().convertirUsdAPen(6.23, { venta: 3.459 })).toEqual({ monto_pen: 21.55, tipo_cambio: 3.459 });
  });

  it('fuera de rango: las DOS en null, nunca una sola', () => {
    // 300000 USD por 3.85 = 1155000, arriba del techo de `validarMonto`. El alta ya dejaba
    // null; las tres rutas de edición escribían el número igual.
    const r = tx().convertirUsdAPen(300000, { venta: 3.85 });
    expect(r).toEqual({ monto_pen: null, tipo_cambio: null });
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('sin tipo utilizable: las DOS en null', () => {
    expect(tx().convertirUsdAPen(100, null)).toEqual({ monto_pen: null, tipo_cambio: null });
    expect(tx().convertirUsdAPen(100, { venta: 'tres con cuarenta' })).toEqual({ monto_pen: null, tipo_cambio: null });
  });

  it('INVARIANTE: si hay monto_pen, monto por tipo_cambio lo reconstruye', () => {
    // Es la propiedad que la base dejó de cumplir en 4 filas reales, y la única que un lector
    // de la fila puede verificar solo. Se barre en vez de probar un caso: un par elegido a
    // mano pasa por casualidad con casi cualquier implementación.
    for (const monto of [0.01, 1, 6.23, 55.07, 95.07, 12345.67]) {
      for (const venta of [3.339, 3.459, 3.85, 4.999]) {
        const r = tx().convertirUsdAPen(monto, { venta });
        if (r.monto_pen === null) { expect(r.tipo_cambio).toBeNull(); continue; }
        // Medio centavo (el máximo que puede meter redondear a 2 decimales) + holgura de
        // punto flotante: 25 * 3.339 = 83.475 se representa como 83.47499... y deja 0.0050000001.
        expect(Math.abs(monto * r.tipo_cambio - r.monto_pen)).toBeLessThanOrEqual(0.005 + 1e-9);
      }
    }
  });
});

describe('tipoCambioDeLaFila: la fila manda, y sólo se cotiza si no hay nada', () => {
  const tx = () => require('../../services/transactions');

  it('la fila trae tipo: se usa ése y NO se cotiza', async () => {
    const cotizador = vi.fn();
    const tc = await tx().tipoCambioDeLaFila({ tipo_cambio: 3.459, moneda: 'USD' }, cotizador);
    expect(tc.venta).toBe(3.459);
    expect(tc.fuente).toBe('fila');
    // Lo que hace que corregir un monto no re-cotice el gasto al tipo de hoy.
    expect(cotizador).not.toHaveBeenCalled();
  });

  it('la fila viene como string (NUMERIC de PostgREST): igual se usa', async () => {
    // supabase-js devuelve NUMERIC como STRING. Un `typeof === number` acá mandaba a la red en
    // el 100% de los casos reales sin que nada fallara.
    const cotizador = vi.fn();
    const tc = await tx().tipoCambioDeLaFila({ tipo_cambio: '3.402' }, cotizador);
    expect(tc.venta).toBe(3.402);
    expect(cotizador).not.toHaveBeenCalled();
  });

  it('la fila no trae tipo: se cotiza, con el cotizador que le pasaron', async () => {
    const cotizador = vi.fn().mockResolvedValue({ venta: 3.33, fuente: 'dolar.pe' });
    expect((await tx().tipoCambioDeLaFila({ tipo_cambio: null }, cotizador)).venta).toBe(3.33);
    expect(cotizador).toHaveBeenCalledTimes(1);
    expect((await tx().tipoCambioDeLaFila({ tipo_cambio: 0 }, cotizador)).venta).toBe(3.33);
  });
});
