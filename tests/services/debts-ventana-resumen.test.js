import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * La VENTANA del resumen semanal de deudas, que es una decisión de producto y no un detalle.
 *
 * `tests/cron/resumen-deudas-semanal.test.js` corre el cron con esta función mockeada, así que
 * **no puede ver la ventana**: le pasa las filas ya elegidas. Lo que se decide acá es cuáles
 * son esas filas, y hay exactamente una afirmación que importa:
 *
 *   **No hay piso.** Todo lo vencido y sin saldar entra, por lejos que haya vencido. Su
 *   hermana `obtenerDeudasProximasVencer` sí tiene piso (−3 días) porque su unidad es el
 *   TOQUE fechado: cuatro por deuda y se acaba. Si esta copiara ese piso, la deuda que venció
 *   el jueves pasado no volvería a nombrarla nadie nunca — el ledger
 *   `recordatorios_enviados` ya se agotó y no hay ningún otro camino que la mencione.
 *
 * Se afirma sobre los FILTROS que la función aplica, no sobre filas de un fixture, porque lo
 * que se quiere fijar es la ausencia de un `.gte`. Un fixture puede pasar por casualidad (no
 * incluir una fila lo bastante vieja); la ausencia del filtro se puede afirmar directamente.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Cada eslabón de la cadena, en orden: `{ metodo, args }`. */
let llamadas = [];
let resultado = { data: [], error: null };

function makeChain(table) {
  const chain = {};
  for (const m of ['select', 'eq', 'neq', 'not', 'is', 'in', 'or', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'ilike']) {
    chain[m] = (...args) => { llamadas.push({ tabla: table, metodo: m, args }); return chain; };
  }
  chain.then = (resolve) => resolve(resultado);
  chain.single = () => Promise.resolve({ data: null, error: null });
  chain.maybeSingle = chain.single;
  return chain;
}

const dbMock = { supabase: { from: vi.fn((t) => makeChain(t)) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

for (const [rel, exports] of [['lib/db.js', dbMock], ['lib/logger.js', logMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { obtenerDeudasParaResumenSemanal, obtenerDeudasProximasVencer } = require('../../services/debts');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

/** Un instante cuya fecha en Lima (UTC-5) es 2026-08-31. */
const LUNES = new Date('2026-08-31T09:05:00-05:00');

const filtrosSobre = (col) => llamadas.filter((l) => l.args[0] === col).map((l) => ({ metodo: l.metodo, args: l.args }));

beforeEach(() => {
  llamadas = [];
  resultado = { data: [], error: null };
  logMock.warn.mockClear();
  vi.setSystemTime(LUNES);
});

describe('la ventana del resumen semanal', () => {
  it('no pone piso: lo vencido hace meses sigue entrando', async () => {
    await obtenerDeudasParaResumenSemanal();

    const sobreVencimiento = filtrosSobre('fecha_vencimiento');
    // El `.not('fecha_vencimiento','is',null)` es legítimo y también matchea la columna; lo
    // que no puede existir es un límite INFERIOR.
    expect(
      sobreVencimiento.filter((f) => f.metodo === 'gte' || f.metodo === 'gt'),
      'el resumen semanal puso un piso de fecha: lo ya vencido dejaría de aparecer, y nada ' +
      'más lo nombra (el ledger de toques se agota en cuatro)',
    ).toEqual([]);
  });

  it('el techo son 7 días', async () => {
    await obtenerDeudasParaResumenSemanal();

    const techo = filtrosSobre('fecha_vencimiento').filter((f) => f.metodo === 'lte');
    expect(techo).toHaveLength(1);
    expect(techo[0].args[1]).toBe('2026-09-07');
  });

  it('declara un tope propio, para poder DETECTAR el recorte', async () => {
    // Sin `.limit()` explícito PostgREST aplica su `max-rows` igual (1000 medido en este
    // proyecto) y recorta **en silencio**: la lista vuelve completa a los ojos del llamador.
    // Acá eso es peor que en otros lados — el orden es por vencimiento ascendente y la ventana
    // no tiene piso, así que lo primero que entra es lo más vencido y lo que se cae es
    // justamente lo que vence esta semana, la mitad que el asunto del correo promete.
    await obtenerDeudasParaResumenSemanal();

    const topes = llamadas.filter((l) => l.metodo === 'limit');
    expect(topes, 'la query perdió su tope explícito: un recorte del servidor sería invisible').toHaveLength(1);
    expect(topes[0].args[0]).toBeGreaterThan(0);
  });

  it('avisa cuando la población TOCA el tope', async () => {
    // La contraprueba del caso de arriba: un tope que nadie mira no sirve de nada. El warn es
    // lo único que separa "esta semana vence poco" de "la lista vino cortada".
    const tope = 500;
    resultado = { data: Array.from({ length: tope }, (_, i) => ({ id: 'd' + i })), error: null };

    const filas = await obtenerDeudasParaResumenSemanal();

    expect(filas).toHaveLength(tope);
    expect(logMock.warn.mock.calls.map((c) => c[0] && c[0].tag)).toContain('DEUDAS_SEMANAL');
  });

  it('y NO avisa cuando no lo toca', async () => {
    resultado = { data: [{ id: 'd1' }], error: null };

    await obtenerDeudasParaResumenSemanal();

    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('sólo deudas activas y con fecha', async () => {
    await obtenerDeudasParaResumenSemanal();

    expect(llamadas).toContainEqual({ tabla: 'deudas', metodo: 'eq', args: ['estado', 'activa'] });
    expect(llamadas).toContainEqual({ tabla: 'deudas', metodo: 'not', args: ['fecha_vencimiento', 'is', null] });
  });

  it('trae la dirección de correo, que es de donde sale el `to` del resumen', async () => {
    // `notificarUsuario` no lee la base: sin esta columna el correo sale `skipped_no_email`
    // para todo el mundo, indistinguible de un usuario que de verdad no tiene dirección.
    // El guard estático (`email-necesita-su-columna`) afirma lo mismo por texto; esto lo
    // afirma sobre la llamada real.
    await obtenerDeudasParaResumenSemanal();

    const select = llamadas.find((l) => l.metodo === 'select');
    expect(select.args[0]).toContain('email');
  });

  it('una caída de PostgREST TIRA, no devuelve vacío', async () => {
    // Un `|| []` acá convertiría la caída en "esta semana no vence nada": el cron no mandaría
    // nada y su log no diría nada. Es el silencio que costó 12 días en el cron de onboarding.
    resultado = { data: null, error: { message: 'boom' } };

    await expect(obtenerDeudasParaResumenSemanal()).rejects.toBeTruthy();
  });
});

describe('la hermana conserva su piso (las dos ventanas son distintas a propósito)', () => {
  it('el recordatorio por deuda SÍ acota por abajo', async () => {
    // La contraprueba del primer caso: sin esto, un `filtrosSobre` roto devolvería `[]` para
    // las dos funciones y el test de arriba pasaría sin mirar nada.
    await obtenerDeudasProximasVencer();

    const piso = filtrosSobre('fecha_vencimiento').filter((f) => f.metodo === 'gte');
    expect(piso).toHaveLength(1);
    expect(piso[0].args[1]).toBe('2026-08-28');
  });
});
