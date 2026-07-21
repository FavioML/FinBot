// E2E probe — el system prompt maestro de NETO llega REALMENTE al modelo.
//
// Regresión que cubre: message-processor.js leía `handlers/NETO_system_prompt.txt` (ruta
// inexistente) dentro de un try/catch silencioso, así que producción respondía con un
// fallback de una línea. El ENOENT solo aparecía como log level 50.
//
// Qué verifica, con el pipeline real (webhook firmado → limiter → procesarMensajeLibre →
// Supabase real → OpenAI real), espiando openai.chat.completions.create:
//   A) El system message que recibe el modelo es el prompt de docs/ (~16KB), no el fallback.
//   B) Los placeholders quedaron resueltos (nombre del usuario dentro, ningún {ALGO} suelto).
//   C) La respuesta al usuario cambia: se reejecuta la MISMA llamada con el fallback viejo
//      y se compara contra la respuesta real.
//
// No manda WhatsApp: stubea enviarWhatsapp para capturar la salida.
// Correr:  node qa-e2e/probe-system-prompt.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import crypto from 'crypto';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';

// El prompt viejo que producción venía usando por el ENOENT. Sirve de control.
const FALLBACK_VIEJO = 'Eres NETO, asistente financiero por WhatsApp. Hablas en espanol peruano, eres directo y siempre terminas con una accion o pregunta.';

process.env.META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || 'qa-probe-token';
process.env.META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || 'qa-probe-phone';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'qa-probe-secret';

// ── Stub de salida: capturar enviarWhatsapp ANTES de cargar index.js ──
const sent = [];
const waPath = require.resolve(path.join(appRoot, 'lib/whatsapp.js'));
const waReal = require(waPath);
require.cache[waPath].exports = {
  ...waReal,
  enviarWhatsapp: async (to, msg) => { sent.push({ to, msg }); return { ok: true }; },
};

// ── Espía sobre OpenAI: mismo objeto singleton que usan todos los módulos ──
const { openai } = require(path.join(appRoot, 'lib/ai.js'));
const llamadas = [];
const createReal = openai.chat.completions.create.bind(openai.chat.completions);
openai.chat.completions.create = async (params, ...rest) => {
  llamadas.push(params);
  return createReal(params, ...rest);
};

const { app } = require(path.join(appRoot, 'index.js'));
const { supabase } = require(path.join(appRoot, 'lib/db.js'));
const { RAW_PROMPT } = require(path.join(appRoot, 'lib/neto-prompt.js'));

const SECRET = process.env.META_APP_SECRET;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

let base;
let wamidSeq = 0;

function cuerpoMensaje(texto, from) {
  return {
    entry: [{ changes: [{ value: { messages: [{
      from,
      id: 'qa-sp-' + Date.now() + '-' + (wamidSeq++),
      type: 'text',
      text: { body: texto },
    }] } }] }],
  };
}

async function postWebhook(body, ip) {
  const rawBody = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  const r = await fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, 'X-Hub-Signature-256': sig },
    body: rawBody,
  });
  return r.status;
}

async function run() {
  const { data: user } = await supabase.from('usuarios')
    .select('id, nombre, whatsapp, is_test_user, plan').eq('id', QA_ID).single();
  check('usuario QA existe y es de prueba',
    user?.is_test_user === true && user?.whatsapp === QA_WHATSAPP,
    'nombre=' + user?.nombre + ' plan=' + user?.plan);

  const antes = sent.length;
  const status = await postWebhook(cuerpoMensaje('¿cuánto gasté este mes?', QA_WHATSAPP), '2001:db8:5150::1');
  check('webhook acepta el mensaje', status !== 429 && status < 500, 'status = ' + status);

  const t0 = Date.now();
  while (sent.length === antes && Date.now() - t0 < 60000) await new Promise(r => setTimeout(r, 500));
  const respuesta = sent.slice(antes).map(s => s.msg).join('\n');
  check('el usuario recibió respuesta', respuesta.length > 0, respuesta ? 'sí' : 'silencio en 60s');

  // ── A) El system message real que viajó a OpenAI ──────────────────────────────
  // La llamada de redacción es la que NO lleva tools (esa es la de clasificación NLP).
  const redaccion = llamadas.filter(c => !c.tools && c.messages?.[0]?.role === 'system').pop();
  check('hubo una llamada de redacción a OpenAI', !!redaccion,
    'llamadas totales = ' + llamadas.length);
  if (!redaccion) return;

  const systemMsg = redaccion.messages[0].content;
  check('el system prompt enviado NO es el fallback de una línea',
    systemMsg !== FALLBACK_VIEJO && systemMsg.length > 10000,
    systemMsg.length + ' bytes');
  // Ancla contra docs/: una sección larga del archivo sin placeholders debe estar textual.
  const ancla = RAW_PROMPT.slice(RAW_PROMPT.indexOf('TRES PILARES'), RAW_PROMPT.indexOf('TONO EXACTO'));
  check('es el prompt maestro de docs/, textual (con el contexto inyectado)',
    systemMsg.includes('SYSTEM PROMPT MAESTRO') && ancla.length > 200 && systemMsg.includes(ancla),
    'ancla de ' + ancla.length + ' bytes presente');

  // ── B) Placeholders resueltos ─────────────────────────────────────────────────
  const bloque = systemMsg.slice(systemMsg.indexOf('DATOS DEL USUARIO (CONTEXTO DINÁMICO)'));
  const sueltos = bloque.match(/\{[A-Z_]+\}/g);
  check('sin placeholders sin resolver en el bloque de contexto', !sueltos,
    sueltos ? [...new Set(sueltos)].join(', ') : 'ninguno');
  check('el nombre y el plan del usuario quedaron inyectados',
    bloque.includes('Nombre: ' + (user?.nombre || 'amigo')) && bloque.includes('Plan: ' + (user?.plan || 'free')),
    bloque.split('\n').filter(Boolean).slice(1, 6).join(' | '));

  // ── C) La respuesta al usuario cambia vs. el fallback viejo ───────────────────
  // Misma llamada, mismos datos, mismo historial: solo cambia el system prompt.
  const { timeout: _t, ...paramsRedaccion } = redaccion;  // `timeout` es opción de cliente, no body
  const control = await createReal({
    ...paramsRedaccion,
    messages: [{ role: 'system', content: FALLBACK_VIEJO }, ...redaccion.messages.slice(1)],
  });
  const respFallback = control.choices[0].message.content.trim();
  const respReal = respuesta.trim();
  console.log('\n--- respuesta CON prompt maestro ---\n' + respReal);
  console.log('\n--- respuesta con el fallback viejo (control) ---\n' + respFallback + '\n');
  check('la respuesta al usuario cambia respecto del fallback', respReal !== respFallback);
}

const server = app.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  let fatal = null;
  try { await run(); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }

  const fallidos = results.filter(r => !r.pass);
  console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
  if (fatal) console.log(fatal.stack);
  server.close();
  process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
});
