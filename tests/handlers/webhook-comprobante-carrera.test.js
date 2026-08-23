import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

/**
 * Dos capturas del MISMO pago, en vuelo a la vez, abren UNA sola solicitud Pro.
 *
 * La guarda que había —`if (usuario.pago_pendiente)` en `handlers/webhook.js`— cubría el
 * REENVÍO y no la carrera: la fila se lee al entrar al handler, después vienen dos awaits
 * caros (bajar el media de Meta y llamar a Vision), y recién ahí se escribe `pago_pendiente`.
 * Dos fotos seguidas leen las dos `false` y las dos siguen de largo. El comentario del sitio
 * ya lo decía y lo mandaba a `docs/DEFECTOS.md`; esto lo cierra con el mismo patrón de claim
 * atómico que ya usaba `reclamarPagoPendiente` para la doble APROBACIÓN.
 *
 * **Por qué el mock de `usuarios` filtra de verdad.** Un mock que devolviera siempre la fila
 * daría verde con el claim escrito al revés (sin el `WHERE pago_pendiente = false`), que es
 * exactamente la mutación que hay que matar. Acá el `update` aplica sus filtros sobre el
 * almacén en memoria y devuelve `null` cuando no matchea, o sea que el CAS gana o pierde de
 * verdad. Las dos ejecuciones concurrentes se intercalan solas: JS resuelve un `await` por
 * vez, así que la segunda llega al claim con la fila ya en `true`.
 */

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

const guardarTransaccion = vi.fn().mockResolvedValue({ id: 'tx-1', categoria: 'Finanzas' });
require('../../services/transactions').guardarTransaccion = guardarTransaccion;

const notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;

const registrarError = vi.fn();
require('../../lib/error-monitor').registrarError = registrarError;

require('../../lib/trial').colaConfirmacionGasto = vi.fn().mockResolvedValue(null);

const visionCreate = globalThis.__mockOpenAICreate;

// ─── Almacén `usuarios` con UPDATE condicional de verdad ─────────────────────
//
// Sólo `usuarios` necesita comportarse; cualquier otra tabla devuelve vacío. `logMock` no se
// inyecta acá a propósito: lo que se afirma es el EFECTO (cuántas solicitudes se abren, si el
// gasto quedó anotado, qué se le contestó), no el texto de un log.
let filaUsuario = null;
/** Error a devolver en el UPDATE de `usuarios`, para el caso "el claim no se pudo hacer". */
let errorClaim = null;

function chainUsuarios(patch) {
  const filtros = [];
  const chain = {};
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.select = () => chain;
  chain.or = (expr) => {
    filtros.push((f) => String(expr).split(',').some((cond) => {
      const [col, op, val] = cond.split('.');
      if (op === 'is' && val === 'null') return f[col] === null || f[col] === undefined;
      if (op === 'is') return String(f[col]) === val;
      if (op === 'eq') return String(f[col]) === val;
      return false;
    }));
    return chain;
  };
  const resolver = () => {
    if (errorClaim) return { data: null, error: errorClaim };
    if (!filaUsuario || !filtros.every((p) => p(filaUsuario))) return { data: null, error: null };
    Object.assign(filaUsuario, patch);
    return { data: { id: filaUsuario.id }, error: null };
  };
  chain.maybeSingle = () => Promise.resolve(resolver());
  // `single` NO es un alias de `maybeSingle`, y la diferencia es justo la que sostiene este
  // arreglo: con cero filas PostgREST responde 406 y postgrest-js sólo lo rescata a
  // `{data:null, error:null}` cuando el llamador pidió `maybeSingle`. Con `.single()`, perder
  // la carrera llega como ERROR — o sea que un cambio de una palabra mandaría a todo el que
  // reenvía su captura por la rama de "no pude registrar tu comprobante". Aliasearlos es el
  // defecto de harness que ya apareció en el ítem 8 del backlog.
  chain.single = () => Promise.resolve((() => {
    const r = resolver();
    if (r.error || r.data) return r;
    return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
  })());
  chain.then = (resolve) => resolve(resolver());
  return chain;
}

function chainVacia() {
  const c = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'or', 'ilike',
    'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit']) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve({ data: null, error: null });
  c.single = () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
  c.then = (resolve) => resolve({ data: [], error: null });
  return c;
}

require('../../lib/db').supabase.from = vi.fn((tabla) => {
  if (tabla !== 'usuarios') return chainVacia();
  const c = chainVacia();
  c.update = (patch) => chainUsuarios(patch);
  return c;
});

// El comprobante en sí (subir a Storage, insertar en `pagos`, avisar al admin) NO es lo que
// se mide acá: lo que se cuenta es cuántas VECES se llega a abrir una solicitud.
const procesarComprobantePro = vi.fn().mockResolvedValue(undefined);
require('../../lib/pro-payment').procesarComprobantePro = procesarComprobantePro;

const createWebhookHandler = require('../../handlers/webhook');
const webhookHandler = createWebhookHandler(vi.fn().mockResolvedValue('ok'));

// ─── Helpers ─────────────────────────────────────────────────────────────────
let wamidSeq = 0;

function buildImagenReq(from) {
  const body = {
    entry: [{ changes: [{ value: { messages: [{
      from, id: 'wamid-carrera-' + (wamidSeq++), type: 'image',
      image: { id: 'media-img', mime_type: 'image/jpeg' },
    }] } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return { req: { headers: { 'x-hub-signature-256': signature }, rawBody, body }, res: { sendStatus: vi.fn() } };
}

/** Persistente (no `Once`): dos capturas concurrentes hacen cuatro fetch. */
function mockFetchOk() {
  global.fetch = vi.fn(async (url) => (String(url).includes('media.meta')
    ? { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
    : { ok: true, json: async () => ({ url: 'https://media.meta/img.jpg', mime_type: 'image/jpeg' }) }));
}

const YAPE_A_NETO = {
  tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza',
  categoria: 'Finanzas', fecha: '2026-08-23',
};

const USUARIO_BASE = {
  id: 'user-1', nombre: 'Juan', whatsapp: '51999000111',
  onboarding_paso: 0, onboarding_completado: true, plan: 'premium',
  esperando_comprobante: false, estado_pago: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  errorClaim = null;
  filaUsuario = { ...USUARIO_BASE, pago_pendiente: false };
  // Cada entrada al webhook lee la fila de nuevo, como en producción: una COPIA, para que la
  // decisión no pueda venir de una referencia que otra ejecución ya mutó.
  obtenerOCrearUsuario.mockImplementation(async () => ({ ...filaUsuario }));
  guardarTransaccion.mockResolvedValue({ id: 'tx-1', categoria: 'Finanzas' });
  procesarComprobantePro.mockResolvedValue(undefined);
  mockFetchOk();
  visionCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(YAPE_A_NETO) } }] });
});

describe('dos comprobantes en vuelo a la vez', () => {
  it('abren UNA sola solicitud Pro, y el gasto de las dos capturas queda anotado', async () => {
    const a = buildImagenReq('51999000111');
    const b = buildImagenReq('51999000111');
    await Promise.all([webhookHandler(a.req, a.res), webhookHandler(b.req, b.res)]);

    // Lo que estaba roto: acá salían DOS.
    expect(procesarComprobantePro).toHaveBeenCalledTimes(1);
    // Y lo que no puede romperse al arreglarlo: la que pierde la carrera NO se descarta.
    // Si la solicitud que ganó salió de un falso positivo de `esPagoNeto`, esta captura es el
    // pago real, y el gasto es lo único que queda de ella.
    expect(guardarTransaccion).toHaveBeenCalledTimes(2);
    // El aviso al admin sale de la rama del PERDEDOR, no del ganador: `procesarComprobantePro`
    // está mockeado, así que el que gana nunca llega a `notificarSolicitudAdminPro`. Lo que
    // esta línea afirma es que la captura descartada dejó rastro, no "una tarjeta por solicitud".
    expect(notificarAdmin).toHaveBeenCalledTimes(1);
    expect(filaUsuario.pago_pendiente).toBe(true);
  });

  it('el ganador le dice a `procesarComprobantePro` que el claim YA está tomado', async () => {
    // Sin `yaReclamado`, `registrarSolicitudPro` repite el UPDATE de las tres columnas. No es
    // sólo una consulta de más: su fallo devolvería `usuarioMarcado:false` sobre una solicitud
    // sana, que es lo que dispara la alarma de "solicitud incompleta" del canal silencioso.
    const { req, res } = buildImagenReq('51999000111');
    await webhookHandler(req, res);
    expect(procesarComprobantePro.mock.calls[0][0]).toMatchObject({ yaReclamado: true });
  });

  it('la que pierde recibe la respuesta de "en verificación", no un error', async () => {
    const a = buildImagenReq('51999000111');
    const b = buildImagenReq('51999000111');
    await Promise.all([webhookHandler(a.req, a.res), webhookHandler(b.req, b.res)]);

    const textos = enviarWhatsapp.mock.calls.map((c) => c[1]);
    expect(textos.some((t) => /verificaci[óo]n/i.test(t))).toBe(true);
    expect(textos.some((t) => /no pude procesar/i.test(t))).toBe(false);
  });
});

describe('el claim tiene que discriminar', () => {
  it('control: una sola captura sí abre la solicitud', async () => {
    // Sin este control, lo de arriba pasaría igual con un claim que NUNCA gana — que es la
    // mutación que deja a todo el mundo sin poder pagar.
    const { req, res } = buildImagenReq('51999000111');
    await webhookHandler(req, res);
    expect(procesarComprobantePro).toHaveBeenCalledTimes(1);
    expect(filaUsuario.pago_pendiente).toBe(true);
  });

  it('con una solicitud ya pendiente no abre otra', async () => {
    filaUsuario.pago_pendiente = true;
    const { req, res } = buildImagenReq('51999000111');
    await webhookHandler(req, res);
    expect(procesarComprobantePro).not.toHaveBeenCalled();
    expect(guardarTransaccion).toHaveBeenCalledTimes(1);
    expect(notificarAdmin).toHaveBeenCalledTimes(1);
  });

  /**
   * `usuarios.pago_pendiente` es NULLABLE (default `false`; 0 nulos al 2026-08-23, pero la
   * columna lo permite y nada impide que un INSERT lo omita explícitamente como null).
   * En PostgREST `pago_pendiente=eq.false` NO matchea NULL, igual que en SQL. Un claim escrito
   * con `.eq(col, false)` a secas dejaría a ese usuario sin poder pagar NUNCA, y encima
   * contestándole que su comprobante está en verificación. Este caso muere si se cae el
   * `or=(pago_pendiente.is.false,pago_pendiente.is.null)`.
   */
  it('un `pago_pendiente` en NULL cuenta como "no hay solicitud", no como "ya hay una"', async () => {
    filaUsuario.pago_pendiente = null;
    const { req, res } = buildImagenReq('51999000111');
    await webhookHandler(req, res);
    expect(procesarComprobantePro).toHaveBeenCalledTimes(1);
    expect(filaUsuario.pago_pendiente).toBe(true);
  });
});

/**
 * La lección literal de `reclamarPagoPendiente`: un claim que falla por error de red es
 * indistinguible de "otro ganó la fila" si sólo se mira `data`. Tratarlo como "otro ganó" le
 * contesta "ya tenemos tu comprobante en verificación" a alguien cuya solicitud NO existe —
 * la peor de las respuestas posibles, porque lo deja tranquilo mientras su plata no figura.
 */
describe('un claim que no se pudo hacer no es "otro ganó"', () => {
  it('no le dice al usuario que su comprobante está en verificación', async () => {
    errorClaim = { message: 'timeout' };
    const { req, res } = buildImagenReq('51999000111');
    await webhookHandler(req, res);

    expect(procesarComprobantePro).not.toHaveBeenCalled();
    const textos = enviarWhatsapp.mock.calls.map((c) => c[1]);
    expect(textos.some((t) => /verificaci[óo]n/i.test(t))).toBe(false);
    // Se le pide reenviarla: es lo único que puede recuperar el pago.
    expect(textos.some((t) => /reenv[íi]a/i.test(t))).toBe(true);
  });

  it('anota el gasto igual y deja rastro para el admin', async () => {
    errorClaim = { message: 'timeout' };
    const { req, res } = buildImagenReq('51999000111');
    await webhookHandler(req, res);

    expect(guardarTransaccion).toHaveBeenCalledTimes(1);
    expect(notificarAdmin).toHaveBeenCalledTimes(1);
    expect(registrarError).toHaveBeenCalled();
  });
});
