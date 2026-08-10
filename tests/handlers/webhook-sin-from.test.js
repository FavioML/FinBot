import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// Regresión del crash del 01-ago-2026: Meta mandó 4 mensajes SIN `from` (05:32 UTC) y el
// webhook los pasaba igual a obtenerOCrearUsuario, que reventaba con
// "Cannot read properties of undefined (reading 'replace')".
//
// Por qué importa más de lo que parece: el `.replace` era lo ÚNICO que frenaba el valor
// vacío. Sin él, el flujo seguía hasta el INSERT final de obtenerOCrearUsuario y, como
// `whatsapp` es NULLABLE (identidad dual web-first, migr 046), el insert NO falla: crea un
// usuario fantasma sin número, imposible de vincular, que además entra al embudo como un
// alta real. O sea que el TypeError estaba haciendo de guarda por accidente.
//
// Se asierta lo que de verdad protege: que el webhook NI SIQUIERA llame a
// obtenerOCrearUsuario cuando no hay remitente, y que deje registrada la FORMA del payload
// (el campo `detalle` de `errores` salía vacío, por eso los 4 casos fueron indiagnosticables).

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

// El espía clave: si el fix falla, ESTE se llama con undefined.
const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

const registrarError = vi.fn();
require('../../lib/error-monitor').registrarError = registrarError;
const buscarUsuarioPorBsuid = vi.fn().mockResolvedValue(null);
require('../../helpers/db-helpers').buscarUsuarioPorBsuid = buscarUsuarioPorBsuid;
const registrarGastoSilencioso = vi.fn().mockResolvedValue({ registrado: true, motivo: 'ok' });
require('../../services/registro-silencioso').registrarGastoSilencioso = registrarGastoSilencioso;
// Hay que mockearlo aunque este archivo no lo verifique. Sin esto corre el real, que llama a
// `notificarAdmin` → Telegram sin token → **fallback a `enviarWhatsapp(ADMIN_NUMBER)`**, que es
// justo el mock que vigilan los tests de "NO intenta responderle". Quedaban en verde solo
// porque el test anterior ya había quemado la clave del throttle para ese mismo usuario: un
// reordenamiento, un `.only` o un `-t` los ponía rojos por un aviso al admin, no por una
// respuesta al usuario.
const avisarPrimeraVezSilencioso = vi.fn().mockResolvedValue(undefined);
require('../../services/registro-silencioso').avisarPrimeraVezSilencioso = avisarPrimeraVezSilencioso;
const notificarErrorAdmin = vi.fn();
require('../../lib/admin-notify').notificarErrorAdmin = notificarErrorAdmin;

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
function buildReqRes(message) {
  const body = { entry: [{ changes: [{ value: { messages: [message] } }] }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return { req: { headers: { 'x-hub-signature-256': signature }, rawBody, body }, res: { sendStatus: vi.fn() } };
}
const sinFrom = (extra = {}) => ({ id: 'wamid-sf-' + (wamidSeq++), type: 'text', text: { body: 'hola' }, ...extra });

describe('mensaje entrante sin `from` (regresión 01-ago-2026)', () => {
  beforeEach(() => {
    obtenerOCrearUsuario.mockReset();
    registrarError.mockClear();
    notificarErrorAdmin.mockClear();
    enviarWhatsapp.mockClear();
    procesarMensajeLibre.mockClear();
    buscarUsuarioPorBsuid.mockReset().mockResolvedValue(null);
    registrarGastoSilencioso.mockReset().mockResolvedValue({ registrado: true, motivo: 'ok' });
  });

  // El círculo que cierra la migración 065: el usuario activó un username, Meta ya no manda
  // su número, pero le aprendimos el BSUID antes. Su gasto se registra igual — es lo que el
  // modelo promete gratis para siempre — aunque no haya forma de confirmárselo.
  describe('cuando el BSUID SÍ corresponde a un usuario conocido', () => {
    const conocido = { id: 'u-conocido', bsuid: 'PE.999' };
    const mensajeConBsuid = () => ({
      ...sinFrom({ from_user_id: 'PE.999' }),
      text: { body: 'gasté 30 soles en el almuerzo' },
    });

    it('registra el gasto en vez de descartarlo', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue(conocido);
      const { req, res } = buildReqRes(mensajeConBsuid());
      await webhookHandler(req, res);
      expect(buscarUsuarioPorBsuid).toHaveBeenCalledWith('PE.999');
      expect(registrarGastoSilencioso).toHaveBeenCalledWith('gasté 30 soles en el almuerzo', conocido);
    });

    it('NO intenta responderle (no hay número, y enviar por BSUID no está habilitado)', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue(conocido);
      const { req, res } = buildReqRes(mensajeConBsuid());
      await webhookHandler(req, res);
      expect(enviarWhatsapp).not.toHaveBeenCalled();
      expect(procesarMensajeLibre).not.toHaveBeenCalled();
      expect(obtenerOCrearUsuario).not.toHaveBeenCalled();
    });

    it('deja de ensuciar `errores`: ya no es un mensaje indiagnosticable', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue(conocido);
      const { req, res } = buildReqRes(mensajeConBsuid());
      await webhookHandler(req, res);
      expect(registrarError).not.toHaveBeenCalled();
    });

    // Imagen y audio SÍ tienen camino silencioso desde el 09-ago-2026 (ver
    // webhook-bsuid-media.test.js). Lo que sigue sin tenerlo es todo lo demás — un documento,
    // una ubicación, un sticker— y eso no cae al descarte con `registrarError`: el mensaje
    // tiene dueño conocido, así que no es el caso indiagnosticable que esa tabla vigila.
    it('un tipo sin camino silencioso no ensucia `errores` ni intenta responder', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue(conocido);
      const { req, res } = buildReqRes(sinFrom({ from_user_id: 'PE.999', type: 'document' }));
      await webhookHandler(req, res);
      expect(registrarGastoSilencioso).not.toHaveBeenCalled();
      expect(registrarError).not.toHaveBeenCalled();
      expect(enviarWhatsapp).not.toHaveBeenCalled();
    });
  });

  it('un BSUID que no conocemos se sigue descartando y registrando', async () => {
    buscarUsuarioPorBsuid.mockResolvedValue(null);
    const { req, res } = buildReqRes(sinFrom({ from_user_id: 'PE.nunca-visto' }));
    await webhookHandler(req, res);
    expect(registrarGastoSilencioso).not.toHaveBeenCalled();
    expect(registrarError).toHaveBeenCalledTimes(1);
  });

  it('NO llega a obtenerOCrearUsuario (que crearía un usuario fantasma sin número)', async () => {
    const { req, res } = buildReqRes(sinFrom());
    await webhookHandler(req, res);
    expect(obtenerOCrearUsuario).not.toHaveBeenCalled();
  });

  it('responde 200 y no intenta contestarle a nadie', async () => {
    const { req, res } = buildReqRes(sinFrom());
    await webhookHandler(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(enviarWhatsapp).not.toHaveBeenCalled();
    expect(procesarMensajeLibre).not.toHaveBeenCalled();
  });

  it('deja la FORMA del payload en `errores` (el detalle que faltaba para diagnosticarlo)', async () => {
    const { req, res } = buildReqRes(sinFrom({ type: 'system' }));
    await webhookHandler(req, res);
    expect(registrarError).toHaveBeenCalledTimes(1);
    const [tag, mensaje, opts] = registrarError.mock.calls[0];
    expect(tag).toBe('WEBHOOK');
    expect(mensaje).toMatch(/sin from/i);
    const detalle = JSON.parse(opts.detalle);
    expect(detalle.tipo).toBe('system');
    expect(detalle.clavesMensaje).toContain('id');
    // No se registra el contenido del mensaje, solo las claves.
    expect(opts.detalle).not.toContain('hola');
  });

  // 08-ago-2026: ya se sabe QUÉ los produce. Meta arrancó el rollout de WhatsApp Usernames,
  // y el usuario que oculta su número llega sin `from` y con `from_user_id` (BSUID). Se
  // registra el BSUID y la forma de `contacts` porque es lo único que podría permitir
  // contestarle el día que la API acepte enviar por BSUID. El nombre del perfil NO se loguea.
  it('registra el BSUID y la forma de `contacts`, sin el nombre del perfil', async () => {
    const message = sinFrom({ from_user_id: 'PE.1049206861029395' });
    const body = {
      entry: [{ changes: [{ value: {
        messaging_product: 'whatsapp',
        contacts: [{ user_id: 'PE.1049206861029395', profile: { name: 'Ana Torres' } }],
        messages: [message],
      } }] }],
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
    const res = { sendStatus: vi.fn() };
    await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, res);

    const [, , opts] = registrarError.mock.calls[0];
    const detalle = JSON.parse(opts.detalle);
    expect(detalle.fromUserId).toBe('PE.1049206861029395');
    expect(detalle.contactoUserId).toBe('PE.1049206861029395');
    expect(detalle.contactoWaId).toBeNull();          // el username-only no trae número
    expect(detalle.clavesContacto).toEqual(['user_id', 'profile']);
    expect(detalle.clavesPerfil).toEqual(['name']);   // la clave sí, el valor no
    expect(opts.detalle).not.toContain('Ana Torres');
    expect(obtenerOCrearUsuario).not.toHaveBeenCalled();
  });

  it('no lo reporta como un crash del webhook (es un descarte, no una excepción)', async () => {
    const { req, res } = buildReqRes(sinFrom());
    await webhookHandler(req, res);
    expect(notificarErrorAdmin).not.toHaveBeenCalled();
  });

  // El complemento: con remitente, el camino normal sigue intacto. Sin esto, un `return`
  // puesto de más arriba dejaría el test anterior verde y el webhook muerto.
  it('un mensaje CON remitente sigue pasando al pipeline normal', async () => {
    obtenerOCrearUsuario.mockResolvedValue({ id: 'u1', nombre: 'Ana', onboarding_paso: 0, onboarding_completado: true });
    const { req, res } = buildReqRes({ ...sinFrom(), from: '51999888777' });
    await webhookHandler(req, res);
    expect(obtenerOCrearUsuario).toHaveBeenCalledWith('51999888777', null);
  });

  // La ventana que abre la migración 065: mientras Meta mande las DOS identidades juntas,
  // cada mensaje con número enseña el BSUID de ese usuario. Si esto deja de pasar, el día
  // que active un username se vuelve un desconocido y su historial queda huérfano.
  it('aprende el BSUID del remitente cuando Meta lo manda junto al número', async () => {
    obtenerOCrearUsuario.mockResolvedValue({ id: 'u1', nombre: 'Ana', onboarding_paso: 0, onboarding_completado: true });
    const { req, res } = buildReqRes({ ...sinFrom(), from: '51999888777', from_user_id: 'PE.2052090595730104' });
    await webhookHandler(req, res);
    expect(obtenerOCrearUsuario).toHaveBeenCalledWith('51999888777', 'PE.2052090595730104');
  });
});
