import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// Quién escribe y a dónde se le contesta, cuando Meta no manda el número.
//
// Dos casos que hasta el 12-sep-2026 compartían bloque y hoy son opuestos:
//
//   · SIN número NI BSUID (los 4 mensajes del 01-ago-2026): no hay identidad. Se descarta y se
//     registra la FORMA del payload. Lo que protege es no llegar al alta, que con `whatsapp`
//     NULLABLE (migr 046) no falla: crearía un usuario fantasma que entra al embudo.
//
//   · SOLO BSUID (quien activó un username y oculta su número): hasta ese día se descartaba o se
//     le anotaban los gastos en silencio, porque se creía que Meta no dejaba escribirle por BSUID.
//     Se midió con un envío real que sí deja, y desde entonces recorre el camino normal: se
//     resuelve (o se da de alta) por BSUID y se le contesta a su BSUID.

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const enviarWhatsapp = vi.fn().mockResolvedValue({ ok: true });
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

// El espía clave: la única puerta de identidad del webhook.
const resolverUsuarioEntrante = vi.fn();
require('../../helpers/db-helpers').resolverUsuarioEntrante = resolverUsuarioEntrante;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

const registrarError = vi.fn();
require('../../lib/error-monitor').registrarError = registrarError;
const notificarErrorAdmin = vi.fn();
require('../../lib/admin-notify').notificarErrorAdmin = notificarErrorAdmin;
require('../../lib/atribucion').registrarOrigenDelAlta = vi.fn().mockResolvedValue(undefined);

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

let wamidSeq = 0;
function firmar(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return { req: { headers: { 'x-hub-signature-256': signature }, rawBody, body }, res: { sendStatus: vi.fn() } };
}
const buildReqRes = (message) => firmar({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
const sinFrom = (extra = {}) => ({ id: 'wamid-sf-' + (wamidSeq++), type: 'text', text: { body: 'hola' }, ...extra });

// Un usuario ya dado de alta: su texto va a la cascada y termina en `procesarMensajeLibre`.
const listo = (extra = {}) => ({ id: 'u1', nombre: 'Ana', onboarding_paso: 0, onboarding_completado: true, ...extra });

beforeEach(() => {
  resolverUsuarioEntrante.mockReset();
  registrarError.mockClear();
  notificarErrorAdmin.mockClear();
  enviarWhatsapp.mockClear();
  procesarMensajeLibre.mockReset().mockResolvedValue('ok');
});

describe('sin número NI BSUID (regresión 01-ago-2026)', () => {
  it('no llega al alta (que crearía un usuario fantasma)', async () => {
    const { req, res } = buildReqRes(sinFrom());
    await webhookHandler(req, res);
    expect(resolverUsuarioEntrante).not.toHaveBeenCalled();
  });

  it('responde 200 y no le contesta a nadie', async () => {
    const { req, res } = buildReqRes(sinFrom());
    await webhookHandler(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(enviarWhatsapp).not.toHaveBeenCalled();
    expect(procesarMensajeLibre).not.toHaveBeenCalled();
  });

  it('deja la FORMA del payload en `errores`, sin el nombre del perfil', async () => {
    const { req, res } = firmar({
      entry: [{ changes: [{ value: {
        messaging_product: 'whatsapp',
        contacts: [{ profile: { name: 'Ana Torres' } }],
        messages: [sinFrom({ type: 'system' })],
      } }] }],
    });
    await webhookHandler(req, res);

    expect(registrarError).toHaveBeenCalledTimes(1);
    const [tag, mensaje, opts] = registrarError.mock.calls[0];
    expect(tag).toBe('WEBHOOK');
    expect(mensaje).toMatch(/sin from/i);
    const detalle = JSON.parse(opts.detalle);
    expect(detalle.tipo).toBe('system');
    expect(detalle.clavesMensaje).toContain('id');
    expect(detalle.clavesPerfil).toEqual(['name']);   // la clave sí, el valor no
    expect(opts.detalle).not.toContain('Ana Torres');
  });

  it('no lo reporta como un crash del webhook (es un descarte, no una excepción)', async () => {
    const { req, res } = buildReqRes(sinFrom());
    await webhookHandler(req, res);
    expect(notificarErrorAdmin).not.toHaveBeenCalled();
  });
});

describe('SOLO BSUID: quien oculta su número recorre el camino normal (12-sep-2026)', () => {
  it('se resuelve por BSUID, sin número', async () => {
    resolverUsuarioEntrante.mockResolvedValue(listo({ id: 'u-conocido', bsuid: 'PE.999' }));
    const { req, res } = buildReqRes(sinFrom({ from_user_id: 'PE.999', text: { body: 'gasté 30 en almuerzo' } }));
    await webhookHandler(req, res);
    expect(resolverUsuarioEntrante).toHaveBeenCalledWith({ numero: null, bsuid: 'PE.999' });
  });

  it('SE LE CONTESTA, y la respuesta va dirigida a su BSUID', async () => {
    // Hasta el 12-sep-2026 este caso afirmaba lo contrario: "NO intenta responderle".
    resolverUsuarioEntrante.mockResolvedValue(listo({ id: 'u-conocido', bsuid: 'PE.999' }));
    const { req, res } = buildReqRes(sinFrom({ from_user_id: 'PE.999', text: { body: 'gasté 30 en almuerzo' } }));
    await webhookHandler(req, res);

    expect(procesarMensajeLibre).toHaveBeenCalledWith('gasté 30 en almuerzo', expect.objectContaining({ id: 'u-conocido' }), 'PE.999');
    expect(enviarWhatsapp).toHaveBeenCalledWith('PE.999', 'ok');
  });

  it('un BSUID desconocido ya no se descarta: se da de alta y se le contesta', async () => {
    resolverUsuarioEntrante.mockResolvedValue(listo({ id: 'u-nuevo', bsuid: 'PE.nuevo' }));
    const { req, res } = buildReqRes(sinFrom({ from_user_id: 'PE.nuevo' }));
    await webhookHandler(req, res);

    expect(resolverUsuarioEntrante).toHaveBeenCalledWith({ numero: null, bsuid: 'PE.nuevo' });
    expect(enviarWhatsapp).toHaveBeenCalled();
    expect(enviarWhatsapp.mock.calls.every(([dest]) => dest === 'PE.nuevo')).toBe(true);
    // No es un mensaje indiagnosticable: tiene dueño, así que no ensucia `errores`.
    expect(registrarError).not.toHaveBeenCalled();
  });

  it('un fallo deja en `errores` el BSUID y el usuario, no un `whatsapp` que el borrado no alcanza', async () => {
    // `borrar_cuenta_total` barre `errores` por `usuario_id` y por `whatsapp`. Con el BSUID
    // metido en `whatsapp` y sin `usuario_id`, la fila sobrevivía a un pedido de baja.
    resolverUsuarioEntrante.mockResolvedValue(listo({ id: 'u-conocido', bsuid: 'PE.999' }));
    procesarMensajeLibre.mockRejectedValue(new Error('boom'));
    const { req, res } = buildReqRes(sinFrom({ from_user_id: 'PE.999', text: { body: 'cuánto llevo' } }));
    await webhookHandler(req, res);

    const fila = registrarError.mock.calls.find(([tag]) => tag === 'WEBHOOK_CMD');
    expect(fila, 'el fallo del comando no se registró').toBeTruthy();
    expect(fila[2]).toEqual(expect.objectContaining({ bsuid: 'PE.999', usuarioId: 'u-conocido', whatsapp: null }));
  });
});

describe('CON número: el camino de siempre', () => {
  it('se resuelve por número', async () => {
    resolverUsuarioEntrante.mockResolvedValue(listo());
    const { req, res } = buildReqRes({ ...sinFrom(), from: '51999888777' });
    await webhookHandler(req, res);
    expect(resolverUsuarioEntrante).toHaveBeenCalledWith({ numero: '51999888777', bsuid: null });
  });

  // La ventana de la migración 065: mientras Meta mande las DOS identidades juntas, cada mensaje
  // con número enseña el BSUID. Si esto deja de pasar, el día que active un username su historial
  // queda huérfano.
  it('pasa el BSUID junto al número para aprenderlo', async () => {
    resolverUsuarioEntrante.mockResolvedValue(listo());
    const { req, res } = buildReqRes({ ...sinFrom(), from: '51999888777', from_user_id: 'PE.2052090595730104' });
    await webhookHandler(req, res);
    expect(resolverUsuarioEntrante).toHaveBeenCalledWith({ numero: '51999888777', bsuid: 'PE.2052090595730104' });
  });

  it('con número Y BSUID, la respuesta va al NÚMERO', async () => {
    resolverUsuarioEntrante.mockResolvedValue(listo());
    // Un texto que no sea comando: "hola" lo contesta la cascada, no el NLP.
    const { req, res } = buildReqRes({ ...sinFrom({ text: { body: 'gasté 30 en almuerzo' } }), from: '51999888777', from_user_id: 'PE.2052090595730104' });
    await webhookHandler(req, res);
    expect(enviarWhatsapp).toHaveBeenCalledWith('51999888777', 'ok');
  });
});
