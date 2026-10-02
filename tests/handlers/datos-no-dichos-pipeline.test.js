import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El caso de prod del 02-oct-2026 por el pipeline ENTERO, con los handlers reales escribiendo.
 *
 * "No aparece en mi dashboard" llegó a `registrar_deuda` con monto y contraparte copiados del
 * turno anterior y Neto insertó "Le debes S/20 a bidon de agua". `tests/lib/datos-dichos.test.js`
 * prueba que el dato no LLEGA al handler; éste prueba lo que importa: que no se ESCRIBA nada,
 * mirando todas las escrituras a la base y a los servicios de plata. Cada negativo tiene su
 * control con el mensaje que sí nombra el dato, para que "no escribió" no sea un mock mudo.
 */

// ─── Parchar singletons ANTES de requerir el SUT (mismo patrón que borrado-compuesto) ───
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

// Los servicios que escriben plata: cada llamada es una escritura.
const escrituras = [];
const espia = (nombre, valor) => vi.fn(async (...args) => { escrituras.push({ servicio: nombre, args }); return valor; });
const debts = require('../../services/debts');
debts.registrarDeuda = espia('registrarDeuda', { id: 'd-nueva' });
debts.abonarDeuda = espia('abonarDeuda', { deuda: { contraparte: 'Juan', monto_pendiente: 0, moneda: 'PEN', tipo: 'debo' }, saldada: true, abono: 20 });
debts.marcarDeudaPagada = espia('marcarDeudaPagada', { contraparte: 'Juan', monto_original: 20, moneda: 'PEN', tipo: 'debo' });
debts.saldarTodasDeudas = espia('saldarTodasDeudas', 1);
require('../../services/metas').abonarMeta = espia('abonarMeta', null);
require('../../services/budget').guardarPresupuesto = espia('guardarPresupuesto', { id: 'p-1' });
require('../../services/transactions').guardarReglaComercio = espia('guardarReglaComercio', { ok: true, destino: { categoria: 'Transporte', subcategoria: null } });
require('../../services/transactions').retroaplicarRegla = espia('retroaplicarRegla', 0);

const META = { id: 'm-1', usuario_id: 'u-1', nombre: 'Viaje', monto_objetivo: 2000, monto_actual: 0, completada: false, status: 'active', created_at: '2026-09-01' };
const PRES = { id: 'p-1', usuario_id: 'u-1', categoria: 'Alimentación', monto_limite: 500, mes: 10, anio: 2026 };
const BORRADO = { id: 'e-1', usuario_id: 'u-1', restored_at: null, deleted_at: '2026-10-01', snapshot: { comercio: 'cine', monto: 30, moneda: 'PEN', fecha: '2026-10-01', categoria: 'Ocio' } };
// Laptop es la MÁS RECIENTE y va primero: es la que un handler toma cuando se descarta el nombre
// (ataque A4 de la revisión: "elimina esa meta" con el historial hablando de Viaje borraba Laptop).
const LAPTOP = { ...META, id: 'm-laptop', nombre: 'Laptop', created_at: '2026-09-20' };
const FILAS = { metas_ahorro: [LAPTOP, META], presupuestos: [PRES], transacciones_eliminadas: [BORRADO] };
// `corregir_categoria` sin comercio cae al último movimiento: tiene que existir para que el ataque A3
// escriba si la guarda no está.
const ULTIMO = { id: 't-ultimo', usuario_id: 'u-1', comercio: 'Wong', monto: 20, monto_pen: 20, moneda: 'PEN', categoria: 'Alimentación' };
require('../../services/transactions').obtenerUltimaTransaccion = vi.fn(async () => ({ ...ULTIMO }));
// La recategorización por comercio, espiada: devuelve la fila que "encontró" (el pago a Ricardo).
require('../../services/transactions').recategorizarTransaccion = espia('recategorizarTransaccion',
  { ok: true, tx: { id: 't-ricardo', comercio: 'Ricardo arauco v', monto: 12.6, monto_pen: 12.6, moneda: 'PEN' } });

// Toda escritura a la base queda anotada. Las lecturas devuelven las filas de FILAS.
function chainPara(tabla) {
  let op = null;
  const filtros = [];
  const c = {};
  for (const m of ['select', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'in', 'is', 'not', 'neq', 'ilike', 'or', 'range', 'match']) c[m] = vi.fn(() => c);
  // `eq` filtra de verdad sobre las columnas que la fila tiene: sin eso, el dedup de crear_meta
  // veía la meta del fixture como "el mismo plan" y el control no podía crear nada.
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

const USUARIO = { id: 'u-1', nombre: 'Rayza', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01' };
// Las tablas que el pipeline escribe para sí mismo y no son plata del usuario.
const PROPIAS = new Set(['conversaciones', 'nlp_errors', 'errores']);
const deUsuario = () => escrituras.filter((e) => !PROPIAS.has(e.tabla));

beforeEach(() => { escrituras.length = 0; });

const NO_NOMBRA = 'No aparece en mi dashboard';

// [nombre, tool call con datos que el modelo copió del historial, mensaje que SÍ los nombra]
const CASOS = [
  ['registrar_deuda (el caso de prod)', { name: 'manage_debts', args: { action: 'register', monto: 20, contraparte: 'bidon de agua', yo_debo: true } }, 'Debo 20 a bidon de agua'],
  ['abonar_deuda', { name: 'manage_debts', args: { action: 'pay', monto: 20, contraparte: 'Juan' } }, 'le pagué 20 a Juan'],
  ['marcar_deuda_pagada', { name: 'manage_debts', args: { action: 'mark_paid', contraparte: 'Juan' } }, 'ya le pagué todo a Juan'],
  ['saldar_todo_contraparte', { name: 'manage_debts', args: { action: 'settle_all', contraparte: 'Juan' } }, 'salda todo con Juan'],
  ['eliminar_meta', { name: 'manage_goals', args: { action: 'delete', nombre: 'Viaje' } }, 'elimina la meta viaje'],
  ['abonar_meta', { name: 'manage_goals', args: { action: 'deposit', monto_abono: 100 } }, 'aboné 100 a mi meta'],
  ['crear_meta', { name: 'manage_goals', args: { action: 'create', monto_objetivo: 3500, nombre: 'Moto' } }, 'quiero ahorrar 3500 para una moto'],
  ['configurar_presupuesto', { name: 'manage_budget', args: { action: 'set', categoria: 'Alimentación', monto: 500 } }, 'pon 500 de presupuesto en comida'],
  ['eliminar_presupuesto', { name: 'manage_budget', args: { action: 'delete', categoria: 'Alimentación' } }, 'elimina el presupuesto de comida'],
  ['restaurar_eliminado', { name: 'manage_transaction', args: { action: 'restore' } }, 'recupera lo que borré'],
];

describe('una escritura con datos que el mensaje no nombra no escribe nada', () => {
  it.each(CASOS)('%s: "No aparece en mi dashboard" no escribe', async (_n, tc) => {
    toolCall = tc;
    const r = await procesarMensajeLibre(NO_NOMBRA, USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
    expect(String(r)).not.toMatch(/Anotado|Listo|elimin[eé]|restaur|actualiz/i);
  });

  it.each(CASOS)('control %s: con el mensaje que lo nombra, SÍ escribe', async (_n, tc, msg) => {
    toolCall = tc;
    await procesarMensajeLibre(msg, USUARIO, '51999');
    expect(deUsuario().length).toBeGreaterThan(0);
  });

  it('el caso de prod contesta que no anotó nada, sin inventar la deuda', async () => {
    toolCall = CASOS[0][1];
    const r = await procesarMensajeLibre(NO_NOMBRA, USUARIO, '51999');
    expect(String(r)).toMatch(/No anoté nada nuevo/);
    expect(String(r)).not.toMatch(/bidon/i);
  });

  it('control del caso de prod: la deuda dicha se anota con SUS datos', async () => {
    toolCall = CASOS[0][1];
    await procesarMensajeLibre('Debo 20 a bidon de agua', USUARIO, '51999');
    const d = escrituras.find((e) => e.servicio === 'registrarDeuda');
    expect(d.args.slice(1, 4)).toEqual(['debo', 'bidon de agua', 20]);
  });
});

describe('una regla permanente de comercio, solo con el alcance dicho', () => {
  const REGLA = { name: 'manage_transaction', args: { action: 'set_category_rule', comercio: 'Plin', nueva_categoria: 'Transporte' } };
  const servicio = (n) => escrituras.filter((e) => e.servicio === n);

  // Contra prod (02-oct, control del harness): este mensaje creó "Plin → Transporte (siempre)".
  // La tercera revisión mostró que la versión anterior de este test pasaba sin probar nada: el
  // `recategorizarTransaccion` real chocaba con el guard de red. Hoy está espiado y devuelve la
  // fila que movió, así que se puede afirmar lo que el diseño promete: se mueve ESE pago, la regla
  // hacia adelante es la de su comercio real (no "Plin") y el pasado no se reescribe.
  it('"Cambiar Plin de ricardo como taxi" mueve ese pago, sin regla "Plin" y sin reescribir el pasado', async () => {
    toolCall = REGLA;
    const r = await procesarMensajeLibre('Cambiar Plin de ricardo como taxi', USUARIO, '51999');
    expect(servicio('recategorizarTransaccion')).toHaveLength(1);
    expect(servicio('retroaplicarRegla')).toEqual([]);
    expect(servicio('guardarReglaComercio').map((e) => e.args[1])).toEqual(['Ricardo arauco v']);
    expect(String(r)).not.toMatch(/Regla creada|siempre\)|todos los pagos anteriores/);
    expect(String(r)).toMatch(/siempre pon Ricardo arauco v en Transporte/);
  });

  it('control: "siempre pon Plin en Transporte" sí la crea y la aplica al pasado', async () => {
    toolCall = REGLA;
    await procesarMensajeLibre('siempre pon Plin en Transporte', USUARIO, '51999');
    expect(servicio('guardarReglaComercio').map((e) => e.args[1])).toEqual(['Plin']);
    expect(servicio('retroaplicarRegla')).toHaveLength(1);
  });
});

describe('rondas 2 y 3: los ataques de las revisiones adversariales, con los handlers escribiendo', () => {
  it('"Una deuda del bidón de agua no aparece en mi dashboard" no anota S/20', async () => {
    toolCall = CASOS[0][1];
    await procesarMensajeLibre('Una deuda del bidón de agua no aparece en mi dashboard', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
  });

  it('sin la forma de reporte, "una" no cuenta como el 20 del historial', async () => {
    toolCall = CASOS[0][1];
    await procesarMensajeLibre('anota una deuda del bidón de agua', USUARIO, '51999');
    expect(escrituras.find((e) => e.servicio === 'registrarDeuda')).toBeUndefined();
  });

  it('una queja que REPITE los datos no duplica la deuda', async () => {
    toolCall = { name: 'manage_debts', args: { action: 'register', monto: 20, contraparte: 'Juan', yo_debo: true } };
    await procesarMensajeLibre('La deuda de 20 con Juan no aparece en mi dashboard', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
  });

  it('el reporte tampoco recategoriza el último movimiento', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'recategorize', comercio: 'Plin', nueva_categoria: 'Transporte' } };
    await procesarMensajeLibre('No aparece en mi dashboard', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
  });

  it('ni borra un presupuesto', async () => {
    toolCall = { name: 'manage_budget', args: { action: 'delete', categoria: 'Alimentación' } };
    await procesarMensajeLibre('El presupuesto no me aparece en el dashboard', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
  });

  it('"elimina esa meta" con el historial hablando de Viaje no borra Laptop (ni ninguna)', async () => {
    toolCall = { name: 'manage_goals', args: { action: 'delete', nombre: 'Viaje' } };
    const r = await procesarMensajeLibre('elimina esa meta', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
    expect(String(r)).toMatch(/De qué meta/);
  });

  it('"Ya me pagó 50" con Juan en el historial no abona a "Ya" (el fallback no corre)', async () => {
    toolCall = { name: 'manage_debts', args: { action: 'pay', contraparte: 'Juan', monto: 50 } };
    const r = await procesarMensajeLibre('Ya me pagó 50', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
    expect(String(r)).toMatch(/Con quién es/);
  });
});

describe('ronda 3: lo que la tercera revisión ejecutó', () => {
  const servicio = (n) => escrituras.filter((e) => e.servicio === n);

  it('"Juan ya me abonó lo de las 2 entradas" no abona S/2 (ni los 50 del historial)', async () => {
    toolCall = { name: 'manage_debts', args: { action: 'pay', contraparte: 'Juan', monto: 50 } };
    await procesarMensajeLibre('Juan ya me abonó lo de las 2 entradas', USUARIO, '51999');
    expect(servicio('abonarDeuda')).toEqual([]);
  });

  it('"Los 100 que Juan me debe no aparecen en mi dashboard" no duplica la deuda', async () => {
    toolCall = { name: 'manage_debts', args: { action: 'register', monto: 100, contraparte: 'Juan', yo_debo: false } };
    await procesarMensajeLibre('Los 100 que Juan me debe no aparecen en mi dashboard', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
  });

  it('control: "Asocia Rappi a Delivery" sigue creando la regla (no se desvía)', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'set_category_rule', comercio: 'Rappi', nueva_categoria: 'Delivery' } };
    await procesarMensajeLibre('Asocia Rappi a Delivery', USUARIO, '51999');
    expect(servicio('guardarReglaComercio').map((e) => e.args[1])).toEqual(['Rappi']);
    expect(servicio('recategorizarTransaccion')).toEqual([]);
  });

  it('"registra un gasto de diez soles en taxi" conserva la defensa contra un comercio-frase', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'set_category_rule', comercio: 'gasto de diez soles en taxi', nueva_categoria: 'Transporte' } };
    const r = await procesarMensajeLibre('registra un gasto de diez soles en taxi', USUARIO, '51999');
    expect(servicio('recategorizarTransaccion')).toEqual([]);
    expect(servicio('guardarReglaComercio')).toEqual([]);
    expect(String(r)).toMatch(/gasté 10 en taxi/);
  });

  it('"eso va en transporte" con el comercio del historial no crea una regla ni mueve el último', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'set_category_rule', comercio: 'Uber', nueva_categoria: 'Transporte' } };
    const r = await procesarMensajeLibre('eso va en transporte', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
    expect(String(r)).toMatch(/De qué comercio/);
  });
});

describe('ronda 4: lo que la cuarta revisión ejecutó', () => {
  const servicio = (n) => escrituras.filter((e) => e.servicio === n);

  it('"Cambia eso a transporte" con Uber del historial no se desvía a mover el último: pregunta', async () => {
    toolCall = { name: 'manage_transaction', args: { action: 'set_category_rule', comercio: 'Uber', nueva_categoria: 'Transporte' } };
    const r = await procesarMensajeLibre('Cambia eso a transporte', USUARIO, '51999');
    expect(deUsuario()).toEqual([]);
    expect(String(r)).toMatch(/De qué comercio/);
  });

  it('control: "Anota que le debo 30 a Rosa, no me aparece en la app" sí anota', async () => {
    toolCall = { name: 'manage_debts', args: { action: 'register', monto: 30, contraparte: 'Rosa', yo_debo: true } };
    await procesarMensajeLibre('Anota que le debo 30 a Rosa, no me aparece en la app', USUARIO, '51999');
    expect(servicio('registrarDeuda').map((e) => e.args.slice(1, 4))).toEqual([['debo', 'Rosa', 30]]);
  });

  it('"Le debo mil 500 soles a Juan" anota 1500, no 500', async () => {
    toolCall = { name: 'manage_debts', args: { action: 'register', monto: 1500, contraparte: 'Juan', yo_debo: true } };
    await procesarMensajeLibre('Le debo mil 500 soles a Juan', USUARIO, '51999');
    expect(servicio('registrarDeuda').map((e) => e.args[3])).toEqual([1500]);
  });
});
