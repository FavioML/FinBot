// E2E probe — selección de bancos en el flujo de conexión Gmail (paso 30).
//
// Ejercita el WEBHOOK REAL (firma HMAC, dedup wamid, skips de imagen/OTP/referido,
// delegación a manejarOnboarding y cascada de comandos) contra Supabase REAL, con el
// usuario QA (ded7e219, is_test_user=true, plan premium). No manda WhatsApp: stubea
// enviarWhatsapp para capturar la respuesta real que vería el usuario. Un
// procesarMensajeLibre espía FALLA si un "1,3"/"todos" llegara al NLP (prueba que
// ningún intercept/NLP secuestra el mensaje).
//
// Correr:  node qa-e2e/probe-bancos.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import crypto from 'crypto';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'qa-probe-secret';

// ── Stub de salida: capturar todo enviarWhatsapp antes de cargar el webhook ──
const sent = [];
const waPath = require.resolve(path.join(appRoot, 'lib/whatsapp.js'));
require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: { enviarWhatsapp: async (to, msg) => { sent.push({ to, msg }); } },
};

const createWebhookHandler = require(path.join(appRoot, 'handlers/webhook.js'));
const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));
const { remitentesParaSeleccion } = require(path.join(appRoot, 'gmail.js'));

// procesarMensajeLibre espía: si se invoca para nuestros replies, el intercept falló.
let nlpCalls = 0;
const handler = createWebhookHandler(async () => { nlpCalls++; return 'NLP-NO-DEBERIA-CORRER'; });

let wamidSeq = 0;
async function enviar(texto) {
  const before = sent.length;
  const body = {
    entry: [{ changes: [{ value: { messages: [{
      from: QA_WHATSAPP,
      id: 'qa-probe-' + Date.now() + '-' + (wamidSeq++),
      type: 'text',
      text: { body: texto },
    }] } }] }],
  };
  const rawBody = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex');
  const req = { headers: { 'x-hub-signature-256': sig }, rawBody, body };
  const res = { sendStatus: () => {} };
  await handler(req, res);
  return sent.slice(before).map(s => s.msg).join('\n');
}

async function dbUser() {
  const { data } = await supabase.from('usuarios')
    .select('onboarding_paso, bancos_seleccionados, plan, is_test_user')
    .eq('id', QA_ID).single();
  return data;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

async function main() {
  // Guarda de identidad
  const u0 = await dbUser();
  check('QA user es de prueba y premium', u0.is_test_user === true && u0.plan === 'premium', 'plan=' + u0.plan);

  // Estado limpio
  await supabase.from('usuarios').update({ onboarding_paso: 0, bancos_seleccionados: null }).eq('id', QA_ID);

  // 1) /conectar (Pro, sin Gmail) → menú de bancos + paso 30
  const rConectar = await enviar('/conectar');
  const uConectar = await dbUser();
  check('/conectar muestra el selector de bancos', /elige tus bancos|con qué bancos operas/i.test(rConectar) && /1\.\s*BCP/.test(rConectar) && /todos/i.test(rConectar), rConectar.slice(0, 60).replace(/\n/g, ' '));
  check('/conectar deja onboarding_paso=30', uConectar.onboarding_paso === 30, 'paso=' + uConectar.onboarding_paso);
  check('/conectar NO entrega el enlace OAuth todavía', !/accounts\.google\.com/.test(rConectar), '');

  // 2) Reply "1,3" (BCP + BBVA) → guarda selección + entrega OAuth, sin tocar NLP
  const nlpAntes = nlpCalls;
  const rSel = await enviar('1,3');
  const uSel = await dbUser();
  check('"1,3" NO llega al NLP (ningún intercept lo secuestra)', nlpCalls === nlpAntes, 'nlpCalls=' + nlpCalls);
  check('"1,3" entrega el enlace OAuth real', /accounts\.google\.com/.test(rSel), rSel.slice(0, 50).replace(/\n/g, ' '));
  check('"1,3" persiste bancos_seleccionados=[bcp,bbva]', JSON.stringify(uSel.bancos_seleccionados) === JSON.stringify(['bcp', 'bbva']), JSON.stringify(uSel.bancos_seleccionados));
  check('"1,3" resetea onboarding_paso a 0', uSel.onboarding_paso === 0, 'paso=' + uSel.onboarding_paso);

  // 3) El filtro del scan usa la selección persistida (DB → remitentesParaSeleccion)
  const remSel = remitentesParaSeleccion(uSel.bancos_seleccionados);
  check('scan filtra: incluye BCP+BBVA', remSel.includes('notificaciones@bcp.com.pe') && remSel.includes('notificaciones@bbva.pe'), '');
  check('scan filtra: excluye no elegidos (Interbank/Yape)', !remSel.includes('notificaciones@interbank.pe') && !remSel.includes('notificaciones@yape.pe'), remSel.length + ' remitentes');

  // 4) Reconectar y elegir "todos" → null (= set completo, backward-compatible)
  await enviar('/conectar');
  const rTodos = await enviar('todos');
  const uTodos = await dbUser();
  check('"todos" persiste bancos_seleccionados=null', uTodos.bancos_seleccionados === null, JSON.stringify(uTodos.bancos_seleccionados));
  const remTodos = remitentesParaSeleccion(uTodos.bancos_seleccionados);
  check('"todos" → set completo (incluye Interbank y Yape)', remTodos.includes('notificaciones@interbank.pe') && remTodos.includes('notificaciones@yape.pe'), remTodos.length + ' remitentes');

  // 5) Entrada inválida en paso 30 no rompe ni avanza
  await supabase.from('usuarios').update({ onboarding_paso: 30, bancos_seleccionados: null }).eq('id', QA_ID);
  const rBad = await enviar('mmm no sé');
  const uBad = await dbUser();
  check('entrada inválida re-pregunta y mantiene paso 30', /no entendí|números/i.test(rBad) && uBad.onboarding_paso === 30, 'paso=' + uBad.onboarding_paso);

  // 6) /bancos: editar la selección en cualquier momento (paso 31), sin OAuth
  await supabase.from('usuarios').update({ onboarding_paso: 0, bancos_seleccionados: ['bcp', 'bbva'] }).eq('id', QA_ID);
  const rBancos = await enviar('/bancos');
  const uBancos = await dbUser();
  check('/bancos muestra el editor con la selección actual', /tus bancos/i.test(rBancos) && /hoy leo/i.test(rBancos) && /BCP/.test(rBancos), rBancos.slice(0, 60).replace(/\n/g, ' '));
  check('/bancos deja onboarding_paso=31', uBancos.onboarding_paso === 31, 'paso=' + uBancos.onboarding_paso);

  const nlpAntesEdit = nlpCalls;
  const rEdit = await enviar('2');
  const uEdit = await dbUser();
  check('editar bancos NO llega al NLP', nlpCalls === nlpAntesEdit, 'nlpCalls=' + nlpCalls);
  check('editar bancos persiste la nueva selección [interbank]', JSON.stringify(uEdit.bancos_seleccionados) === JSON.stringify(['interbank']), JSON.stringify(uEdit.bancos_seleccionados));
  check('editar bancos confirma sin entregar OAuth', /actualizado/i.test(rEdit) && !/accounts\.google\.com/.test(rEdit), rEdit.slice(0, 50).replace(/\n/g, ' '));
  check('editar bancos resetea onboarding_paso a 0', uEdit.onboarding_paso === 0, 'paso=' + uEdit.onboarding_paso);

  // Cleanup → estado original
  await supabase.from('usuarios').update({ onboarding_paso: 0, bancos_seleccionados: null }).eq('id', QA_ID);

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks OK');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('PROBE ERROR:', e); process.exit(1); });
