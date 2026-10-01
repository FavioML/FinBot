import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Clases 2, 3 y 6 de la tanda "respuestas malas del día 0" (30-sep-2026). Medido en 60 días:
 * 25 preguntas reales sobre Neto ("¿tienes app?", "¿después cuánto pago?", "¿vas a perder el
 * registro?") recibieron el mismo texto genérico, y otras salieron INVENTADAS por el camino de
 * texto crudo (una app "Neto Finanzas" en Play Store que no existe).
 *
 * Qué fija este archivo:
 *   · cada tema de `social_response` action=help tiene su texto, y ese texto dice lo que el
 *     código hace (cada afirmación está verificada al lado del texto, en social.js);
 *   · el tema que el modelo pone en `action` en vez de `tema` (medido 2 de 2) también llega;
 *   · `no_quiero_pro` no abre la espera del comprobante, y cierra la que estaba abierta;
 *   · sin tool call, el texto del modelo no se envía y no termina en un gasto;
 *   · el menú de borrado sin Gmail se titula como lo que es.
 *
 * Lo que NO puede fijar: que el modelo REAL elija el tema correcto. Eso lo mide la sonda en
 * vivo `qa-e2e/probe-ayuda-temas.mjs`, y contra producción `qa-e2e/qa-respuestas-malas-preguntas.mjs`.
 */

// ─── Parchar singletons ANTES de requerir el SUT (mismo patrón que muro-dispatch) ───
require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn().mockResolvedValue(null);
require('../../gmail').obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
// `tieneGmailConectado` llama a la función interna, no al export: sin este mock caía al bloqueo
// de red de tests/setup.js y devolvía false por accidente (revisión adversarial).
require('../../gmail').tieneGmailConectado = vi.fn().mockResolvedValue(false);
require('../../helpers/db-helpers').obtenerHistorial = vi.fn().mockResolvedValue([]);
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/analytics').capture = vi.fn();

// Ningún camino de este archivo puede guardar plata: si se llama, el test lo ve.
const guardarTransaccion = vi.fn().mockResolvedValue({ id: 'tx', conteoTx: 1 });
require('../../services/transactions').guardarTransaccion = guardarTransaccion;
require('../../services/transactions').obtenerGastosMes = vi.fn().mockResolvedValue([]);
const parsearCorreoBancario = vi.fn().mockResolvedValue({ monto: 15800, tipo: 'gasto', comercio: 'x', categoria: 'Otros' });
require('../../services/parsers').parsearCorreoBancario = parsearCorreoBancario;
require('../../services/transactions').obtenerUltimaTransaccion = vi.fn().mockResolvedValue({
  id: 'tx-ult', tipo: 'gasto', monto: 12, moneda: 'PEN', comercio: 'taxi', categoria: 'Transporte', subcategoria: 'taxi', fecha: '2026-09-30',
});

// La espera del comprobante: `premium.js` la destructura al cargar, así que el espía va antes.
const solicitarComprobante = vi.fn().mockResolvedValue(undefined);
require('../../lib/pro-payment').solicitarComprobante = solicitarComprobante;

// Supabase que registra cada escritura y contesta la fila tocada (`.select('id')`).
let escrituras = [];
function chain(tabla) {
  const q = { tabla, op: null, patch: null, filtros: [] };
  const c = {};
  for (const m of ['select', 'order', 'limit', 'gte', 'lte', 'in', 'is', 'not', 'neq', 'ilike', 'single', 'maybeSingle']) c[m] = vi.fn(() => c);
  c.update = vi.fn((p) => { q.op = 'update'; q.patch = p; return c; });
  c.insert = vi.fn((p) => { q.op = 'insert'; q.patch = p; return c; });
  c.delete = vi.fn(() => { q.op = 'delete'; return c; });
  c.eq = vi.fn((col, val) => { q.filtros.push([col, val]); return c; });
  c.then = (onF, onR) => Promise.resolve().then(() => {
    if (q.op) escrituras.push(q);
    return { data: q.op ? [{ id: 'fila' }] : [], error: null, count: 0 };
  }).then(onF, onR);
  return c;
}
require('../../lib/db').supabase = { from: vi.fn((t) => chain(t)) };

let respuestaModelo = null;
const crearCompletion = vi.fn(async () => respuestaModelo);
require('../../lib/ai').openai = { chat: { completions: { create: crearCompletion } } };
const tool = (name, args) => ({ choices: [{ message: { tool_calls: [{ id: 'c1', function: { name, arguments: JSON.stringify(args) } }] } }] });

const { procesarMensajeLibre } = require('../../handlers/message-processor');
const { NETO_TOOLS, mapToolToIntent, TEMAS_AYUDA } = require('../../handlers/neto-tools');
const { textoAyuda, AYUDA_GENERICA } = require('../../handlers/intents/social');
const { PRO_PRECIOS } = require('../../lib/config');

// Los estados que cambian el texto. `supabase_auth_id` va SIEMPRE explícito: `enlaceApp` lee
// `undefined` como fila parcial.
const EN_TRIAL = { id: 'u-t', nombre: 'Ana', plan: 'premium', trial_estado: 'activo', trial_vence: '2026-10-10', supabase_auth_id: 'auth-t' };
const SIN_PRUEBA = { id: 'u-n', nombre: 'Ana', plan: 'free', trial_estado: null, supabase_auth_id: null };
const EN_MURO = { id: 'u-m', nombre: 'Ana', plan: 'free', trial_estado: 'vencido', trial_vence: '2026-09-01', supabase_auth_id: 'auth-m' };
const PAGADO = { id: 'u-p', nombre: 'Ana', plan: 'premium', trial_estado: 'convertido', premium_desde: '2026-09-01', premium_vence: '2026-10-31', tipo_plan: 'mensual', supabase_auth_id: 'auth-p' };
const ESTADOS = { EN_TRIAL, SIN_PRUEBA, EN_MURO, PAGADO };

beforeEach(() => {
  escrituras = [];
  solicitarComprobante.mockClear();
  guardarTransaccion.mockClear();
  parsearCorreoBancario.mockClear();
  crearCompletion.mockClear();
});

describe('el enum de temas es UNA lista: tool, mapper y textos', () => {
  // La lista va escrita A MANO: compararla contra la misma constante de la que sale el enum era
  // circular, y sacar `app_movil` de TEMAS_AYUDA dejaba la suite verde con el tema muerto en
  // producción (revisión adversarial, 30-sep). Agregar o quitar un tema es una decisión: se
  // cambia acá también.
  const TEMAS_ESPERADOS = ['precio_despues_prueba', 'que_pasa_si_no_pago', 'app_movil', 'conexiones', 'gmail',
    'periodo_del_mes', 'se_registro', 'uso_negocio', 'reiniciar_o_borrar', 'no_quiero_pro', 'otro'];
  it('TEMAS_AYUDA es la lista decidida, y el parámetro `tema` la ofrece entera', () => {
    expect([...TEMAS_AYUDA]).toEqual(TEMAS_ESPERADOS);
    const social = NETO_TOOLS.find((t) => t.function.name === 'social_response');
    expect(social.function.parameters.properties.tema.enum).toEqual(TEMAS_ESPERADOS);
  });

  // Antivacuidad del texto: un tema sin `case` caería al default y contestaría lo genérico.
  // Solo `otro` puede contestar eso, y `se_registro` no llega al handler (lo desvía el mapper).
  it('cada tema que llega a `ayuda` tiene su propio texto', () => {
    const textos = new Map();
    for (const tema of TEMAS_AYUDA.filter((t) => t !== 'se_registro')) {
      const t = textoAyuda(tema, EN_TRIAL);
      if (tema !== 'otro') expect(t, tema).not.toContain(AYUDA_GENERICA);
      expect(textos.has(t), tema + ' repite el texto de ' + textos.get(t)).toBe(false);
      textos.set(t, tema);
    }
  });
});

describe('mapToolToIntent: el tema llega venga por donde venga', () => {
  it('help + tema viaja a `ayuda` con su tema', () => {
    expect(mapToolToIntent('social_response', { action: 'help', tema: 'app_movil' }))
      .toEqual({ intencion: 'ayuda', datos: { tema: 'app_movil' } });
  });

  it('"¿se registró?" es el eco del último movimiento, sin argumentos', () => {
    expect(mapToolToIntent('social_response', { action: 'help', tema: 'se_registro' }))
      .toEqual({ intencion: 'ver_ultima_transaccion', datos: {} });
  });

  // Medido 2 de 2 con el modelo real: "No deseo el pro" → manage_account action=no_quiero_pro,
  // "Quiero reiniciar" → social_response action=reiniciar_o_borrar. Sin esto, un intent sin
  // handler y el fallback que registra plata con cualquier número.
  it.each([
    ['manage_account', 'no_quiero_pro'],
    ['social_response', 'reiniciar_o_borrar'],
    ['query_expenses', 'precio_despues_prueba'],
  ])('%s action=%s (el tema en action) va a la ayuda', (toolName, action) => {
    expect(mapToolToIntent(toolName, { action })).toEqual({ intencion: 'ayuda', datos: { tema: action } });
  });

  it('una action inventada en social_response va a la ayuda genérica, no al fallback', () => {
    expect(mapToolToIntent('social_response', { action: 'financial_query' }))
      .toEqual({ intencion: 'ayuda', datos: { tema: 'otro' } });
  });

  // `tema` en una tool que no lo tiene: el modelo quiso contestar una pregunta sobre Neto. Con
  // view_premium + no_quiero_pro, ganar la action abría la espera del comprobante.
  it.each([
    ['manage_account', { action: 'help', tema: 'no_quiero_pro' }],
    ['manage_account', { action: 'view_premium', tema: 'no_quiero_pro' }],
    ['financial_query', { pregunta: 'cuanto cuesta', tema: 'precio_despues_prueba' }],
  ])('%s con tema %j va a la ayuda', (toolName, args) => {
    expect(mapToolToIntent(toolName, args)).toEqual({ intencion: 'ayuda', datos: { tema: args.tema } });
  });

  // Segunda revisión adversarial: la primera versión desviaba el `tema` en CUALQUIER tool, y un
  // registro con `tema` contestaba el último movimiento sin guardar la plata.
  it.each([
    ['register_transaction', { monto: 40, comercio: 'mercado', tema: 'se_registro' }, 'registrar_manual'],
    ['register_transaction', { monto: 40, tema: 'otro' }, 'registrar_manual'],
    ['manage_debts', { action: 'register', monto: 100, tema: 'otro' }, 'registrar_deuda'],
    ['manage_goals', { action: 'deposit', monto_abono: 50, tema: 'otro' }, 'abonar_meta'],
    ['manage_transaction', { action: 'edit_amount', nuevo_monto: 50, tema: 'se_registro' }, 'editar_monto'],
    ['manage_account', { action: 'change_name', new_name: 'Ana', tema: 'otro' }, 'cambiar_nombre'],
  ])('%s %j: una tool que escribe hace lo que dice su action', (toolName, args, esperado) => {
    expect(mapToolToIntent(toolName, args).intencion).toBe(esperado);
  });

  it('control: una action inventada en otra tool sigue sin mapearse', () => {
    expect(mapToolToIntent('manage_account', { action: 'cosa_rara' }).intencion).toBe('manage_account_cosa_rara');
  });
});

describe('textoAyuda: cada tema dice lo que el código hace', () => {
  it('precio: con descuento de referido vigente dice el precio del primer mes', () => {
    const conRef = { ...SIN_PRUEBA, referido_dscto_pct: 50, referido_dscto_vence: '2099-01-01' };
    expect(textoAyuda('precio_despues_prueba', conRef)).toContain('tu primer mes sale a *S/' + PRO_PRECIOS.mensual / 2 + '*');
    expect(textoAyuda('precio_despues_prueba', SIN_PRUEBA)).not.toMatch(/referido/);
  });

  // El mes de referido y la cortesía son `esProPagado` sin haber pagado.
  it('precio: a quien tiene Pro no le dice "pagado"', () => {
    const cortesia = { ...PAGADO, trial_estado: 'vencido' };
    for (const u of [PAGADO, cortesia]) expect(textoAyuda('precio_despues_prueba', u)).not.toMatch(/pagado/i);
  });

  it('precio: sale de PRO_PRECIOS y dice que no hay cobro automático', () => {
    for (const u of [EN_TRIAL, SIN_PRUEBA, EN_MURO]) {
      const t = textoAyuda('precio_despues_prueba', u);
      expect(t).toContain('S/' + PRO_PRECIOS.mensual + '/mes');
      expect(t).toContain('S/' + PRO_PRECIOS.anual + '/año');
      expect(t).toMatch(/no te cobro nada automático/i);
      expect(t).toMatch(/sigo anotando tus gastos gratis/i);
    }
    expect(textoAyuda('precio_despues_prueba', EN_TRIAL)).toContain('Tu prueba termina el');
    expect(textoAyuda('precio_despues_prueba', SIN_PRUEBA)).toMatch(/empieza con tu primer gasto/);
    expect(textoAyuda('precio_despues_prueba', EN_MURO)).not.toMatch(/primer gasto|termina el/);
    expect(textoAyuda('precio_despues_prueba', PAGADO)).toMatch(/Ya tienes \*Neto Pro\* hasta el/);
  });

  it('qué pasa si no pago: no se pierde nada y anotar sigue gratis', () => {
    const t = textoAyuda('que_pasa_si_no_pago', EN_TRIAL);
    expect(t).toMatch(/No pierdes nada/);
    expect(t).toMatch(/no se borra nada/);
    expect(t).toMatch(/gratis y para siempre/);
    expect(t).toContain('S/' + PRO_PRECIOS.mensual);
  });

  it('app: no hay app en tiendas, y el link respeta la identidad', () => {
    const conWeb = textoAyuda('app_movil', EN_TRIAL);
    expect(conWeb).toMatch(/No tengo app en Play Store ni en App Store/);
    expect(conWeb).toContain('app.neto.pe/dashboard');
    expect(conWeb).not.toMatch(/Neto Pro/);
    // En el muro se dice que ver es de Pro: si no, la pantalla siguiente desmiente el mensaje.
    expect(textoAyuda('app_movil', EN_MURO)).toMatch(/son de \*Neto Pro\*/);
  });

  it('conexiones: no hay integración con bancos, tarjetas, Yape ni Uber', () => {
    const t = textoAyuda('conexiones', EN_TRIAL);
    expect(t).toMatch(/No me conecto con bancos, tarjetas, Yape ni Uber/);
    expect(t).toMatch(/captura/);
    expect(t).not.toMatch(/correos/);
    // Al que paga, "me los cuentas tú" es falso si tiene el Gmail conectado: se nombra.
    expect(textoAyuda('conexiones', PAGADO)).toMatch(/leo los correos de consumo/);
  });

  it('qué pasa si no pago (el que paga): el Gmail se vuelve a conectar, no "recuperas todo"', () => {
    const t = textoAyuda('que_pasa_si_no_pago', PAGADO);
    expect(t).toMatch(/Gmail lo vuelves a conectar/);
    expect(t).not.toMatch(/recuperas todo/);
  });

  it('negocio: no promete que se separe del total', () => {
    expect(textoAyuda('uso_negocio', EN_TRIAL)).not.toMatch(/no se mezcla/);
    expect(textoAyuda('uso_negocio', EN_TRIAL)).toMatch(/el total del mes los suma/);
  });

  it('gmail: Pro PAGADO, opcional, solo desde la web; en la prueba se dice que es la excepción', () => {
    for (const u of [EN_TRIAL, SIN_PRUEBA, EN_MURO]) {
      const t = textoAyuda('gmail', u);
      expect(t).toMatch(/Neto Pro pagado/);
      expect(t).toMatch(/opcional/);
      expect(t).toMatch(/solo desde la web/);
      // El dominio pelado deja al WhatsApp-only en /login: cuenta huérfana (lib/trial.js).
      expect(t).not.toMatch(/app\.neto\.pe/);
    }
    expect(textoAyuda('gmail', EN_TRIAL)).toMatch(/tu prueba no incluye/);
    expect(textoAyuda('gmail', EN_MURO)).not.toMatch(/tu prueba no incluye/);
    // Al que paga no se le vende: se le da el atajo a la app.
    const pagado = textoAyuda('gmail', PAGADO);
    expect(pagado).not.toMatch(/S\/\d+\/mes/);
    expect(pagado).toContain('app.neto.pe/dashboard/pro');
  });

  it('periodo, negocio, reiniciar, no quiero pro y otro', () => {
    expect(textoAyuda('periodo_del_mes', EN_TRIAL)).toMatch(/no cierra nada/);
    expect(textoAyuda('uso_negocio', EN_TRIAL)).toContain('Trabajo_Negocio');
    const reiniciar = textoAyuda('reiniciar_o_borrar', EN_TRIAL);
    expect(reiniciar).toContain('*borrar mi cuenta*');
    expect(reiniciar).toContain('Transacciones');
    // El borrado de varios vive en la webapp, que el muro cierra: no se ofrece a quien no la ve.
    expect(textoAyuda('reiniciar_o_borrar', EN_MURO)).not.toContain('Transacciones');
    expect(textoAyuda('reiniciar_o_borrar', SIN_PRUEBA)).not.toContain('Transacciones');
    expect(textoAyuda('no_quiero_pro', EN_TRIAL)).toMatch(/no tienes que pagar nada/);
    expect(textoAyuda('no_quiero_pro', EN_TRIAL)).toContain('Tu prueba termina el');
    const otro = textoAyuda('otro', EN_TRIAL);
    expect(otro).toContain(AYUDA_GENERICA);
    expect(otro).toContain('/soporte');
    expect(textoAyuda(undefined, EN_TRIAL)).toBe(otro);
  });

  // Las reglas de `content/scripts/verify-claims.mjs` (y su hermano de la webapp) que aplican
  // a este copy, copiadas a propósito: ese guard vive en otra carpeta y no alcanza al backend.
  // Si cambian allá, se actualizan acá.
  const PROHIBIDAS = {
    'integracion-bancaria': /(conect|vincul|sincroniz|enlaz)\w*\s+(tu|su)\s+(banco|cuenta\s+bancaria)/i,
    // Más ancha que la original a propósito: la revisión evadió la de allá con "sin tener que
    // anotar nada" y "se anotan solos".
    'registro-sin-esfuerzo': /(sin\s+(tener\s+que\s+)?(anotar|ingresar|escribir|hacer)\s+nada|sin\s+que\s+(tengas\s+que\s+)?(hagas|escribas|anotes|hacer|escribir|anotar)\s+nada|se\s+(registran|anotan|guardan)\s+sol[oa]s|sin\s+mover\s+un\s+dedo)/i,
    // Prominencia de Gmail (products/neto/CLAUDE.md): "automáticamente" junto a los correos.
    'gmail-automatico': /correos?[^.\n]{0,40}autom[aá]tic|autom[aá]tic[^.\n]{0,40}correos?/i,
    'registro-por-notificacion-bancaria': /notificaci\S*\s+(de\s+)?(tu|su|del)\s+banco|notificaciones\s+bancarias|SMS\s+bancarios?/i,
    'bancos-conectados': /\bbancos?\s+(conectad|integrad|vinculad|sincronizad|compatibl|soportad)\w*/i,
    'bancos-con-capacidad': /\b(BCP|BBVA|Interbank|Scotiabank|BanBif|Mibanco)\b/,
  };
  // El barrido alcanza también el `como_empezar` y el fuera-de-alcance, que la primera versión no
  // miraba: devolverle a `como_empezar` "Neto lee tus correos bancarios automáticamente" pasaba.
  it('el texto de cómo empezar y el de fuera de alcance tampoco', async () => {
    respuestaModelo = tool('social_response', { action: 'onboarding' });
    const empezar = await procesarMensajeLibre('como empiezo', { ...EN_TRIAL }, '51999');
    respuestaModelo = { choices: [{ message: { content: 'x' } }] };
    const fuera = await procesarMensajeLibre('???', { ...EN_TRIAL }, '51999');
    expect(empezar).toContain('3 pasos');
    expect(empezar, 'Gmail en una superficie de conversión').not.toMatch(/correo/i);
    for (const t of [empezar, fuera]) {
      for (const [regla, re] of Object.entries(PROHIBIDAS)) expect(t, regla).not.toMatch(re);
    }
  });

  it('ningún texto, en ningún estado, hace una afirmación que los guards de copy prohíben', () => {
    for (const tema of TEMAS_AYUDA) {
      for (const [nombre, u] of Object.entries(ESTADOS)) {
        const t = textoAyuda(tema, u);
        for (const [regla, re] of Object.entries(PROHIBIDAS)) expect(t, `${tema}/${nombre}: ${regla}`).not.toMatch(re);
        expect(t, `${tema}/${nombre}: em dash`).not.toContain('—');
      }
    }
  });
});

describe('el pipeline: del tool call a la respuesta', () => {
  it.each(Object.entries(ESTADOS))('no_quiero_pro (%s) NO abre la espera del comprobante', async (_n, u) => {
    respuestaModelo = tool('social_response', { action: 'help', tema: 'no_quiero_pro' });
    const r = await procesarMensajeLibre('No deseo el pro', { ...u }, '51999');
    await new Promise((res) => setTimeout(res, 20));
    expect(r).toMatch(/no tienes que pagar nada/);
    expect(solicitarComprobante).not.toHaveBeenCalled();
  });

  // La forma que el modelo produjo de verdad: el tema en `action` de manage_account.
  it('no_quiero_pro con el tema en action llega igual, sin abrir la espera', async () => {
    respuestaModelo = tool('manage_account', { action: 'no_quiero_pro' });
    const r = await procesarMensajeLibre('No deseo el pro', { ...EN_MURO }, '51999');
    await new Promise((res) => setTimeout(res, 20));
    expect(r).toMatch(/no tienes que pagar nada/);
    expect(solicitarComprobante).not.toHaveBeenCalled();
  });

  it('no_quiero_pro CIERRA una espera que ya estaba abierta (y solo esa)', async () => {
    respuestaModelo = tool('social_response', { action: 'help', tema: 'no_quiero_pro' });
    await procesarMensajeLibre('No deseo el pro', { ...EN_MURO, esperando_comprobante: true }, '51999');
    const cierre = escrituras.find((e) => e.tabla === 'usuarios' && e.op === 'update');
    expect(cierre && cierre.patch).toEqual({ esperando_comprobante: false });
    expect(cierre.filtros).toEqual([['id', 'u-m'], ['esperando_comprobante', true]]);
  });

  it('control: sin espera abierta no escribe nada', async () => {
    respuestaModelo = tool('social_response', { action: 'help', tema: 'no_quiero_pro' });
    await procesarMensajeLibre('No deseo el pro', { ...EN_MURO, esperando_comprobante: false }, '51999');
    expect(escrituras.filter((e) => e.tabla === 'usuarios')).toEqual([]);
  });

  // Control del efecto: "quiero pro" del muro SÍ la abre, o el espía de arriba no prueba nada.
  it('control: ver_premium en el muro sí abre la espera', async () => {
    respuestaModelo = tool('manage_account', { action: 'view_premium' });
    await procesarMensajeLibre('quiero pro', { ...EN_MURO }, '51999');
    expect(solicitarComprobante).toHaveBeenCalledTimes(1);
  });

  it('cada tema que llega por el pipeline contesta su texto (no el genérico), en todo estado', async () => {
    // El link de activación firma `Date.now()`, y la respuesta y el texto esperado se arman en
    // dos momentos: con la suite cargada caían en milisegundos distintos y el test fallaba
    // (01-oct-2026, 2 de 3 corridas completas). Se congela el reloj, no se afloja la igualdad.
    const reloj = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 1, 12));
    try {
      const SIN_WEB_EN_PRUEBA = { ...EN_TRIAL, id: 'u-sw', supabase_auth_id: null };
      for (const [nombre, u] of Object.entries({ ...ESTADOS, SIN_WEB_EN_PRUEBA })) {
        for (const tema of TEMAS_AYUDA.filter((t) => t !== 'se_registro' && t !== 'otro')) {
          respuestaModelo = tool('social_response', { action: 'help', tema });
          const r = await procesarMensajeLibre('pregunta', { ...u }, '51999');
          expect(r, tema + '/' + nombre).toBe(textoAyuda(tema, u));
          expect(r, tema + '/' + nombre).not.toContain(AYUDA_GENERICA);
        }
      }
    } finally {
      reloj.mockRestore();
    }
  });

  // `social_response` tiene un parámetro `message` (el texto del usuario para quejas): nunca
  // puede volver a la persona como respuesta, ni con `otro` ni sin tema.
  it.each([[{ action: 'help', tema: 'otro' }], [{ action: 'help' }]])('help %j no devuelve el `message` del modelo', async (args) => {
    respuestaModelo = tool('social_response', { ...args, message: 'Busca Neto Finanzas en Play Store y descárgala gratis.' });
    const r = await procesarMensajeLibre('ayuda', { ...EN_TRIAL }, '51999');
    expect(r).not.toMatch(/Neto Finanzas/);
    expect(r).toContain('/soporte');
  });

  it('"¿se registró?" contesta el último movimiento', async () => {
    respuestaModelo = tool('social_response', { action: 'help', tema: 'se_registro' });
    const r = await procesarMensajeLibre('Se registro si o no.?', { ...EN_MURO }, '51999');
    expect(r).toContain('Tu último movimiento');
    expect(r).toContain('taxi');
  });

  it('pide la herramienta obligatoria: tool_choice required', async () => {
    respuestaModelo = tool('social_response', { action: 'greeting' });
    await procesarMensajeLibre('hola', { ...EN_TRIAL }, '51999').catch(() => {});
    expect(crearCompletion.mock.calls[0][0].tool_choice).toBe('required');
  });
});

describe('un mensaje que el clasificador no ubica no registra plata', () => {
  // Hasta el 30-sep el fallback leía el mensaje como correo bancario y registraba cualquier
  // número. 0 veces en toda la historia de `conversaciones`, así que se sacó entero.
  it.each([
    ['un borrado en forma de pregunta (bloqueado)', 'me borras el gasto de 15 soles?', tool('manage_transaction', { action: 'delete', monto: 15 })],
    ['una action inventada en otra tool', 'no quiero pagar los 10 soles del pro', tool('manage_account', { action: 'cosa_rara' })],
    ['una action inventada en una tool que escribe', 'gasté 40 en el mercado', tool('manage_transaction', { action: 'add', monto: 40 })],
    ['una action inventada en deudas', 'Juan me pagó 100', tool('manage_debts', { action: 'cobrar', monto: 100 })],
    ['un refusal: sin tool call y sin texto', 'Neto es 15800 y donde bajo la app?', { choices: [{ message: { content: null, refusal: 'no' } }] }],
  ])('%s', async (_n, msg, resp) => {
    respuestaModelo = resp;
    const r = await procesarMensajeLibre(msg, { ...EN_TRIAL }, '51999');
    expect(r).toContain('Eso se me escapa');
    expect(guardarTransaccion).not.toHaveBeenCalled();
    expect(parsearCorreoBancario).not.toHaveBeenCalled();
    // Ninguna escritura en ninguna tabla de plata, venga por la puerta que venga.
    expect(escrituras.filter((e) => e.tabla !== 'nlp_errors')).toEqual([]);
  });
});

describe('sin tool call, el texto del modelo no llega a la persona', () => {
  it('no se envía crudo ni termina en un gasto, aunque el mensaje traiga un número', async () => {
    respuestaModelo = { choices: [{ message: { content: 'Busca Neto Finanzas en Play Store y descárgala.' } }] };
    const r = await procesarMensajeLibre('Neto es 15800 y donde bajo la app?', { ...EN_TRIAL }, '51999');
    expect(r).not.toMatch(/Play Store/);
    expect(r).toContain('Eso se me escapa');
    expect(guardarTransaccion).not.toHaveBeenCalled();
    expect(parsearCorreoBancario).not.toHaveBeenCalled();
    const nlp = escrituras.find((e) => e.tabla === 'nlp_errors');
    expect(nlp && nlp.patch.error_tipo).toBe('sin_tool_call');
  });
});

describe('el menú de borrado sin Gmail se titula como lo que es', () => {
  it('sin cuentas: "Eliminar tu cuenta", sin hablar de Gmail', async () => {
    respuestaModelo = tool('manage_account', { action: 'disconnect' });
    const r = await procesarMensajeLibre('Quiero eliminar mi cuenta', { ...EN_TRIAL }, '51999');
    expect(r).toMatch(/^⚠️ \*Eliminar tu cuenta\*/);
    expect(r).not.toMatch(/Gmail|Desconectar cuenta/);
    expect(r).toContain('confirmo borrar mi cuenta');
  });

  it('control: con una cuenta Gmail sigue siendo "Desconectar cuenta"', async () => {
    require('../../gmail').obtenerCuentasGmail.mockResolvedValueOnce([{ id: 'g1', email: 'a@x.com' }]);
    respuestaModelo = tool('manage_account', { action: 'disconnect' });
    const r = await procesarMensajeLibre('desconectar cuenta', { ...EN_TRIAL }, '51999');
    expect(r).toMatch(/^⚠️ \*Desconectar cuenta\*/);
  });
});
