import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * "Ya pague pro y no se activa" (02-oct-2026, 3ccd5bf5) recibió el texto de VENTA de
 * `ver_premium`; su comprobante estaba en revisión y se aprobó 5 segundos después. Quien dice que
 * ya pagó recibe el estado de su pago, nunca el pitch, llegue por el intent que llegue.
 */

// ─── Parchar ANTES de requerir el SUT ───────────────────────────────────────
require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn().mockResolvedValue(null);
require('../../gmail').obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
require('../../gmail').tieneGmailConectado = vi.fn().mockResolvedValue(false);
require('../../helpers/db-helpers').obtenerHistorial = vi.fn().mockResolvedValue([]);
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/analytics').capture = vi.fn();
const parsers = require('../../services/parsers');
parsers.parsearRegistroManual = vi.fn().mockResolvedValue({ ok: true, decision: 'registrar', monto: 2, moneda: 'PEN', tipo: 'gasto', categoria: 'Transporte', subcategoria: null, fecha: null, comercio: 'Tasa' });
require('../../services/categories').detectarCategoriaIA = vi.fn().mockResolvedValue({ categoria: null });
require('../../services/categories').asegurarCategoriaUsuario = vi.fn().mockResolvedValue('nada');
require('../../services/categories').crearSubcategoriaLibreUsuario = vi.fn().mockResolvedValue(null);
require('../../services/transactions').guardarTransaccion = vi.fn().mockResolvedValue({ id: 'tx-1', categoria: 'Transporte', subcategoria: 'sin_categoria', conteoTx: 3 });
require('../../services/budget').verificarAlertaPresupuesto = vi.fn().mockResolvedValue(null);
require('../../lib/trial').colaConfirmacionGasto = vi.fn().mockResolvedValue('');
const utilidades = require('../../handlers/intents/utilidades');
const handleUtilReal = utilidades.handle;
utilidades.handle = async (args) => (args.intencion === 'ver_tipo_cambio' ? 'TIPO_DE_CAMBIO' : handleUtilReal(args));
const proPayment = require('../../lib/pro-payment');
proPayment.solicitarComprobante = vi.fn().mockResolvedValue(undefined);

function chain() {
  const c = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'eq', 'neq', 'gte', 'lte', 'in', 'is', 'not', 'ilike']) c[m] = vi.fn(() => c);
  c.single = vi.fn(async () => ({ data: null, error: null }));
  c.maybeSingle = c.single;
  c.then = (onF, onR) => Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR);
  return c;
}
require('../../lib/db').supabase = { from: vi.fn(() => chain()) };

let toolCall = null;
require('../../lib/ai').openai = { chat: { completions: { create: vi.fn(async () => ({
  choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] } }],
})) } } };

const { diceQueYaPago, mensajeYaPague } = require('../../handlers/intents/premium');
const { procesarMensajeLibre } = require('../../handlers/message-processor');

const MURO_PENDIENTE = { id: 'u-1', plan: 'free', trial_estado: 'vencido', pago_pendiente: true };
const MURO_SIN_PAGO = { id: 'u-1', plan: 'free', trial_estado: 'vencido', pago_pendiente: false };
const PAGADO = { id: 'u-1', plan: 'premium', trial_estado: 'convertido', premium_vence: '2026-11-02' };
const PITCH = /Desbloquea todo el potencial|Yapea al/;

beforeEach(() => { proPayment.solicitarComprobante.mockClear(); });

describe('diceQueYaPago', () => {
  it.each([
    'Ya pague pro y no se activa', 'ya pagué', 'Ya yapeé y nada', 'ya hice el pago', 'ya te yapee',
    'pagué el pro y sigo sin gráficos', 'ya mandé el comprobante', 'Ya realicé el pago del plan',
  ])('sí: %s', (m) => expect(diceQueYaPago(m)).toBe(true));

  it.each([
    'quiero pagar pro', 'cuánto cuesta pro', 'ya pagaré mañana', 'pagué la luz 80', 'cómo pago',
    'ya pagaste?',
  ])('no: %s', (m) => expect(diceQueYaPago(m)).toBe(false));
});

describe('mensajeYaPague: el estado, nunca el pitch', () => {
  it('pago en revisión: lo dice y no pide que lo reenvíe', () => {
    const m = mensajeYaPague(MURO_PENDIENTE);
    expect(m).toMatch(/lo estoy revisando/);
    expect(m).toMatch(/No tienes que mandarlo de nuevo/);
    expect(m).not.toMatch(PITCH);
  });
  it('Pro activo: con el vencimiento', () => {
    expect(mensajeYaPague(PAGADO)).toMatch(/ya está activo/);
  });
  it('sin pago registrado: pide la captura', () => {
    const m = mensajeYaPague(MURO_SIN_PAGO);
    expect(m).toMatch(/Todavía no me llegó tu comprobante/);
    expect(m).not.toMatch(PITCH);
  });
  it('en prueba no le dice que su Pro está activo (no pagó)', () => {
    const m = mensajeYaPague({ id: 'u-1', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01' });
    expect(m).not.toMatch(/ya está activo/);
  });
});

describe('por el pipeline: el intent que elija el clasificador no cambia la respuesta', () => {
  it.each([
    ['ver_premium', { name: 'manage_account', args: { action: 'view_premium' } }],
    ['estado_cuenta', { name: 'manage_account', args: { action: 'account_status' } }],
    ['ayuda', { name: 'social_response', args: { action: 'help', tema: 'otro' } }],
    ['queja', { name: 'social_response', args: { action: 'complaint' } }],
  ])('%s con "Ya pague pro y no se activa" y el pago en revisión: estado, sin abrir la espera', async (_n, tc) => {
    toolCall = tc;
    const r = await procesarMensajeLibre('Ya pague pro y no se activa', { ...MURO_PENDIENTE }, '51999');
    expect(String(r)).toMatch(/lo estoy revisando/);
    expect(String(r)).not.toMatch(PITCH);
    expect(proPayment.solicitarComprobante).not.toHaveBeenCalled();
  });

  it('sin pago registrado y en el muro: pide la captura y abre la espera del comprobante', async () => {
    toolCall = { name: 'manage_account', args: { action: 'view_premium' } };
    const r = await procesarMensajeLibre('ya pagué el pro', { ...MURO_SIN_PAGO }, '51999');
    expect(String(r)).toMatch(/Todavía no me llegó/);
    expect(proPayment.solicitarComprobante).toHaveBeenCalledOnce();
  });

  it('control: "quiero pro" sigue recibiendo el pitch', async () => {
    toolCall = { name: 'manage_account', args: { action: 'view_premium' } };
    const r = await procesarMensajeLibre('quiero pro', { ...MURO_SIN_PAGO }, '51999');
    expect(String(r)).toMatch(PITCH);
  });
});

describe('"Tasa 2": la forma corta pelada no es una consulta del tipo de cambio', () => {
  const TIPO_CAMBIO = { name: 'currency_tools', args: { action: 'exchange_rate' } };
  const EN_PRUEBA = { id: 'u-1', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01' };

  it('"Tasa 2" va al registro', async () => {
    toolCall = TIPO_CAMBIO;
    parsers.parsearRegistroManual.mockClear();
    const r = await procesarMensajeLibre('Tasa 2', { ...EN_PRUEBA }, '51999');
    expect(parsers.parsearRegistroManual).toHaveBeenCalled();
    expect(String(r)).not.toBe('TIPO_DE_CAMBIO');
  });

  it.each(['a cuánto está el dólar', 'tasa de cambio', 'dolar 3.45', 'tipo de cambio hoy'])(
    'control "%s": sigue siendo el tipo de cambio', async (m) => {
      toolCall = TIPO_CAMBIO;
      const r = await procesarMensajeLibre(m, { ...EN_PRUEBA }, '51999');
      expect(String(r)).toBe('TIPO_DE_CAMBIO');
    });
});

describe('ronda 2: "ya pagué" fuera de ver_premium exige que se hable de Pro', () => {
  it.each(['ya pagué la luz y no me aparece en el dashboard', 'ya pague mi tarjeta', 'ayuda, ya deposité el alquiler',
    'ya pagué la luz pero neto no me la registró', 'ya pagué el plan de datos de Claro, cómo lo anoto', 'Juan ya pagó su parte pero la deuda sigue activa',
    'ya pagué la suscripción de Netflix, cómo la anoto?', 'ya pagué mi Spotify premium y no me aparece', 'ya pagué la mensualidad del gym, se registró?',
    'Ya pagué el internet y no se activa', 'acabo de pagar el recibo del cable, cuándo se activa?', 'ya pagué la luz y te mandé el comprobante pero no me aparece'])(
    'no: %s', (m) => expect(diceQueYaPago(m, { exigePro: true })).toBe(false));
  it.each(['Ya pague pro y no se activa', 'acabo de pagar el pro', 'te mandé el yape del pro', 'hice el pago de pro', 'ya está pagado el pro'])(
    'sí: %s', (m) => expect(diceQueYaPago(m, { exigePro: true })).toBe(true));

  it('una queja sobre otro pago no recibe el estado del comprobante ni abre la espera', async () => {
    toolCall = { name: 'social_response', args: { action: 'complaint' } };
    const r = await procesarMensajeLibre('ya pagué la luz y no me aparece en el dashboard', { ...MURO_SIN_PAGO }, '51999');
    expect(String(r)).not.toMatch(/comprobante/);
    expect(proPayment.solicitarComprobante).not.toHaveBeenCalled();
  });
});
