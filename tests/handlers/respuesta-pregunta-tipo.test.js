import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * La respuesta a la pregunta fija de tipo (17-oct-2026, arreglo intermedio de
 * `memory/reports/neto-nlp-arquitectura-2026-10-17.md`). Medido en el arnés del reporte, 3 de 3:
 * "Gasto" contestando "¿Esos S/28 entraron o salieron?" iba al extractor, que no ve la conversación,
 * decidía `no_es_movimiento` y Neto contestaba "Eso no lo anoté".
 *
 * Tres capas, y cada una tiene su test que muere si se revierte:
 *  · `respuestaAPreguntaDeTipo` decide (pura);
 *  · `procesarMensajeLibre` la usa ANTES del clasificador y manda a `registrar_manual`;
 *  · `registrar_manual` registra el monto preguntado sin llamar al extractor.
 */

// ─── Singletons parchados ANTES de requerir el SUT (message-processor destructura al cargar) ──
let historial = [];
require('../../helpers/db-helpers').obtenerHistorial = vi.fn(async () => historial);
require('../../helpers/db-helpers').guardarMensaje = vi.fn(async () => {});
require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn(async () => null);
require('../../gmail').tieneGmailConectado = vi.fn(async () => false);
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = vi.fn();

// El clasificador contesta texto (sin herramienta): si se lo llama, el mensaje termina en "fuera de
// alcance" y no se registra nada. Es el control de que la respuesta NO pasó por él.
const crear = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'texto' } }] });
require('../../lib/ai').openai.chat.completions.create = crear;

const guardarTransaccion = vi.fn(async (_uid, d) => ({ id: 'tx-1', categoria: d.categoria, subcategoria: d.subcategoria, conteoTx: 7 }));
require('../../services/transactions').guardarTransaccion = guardarTransaccion;
const parsearRegistroManual = vi.fn(async () => ({ ok: false, decision: 'no_es_movimiento', monto: 0 }));
require('../../services/parsers').parsearRegistroManual = parsearRegistroManual;
const detectarCategoriaIA = vi.fn(async () => ({ categoria: null }));
require('../../services/categories').detectarCategoriaIA = detectarCategoriaIA;
require('../../services/categories').asegurarCategoriaUsuario = vi.fn().mockResolvedValue('creada');
require('../../services/budget').verificarAlertaPresupuesto = vi.fn().mockResolvedValue(null);

function makeChain() {
  const c = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'ilike', 'gte', 'lte', 'is',
    'neq', 'not', 'or', 'order', 'limit', 'range', 'single', 'maybeSingle']) c[m] = vi.fn(() => c);
  c.then = (f, r) => Promise.resolve({ data: [], error: null, count: 0 }).then(f, r);
  return c;
}
require('../../lib/db').supabase = { from: vi.fn(() => makeChain()), rpc: vi.fn(async () => ({ data: null, error: null })) };

const { procesarMensajeLibre } = require('../../handlers/message-processor');
const { respuestaAPreguntaDeTipo, handle } = require('../../handlers/intents/transacciones');

const USUARIO = { id: 'u-1', nombre: 'Ana', plan: 'premium', trial_estado: 'convertido', whatsapp: '51999' };
const AHORA = Date.parse('2026-10-17T15:00:00Z');
const hace = (min) => new Date(AHORA - min * 60000).toISOString();
const PREGUNTA_28 = '¿Esos S/28 entraron o salieron? Escríbemelo con el verbo: "gasté 28 en…" o "me pagaron 28".';
const PREGUNTA_USD = '¿Esos $12.50 entraron o salieron? Escríbemelo con el verbo: "gasté 12.50 dólares en…" o "me pagaron 12.50 dólares".';
const ventana = (previo, pregunta = PREGUNTA_28, min = 1) => [
  { rol: 'usuario', mensaje: previo, created_at: hace(min + 0.1) },
  { rol: 'neto', mensaje: pregunta, created_at: hace(min) },
];

beforeEach(() => {
  crear.mockClear(); guardarTransaccion.mockClear(); parsearRegistroManual.mockClear(); detectarCategoriaIA.mockClear();
});

describe('respuestaAPreguntaDeTipo: cuándo un mensaje contesta la pregunta', () => {
  it.each([
    ['Gasto', 'gasto'],
    ['Gasté', 'gasto'],
    ['fue un gasto', 'gasto'],
    ['sí, gasto', 'gasto'],
    ['Gasto nomás', 'gasto'],
    ['salió', 'gasto'],
    ['Salieron', 'gasto'],
    ['Es un ingreso', 'ingreso'],
    ['entró', 'ingreso'],
    ['entraron', 'ingreso'],
    ['me pagaron', 'ingreso'],
  ])('"%s" → %s de S/28', (msg, tipo) => {
    expect(respuestaAPreguntaDeTipo(msg, ventana('28, tarjeta de débito'), AHORA))
      .toEqual({ monto: 28, moneda: 'PEN', tipo, texto: '28, tarjeta de débito' });
  });

  it('en dólares, con decimales', () => {
    expect(respuestaAPreguntaDeTipo('gasto', ventana('12.50 dólares netflix', PREGUNTA_USD), AHORA))
      .toEqual({ monto: 12.5, moneda: 'USD', tipo: 'gasto', texto: '12.50 dólares netflix' });
  });

  // La lista cerrada es la defensa: la primera versión ("nombra un sentido y tiene hasta seis
  // palabras") guardaba un gasto de S/X con cada uno de estos (revisión adversarial del 17-oct).
  it.each([
    'mis gastos del mes', 'Quiero ver mis gastos', 'Borra ese gasto', 'elimina el gasto', 'cancela ese gasto',
    'Gasto. Borra el anterior', 'gasto y borra el último', 'pagué la deuda', 'le pagué a Juan', 'Transferí a mi otra cuenta',
    'ya lo anoté como gasto', 'ese gasto ya está', 'Gastos', 'ingresos', 'sin gasto', 'jamás gasté eso', 'nunca gasté eso',
    'tampoco es gasto', 'no es gasto', 'Gasto de mañana', 'Gasto de ayer', 'gasto de una cosa que compré en el mercado',
    'gasto, no, ingreso', 'ok', 'sí', 'Gaste 300', 'gasté cincuenta', '¿gasto?', 'pagué', 'entrada',
  ])('no contesta: "%s"', (msg) => {
    expect(respuestaAPreguntaDeTipo(msg, ventana('28, tarjeta de débito'), AHORA)).toBeNull();
  });

  it('la pregunta tiene que ser lo ÚLTIMO, de hace menos de 30 minutos e idéntica al texto fijo', () => {
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('28 x', PREGUNTA_28, 29), AHORA)).not.toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('28 x', PREGUNTA_28, 31), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('28 x', PREGUNTA_28 + '\n\n✅ S/10 en Otros', 1), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('28 x', PREGUNTA_28.slice(0, 60), 1), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('28 x', '¿Esa plata entró o salió? Escríbemelo con el verbo: "gasté 35 en…" o "me pagaron 35".'), AHORA)).toBeNull();
    const sinHora = ventana('28 x'); delete sinHora[1].created_at;
    expect(respuestaAPreguntaDeTipo('Gasto', sinHora, AHORA)).toBeNull();
    // Después de la pregunta Neto ya dijo otra cosa: la pregunta no es lo último.
    expect(respuestaAPreguntaDeTipo('Gasto', [...ventana('28 x'), { rol: 'usuario', mensaje: 'hola', created_at: hace(0.5) }, { rol: 'neto', mensaje: '¡Hola!', created_at: hace(0.4) }], AHORA)).toBeNull();
    // El turno de antes de la pregunta no es de la persona.
    expect(respuestaAPreguntaDeTipo('Gasto', [{ rol: 'neto', mensaje: '28 te recuerdo tu deuda', created_at: hace(1.1) }, { rol: 'neto', mensaje: PREGUNTA_28, created_at: hace(1) }], AHORA)).toBeNull();
  });

  it('el monto tiene que estar escrito en el mensaje que Neto preguntó, con su moneda', () => {
    // Una pregunta sobre un monto que el modelo leyó mal no se vuelve plata.
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('280 en algo'), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('veintiocho soles'), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('28 euros'), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', [{ rol: 'neto', mensaje: PREGUNTA_28, created_at: hace(1) }], AHORA)).toBeNull();
    // La moneda de la pregunta la puso el modelo: tiene que ser la del mensaje.
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('$28 netflix'), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('28 dólares'), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('28 dls netflix'), AHORA)).toBeNull();
    // Con dos montos en el mensaje uno quedaría afuera.
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('luz 28 agua 20'), AHORA)).toBeNull();
    expect(respuestaAPreguntaDeTipo('Gasto', ventana('12.50 netflix', PREGUNTA_USD), AHORA)).toBeNull();
  });

  it.each([
    '28 el 13-oct', '28 el lunes', '28.00 del 13 de oct', '28.00 13 oct', '28 del mes pasado', '28.00 hace una semana',
    '28.00 el pasado 10', '28.00 del 1ro', '28 el finde', '28 en septiembre', '28.00 anoche', 'hoy vi 28.00 del 13-oct',
    '06.10 gasté 28', '28 en la noche',
    // Segunda revisión: "del 13" sin mes, palabras de número y "antes de ayer" (que los guards de fecha
    // resuelven mal), "el primero" y un "hace" fuera de rango.
    '28.00 del 13', '28.00 hace dos dias', '28 antes de ayer', '28 el primero', '28.00 hace 400 dias',
  ])('una fecha que el código no resuelve solo no se toma: "%s"', (previo) => {
    expect(respuestaAPreguntaDeTipo('Gasto', ventana(previo), AHORA)).toBeNull();
  });

  it.each(['28 ayer', '28 hoy', '28 hace 2 días', '28 el lunes pasado', '28 antier'])('las que sí resuelve: "%s"', (previo) => {
    expect(respuestaAPreguntaDeTipo('Gasto', ventana(previo), AHORA)).not.toBeNull();
  });
});

describe('procesarMensajeLibre: la respuesta se registra sin clasificador ni extractor', () => {
  it('"Gasto" a "¿Esos S/28…?" registra S/28 como gasto', async () => {
    historial = ventana('28, tarjeta de débito', PREGUNTA_28, 1).map((t) => ({ ...t, created_at: new Date(Date.now() - 60000).toISOString() }));
    const r = await procesarMensajeLibre('Gasto', USUARIO, '51999');
    expect(crear).not.toHaveBeenCalled();
    expect(parsearRegistroManual).not.toHaveBeenCalled();
    expect(guardarTransaccion).toHaveBeenCalledTimes(1);
    expect(guardarTransaccion.mock.calls[0][1]).toMatchObject({ monto: 28, moneda: 'PEN', tipo: 'gasto', descripcion_original: '28, tarjeta de débito' });
    // La categoría se busca sobre el mensaje con el monto, no sobre la palabra suelta.
    expect(detectarCategoriaIA.mock.calls[0][0]).toBe('28, tarjeta de débito');
    expect(r).toMatch(/^✅ S\/28\.00 en /);
  });

  it('control: con la pregunta de hace 31 minutos va al clasificador y no registra', async () => {
    historial = ventana('28, tarjeta de débito').map((t) => ({ ...t, created_at: new Date(Date.now() - 31 * 60000).toISOString() }));
    await procesarMensajeLibre('Gasto', USUARIO, '51999');
    expect(crear).toHaveBeenCalled();
    expect(guardarTransaccion).not.toHaveBeenCalled();
  });
});

describe('registrar_manual con ctx.respuestaTipo', () => {
  const ctxBase = () => ({
    supabase: { from: vi.fn(() => makeChain()) },
    parsearRegistroManual, guardarTransaccion, detectarCategoriaIA,
    asegurarCategoriaUsuario: vi.fn().mockResolvedValue('creada'),
    crearSubcategoriaLibreUsuario: vi.fn(),
    verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null),
    fechaHoyPeru: () => '2026-10-17', fechaAyerPeru: () => '2026-10-16', formatFecha: (f) => f,
    historialConv: [],
  });
  const registrar = (msg, ctx) => handle({ intencion: 'registrar_manual', msg, datos: {}, usuario: USUARIO, from: '51999', ctx });

  it('ingreso en dólares, con la fecha del mensaje original ("ayer")', async () => {
    const ctx = { ...ctxBase(), respuestaTipo: { monto: 12.5, moneda: 'USD', tipo: 'ingreso', texto: '12.50 ayer' } };
    await registrar('entró', ctx);
    expect(parsearRegistroManual).not.toHaveBeenCalled();
    expect(guardarTransaccion.mock.calls[0][1]).toMatchObject({ monto: 12.5, moneda: 'USD', tipo: 'ingreso', fecha: '2026-10-16' });
    // Se consume: otro despacho del mismo mensaje no puede volver a registrarlo.
    expect(ctx.respuestaTipo).toBeNull();
  });

  it('el monto se valida contra el mensaje original: si no está escrito, no se guarda', async () => {
    const ctx = { ...ctxBase(), respuestaTipo: { monto: 28, moneda: 'PEN', tipo: 'gasto', texto: '280 en algo' } };
    await registrar('Gasto', ctx);
    expect(guardarTransaccion).not.toHaveBeenCalled();
  });
});
