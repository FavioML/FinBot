// E2E probe — conectar Gmail y elegir bancos son WEB-ONLY desde WhatsApp.
//
// Este archivo probaba el flujo contrario: `/conectar` dejaba al usuario en el paso 30 con un
// menú numerado de bancos, y el enlace de OAuth salía cuando respondía "1,3" o "todos". O sea
// que el estado de una capability de pago vivía en la base ENTRE dos mensajes, y por eso los
// pasos 30 y 31 necesitaban cada uno un gate duplicado (el del comando ya había quedado atrás).
//
// Ese flujo se retiró. Cada conexión quema uno de los 100 cupos de Google, el límite es sobre
// todo el ciclo de vida del proyecto y NO se puede restablecer, así que la protección real es
// tener UNA sola puerta: `routes/pro.js`, detrás de la sesión de la webapp. Lo que se verifica
// acá es justo lo inverso de antes — que WhatsApp NO emita, NO capture la respuesta siguiente
// y NO escriba un paso de onboarding.
//
// Ejercita el WEBHOOK REAL (firma HMAC, dedup wamid, delegación a manejarOnboarding y cascada
// de comandos) contra Supabase REAL, con el usuario QA (ded7e219, is_test_user=true, premium
// convertido, con cuenta web). No manda WhatsApp: stubea enviarWhatsapp para capturar la
// respuesta real que vería el usuario.
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

// procesarMensajeLibre espía. Antes un "1,3" que llegara acá era un fallo (el paso 30 debía
// capturarlo); ahora es lo correcto: no hay estado que capture nada.
let nlpCalls = 0;
const handler = createWebhookHandler(async () => { nlpCalls++; return 'NLP-respuesta-generica'; });

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
    .select('onboarding_paso, bancos_seleccionados, plan, trial_estado, is_test_user')
    .eq('id', QA_ID).single();
  return data;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

/** Un enlace de OAuth de Google en una respuesta de WhatsApp es el agujero que se cerró. */
function tieneOAuth(texto) {
  return /accounts\.google\.com/.test(texto);
}

async function main() {
  // Guarda de identidad: sin esto el probe podría estar escribiendo sobre un usuario real.
  const u0 = await dbUser();
  check('QA user es de prueba y Pro PAGADO', u0.is_test_user === true && u0.plan === 'premium' && u0.trial_estado !== 'activo',
    'plan=' + u0.plan + ' trial=' + u0.trial_estado);

  // Estado limpio
  await supabase.from('usuarios').update({ onboarding_paso: 0, bancos_seleccionados: null }).eq('id', QA_ID);

  // 1) /conectar → atajo a la app, sin OAuth y sin tocar el estado del alta
  const rConectar = await enviar('/conectar');
  const uConectar = await dbUser();
  check('/conectar manda al panel de la app', /app\.neto\.pe/.test(rConectar), rConectar.slice(0, 70).replace(/\n/g, ' '));
  check('/conectar NO entrega enlace de OAuth', !tieneOAuth(rConectar), '');
  check('/conectar NO muestra el menú numerado viejo', !/1\.\s*BCP/.test(rConectar), '');
  check('/conectar deja onboarding_paso en 0', uConectar.onboarding_paso === 0, 'paso=' + uConectar.onboarding_paso);

  // 2) El mensaje siguiente ya NO es capturado: no queda estado esperando una selección.
  //    Este es el punto del cambio — el gate duplicado existía justo por esta ventana.
  const nlpAntes = nlpCalls;
  const rSel = await enviar('1,3');
  const uSel = await dbUser();
  check('"1,3" ya no lo captura ningún paso: sigue a la cascada normal', nlpCalls > nlpAntes, 'nlpCalls=' + nlpCalls);
  check('"1,3" NO entrega enlace de OAuth', !tieneOAuth(rSel), rSel.slice(0, 50).replace(/\n/g, ' '));
  check('"1,3" NO escribe bancos_seleccionados desde WhatsApp', uSel.bancos_seleccionados === null, JSON.stringify(uSel.bancos_seleccionados));

  // 3) /bancos → mismo trato: atajo, sin editor numerado ni paso 31
  await supabase.from('usuarios').update({ bancos_seleccionados: ['bcp', 'bbva'] }).eq('id', QA_ID);
  const rBancos = await enviar('/bancos');
  const uBancos = await dbUser();
  check('/bancos manda al panel de la app', /app\.neto\.pe/.test(rBancos), rBancos.slice(0, 70).replace(/\n/g, ' '));
  check('/bancos deja onboarding_paso en 0', uBancos.onboarding_paso === 0, 'paso=' + uBancos.onboarding_paso);
  check('/bancos NO altera la selección guardada', JSON.stringify(uBancos.bancos_seleccionados) === JSON.stringify(['bcp', 'bbva']), JSON.stringify(uBancos.bancos_seleccionados));

  // 4) La selección sigue mandando en el scan, la haya hecho quien la haya hecho. Que la UI
  //    se mudara a la web no puede cambiar cómo se lee esa columna.
  const remSel = remitentesParaSeleccion(uBancos.bancos_seleccionados);
  check('scan filtra: incluye BCP+BBVA', remSel.includes('notificaciones@bcp.com.pe') && remSel.includes('notificaciones@bbva.pe'), '');
  check('scan filtra: excluye no elegidos (Interbank/Yape)', !remSel.includes('notificaciones@interbank.pe') && !remSel.includes('notificaciones@yape.pe'), remSel.length + ' remitentes');
  const remTodos = remitentesParaSeleccion(null);
  check('null → set completo (incluye Interbank y Yape)', remTodos.includes('notificaciones@interbank.pe') && remTodos.includes('notificaciones@yape.pe'), remTodos.length + ' remitentes');

  // 5) Un paso 30 huérfano en la DB (alguien a medias cuando se desplegó) no atrapa a nadie.
  await supabase.from('usuarios').update({ onboarding_paso: 30 }).eq('id', QA_ID);
  const nlpAntesHuerfano = nlpCalls;
  await enviar('todos');
  const uHuerfano = await dbUser();
  check('un paso 30 huérfano no captura el mensaje', nlpCalls > nlpAntesHuerfano, 'nlpCalls=' + nlpCalls);
  check('un paso 30 huérfano no escribe bancos', JSON.stringify(uHuerfano.bancos_seleccionados) === JSON.stringify(['bcp', 'bbva']), JSON.stringify(uHuerfano.bancos_seleccionados));

  // 6) Leer SÍ se queda en WhatsApp: no consume cupo y no tiene superficie web.
  const rEscanear = await enviar('/escanear');
  check('/escanear sigue respondiendo por WhatsApp', rEscanear.length > 0 && !tieneOAuth(rEscanear), rEscanear.slice(0, 50).replace(/\n/g, ' '));

  // Cleanup → estado original
  await supabase.from('usuarios').update({ onboarding_paso: 0, bancos_seleccionados: null }).eq('id', QA_ID);

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks OK');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('PROBE ERROR:', e); process.exit(1); });
