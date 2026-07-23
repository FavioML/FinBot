// Helper reutilizable para E2E del canal de WhatsApp.
//
// Bootea el `app` de Express REAL en proceso (app.listen(0)), stubea
// `enviarWhatsapp` para capturar la salida hacia el usuario, y firma webhooks de
// Meta como lo haría la Cloud API. Con esto un harness POSTea a /webhook y lee la
// respuesta que NETO le habría mandado al usuario — el pipeline entero (HMAC →
// limiter → webhook.js → onboarding/comandos/NLP → intent → Supabase real) corre
// sin tocar Meta ni mandar un solo WhatsApp.
//
// Por qué en proceso y no black-box contra api.neto.pe:
//   - La respuesta de NETO sale por WhatsApp (Meta), NO en el body HTTP del
//     webhook (que responde 200 y procesa async). Black-box no puede leerla.
//   - Correr en proceso valida el CÓDIGO del working tree. La frescura del deploy
//     de Railway es un check aparte (backend-deploy-fresh, /version), no este.
//
// Seguridad de datos: el usuario QA tiene is_test_user=true, así que aunque no se
// stubeara, lib/whatsapp.js ya saltea los envíos Meta reales. El stub es para
// CAPTURAR el texto y asertar sobre él.
//
// Importar index.js como módulo NO arranca los crons (solo corren bajo
// require.main === module), así que bootear es libre de efectos.
//
// Uso:
//   import { startWebhookHarness } from './webhook-harness.mjs';
//   const h = await startWebhookHarness();
//   const before = h.sent.length;
//   const status = await h.postText('gasté 50 en taxi', 'qa-test-dashboard');
//   const reply  = await h.waitForReply(before);
//   ...
//   await h.close();

import 'dotenv/config';
import crypto from 'crypto';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (m) => path.join(appRoot, m);

// Placeholders para validateConfig() (index.js los exige al require). Los reales
// (Supabase, OpenAI) vienen de app/.env vía dotenv. No se manda nada a Meta.
process.env.META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || 'qa-harness-token';
process.env.META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || 'qa-harness-phone';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'qa-harness-secret';

/**
 * Bootea el harness. Devuelve handles para postear webhooks y leer respuestas.
 * @returns {Promise<{
 *   base: string, sent: Array<{to:string,msg:string}>, secret: string,
 *   supabase: any, openai: any, app: any,
 *   sign: (rawBody:string)=>string,
 *   textEnvelope: (texto:string, from:string)=>object,
 *   imageEnvelope: (mediaId:string, from:string, mime?:string)=>object,
 *   post: (body:object, opts?:{ip?:string, badSig?:string|null})=>Promise<number>,
 *   postText: (texto:string, from:string, opts?:object)=>Promise<number>,
 *   waitForReply: (sinceIndex:number, timeoutMs?:number)=>Promise<string>,
 *   close: ()=>Promise<void>,
 * }>}
 */
export async function startWebhookHarness() {
  // ── Stub de salida: capturar enviarWhatsapp ANTES de cargar index.js ──
  const sent = [];
  const waPath = require.resolve(R('lib/whatsapp.js'));
  const waReal = require(waPath);
  require.cache[waPath].exports = {
    ...waReal,
    enviarWhatsapp: async (to, msg) => { sent.push({ to, msg }); return { ok: true }; },
  };

  const { app } = require(R('index.js'));
  const { supabase } = require(R('lib/db.js'));
  const { openai } = require(R('lib/ai.js'));
  const secret = process.env.META_APP_SECRET;

  let wamidSeq = 0;
  const nextWamid = () => 'qa-h-' + Date.now() + '-' + (wamidSeq++);

  const sign = (rawBody) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const textEnvelope = (texto, from) => ({
    entry: [{ changes: [{ value: { messages: [{
      from, id: nextWamid(), type: 'text', text: { body: texto },
    }] } }] }],
  });

  const imageEnvelope = (mediaId, from, mime = 'image/jpeg') => ({
    entry: [{ changes: [{ value: { messages: [{
      from, id: nextWamid(), type: 'image', image: { id: mediaId, mime_type: mime },
    }] } }] }],
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  // POSTea un envelope firmado. Devuelve el status HTTP. `badSig`: si es string se
  // manda esa firma (para probar rechazo); si es null se omite el header X-Hub.
  async function post(body, opts = {}) {
    const { ip = '2001:db8:e2e::1', badSig } = opts;
    const rawBody = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip };
    if (badSig !== null) headers['X-Hub-Signature-256'] = badSig !== undefined ? badSig : sign(rawBody);
    const r = await fetch(base + '/webhook', { method: 'POST', headers, body: rawBody });
    return r.status;
  }

  const postText = (texto, from, opts) => post(textEnvelope(texto, from), opts);

  // El webhook responde 200 y procesa async: la respuesta al usuario aparece en
  // `sent` cuando el pipeline llama a enviarWhatsapp. Poll hasta que llegue.
  async function waitForReply(sinceIndex, timeoutMs = 60000) {
    const t0 = Date.now();
    while (sent.length === sinceIndex && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 300));
    }
    return sent.slice(sinceIndex).map((s) => s.msg).join('\n');
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    base, sent, secret, supabase, openai, app,
    sign, textEnvelope, imageEnvelope, post, postText, waitForReply, close,
  };
}
