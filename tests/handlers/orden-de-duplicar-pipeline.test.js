import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Duplicar el último movimiento PARA OTRA FECHA, de punta a punta (24-nov-2026).
 *
 * "duplícalo para el 15/10" creaba la copia con la fecha de HOY: el clasificador real no manda la fecha
 * de la copia (qa-e2e/probe-editar-fecha.mjs --duplicar: 0 de 12 y después 0 de 16, las dos el 24-nov). Y
 * "repítelo para el 15 de octubre" ni llegaba a duplicar: en frío iba a `edit_date` y detrás de una
 * confirmación a `register_transaction` con el monto del historial. Acá el clasificador se simula como
 * en esa sonda y lo que se mira es la fila ESCRITA.
 */

vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-11-24T17:00:00Z')); // martes 24-nov-2026, 12:00 en Lima
afterAll(() => vi.useRealTimers());

require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn().mockResolvedValue(null);
require('../../gmail').obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
require('../../gmail').tieneGmailConectado = vi.fn().mockResolvedValue(false);
let historial = [];
require('../../helpers/db-helpers').obtenerHistorial = vi.fn(async () => historial);
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/analytics').capture = vi.fn();

const TAXI = { id: 't-taxi', usuario_id: 'u-1', comercio: 'Taxi', monto: 20, monto_pen: 20, moneda: 'PEN',
  categoria: 'Transporte', subcategoria: 'Taxi', tipo: 'gasto', fecha: '2026-11-24' };
const copias = [];
const tx = require('../../services/transactions');
tx.obtenerUltimaTransaccion = vi.fn(async () => ({ ...TAXI }));
tx.guardarTransaccion = vi.fn(async (_uid, fila) => { copias.push(fila); return { id: 't-copia' }; });

const escrituras = [];
function chainPara(tabla) {
  const c = {};
  for (const m of ['select', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'in', 'is', 'not', 'neq', 'ilike', 'or', 'range', 'match', 'eq']) c[m] = vi.fn(() => c);
  for (const m of ['insert', 'update', 'upsert', 'delete']) c[m] = vi.fn((payload) => { escrituras.push({ tabla, op: m, payload }); return c; });
  c.single = vi.fn(async () => ({ data: null, error: null }));
  c.maybeSingle = c.single;
  c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
  return c;
}
require('../../lib/db').supabase = { from: vi.fn((t) => chainPara(t)), rpc: vi.fn(async () => ({ data: null, error: null })) };

let toolCall = null;
require('../../lib/ai').openai = { chat: { completions: { create: vi.fn(async () => ({
  choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] } }],
})) } } };

const { procesarMensajeLibre } = require('../../handlers/message-processor');

const USUARIO = { id: 'u-1', nombre: 'Ana', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01' };
const DUPLICAR = { name: 'manage_transaction', args: { action: 'duplicate', transaction_id: 'last' } };
const EDITAR_FECHA = { name: 'manage_transaction', args: { action: 'edit_date', nueva_fecha: '2026-10-15' } };
// Lo que mandó el clasificador detrás de la confirmación: el monto del historial y el año inventado.
const REGISTRAR = { name: 'register_transaction', args: { monto: 20, fecha: '2023-10-15', categoria: 'Transporte', comercio: 'Taxi' } };
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
const CONFIRMACION = [
  { rol: 'usuario', mensaje: 'gasté 20 en taxi', created_at: hace(2) },
  { rol: 'neto', mensaje: '✅ S/ 20.00 en *Taxi* (Transporte)\n📅 Hoy', created_at: hace(1) },
];
const updatesTx = () => escrituras.filter((e) => e.tabla === 'transacciones' && e.op === 'update');

beforeEach(() => {
  copias.length = 0;
  escrituras.length = 0;
  historial = [];
});

describe('la copia lleva la fecha que dice el mensaje, aunque el clasificador no la mande', () => {
  it.each([
    ['duplícalo para el 15/10', '2026-10-15'],
    ['duplícalo para el 03/10', '2026-10-03'],
    ['repítelo para el 15 de octubre', '2026-10-15'],
    ['duplícalo para ayer', '2026-11-23'],
    ['copia ese gasto para el lunes', '2026-11-23'],
    ['duplícalo para el 30', '2026-10-30'],
    ['duplícalo para el 15/10/2025', '2025-10-15'],
  ])('"%s" → copia del %s', async (msg, fecha) => {
    toolCall = DUPLICAR;
    const r = await procesarMensajeLibre(msg, USUARIO, '51999');
    expect(copias.map((c) => c.fecha)).toEqual([fecha]);
    expect(copias[0]).toMatchObject({ monto: 20, comercio: 'Taxi', descripcion_original: 'duplicado:t-taxi' });
    expect(String(r)).toMatch(/Gasto duplicado/);
  });

  it('CONTROL: sin fecha en el mensaje, la de hoy', async () => {
    toolCall = DUPLICAR;
    await procesarMensajeLibre('duplícalo', USUARIO, '51999');
    expect(copias.map((c) => c.fecha)).toEqual(['2026-11-24']);
  });

  it('el año inventado que mande el modelo no gana a lo que dice el texto', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'duplicate', nueva_fecha: '2023-10-15' } };
    await procesarMensajeLibre('duplícalo para el 15/10', USUARIO, '51999');
    expect(copias.map((c) => c.fecha)).toEqual(['2026-10-15']);
  });

  it('el TEXTO gana a la fecha que mande el modelo, aunque sea creíble', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'duplicate', nueva_fecha: '2026-11-10' } };
    await procesarMensajeLibre('duplícalo para ayer', USUARIO, '51999');
    expect(copias.map((c) => c.fecha)).toEqual(['2026-11-23']);
  });

  it('sin fecha en el texto, la que invente el modelo se tira y la copia sale (antes: la pregunta fija)', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'duplicate', nueva_fecha: '2026-11-20' } };
    await procesarMensajeLibre('duplícalo', USUARIO, '51999');
    expect(copias.map((c) => c.fecha)).toEqual(['2026-11-24']);
  });

  it('una fecha que no da un día pasado pregunta y no crea la copia', async () => {
    toolCall = DUPLICAR;
    for (const msg of ['duplícalo para la semana pasada', 'duplícalo para el 31 de febrero', 'duplícalo para el 15/10/2062', 'duplícalo para el lunes 15']) {
      const r = await procesarMensajeLibre(msg, USUARIO, '51999');
      expect(copias, msg).toEqual([]);
      expect(String(r), msg).toMatch(/duplícalo para el 24\/11\/2026/);
    }
  });
});

describe('la orden de duplicar va a duplicar_gasto, diga lo que diga el clasificador', () => {
  it('"repítelo para el 15 de octubre" que llega como edit_date no mueve la fecha del original: lo copia', async () => {
    toolCall = EDITAR_FECHA;
    await procesarMensajeLibre('repítelo para el 15 de octubre', USUARIO, '51999');
    expect(updatesTx()).toEqual([]);
    expect(copias.map((c) => c.fecha)).toEqual(['2026-10-15']);
  });

  it('detrás de una confirmación, el register_transaction con el monto del historial tampoco escribe un gasto nuevo con 2023', async () => {
    historial = CONFIRMACION;
    toolCall = REGISTRAR;
    await procesarMensajeLibre('repítelo para el 15 de octubre', USUARIO, '51999');
    expect(copias.map((c) => c.fecha)).toEqual(['2026-10-15']);
    expect(copias[0].descripcion_original).toBe('duplicado:t-taxi');
  });

  it.each(['repítelo', 'repite eso por favor', '¿duplícalo para el 15/10?', 'copia el anterior'])('"%s" no se reencamina', async (msg) => {
    toolCall = { name: 'social_response', args: { tipo: 'otro' } };
    await procesarMensajeLibre(msg, USUARIO, '51999');
    expect(copias).toEqual([]);
  });
});
