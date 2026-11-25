import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * "Quiero pagar mi mensualidad" (11-nov-2026, 8e961fe0, pagadora que renueva el 06-dic) recibió
 * el fallback de recordatorios, y "quiero pagar por tu aplicacion" recibió "No hay problema, no
 * tienes que pagar nada". Medido con el clasificador real en frío (24-nov): la primera cae en
 * `recordatorio_pago` 3 de 3, "deseo pagar la suscripción" en `ver_suscripciones` 3 de 3. Quien
 * dice que quiere pagarle a Neto recibe cómo pagar, llegue por el intent que llegue, y quien ya
 * paga recibe también cómo RENOVAR (antes `ver_premium` solo le decía su fecha).
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
parsers.parsearRegistroManual = vi.fn().mockResolvedValue({ ok: true, decision: 'registrar', monto: 10, moneda: 'PEN', tipo: 'gasto', categoria: 'Suscripciones', subcategoria: null, fecha: null, comercio: 'Neto' });
require('../../services/categories').detectarCategoriaIA = vi.fn().mockResolvedValue({ categoria: null });
require('../../services/categories').asegurarCategoriaUsuario = vi.fn().mockResolvedValue('nada');
require('../../services/categories').crearSubcategoriaLibreUsuario = vi.fn().mockResolvedValue(null);
require('../../services/transactions').guardarTransaccion = vi.fn().mockResolvedValue({ id: 'tx-1', categoria: 'Suscripciones', subcategoria: 'sin_categoria', conteoTx: 3 });
require('../../services/budget').verificarAlertaPresupuesto = vi.fn().mockResolvedValue(null);
require('../../lib/trial').colaConfirmacionGasto = vi.fn().mockResolvedValue('');
const proPayment = require('../../lib/pro-payment');
proPayment.solicitarComprobante = vi.fn().mockResolvedValue(undefined);
// El handler real de recordatorios toca la base; acá basta con saber que NO se llegó a él.
const utilidades = require('../../handlers/intents/utilidades');
const handleUtilReal = utilidades.handle;
utilidades.handle = async (args) => (args.intencion === 'recordatorio_pago' ? 'RECORDATORIO' : handleUtilReal(args));

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

const { quierePagarNeto, mensajeVerPremium } = require('../../handlers/intents/premium');
const { procesarMensajeLibre } = require('../../handlers/message-processor');

const PAGADO = { id: 'u-1', plan: 'premium', tipo_plan: 'mensual', trial_estado: 'convertido', premium_vence: '2026-12-06' };
const MURO = { id: 'u-1', plan: 'free', trial_estado: 'vencido', pago_pendiente: false };
const COMO_PAGAR = /Yapea al \*970398192\*/;

beforeEach(() => { proPayment.solicitarComprobante.mockClear(); parsers.parsearRegistroManual.mockClear(); });

describe('quierePagarNeto', () => {
  it.each([
    'quiero pagar mi mensualidad', 'quiero pagar por tu aplicacion', 'Quiero pagar por tu aplicación',
    'deseo pagar la suscripción', 'quiero renovar mi plan', 'quiero renovar', 'como pago el pro', 'cómo te pago?',
    'quiero pagar el mes de neto', 'quiero pagar el pro', 'me gustaría pagar el plan anual', 'quisiera pagarte',
    'necesito renovar mi suscripción de neto', 'no sé cómo pagar el pro',
    // Colas naturales: la revisión del 24-nov mostró que un "porfa" reproducía el bug original.
    'quiero pagar mi mensualidad porfa', 'quiero pagar mi mensualidad por yape', 'quiero pagar mi mensualidad de diciembre',
    'cómo hago para pagar el pro', 'quiero pagar el anual',
  ])('sí: %s', (m) => expect(quierePagarNeto(m)).toBe(true));

  it.each([
    'quiero pagar la luz el 15', 'recuérdame pagar el alquiler', 'quiero pagar mi mensualidad del gym',
    'quiero pagar la suscripción de Netflix', 'quiero pagar mi plan de claro', 'voy a pagar la mensualidad del colegio',
    'no quiero pagar pro', 'no me interesa pagar', 'no deseo pagar el plan', 'ya pagué el pro', 'pagué 10 de la mensualidad',
    'gasté 10 en neto', 'quiero renovar mi dni', 'cuánto cuesta pro',
    // Revisión adversarial del 24-nov: el objeto de Neto seguido de otra cosa es de otro.
    'quiero pagar premium de spotify', 'quiero comprar el premium de spotify', 'quiero pagar el pro de la tarjeta',
    'quiero pagar el neto de la planilla', 'quiero pagar neto a juan', 'quiero pagar a Neto Perez',
    'quiero pagar pro pero no me deja', 'quiero pagar el pro y me sale error',
    // Negaciones sin "no quiero".
    'tampoco quiero pagar pro', 'nunca voy a pagar el pro', 'jamás quiero pagar pro', 'no puedo pagar el pro',
    'quiero pagar pro, no gracias',
    // Sin objeto de Neto o con un verbo que significa otra cosa.
    'quiero pagar el mes', 'voy a pagar mi mensualidad', 'quiero activar la app', 'como activar la app',
    'como pago', 'donde pago', 'como yapeo', 'como abono',
  ])('no: %s', (m) => expect(quierePagarNeto(m)).toBe(false));
});

describe('mensajeVerPremium: quien ya paga recibe cómo renovar', () => {
  it('pagador vigente: su fecha y cómo renovar sin perder días', () => {
    const m = mensajeVerPremium(PAGADO);
    expect(m).toContain('Tu plan NETO Pro');
    expect(m).toMatch(COMO_PAGAR);
    expect(m).toMatch(/no pierdes días/);
    expect(m).toMatch(/S\/10\/mes/);
  });
  it('pagador con un comprobante de renovación en revisión: no repite cómo pagar', () => {
    const m = mensajeVerPremium({ ...PAGADO, pago_pendiente: true });
    expect(m).toMatch(/lo estoy revisando/);
    expect(m).not.toMatch(COMO_PAGAR);
  });
  it('sin premium_vence no promete "no pierdes días"', () => {
    const m = mensajeVerPremium({ ...PAGADO, premium_vence: null });
    expect(m).toMatch(COMO_PAGAR);
    expect(m).not.toMatch(/no pierdes días/);
  });
});

describe('por el pipeline: el intent que elija el clasificador no tapa el pedido de pago', () => {
  it.each([
    ['recordatorio_pago', 'quiero pagar mi mensualidad', { name: 'payment_reminder', args: { descripcion: 'mensualidad' } }],
    ['ayuda/no_quiero_pro', 'quiero pagar por tu aplicacion', { name: 'social_response', args: { action: 'help', tema: 'no_quiero_pro' } }],
    ['ayuda/precio_despues_prueba', 'quiero pagar por tu aplicacion', { name: 'social_response', args: { action: 'help', tema: 'precio_despues_prueba' } }],
    ['ver_suscripciones', 'deseo pagar la suscripción', { name: 'query_analytics', args: { action: 'subscriptions' } }],
    ['estado_cuenta', 'quiero renovar mi plan', { name: 'manage_account', args: { action: 'account_status' } }],
  ])('%s con "%s" (pagador): cómo renovar, nunca "no tienes que pagar nada"', async (_n, msg, tc) => {
    toolCall = tc;
    const r = String(await procesarMensajeLibre(msg, { ...PAGADO }, '51999'));
    expect(r).toMatch(COMO_PAGAR);
    expect(r).not.toMatch(/no tienes que pagar nada/);
    expect(r).not.toBe('RECORDATORIO');
    // Quien ya paga no necesita la espera: su captura se reconoce por el contenido.
    expect(proPayment.solicitarComprobante).not.toHaveBeenCalled();
  });

  it('en el muro: el pitch y abre la espera del comprobante, como ver_premium', async () => {
    toolCall = { name: 'payment_reminder', args: { descripcion: 'mensualidad' } };
    const r = String(await procesarMensajeLibre('quiero pagar mi mensualidad', { ...MURO }, '51999'));
    expect(r).toMatch(COMO_PAGAR);
    expect(proPayment.solicitarComprobante).toHaveBeenCalledOnce();
  });

  it('en el muro con un comprobante en revisión: lo dice, no repite el Yape ni reabre la espera', async () => {
    toolCall = { name: 'payment_reminder', args: { descripcion: 'mensualidad' } };
    const r = String(await procesarMensajeLibre('quiero pagar mi mensualidad', { ...MURO, pago_pendiente: true }, '51999'));
    expect(r).toMatch(/lo estoy revisando/);
    expect(r).not.toMatch(COMO_PAGAR);
    expect(proPayment.solicitarComprobante).not.toHaveBeenCalled();
  });

  it('una queja sobre el pago no se desvía: conserva su efecto', async () => {
    toolCall = { name: 'social_response', args: { action: 'complaint' } };
    const r = String(await procesarMensajeLibre('quiero pagar el pro', { ...PAGADO }, '51999'));
    expect(r).not.toMatch(COMO_PAGAR);
  });

  it('control: "quiero pagar la luz el 15" sigue siendo un recordatorio', async () => {
    toolCall = { name: 'payment_reminder', args: { descripcion: 'luz' } };
    const r = await procesarMensajeLibre('quiero pagar la luz el 15', { ...PAGADO }, '51999');
    expect(String(r)).toBe('RECORDATORIO');
  });

  it('control: "no quiero pagar pro" sigue en no_quiero_pro', async () => {
    toolCall = { name: 'social_response', args: { action: 'help', tema: 'no_quiero_pro' } };
    const r = String(await procesarMensajeLibre('no quiero pagar pro', { ...PAGADO }, '51999'));
    expect(r).toMatch(/no tienes que pagar nada/);
  });

  it('control: un registro con la palabra mensualidad no se desvía (el desvío no sale de un intent que escribe)', async () => {
    toolCall = { name: 'register_transaction', args: { monto: 10, descripcion: 'mensualidad' } };
    await procesarMensajeLibre('quiero pagar mi mensualidad', { ...PAGADO }, '51999');
    expect(parsers.parsearRegistroManual).toHaveBeenCalled();
  });
});
