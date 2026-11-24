import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Cambiar el TIPO del último movimiento por WhatsApp, de punta a punta (24-nov-2026).
 *
 * Caso de producción: ec843051 probó cinco formas el 16 y 17-nov ("Corregir como gasto", "Cambia 9.60
 * de ingreso como gasto", "Corregir es gasto"…) y ninguna pasó. Tres cosas se juntaban: la tool del
 * clasificador no trae `tipo_nuevo` (y la puerta comparaba contra el default 'ingreso', así que pasar
 * algo a GASTO era imposible), la gramática no tenía "corregir" ni la forma con monto, y el clasificador
 * mandaba esas frases a otros intents. "Corregir es gasto" fue a `registrar_deuda`, recibió "¿Con quién
 * es?" y la respuesta quedó anotada como deuda.
 *
 * Acá el clasificador se simula equivocándose de intent como en prod, y lo que se mira es lo ESCRITO.
 */

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

const escrituras = [];
const debts = require('../../services/debts');
debts.registrarDeuda = vi.fn(async (...args) => { escrituras.push({ servicio: 'registrarDeuda', args }); return { id: 'd-nueva' }; });

// El último movimiento: la captura del estacionamiento que quedó como ingreso (16-nov).
const ESTACIONAMIENTO = { id: 't-estac', usuario_id: 'u-1', comercio: 'Estacionamiento', monto: 9.6, monto_pen: 9.6, moneda: 'PEN',
  categoria: 'Transporte', subcategoria: 'Estacionamiento', tipo: 'ingreso' };
let ultimo = { ...ESTACIONAMIENTO };
require('../../services/transactions').obtenerUltimaTransaccion = vi.fn(async () => ({ ...ultimo }));

function chainPara(tabla) {
  let op = null;
  const c = {};
  for (const m of ['select', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'in', 'is', 'not', 'neq', 'ilike', 'or', 'range', 'match', 'eq']) c[m] = vi.fn(() => c);
  for (const m of ['insert', 'update', 'upsert', 'delete']) c[m] = vi.fn((payload) => { op = m; escrituras.push({ tabla, op: m, payload }); return c; });
  const resolver = () => (op === 'update' && tabla === 'transacciones' ? { data: [{ id: ultimo.id }], error: null } : { data: [], error: null });
  c.single = vi.fn(async () => ({ data: null, error: null }));
  c.maybeSingle = c.single;
  c.then = (onF, onR) => Promise.resolve().then(resolver).then(onF, onR);
  return c;
}
require('../../lib/db').supabase = { from: vi.fn((t) => chainPara(t)), rpc: vi.fn(async () => ({ data: null, error: null })) };

let toolCall = null;
require('../../lib/ai').openai = { chat: { completions: { create: vi.fn(async () => ({
  choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] } }],
})) } } };

const { procesarMensajeLibre } = require('../../handlers/message-processor');

const USUARIO = { id: 'u-1', nombre: 'Luis', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01' };
const PROPIAS = new Set(['conversaciones', 'nlp_errors', 'errores']);
const deUsuario = () => escrituras.filter((e) => !PROPIAS.has(e.tabla));
const updatesTx = () => escrituras.filter((e) => e.tabla === 'transacciones' && e.op === 'update').map((e) => e.payload);

// Lo que devolvió el clasificador con cada frase, en la forma que llega al mapper.
const DEUDA = { name: 'manage_debts', args: { action: 'register', monto: 500, contraparte: 'Gonzalo Aceijas', yo_debo: true } };
const EDITAR_MONTO = { name: 'manage_transaction', args: { action: 'edit_amount', nuevo_monto: 9.6 } };
const REGISTRAR = { name: 'register_transaction', args: { monto: 9.6, comercio: 'estacionamiento', tipo: 'gasto' } };

const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

beforeEach(() => {
  escrituras.length = 0;
  ultimo = { ...ESTACIONAMIENTO };
  historial = [];
});

describe('las frases de producción cambian el tipo del último, diga lo que diga el clasificador', () => {
  it.each([
    ['Corregir como gasto', EDITAR_MONTO],
    ['Cambiar los 9.60 de estacionamiento como gasto', EDITAR_MONTO],
    ['Cambia 9.60 de ingreso como gasto', REGISTRAR],
    ['Corregir es gasto', DEUDA],
    ['márcalo como gasto', DEUDA],
  ])('"%s" pasa el ingreso a gasto, y no anota ninguna deuda', async (msg, tc) => {
    toolCall = tc;
    const r = await procesarMensajeLibre(msg, USUARIO, '51999');
    expect(updatesTx()).toEqual([{ tipo: 'gasto' }]);
    expect(escrituras.some((e) => e.servicio === 'registrarDeuda')).toBe(false);
    expect(String(r)).toMatch(/Estacionamiento\* \(S\/ 9\.60\) ahora está marcado como \*gasto\*/);
    expect(String(r)).toMatch(/márcalo como ingreso/);
  });

  it('CONTROL: la otra dirección (gasto a ingreso) sigue funcionando', async () => {
    ultimo = { ...ESTACIONAMIENTO, tipo: 'gasto' };
    toolCall = { name: 'manage_transaction', args: { action: 'mark_income' } };
    await procesarMensajeLibre('márcalo como ingreso', USUARIO, '51999');
    expect(updatesTx()).toEqual([{ tipo: 'ingreso' }]);
  });

  it('un gasto con la categoría "Ingreso" pasa a Otros al volverse gasto', async () => {
    ultimo = { ...ESTACIONAMIENTO, categoria: 'Ingreso', subcategoria: null };
    toolCall = EDITAR_MONTO;
    await procesarMensajeLibre('corregir como gasto', USUARIO, '51999');
    expect(updatesTx()).toEqual([{ tipo: 'gasto', categoria: 'Otros', subcategoria: null }]);
  });
});

describe('lo que NO escribe', () => {
  it('si ya tiene ese tipo, lo dice y no toca nada', async () => {
    ultimo = { ...ESTACIONAMIENTO, tipo: 'gasto' };
    toolCall = DEUDA;
    const r = await procesarMensajeLibre('Corregir es gasto', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
    expect(String(r)).toMatch(/ya está como \*gasto\*: no cambié nada/);
  });

  it('con un monto que no es el del último, no escribe (regla 1)', async () => {
    toolCall = EDITAR_MONTO;
    const r = await procesarMensajeLibre('cambia 30 de gasolina como gasto', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
    expect(String(r)).toMatch(/No cambié nada: lo último que anoté es \*Estacionamiento\* \(S\/ 9\.60\)/);
  });

  it('con el monto del último pero otro nombre, tampoco', async () => {
    toolCall = EDITAR_MONTO;
    await procesarMensajeLibre('cambia 9.60 de taxi como gasto', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
  });

  it('la elíptica sin confirmación detrás no escribe', async () => {
    toolCall = REGISTRAR;
    await procesarMensajeLibre('es gasto', USUARIO, '51999');
    expect(updatesTx()).toEqual([]);
  });

  it('"<nombre> 4.8 es gasto cambiar" no se anota como deuda: pregunta si es deuda o gasto', async () => {
    toolCall = { name: 'manage_debts', args: { action: 'register', monto: 4.8, contraparte: 'Luis Martin Retuerto Arana' } };
    const r = await procesarMensajeLibre('Luis Martin Retuerto Arana 4.8 es gasto cambiar', USUARIO, '51999');
    expect(escrituras.some((e) => e.servicio === 'registrarDeuda')).toBe(false);
    expect(String(r)).toMatch(/deuda o un gasto/);
  });
});

describe('detrás de una captura', () => {
  const captura = (monto) => [{ rol: 'neto', mensaje: '📸 *Ingreso registrado*\n\n💵 *Estacionamiento* — S/ ' + monto + '\nTransporte · 16-nov-26', created_at: hace(2) }];

  it('"Es un gasto" corrige la captura que NETO acaba de confirmar', async () => {
    historial = captura('9.60');
    toolCall = REGISTRAR;
    await procesarMensajeLibre('Es un gasto', USUARIO, '51999');
    expect(updatesTx()).toEqual([{ tipo: 'gasto' }]);
  });

  it('si el último movimiento no es el de la confirmación (otra captura llegó después), no escribe', async () => {
    historial = captura('5.59');
    toolCall = REGISTRAR;
    const r = await procesarMensajeLibre('Es un gasto', USUARIO, '51999');
    expect(updatesTx()).toEqual([]);
    expect(String(r)).toMatch(/No cambié nada/);
  });
});

describe('revisión adversarial del 24-nov', () => {
  it('"márcalo como gasto" contestando "¿Esos S/35 entraron o salieron?" no toca el último guardado', async () => {
    historial = [{ rol: 'usuario', mensaje: '35', created_at: hace(1) },
      { rol: 'neto', mensaje: '¿Esos S/35 entraron o salieron? Escríbemelo con el verbo: "gasté 35 en…" o "me pagaron 35".', created_at: hace(1) }];
    toolCall = { name: 'manage_transaction', args: { action: 'mark_income' } };
    await procesarMensajeLibre('márcalo como gasto', USUARIO, '51999');
    expect(updatesTx()).toEqual([]);
  });

  it('"no son ingresos" detrás de la captura pasa el ingreso a gasto, no al revés', async () => {
    historial = [{ rol: 'neto', mensaje: '📸 *Ingreso registrado*\n\n💵 *Estacionamiento* — S/ 9.60', created_at: hace(2) }];
    toolCall = REGISTRAR;
    await procesarMensajeLibre('no son ingresos', USUARIO, '51999');
    expect(updatesTx()).toEqual([{ tipo: 'gasto' }]);
  });

  it('con la categoría cambiada, la confirmación lo dice', async () => {
    ultimo = { ...ESTACIONAMIENTO, categoria: 'Ingreso', subcategoria: null };
    toolCall = EDITAR_MONTO;
    const r = await procesarMensajeLibre('corregir como gasto', USUARIO, '51999');
    expect(String(r)).toMatch(/categoría \*Otros\*/);
  });
});
