import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// El HMAC se calculaba FUERA del try (`handlers/webhook.js`, el try abre después), sobre
// `req.rawBody`. Ese campo lo puebla el `verify` de `express.json()`, que NO corre si el
// Content-Type no es JSON — o sea que un POST con `Content-Type: text/plain` y CUALQUIER
// valor en el header de firma llegaba con `rawBody` undefined y hacía que
// `createHmac().update(undefined)` lanzara un TypeError.
//
// Por qué eso importaba más que un 500 feo: al estar fuera del try, el throw caía en el error
// handler de Express, que escribe una fila con stack en la tabla `errores`. Ese INSERT no
// tiene throttle — el cooldown de 5 min es de `notificarErrorAdmin`, otra función — así que
// era un camino SIN AUTENTICAR para llenar Supabase, que en Neto es capa única: tumbarla apaga
// WhatsApp, webapp y crons a la vez.
//
// Se asierta lo que de verdad protege: que el handler RESUELVA con 403 en vez de rechazar, y
// que no toque `errores`. Un test que solo mirara el status pasaría en verde con el bug si
// alguien envolviera la línea en un try/catch que igual registra el error.

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

const registrarError = vi.fn();
require('../../lib/error-monitor').registrarError = registrarError;

function makeChain(data = []) {
  const c = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'ilike', 'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit', 'single', 'maybeSingle']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (onF, onR) => Promise.resolve({ data, error: null }).then(onF, onR);
  return c;
}
require('../../lib/db').supabase.from = vi.fn(() => makeChain([]));

const createWebhookHandler = require('../../handlers/webhook');
const procesarMensajeLibre = vi.fn().mockResolvedValue('ok');
const webhookHandler = createWebhookHandler(procesarMensajeLibre);

/** Un POST cuyo Content-Type no era JSON: Express no pobló `rawBody`. */
function reqSinRawBody(signature = 'sha256=' + 'a'.repeat(64)) {
  return {
    req: { headers: { 'x-hub-signature-256': signature }, body: {} },
    res: { sendStatus: vi.fn() },
  };
}

describe('webhook con firma pero sin rawBody (Content-Type no JSON)', () => {
  beforeEach(() => {
    registrarError.mockClear();
    enviarWhatsapp.mockClear();
    procesarMensajeLibre.mockClear();
    obtenerOCrearUsuario.mockClear();
  });

  it('responde 403 en vez de reventar', async () => {
    const { req, res } = reqSinRawBody();
    await expect(webhookHandler(req, res)).resolves.not.toThrow();
    expect(res.sendStatus).toHaveBeenCalledWith(403);
  });

  // La parte que de verdad cierra el agujero: sin fila en `errores` no hay amplificación.
  it('no escribe en `errores` (era el vector, no el status)', async () => {
    const { req, res } = reqSinRawBody();
    await webhookHandler(req, res);
    expect(registrarError).not.toHaveBeenCalled();
  });

  it('no procesa nada del body', async () => {
    const { req, res } = reqSinRawBody();
    await webhookHandler(req, res);
    expect(procesarMensajeLibre).not.toHaveBeenCalled();
    expect(obtenerOCrearUsuario).not.toHaveBeenCalled();
    expect(enviarWhatsapp).not.toHaveBeenCalled();
  });

  // Un Buffer vacío es TRUTHY, así que la primera versión de este caso pasaba en verde por la
  // comparación de firma y no por la guarda — verde por el motivo equivocado. Ahora la guarda
  // lo cubre explícitamente. No era un agujero (nadie forja el HMAC del buffer vacío sin el
  // secreto), pero un caso que afirma una cosa y prueba otra es peor que no tenerlo.
  it('trata el rawBody vacío igual que el ausente', async () => {
    const req = { headers: { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) }, rawBody: Buffer.alloc(0), body: {} };
    const res = { sendStatus: vi.fn() };
    await webhookHandler(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(403);
    expect(registrarError).not.toHaveBeenCalled();
  });
});

// Control: sin este caso, un handler que respondiera 403 SIEMPRE se vería idéntico al bueno.
describe('control — el camino con rawBody y firma válida sigue entrando', () => {
  it('acepta el request bien firmado', async () => {
    const body = { entry: [{ changes: [{ value: { statuses: [] } }] }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
    const res = { sendStatus: vi.fn() };
    await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});
