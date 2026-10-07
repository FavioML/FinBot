import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El turno que sigue al menú de borrar la cuenta, mirando la BASE con los handlers REALES (07-oct-2026).
 *
 * `menu-borrado-mensaje-siguiente.test.js` espía los handlers que borran, y la segunda revisión
 * adversarial midió lo que eso no ve: con el freno apagado, sus casos "ningún DELETE" seguían verdes
 * porque el espía no escribe, y un atajo que LEE el último gasto y lo borra pasaba porque el doble no
 * tenía filas. Acá el doble tiene filas del usuario en las cuatro tablas, los handlers son los de
 * producción, y cada negativo tiene su control sin la marca, que SÍ borra: sin control, "no borró"
 * podría ser un doble mudo.
 */

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
// Registrar la deuda no es lo que se mide: lo que importa es si se BORRÓ la opuesta.
require('../../services/debts').registrarDeuda = vi.fn(async () => ({ id: 'd-nueva' }));

const ULTIMO = { id: 't-ultimo', usuario_id: 'u-1', comercio: 'cine', monto: 15, monto_pen: 15, moneda: 'PEN', categoria: 'Ocio', fecha: '2026-10-07', created_at: '2026-10-07T10:00:00Z' };
require('../../services/transactions').obtenerUltimaTransaccion = vi.fn(async () => ({ ...ULTIMO }));

const escrituras = [];
let FILAS;
function sembrar() {
  const ahora = new Date().toISOString();
  FILAS = {
    usuarios: [{ id: 'u-1' }],
    transacciones: [{ ...ULTIMO }],
    metas_ahorro: [{ id: 'm-1', usuario_id: 'u-1', nombre: 'Viaje', monto_objetivo: 2000, monto_actual: 0, completada: false, status: 'active', created_at: '2026-09-01' }],
    presupuestos: [{ id: 'p-1', usuario_id: 'u-1', categoria: 'Alimentación', monto_limite: 500, mes: 10, anio: 2026 }],
    // La anotación OPUESTA de hace un minuto: "Juan me debe 50" la borraba como corrección.
    deudas: [{ id: 'd-op', usuario_id: 'u-1', estado: 'activa', monto_original: 50, monto_pendiente: 50, tipo: 'debo', contraparte: 'Juan', moneda: 'PEN', created_at: ahora }],
  };
}
function chainPara(tabla) {
  let op = null;
  const filtros = [];
  const c = {};
  for (const m of ['select', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'in', 'is', 'not', 'neq', 'ilike', 'or', 'range', 'match']) c[m] = vi.fn(() => c);
  c.eq = vi.fn((col, val) => { filtros.push((f) => !(col in f) || f[col] === val); return c; });
  for (const m of ['insert', 'update', 'upsert', 'delete']) c[m] = vi.fn((payload) => { op = m; escrituras.push({ tabla, op: m, payload }); return c; });
  const resolver = () => {
    const filas = (FILAS[tabla] || []).filter((f) => filtros.every((fn) => fn(f)));
    if (op === 'insert' || op === 'upsert') return { data: [{ id: 'nuevo', ...(FILAS[tabla]?.[0] || {}) }], error: null };
    return { data: filas, error: null, count: filas.length };
  };
  c.single = vi.fn(async () => { const r = resolver(); return { data: r.data[0] || null, error: null }; });
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
const moderacion = require('../../handlers/intents/moderacion');

const USUARIO = { id: 'u-1', nombre: 'Ana', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01', onboarding_completado: true, onboarding_paso: 0 };
const borrados = () => escrituras.filter((e) => e.op === 'delete');

beforeEach(() => { escrituras.length = 0; sembrar(); });

describe('con sinBorrados no se borra ninguna fila; sin la marca, el mismo mensaje sí (control)', () => {
  // Cada caso: el mensaje, lo que el clasificador devuelve, y la tabla que el control borra.
  const CASOS = [
    ['borra el último', { name: 'manage_transaction', args: { action: 'undo' } }, 'transacciones'],
    ['deshacer', { name: 'manage_transaction', args: { action: 'undo' } }, 'transacciones'],
    ['borra el gasto de 15 en cine', { name: 'manage_transaction', args: { action: 'delete', monto: 15, comercio: 'cine' } }, 'transacciones'],
    ['elimina la meta Viaje', { name: 'manage_goals', args: { action: 'delete', nombre: 'Viaje' } }, 'metas_ahorro'],
    ['elimina el presupuesto de Alimentación', { name: 'manage_budget', args: { action: 'delete', categoria: 'Alimentación' } }, 'presupuestos'],
    ['Juan me debe 50', { name: 'manage_debts', args: { action: 'register', contraparte: 'Juan', monto: 50, tipo: 'me_deben' } }, 'deudas'],
  ];
  for (const [msg, tc, tabla] of CASOS) {
    it(`"${msg}"`, async () => {
      toolCall = tc;
      await procesarMensajeLibre(msg, { ...USUARIO }, '51999', { sinBorrados: true });
      expect(borrados()).toEqual([]);
      escrituras.length = 0;
      await procesarMensajeLibre(msg, { ...USUARIO }, '51999');
      expect(borrados().map((e) => e.tabla)).toContain(tabla);
    });
  }

  it('registrar_deuda con sinBorrados registra la deuda igual y avisa que la opuesta quedó', async () => {
    toolCall = { name: 'manage_debts', args: { action: 'register', contraparte: 'Juan', monto: 50, tipo: 'me_deben' } };
    const r = await procesarMensajeLibre('Juan me debe 50', { ...USUARIO }, '51999', { sinBorrados: true });
    expect(require('../../services/debts').registrarDeuda).toHaveBeenCalled();
    expect(r).toContain('anotación opuesta');
  });
});

describe('el menú que se reabre en el mismo turno se ve en la fila en memoria', () => {
  it('moderacion.desconectar_cuenta deja la fila en -1 solo si la escritura entró', async () => {
    const u = { ...USUARIO };
    const ctx = { supabase: require('../../lib/db').supabase, obtenerCuentasGmail: async () => [], log: { info() {}, warn() {}, error() {} } };
    await moderacion.handle({ intencion: 'desconectar_cuenta', msg: 'quiero darme de baja', datos: {}, usuario: u, from: '51999', ctx });
    expect(u.onboarding_paso).toBe(-1);

    FILAS.usuarios = [];   // la escritura afecta cero filas: el menú NO se abrió
    const u2 = { ...USUARIO };
    await moderacion.handle({ intencion: 'desconectar_cuenta', msg: 'quiero darme de baja', datos: {}, usuario: u2, from: '51999', ctx });
    expect(u2.onboarding_paso).toBe(0);
  });
});
