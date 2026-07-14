import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// ─── Setup: parchar singletons ANTES de requerir el webhook ──────────────────
// Mismo patrón que webhook-onboarding.test.js: webhook.js destructura los
// singletons al cargar, así que hay que reemplazarlos antes del require.

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;

// Mock del cliente OpenAI: solo nos interesa audio.transcriptions.create.
const transcriptionsCreate = vi.fn();
require('../../lib/ai').openai = { audio: { transcriptions: { create: transcriptionsCreate } } };

// Supabase: cadena vacía por defecto (ningún referido, ningún OTP, etc.).
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
// procesarMensajeLibre es lo que recibe el texto (transcrito o escrito).
const procesarMensajeLibre = vi.fn().mockResolvedValue('ok');
const webhookHandler = createWebhookHandler(procesarMensajeLibre);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildAudioReqRes(from, audioId) {
  const audio = audioId === null ? {} : { id: audioId, mime_type: 'audio/ogg' };
  const body = {
    entry: [{
      changes: [{
        value: { messages: [{ from, id: 'wamid-' + Math.random().toString(36).slice(2), type: 'audio', audio }] }
      }]
    }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  const req = { headers: { 'x-hub-signature-256': signature }, rawBody, body };
  const res = { sendStatus: vi.fn() };
  return { req, res };
}

// fetch se llama dos veces: (1) metadata Meta → { url }, (2) descarga del binario.
function mockFetchOk() {
  global.fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://media.meta/audio.ogg', mime_type: 'audio/ogg' }) })
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('Notas de voz (audio) → pipeline de texto', () => {
  beforeEach(() => {
    enviarWhatsapp.mockClear();
    procesarMensajeLibre.mockClear();
    transcriptionsCreate.mockReset();
    obtenerOCrearUsuario.mockReset();
    // Usuario ya onboardeado → el texto libre cae a procesarMensajeLibre.
    obtenerOCrearUsuario.mockResolvedValue({ id: 'user-1', nombre: 'Juan', onboarding_paso: 0, onboarding_completado: true });
  });

  it('transcribe el audio y mete el texto en el pipeline de NLP', async () => {
    mockFetchOk();
    transcriptionsCreate.mockResolvedValue({ text: 'gasté 20 soles en el almuerzo' });

    const { req, res } = buildAudioReqRes('51999000111', 'media-abc');
    await webhookHandler(req, res);

    expect(transcriptionsCreate).toHaveBeenCalledOnce();
    // El texto transcrito llega a procesarMensajeLibre igual que si lo hubiera escrito.
    expect(procesarMensajeLibre).toHaveBeenCalledWith('gasté 20 soles en el almuerzo', expect.any(Object), '51999000111');
  });

  it('audio ilegible (transcripción vacía) → mensaje amable, sin tocar el NLP', async () => {
    mockFetchOk();
    transcriptionsCreate.mockResolvedValue({ text: '   ' });

    const { req, res } = buildAudioReqRes('51999000111', 'media-abc');
    await webhookHandler(req, res);

    expect(procesarMensajeLibre).not.toHaveBeenCalled();
    expect(enviarWhatsapp.mock.calls[0][1]).toMatch(/no logr[ée] entender/i);
  });

  it('sin media id → mensaje amable, no intenta transcribir', async () => {
    const { req, res } = buildAudioReqRes('51999000111', null);
    await webhookHandler(req, res);

    expect(transcriptionsCreate).not.toHaveBeenCalled();
    expect(procesarMensajeLibre).not.toHaveBeenCalled();
    expect(enviarWhatsapp.mock.calls[0][1]).toMatch(/no pude recibir/i);
  });

  it('falla la transcripción → mensaje amable, no revienta el webhook', async () => {
    mockFetchOk();
    transcriptionsCreate.mockRejectedValue(new Error('whisper down'));

    const { req, res } = buildAudioReqRes('51999000111', 'media-abc');
    await webhookHandler(req, res);

    expect(procesarMensajeLibre).not.toHaveBeenCalled();
    expect(enviarWhatsapp.mock.calls[0][1]).toMatch(/no pude procesar/i);
  });
});
