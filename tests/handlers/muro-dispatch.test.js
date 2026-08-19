import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * M21 de la auditoría del 10-ago: el muro se evaluaba UNA vez, con la intención que salía
 * del LLM maestro, y el pipeline despacha handlers en CUATRO sitios. Los otros tres tomaban
 * el handler del registry y lo llamaban directo, así que "gasté 20 en taxi y cuánto llevo
 * este mes" entregaba la lectura gratis a quien está en el muro.
 *
 * Este archivo ejercita el gate **por cada call-site**, no una vez y por elevación. Es la
 * lección que la sesión anterior pagó tres veces: un fix con N call-sites necesita N
 * mutaciones, una por sitio. Cada `it` de acá muere si se revierte SU sitio a `getHandler`:
 *
 *   dispatch primario              → «una lectura directa muere en el muro»
 *   continuación multi-intent      → «la continuación multi-intent …»
 *   redirect pre-parser            → «el redirect pre-parser …»
 *   redirect post-parser-fail      → «el redirect post-parser …»
 *
 * Los controles en trial son lo que impide que estos pasen por vacuidad: sin ellos, un
 * pipeline roto que devolviera cualquier cosa también daría "no entregó la lectura". El
 * centinela viaja DENTRO de la respuesta del handler de lecturas, así que "no está" solo
 * puede significar que ese handler no corrió.
 */

const CENTINELA = 'ZZ-DESGLOSE-SECRETO-ZZ';

// ─── Parchar singletons ANTES de requerir el SUT ────────────────────────────
// message-processor.js y los handlers de intents destructuran sus dependencias al cargar,
// y el registry captura `mod.handle` al cargar. Todo lo de acá tiene que ocurrir antes del
// `require` de message-processor, que es quien arrastra al registry.

require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn().mockResolvedValue(null);
require('../../gmail').obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
require('../../helpers/db-helpers').obtenerHistorial = vi.fn().mockResolvedValue([]);
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = vi.fn().mockResolvedValue(undefined);

// El camino del gasto. Lo que importa es que `registrar_manual` LLEGUE a completarse: solo
// así el mensaje sigue hasta la continuación multi-intent, que es el call-site 2.
const parsers = require('../../services/parsers');
parsers.parsearRegistroManual = vi.fn().mockResolvedValue({
  ok: true, monto: 20, moneda: 'PEN', tipo: 'gasto',
  categoria: 'Transporte', subcategoria: null, fecha: null,
});
require('../../services/categories').detectarCategoriaIA = vi.fn().mockResolvedValue({ categoria: null });
require('../../services/categories').asegurarCategoriaUsuario = vi.fn().mockResolvedValue('nada');
require('../../services/categories').crearSubcategoriaLibreUsuario = vi.fn().mockResolvedValue(null);
require('../../services/transactions').guardarTransaccion = vi.fn().mockResolvedValue({
  id: 'tx-1', categoria: 'Transporte', subcategoria: 'sin_categoria', conteoTx: 3,
});
require('../../services/budget').verificarAlertaPresupuesto = vi.fn().mockResolvedValue(null);
require('../../lib/trial').colaConfirmacionGasto = vi.fn().mockResolvedValue('');

// El handler de lecturas, envuelto ANTES de que el registry lo capture. Devuelve el
// centinela para los dos intents que este archivo dirige hacia él.
const modGastos = require('../../handlers/intents/gastos.js');
const handleGastosReal = modGastos.handle;
let vecesLectura = 0;
modGastos.handle = async (args) => {
  if (args.intencion === 'listar_gastos_mes' || args.intencion === 'ver_total_gastado') {
    vecesLectura++;
    return 'Tus gastos del mes: ' + CENTINELA;
  }
  return handleGastosReal(args);
};

// El splitter se requiere PEREZOSAMENTE dentro de procesarMensajeLibre, así que se puede
// reemplazar por test. Lo usa el caso de `d1.muro`, que hoy es inalcanzable con la
// clasificación real (las tres intenciones que producen continuación están fijadas como
// LIBRES) y que igual tiene que estar cubierto.
const splitter = require('../../services/multi-intent-splitter');
const detectarContinuacionReal = splitter.detectarContinuacion;

// Analytics: el evento dice que respondió el gate del muro, y con qué intención.
const eventos = [];
require('../../lib/analytics').capture = vi.fn((id, ev, props) => { eventos.push({ ev, props: props || {} }); });

// Supabase: el conteo del muro (`count`) y cualquier lectura suelta.
const chainSb = {};
for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'is', 'not']) {
  chainSb[m] = vi.fn(() => chainSb);
}
chainSb.single = vi.fn().mockResolvedValue({ data: null, error: null });
chainSb.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
chainSb.then = (onF, onR) => Promise.resolve({ data: [], error: null, count: 7 }).then(onF, onR);
require('../../lib/db').supabase = { from: vi.fn(() => chainSb) };

// OpenAI: el clasificador maestro. `toolDelLLM` decide qué tool call devuelve.
const TOOL_CALLS = {
  registrar_manual: { name: 'register_transaction', args: { amount: 20, description: 'taxi', type: 'expense' } },
  listar_gastos_mes: { name: 'query_expenses', args: { action: 'month' } },
};
let toolDelLLM = 'registrar_manual';
const crearCompletion = vi.fn(async () => {
  const tc = TOOL_CALLS[toolDelLLM];
  return {
    choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] } }],
  };
});
require('../../lib/ai').openai = { chat: { completions: { create: crearCompletion } } };

const { procesarMensajeLibre } = require('../../handlers/message-processor');
const { mensajeMuro } = require('../../lib/trial');

const EN_MURO = { id: 'u-muro', nombre: 'Favio', plan: 'free', trial_estado: 'vencido', trial_vence: '2026-07-01' };
const EN_TRIAL = { id: 'u-trial', nombre: 'Favio', plan: 'premium', trial_estado: 'activo', trial_vence: '2026-09-01' };

// El prefijo se deriva en runtime, no se hardcodea el emoji: si cambia el copy, esto sigue
// apuntando al mensaje del muro y no a un literal viejo.
const MARCA = mensajeMuro(EN_MURO, 7).split(' ')[0];
const esMuro = (t) => String(t || '').includes(MARCA);
const filtro = (t) => !String(t || '').includes(CENTINELA);
const eventosMuro = () => eventos.filter((e) => e.ev === 'wa_muro_lectura');

const PARSE_OK = {
  ok: true, monto: 20, moneda: 'PEN', tipo: 'gasto',
  categoria: 'Transporte', subcategoria: null, fecha: null,
};

beforeEach(() => {
  eventos.length = 0;
  vecesLectura = 0;
  toolDelLLM = 'registrar_manual';
  crearCompletion.mockClear();
  splitter.detectarContinuacion = detectarContinuacionReal;
  // `mockReset` y no `mockClear`: el segundo NO drena los `mockResolvedValueOnce`
  // encolados, así que un `{ok:false}` que su test no llegue a consumir se lo come el
  // test siguiente. Lo encontró la revisión adversarial de este mismo archivo.
  parsers.parsearRegistroManual.mockReset();
  parsers.parsearRegistroManual.mockResolvedValue(PARSE_OK);
});

describe('M21 — el muro se evalúa en CADA dispatch, no solo en el primero', () => {
  // ── Call-site 1: el dispatch primario ────────────────────────────────────
  it('una lectura directa muere en el muro (dispatch primario)', async () => {
    toolDelLLM = 'listar_gastos_mes';
    const r = await procesarMensajeLibre('mis gastos del mes', EN_MURO, '51999');
    expect(esMuro(r)).toBe(true);
    expect(filtro(r)).toBe(true);
    expect(eventosMuro()).toHaveLength(1);
    expect(eventosMuro()[0].props.intencion).toBe('listar_gastos_mes');
  });

  it('control: en trial, esa misma lectura SÍ se entrega', async () => {
    toolDelLLM = 'listar_gastos_mes';
    const r = await procesarMensajeLibre('mis gastos del mes', EN_TRIAL, '51999');
    expect(esMuro(r)).toBe(false);
    expect(r).toContain(CENTINELA);
  });

  // ── Call-site 2: la continuación multi-intent ────────────────────────────
  it('la continuación multi-intent no entrega la lectura en el muro', async () => {
    const r = await procesarMensajeLibre('gasté 20 en taxi y cuánto llevo este mes', EN_MURO, '51999');
    expect(r).toContain('✅');        // la escritura sí ocurrió: no se negocia
    expect(filtro(r)).toBe(true);      // pero el desglose NO viajó
    expect(esMuro(r)).toBe(true);
    expect(eventosMuro()).toHaveLength(1);
  });

  it('control: en trial, la continuación SÍ entrega la lectura', async () => {
    const r = await procesarMensajeLibre('gasté 20 en taxi y cuánto llevo este mes', EN_TRIAL, '51999');
    expect(r).toContain('✅');
    expect(r).toContain(CENTINELA);
  });

  // ── Call-site 3: el redirect pre-parser de registrar_manual ──────────────
  it('el redirect pre-parser de registrar_manual no entrega la lectura en el muro', async () => {
    // El LLM clasificó register, pero no hay patrón "verbo + monto + en/de/por": el
    // pre-check redirige a la query ANTES de llamar al parser.
    const r = await procesarMensajeLibre('cuánto llevo este mes', EN_MURO, '51999');
    expect(esMuro(r)).toBe(true);
    expect(filtro(r)).toBe(true);
    expect(parsers.parsearRegistroManual).not.toHaveBeenCalled();
    expect(eventosMuro()).toHaveLength(1);
  });

  it('control: en trial, el redirect pre-parser SÍ entrega la lectura', async () => {
    const r = await procesarMensajeLibre('cuánto llevo este mes', EN_TRIAL, '51999');
    expect(r).toContain(CENTINELA);
    expect(esMuro(r)).toBe(false);
    expect(parsers.parsearRegistroManual).not.toHaveBeenCalled();
  });

  // ── Call-site 4: el redirect post-parser-fail ────────────────────────────
  it('el redirect post-parser de registrar_manual no entrega la lectura en el muro', async () => {
    // Acá el pre-check NO dispara (hay patrón de gasto) y el parser es el que falla.
    //
    // ⚠️ El mensaje va SIN coma, y hace falta que sea así para que este test siga midiendo lo
    // que su nombre dice. Con coma ("gasté 20 en algo, cuánto llevo este mes"),
    // `partirEscrituraLectura` lo reconoce como mensaje COMPUESTO: `registrar_manual` se queda
    // con la mitad de escritura, el redirect post-parser ya no se evalúa nunca, y la lectura
    // sale por la CONTINUACIÓN — o sea el call-site 2, que ya tiene su propio test.
    // Medido: con la coma, neutralizar el redirect post-parser dejaba los 16 tests en VERDE.
    parsers.parsearRegistroManual.mockResolvedValueOnce({ ok: false });
    const r = await procesarMensajeLibre('gasté 20 en algo cuánto llevo este mes', EN_MURO, '51999');
    expect(parsers.parsearRegistroManual).toHaveBeenCalled();
    expect(esMuro(r)).toBe(true);
    expect(filtro(r)).toBe(true);
  });

  it('control: en trial, el redirect post-parser SÍ entrega la lectura', async () => {
    parsers.parsearRegistroManual.mockResolvedValueOnce({ ok: false });
    const r = await procesarMensajeLibre('gasté 20 en algo cuánto llevo este mes', EN_TRIAL, '51999');  // sin coma: ver el test de arriba
    expect(parsers.parsearRegistroManual).toHaveBeenCalled();
    expect(r).toContain(CENTINELA);
  });

  // ── La regla que no se negocia ───────────────────────────────────────────
  it('registrar un gasto sigue siendo gratis en el muro', async () => {
    const r = await procesarMensajeLibre('gasté 20 en taxi', EN_MURO, '51999');
    expect(esMuro(r)).toBe(false);
    expect(r).toContain('✅');
    expect(eventosMuro()).toHaveLength(0);
  });
});

describe('M21 — el redirect y la continuación no resuelven dos veces lo mismo', () => {
  // El handler de `registrar_manual` que redirige resuelve el mensaje ENTERO como query.
  // Si además corriera la continuación, el mismo handler se ejecutaría dos veces: dos
  // filas en `conversaciones`, dos eventos de analytics, y —en el muro— el mensaje del
  // muro pegado a sí mismo. Lo encontró la revisión adversarial del fix de M21.
  it('en el muro, el gate se dispara UNA vez y el mensaje sale UNA vez', async () => {
    parsers.parsearRegistroManual.mockResolvedValue({ ok: false });
    const r = await procesarMensajeLibre('gasté algo y cuánto llevo este mes', EN_MURO, '51999');
    expect(String(r).split(MARCA).length - 1).toBe(1);
    expect(eventosMuro()).toHaveLength(1);
  });

  it('fuera del muro, el handler de lectura corre UNA vez', async () => {
    parsers.parsearRegistroManual.mockResolvedValue({ ok: false });
    await procesarMensajeLibre('gasté algo y cuánto llevo este mes', EN_TRIAL, '51999');
    expect(vecesLectura).toBe(1);
  });

  // El caso de arriba entra por el redirect PRE-parser (el mensaje no tiene el patrón
  // "verbo + monto + en/de/por"). Este entra por el POST-parser, que es otro `if` y otra
  // asignación del flag: sin este test, quitarle el flag a ese sitio pasaba en verde.
  it('el redirect POST-parser también corta la continuación', async () => {
    parsers.parsearRegistroManual.mockResolvedValue({ ok: false });
    await procesarMensajeLibre('gasté 20 en taxi y cuánto llevo este mes', EN_TRIAL, '51999');
    expect(parsers.parsearRegistroManual).toHaveBeenCalled();  // no fue el pre-check
    expect(vecesLectura).toBe(1);
  });

  // La regresión que la comparación `d2.respuesta !== r1` había introducido: dos gastos
  // que parsean idéntico producen la MISMA confirmación a propósito, y esconder la
  // segunda deja al usuario con dos filas guardadas y un solo ✅.
  //
  // ⚠️ El mensaje NO puede ser "gasté 20 en taxi y gasté 20 en taxi": eso lo agarra
  // `detectarMultiGasto` mucho antes del dispatch (dos pares monto+preposición) y sale por
  // el fanout homogéneo, así que el test pasaba con y sin la comparación puesta — vacuo.
  // Lo destapó la mutación, no la corrida en verde.
  it('una continuación register+register idéntica muestra las DOS confirmaciones', async () => {
    splitter.detectarContinuacion = () => ({ intencion: 'registrar_manual', datos: {}, parte2: 'otra vez lo mismo' });
    const r = await procesarMensajeLibre('gasté 20 en taxi y otra vez lo mismo', EN_TRIAL, '51999');
    expect(String(r).split('✅').length - 1).toBe(2);
  });

  // `d1.muro`: inalcanzable con la clasificación real, cubierto con el splitter mockeado.
  it('si la primera parte muere en el muro, la continuación NO se despacha', async () => {
    toolDelLLM = 'listar_gastos_mes';
    splitter.detectarContinuacion = () => ({ intencion: 'listar_gastos_mes', datos: {}, parte2: 'y cuánto llevo' });
    const r = await procesarMensajeLibre('mis gastos del mes y cuánto llevo', EN_MURO, '51999');
    expect(String(r).split(MARCA).length - 1).toBe(1);
    expect(vecesLectura).toBe(0);
    expect(eventosMuro()).toHaveLength(1);
  });
});

/**
 * La fila `usuario` se lee UNA vez, al entrar al pipeline, o sea antes de que la primera
 * parte escriba nada. Si esa escritura arranca el trial, la fila en memoria sigue diciendo
 * `plan='free'` y `estaEnMuro` la da por amurallada — así que la parte 2 recibe el muro que
 * esa persona acaba de dejar atrás, en el mismo mensaje.
 *
 * Es el caso del usuario NUEVO, que es el que más importa: su primer gasto es el que
 * arranca los 14 días, y el mixto es una forma natural de escribirle a un bot por primera
 * vez ("gasté 20 en taxi, cuánto llevo hoy"). Sin la sincronización recibía
 * "🎁 Acabas de estrenar Neto Pro" y pegado abajo "🔒 necesitas Neto Pro".
 *
 * El control en el mismo `describe` es lo que impide que esto pase por vacuidad: si el
 * pipeline dejara de despachar la continuación, el primer test también daría "no salió el
 * muro" y estaría verde por la razón equivocada.
 */
describe('el trial que arranca en la parte 1 vale para la parte 2', () => {
  const NUEVO = { id: 'u-nuevo', nombre: 'Favio', plan: 'free', trial_estado: null, trial_vence: null };
  const guardar = require('../../services/transactions').guardarTransaccion;

  it('el gasto que estrena el trial hace que la consulta SÍ se entregue', async () => {
    guardar.mockResolvedValueOnce({
      id: 'tx-1', categoria: 'Transporte', subcategoria: 'sin_categoria', conteoTx: 1,
      trialIniciado: true, trialVence: '2026-09-01',
    });
    const r = await procesarMensajeLibre('gasté 20 en taxi, cuánto llevo este mes', { ...NUEVO }, '51999');
    expect(r).toContain('✅');            // la escritura ocurrió
    expect(r).toContain(CENTINELA);        // y la lectura también: ya no está en el muro
    expect(esMuro(r)).toBe(false);         // sin el muro contradiciendo al 🎁 de arriba
    expect(eventosMuro()).toHaveLength(0);
  });

  /**
   * El evento del mensaje mixto, que es el ÚNICO instrumento consultable que tiene ese camino.
   *
   * Se midió el 2026-08-18 que esta forma de mensaje tiene cero ocurrencias en la historia del
   * producto, y el arreglo se shippeó igual. Sin este evento, dentro de un mes la pregunta
   * "¿le pasó a alguien?" no tendría con qué responderse: el log de `MSG_MIXTO` va a stdout de
   * Railway y `conversaciones` se auto-purga.
   *
   * Se asierta `enMuro`, no solo que el evento salió: esa propiedad es la que separa "alguien
   * escribió un compuesto" de "alguien perdió su gasto Y recibió un pedido de plata", que era
   * el caso que abrió toda esta sesión. Un evento sin esa dimensión no responde la pregunta
   * que lo justifica.
   */
  it('el mensaje mixto emite su evento, y dice si la persona estaba en el muro', async () => {
    guardar.mockResolvedValueOnce({
      id: 'tx-1', categoria: 'Transporte', subcategoria: 'sin_categoria', conteoTx: 9,
    });
    await procesarMensajeLibre('gasté 20 en taxi, cuánto llevo este mes', { ...NUEVO }, '51999');
    const mixtos = eventos.filter((e) => e.ev === 'wa_mensaje_mixto');
    expect(mixtos).toHaveLength(1);
    expect(mixtos[0].props.lectura).toBe('ver_total_gastado');
    expect(mixtos[0].props.enMuro).toBe(true);
  });

  it('control: con Pro, el mismo evento sale con enMuro=false', async () => {
    // Sin este control, `enMuro: true` podría estar hardcodeado y el test no lo vería.
    guardar.mockResolvedValueOnce({
      id: 'tx-1', categoria: 'Transporte', subcategoria: 'sin_categoria', conteoTx: 9,
    });
    await procesarMensajeLibre('gasté 20 en taxi, cuánto llevo este mes', EN_TRIAL, '51999');
    const mixtos = eventos.filter((e) => e.ev === 'wa_mensaje_mixto');
    expect(mixtos).toHaveLength(1);
    expect(mixtos[0].props.enMuro).toBe(false);
  });

  it('un mensaje que NO es mixto no emite el evento', async () => {
    // Anti-vacuidad por el otro lado: si el evento saliera en todo registro, el conteo del mes
    // que viene mediría "cuánta gente anota gastos", no esta forma de mensaje.
    guardar.mockResolvedValueOnce({
      id: 'tx-1', categoria: 'Transporte', subcategoria: 'sin_categoria', conteoTx: 9,
    });
    await procesarMensajeLibre('gasté 20 en taxi', { ...NUEVO }, '51999');
    expect(eventos.filter((e) => e.ev === 'wa_mensaje_mixto')).toHaveLength(0);
  });

  it('control: si ese mismo gasto NO estrena trial, la consulta sigue muriendo en el muro', async () => {
    // Mismo mensaje, mismo usuario amurallado, y lo único que cambia es `trialIniciado`.
    // Sin este control, el test de arriba sería verde con un pipeline que dejó de gatear.
    guardar.mockResolvedValueOnce({
      id: 'tx-1', categoria: 'Transporte', subcategoria: 'sin_categoria', conteoTx: 9,
    });
    const r = await procesarMensajeLibre('gasté 20 en taxi, cuánto llevo este mes', { ...NUEVO }, '51999');
    expect(r).toContain('✅');            // escribir sigue siendo gratis
    expect(filtro(r)).toBe(true);          // pero el desglose NO viajó
    expect(esMuro(r)).toBe(true);
    expect(eventosMuro()).toHaveLength(1);
  });
});
