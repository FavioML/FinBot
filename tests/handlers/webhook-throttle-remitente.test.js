import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

/**
 * S′5, la mitad que el keyGenerator no podía dar.
 *
 * El limiter de `index.js` corre ANTES del HMAC, así que la única clave honesta que tiene es
 * la IP: cualquier campo del body lo escribió quien mandó el request. La versión anterior
 * keyeaba por `messages[0].from` sin verificar, o sea que un atacante que supiera un número
 * podía dejar a su dueño en 429 sin probar identidad. Eso se cerró keyeando por IP.
 *
 * Pero entonces un remitente AUTENTICADO deja de tener tope propio, y ahí es donde se queman
 * las llamadas a OpenAI. Ese tope vive acá, después de la firma. Este archivo lo ejercita
 * por el handler real: no hay forma de llamarlo suelto, la función no se exporta a propósito.
 */

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

require('../../lib/whatsapp').enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
const procesarStatusesEspia = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').procesarStatuses = procesarStatusesEspia;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
require('../../helpers/db-helpers').obtenerOCrearUsuario = vi.fn(async (numero) => ({
  id: 'u-' + numero, whatsapp: numero, nombre: 'QA', plan: 'premium',
  onboarding_completado: true, onboarding_paso: null,
}));
const buscarPorBsuid = vi.fn().mockResolvedValue(null);
require('../../helpers/db-helpers').buscarUsuarioPorBsuid = buscarPorBsuid;
require('../../lib/error-monitor').registrarError = vi.fn();
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn();
require('../../services/registro-silencioso').registrarGastoSilencioso = vi.fn().mockResolvedValue({ registrado: true });
require('../../services/registro-silencioso').avisarPrimeraVezSilencioso = vi.fn().mockResolvedValue(undefined);


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

let seq = 0;
function firmar(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return { req: { headers: { 'x-hub-signature-256': signature }, rawBody, body }, res: { sendStatus: vi.fn() } };
}

// Cada mensaje lleva un wamid único: el dedup corre ANTES del throttle, así que repetir el
// id contaría como duplicado y no como mensaje nuevo — el test mediría otra cosa.
const mensajeDe = (from) => firmar({
  entry: [{ changes: [{ value: { messages: [{
    from, id: 'wamid-thr-' + (seq++), type: 'text', text: { body: 'gasté 10 en pan' },
  }] } }] }],
});

const statusDe = (recipient) => firmar({
  entry: [{ changes: [{ value: { statuses: [{
    id: 'wamid-st-' + (seq++), status: 'sent', recipient_id: recipient,
  }] } }] }],
});

async function mandar({ req, res }) { await webhookHandler(req, res); }

// Cada `it` usa un número distinto: el contador es un Map de módulo con ventana de 60s, así
// que compartir número entre tests haría que el orden de ejecución cambiara el resultado.
let n = 0;
const numeroFresco = () => '51900' + String(n++).padStart(6, '0');

beforeEach(() => { procesarMensajeLibre.mockClear(); procesarStatusesEspia.mockClear(); });

describe('S′5 — tope por remitente VERIFICADO, después del HMAC', () => {
  it('60 mensajes del mismo remitente pasan; el 61 se descarta', async () => {
    const from = numeroFresco();
    for (let i = 0; i < 60; i++) await mandar(mensajeDe(from));
    expect(procesarMensajeLibre).toHaveBeenCalledTimes(60);

    await mandar(mensajeDe(from));
    expect(procesarMensajeLibre).toHaveBeenCalledTimes(60);  // el 61 no llegó al pipeline
  });

  it('el tope es POR remitente: otro número no hereda el throttle del primero', async () => {
    const victima = numeroFresco();
    const otro = numeroFresco();
    for (let i = 0; i < 61; i++) await mandar(mensajeDe(victima));
    const tras = procesarMensajeLibre.mock.calls.length;

    await mandar(mensajeDe(otro));
    expect(procesarMensajeLibre).toHaveBeenCalledTimes(tras + 1);
  });

  it('el webhook sigue respondiendo 200, incluso al mensaje descartado', async () => {
    const from = numeroFresco();
    for (let i = 0; i < 60; i++) await mandar(mensajeDe(from));
    const { req, res } = mensajeDe(from);
    await webhookHandler(req, res);
    // 429 a Meta dispararía retransmisiones: más carga por la misma ráfaga.
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it('los callbacks de status NO se throttlean (no los origina un usuario)', async () => {
    const dest = numeroFresco();
    for (let i = 0; i < 200; i++) await mandar(statusDe(dest));
    // Un cron de ~100 usuarios produce 300 statuses en ráfaga; throttlearlos perdería el
    // aprendizaje de BSUID justo en el pico.
    expect(procesarStatusesEspia).toHaveBeenCalledTimes(200);
  });

  it('un mensaje sin remitente ni BSUID no se cuenta (no hay a quién contarle)', async () => {
    // Si `limiteRemitenteSuperado(undefined)` contara, TODOS los mensajes sin `from` del
    // mundo compartirían una sola clave y se throttlearían entre sí — justo el camino del
    // usuario con username activo, que es el que menos puede permitirse perder mensajes.
    //
    // ⚠️ La primera versión de este test asertaba `res.sendStatus(200)`, y eso ya salió
    // ANTES del throttle: era verde pasara lo que pasara. La mutación lo destapó. El
    // oráculo tiene que ser algo que el throttle SÍ puede impedir, y en este camino es
    // `buscarUsuarioPorBsuid`, que vive después.
    const sinFrom = () => firmar({
      entry: [{ changes: [{ value: { messages: [{
        id: 'wamid-nf-' + (seq++), type: 'text', text: { body: 'hola' },
      }] } }] }],
    });
    buscarPorBsuid.mockClear();
    for (let i = 0; i < 70; i++) await mandar(sinFrom());
    expect(buscarPorBsuid).toHaveBeenCalledTimes(70);
  });
});
