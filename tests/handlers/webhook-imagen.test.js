import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// La rama de imagen del webhook (Yape/Plin/banco → Vision → guardarTransaccion) no tenía
// ninguna cobertura en la suite rápida: solo la ejercitaban dos harness manuales que gastan
// una llamada Vision real cada vez. Este archivo es la red que hace seguro extraer la
// descarga de media y el prompt a `services/media-intake.js`: lo que hay que vigilar de un
// refactor así no es que reviente, es que un EFECTO LATERAL viaje con el código movido —
// el orden de `esperaComprobante` antes de guardar, el default de fecha, o la categoría que
// sale de `guardarTransaccion` y no del parser.

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

const guardarTransaccion = vi.fn();
require('../../services/transactions').guardarTransaccion = guardarTransaccion;

const procesarComprobantePro = vi.fn().mockResolvedValue(undefined);
require('../../lib/pro-payment').procesarComprobantePro = procesarComprobantePro;

const colaConfirmacionGasto = vi.fn().mockResolvedValue(null);
require('../../lib/trial').colaConfirmacionGasto = colaConfirmacionGasto;

const registrarError = vi.fn();
require('../../lib/error-monitor').registrarError = registrarError;

// OJO: acá NO se reemplaza el objeto `openai` entero (como sí hace webhook-audio.test.js),
// porque eso destruiría `chat.completions.create`, que es justo lo que usa Vision.
// `tests/setup.js` ya parchea ese método sobre la instancia compartida.
const visionCreate = globalThis.__mockOpenAICreate;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────
let wamidSeq = 0;

function buildImagenReqRes(from, imageId) {
  const image = imageId === null ? {} : { id: imageId, mime_type: 'image/jpeg' };
  const body = {
    entry: [{
      changes: [{
        value: { messages: [{ from, id: 'wamid-img-' + (wamidSeq++), type: 'image', image }] }
      }]
    }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return { req: { headers: { 'x-hub-signature-256': signature }, rawBody, body }, res: { sendStatus: vi.fn() } };
}

// fetch se llama dos veces, en este orden: (1) metadata de Meta → { url }, (2) el binario.
function mockFetchOk() {
  global.fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://media.meta/img.jpg', mime_type: 'image/jpeg' }) })
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
}

function visionResponde(obj) {
  visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

const YAPE_GASTO = {
  tipo: 'gasto', monto: 23.45, moneda: 'PEN', comercio: 'Pollería El Rancho',
  categoria: 'Alimentación', subcategoria: 'Restaurantes', metodo_pago: 'Yape',
  fecha: '2026-08-09', descripcion_original: 'Yapeaste S/ 23.45',
};

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('Imágenes de pago (Yape/Plin/banco) → Vision → transacción', () => {
  beforeEach(() => {
    enviarWhatsapp.mockClear();
    guardarTransaccion.mockReset().mockResolvedValue({ categoria: 'Alimentación', subcategoria: 'Restaurantes', conteoTx: 5 });
    procesarComprobantePro.mockClear();
    colaConfirmacionGasto.mockClear().mockResolvedValue(null);
    visionCreate.mockReset().mockResolvedValue({ choices: [{ message: { content: '{}' } }] });
    obtenerOCrearUsuario.mockReset().mockResolvedValue({
      id: 'user-1', nombre: 'Juan', onboarding_paso: 0, onboarding_completado: true, esperando_comprobante: false,
    });
  });

  it('registra el gasto y confirma con la categoría YA persistida, no la del parser', async () => {
    mockFetchOk();
    // Vision dice "Otros"; guardarTransaccion normaliza a "Alimentación". La confirmación
    // tiene que mostrar lo que quedó guardado.
    visionResponde({ ...YAPE_GASTO, categoria: 'Otros' });

    const { req, res } = buildImagenReqRes('51999000111', 'media-img');
    await webhookHandler(req, res);

    expect(guardarTransaccion).toHaveBeenCalledOnce();
    const [usuarioId, datos] = guardarTransaccion.mock.calls[0];
    expect(usuarioId).toBe('user-1');
    expect(datos.monto).toBe(23.45);

    const resp = enviarWhatsapp.mock.calls[0][1];
    expect(resp).toMatch(/Gasto registrado/);
    expect(resp).toMatch(/23\.45/);
    expect(resp).toMatch(/Alimentación/);
  });

  it('un ingreso se confirma como ingreso, no como gasto', async () => {
    mockFetchOk();
    visionResponde({ ...YAPE_GASTO, tipo: 'ingreso', comercio: 'Maria', categoria: 'Finanzas' });
    guardarTransaccion.mockResolvedValue({ categoria: 'Finanzas', subcategoria: null, conteoTx: 2 });

    const { req, res } = buildImagenReqRes('51999000111', 'media-img');
    await webhookHandler(req, res);

    expect(enviarWhatsapp.mock.calls[0][1]).toMatch(/Ingreso registrado/);
  });

  it('sin fecha en la imagen, cae al día de hoy en vez de guardar null', async () => {
    mockFetchOk();
    const { fecha, ...sinFecha } = YAPE_GASTO;
    visionResponde(sinFecha);

    const { req, res } = buildImagenReqRes('51999000111', 'media-img');
    await webhookHandler(req, res);

    expect(guardarTransaccion.mock.calls[0][1].fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // B29 — DECISIÓN, no descuido: la fecha impresa en el recibo gana sobre el día en que
  // llegó la foto, y este test existe para que nadie le agregue acá el guard de
  // `registrar_manual` ("sin mención explícita, la fecha es hoy") creyendo que falta.
  //
  // No falta: son casos distintos. Ese guard existe porque el modelo ALUCINA una fecha
  // pasada sin nada en el mensaje que la respalde; una captura no alucina, LEE una fecha
  // impresa. Medido el 12-ago-2026 sobre 290 filas que entraron por foto en 180 días: 75
  // traen una fecha anterior al día de envío, y sólo 3 caen en otro mes. El desfase más
  // común (31 filas) es de UN día — el Yape de las 11pm fotografiado pasada la medianoche,
  // donde forzar "hoy" sería introducir el error, no corregirlo.
  //
  // El E2E hermano (`qa-e2e/qa-e2e-registro-gasto-foto.mjs`) afirma lo mismo contra Vision
  // real, pero cuesta una llamada a GPT-4o y no está en el canary: esta es la copia que
  // corre en cada push.
  it('respeta la fecha que Vision leyó del recibo (NO la fuerza a hoy) — B29', async () => {
    mockFetchOk();
    visionResponde({ ...YAPE_GASTO, fecha: '2026-07-24' });

    const { req, res } = buildImagenReqRes('51999000111', 'media-img');
    await webhookHandler(req, res);

    expect(guardarTransaccion.mock.calls[0][1].fecha).toBe('2026-07-24');
  });

  it('imagen sin transacción (no_pago) → no registra nada y lo dice', async () => {
    mockFetchOk();
    visionResponde({ tipo: 'no_pago' });

    const { req, res } = buildImagenReqRes('51999000111', 'media-img');
    await webhookHandler(req, res);

    expect(guardarTransaccion).not.toHaveBeenCalled();
    expect(enviarWhatsapp.mock.calls[0][1]).toMatch(/no reconoc/i);
  });

  it('sin media id → no llama a Vision', async () => {
    const { req, res } = buildImagenReqRes('51999000111', null);
    await webhookHandler(req, res);

    expect(visionCreate).not.toHaveBeenCalled();
    expect(enviarWhatsapp.mock.calls[0][1]).toMatch(/no pude recibir/i);
  });

  it('Vision devuelve basura → mensaje amable, no revienta el webhook', async () => {
    mockFetchOk();
    visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'lo siento, no puedo' } }] });

    const { req, res } = buildImagenReqRes('51999000111', 'media-img');
    await webhookHandler(req, res);

    expect(guardarTransaccion).not.toHaveBeenCalled();
    expect(enviarWhatsapp.mock.calls[0][1]).toMatch(/no pude procesar/i);
  });

  describe('cuando el usuario está esperando enviar su comprobante Pro', () => {
    beforeEach(() => {
      obtenerOCrearUsuario.mockResolvedValue({
        id: 'user-1', nombre: 'Juan', onboarding_paso: 0, onboarding_completado: true,
        esperando_comprobante: true, comprobante_solicitado_at: new Date().toISOString(),
      });
    });

    it('la captura del pago a Neto va al flujo Pro Y se registra como gasto', async () => {
      mockFetchOk();
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas', fecha: '2026-08-09' });

      const { req, res } = buildImagenReqRes('51999000111', 'media-img');
      await webhookHandler(req, res);

      expect(procesarComprobantePro).toHaveBeenCalledOnce();
      // El gasto de la suscripción se registra igual: es plata que salió.
      expect(guardarTransaccion).toHaveBeenCalledOnce();
    });

    it('una captura que NO es el pago a Neto no activa el flujo Pro ni registra el gasto', async () => {
      mockFetchOk();
      visionResponde(YAPE_GASTO);

      const { req, res } = buildImagenReqRes('51999000111', 'media-img');
      await webhookHandler(req, res);

      expect(procesarComprobantePro).not.toHaveBeenCalled();
      expect(guardarTransaccion).not.toHaveBeenCalled();
      expect(enviarWhatsapp.mock.calls[0][1]).toMatch(/no parece el pago/i);
    });
  });
});
