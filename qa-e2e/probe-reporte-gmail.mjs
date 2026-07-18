// E2E probe — copy del modo de reporte Gmail con UNA sola cuenta (regla: un correo por usuario).
//
// Ejercita el WEBHOOK REAL + procesarMensajeLibre REAL (NLP con OpenAI real) contra Supabase
// REAL, con el usuario QA (ded7e219, is_test_user=true, plan premium). Siembra HISTORIAL
// ADVERSO (turnos que hablan de "agregar otra cuenta") para que historialConv.slice(-4) no
// desvíe el ruteo. Verifica que:
//   1) el mensaje NL llega hasta el intent (ningún intercept del webhook lo secuestra),
//   2) con <2 cuentas Gmail, la respuesta real ya NO invita a "agregar otro correo",
//   3) usa el copy nuevo (una sola cuenta → reportes en uno solo).
//
// Stubea enviarWhatsapp para capturar la respuesta real. Hace real OpenAI (costo mínimo).
//
// Correr:  node qa-e2e/probe-reporte-gmail.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import crypto from 'crypto';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

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
const { procesarMensajeLibre } = require(path.join(appRoot, 'handlers/message-processor.js'));
const { supabase } = require(path.join(appRoot, 'lib/db.js'));
const { obtenerCuentasGmail } = require(path.join(appRoot, 'gmail.js'));

// Handler REAL: el mensaje NL debe recorrer webhook → procesarMensajeLibre (NLP real).
const handler = createWebhookHandler(procesarMensajeLibre);

let wamidSeq = 0;
async function enviar(texto) {
  const before = sent.length;
  const body = {
    entry: [{ changes: [{ value: { messages: [{
      from: QA_WHATSAPP,
      id: 'qa-probe-rgmail-' + Date.now() + '-' + (wamidSeq++),
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

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

async function main() {
  // ── Guarda de identidad ──
  const { data: u0 } = await supabase.from('usuarios')
    .select('is_test_user, plan, reporte_gmail_modo').eq('id', QA_ID).single();
  check('QA user es de prueba y premium', u0.is_test_user === true && u0.plan === 'premium', 'plan=' + u0.plan);
  const modoOriginal = u0.reporte_gmail_modo;

  // Estado limpio: sin paso de onboarding pendiente, si no el webhook secuestra el mensaje
  // (manejarOnboarding lo atrapa) y nunca llega al NLP.
  await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', QA_ID);

  // ── Preparar exactamente 1 cuenta Gmail: la rama del copy aplica a un usuario con
  //    Gmail conectado (no 0, si no el NLP rutea a "conectar") y <2 cuentas. Fila mínima:
  //    preferencia_reporte_gmail solo usa cuentasConf.length, no los tokens. ──
  await supabase.from('gmail_cuentas').delete().eq('usuario_id', QA_ID).eq('email', 'qa-probe@gmail.com');
  await supabase.from('gmail_cuentas').insert({
    usuario_id: QA_ID, email: 'qa-probe@gmail.com', activa: true,
    access_token: 'qa-probe-dummy', refresh_token: 'qa-probe-dummy',
  });
  const cuentas = await obtenerCuentasGmail(QA_ID);
  check('QA tiene exactamente 1 cuenta Gmail (conectado, <2 → dispara la rama)', cuentas.length === 1, cuentas.length + ' cuentas');

  // ── Sembrar HISTORIAL ADVERSO (entra en historialConv.slice(-4)) ──
  await supabase.from('conversaciones').delete().eq('usuario_id', QA_ID);
  const advHist = [
    { rol: 'usuario', mensaje: 'quiero agregar otra cuenta de gmail para separar mis reportes' },
    { rol: 'neto', mensaje: 'Ya tienes un Gmail conectado.' },
    { rol: 'usuario', mensaje: 'ya pero quiero un segundo correo aparte' },
    { rol: 'neto', mensaje: 'Un usuario conecta un solo correo.' },
  ];
  for (const h of advHist) {
    await supabase.from('conversaciones').insert({ usuario_id: QA_ID, rol: h.rol, mensaje: h.mensaje });
    await new Promise((r) => setTimeout(r, 25)); // asegurar orden created_at
  }

  // ── Mensaje NL real: cambiar la PREFERENCIA de reporte a separado ──
  const resp = await enviar('cambia mi preferencia de reporte de gmail a modo separado por cuenta');
  console.log('\n--- respuesta real del usuario ---\n' + resp + '\n----------------------------------\n');

  const { data: uAfter } = await supabase.from('usuarios').select('reporte_gmail_modo').eq('id', QA_ID).single();

  // 1) El mensaje llegó al intent (no lo secuestró un intercept): hay respuesta y no es fallback vacío.
  check('el mensaje produce respuesta real (no fue tragado por un intercept)', resp && resp.trim().length > 0, resp.slice(0, 60).replace(/\n/g, ' '));

  // 2) Copy nuevo presente
  check('respuesta usa el copy nuevo (una sola cuenta → reportes en uno solo)',
    /una sola cuenta gmail|modo separado aplica|salen en uno solo/i.test(resp),
    resp.slice(0, 80).replace(/\n/g, ' '));

  // 3) Copy stale AUSENTE (ya no invita a agregar otro correo)
  check('respuesta NO invita a agregar otro correo (copy stale eliminado)',
    !/agrega otra|agregar otro correo/i.test(resp),
    '');

  // Señal de ruteo correcto: el intent guardó modo=separado antes del check <2.
  check('routeó a preferencia_reporte_gmail (persistió modo=separado)', uAfter.reporte_gmail_modo === 'separado', 'modo=' + uAfter.reporte_gmail_modo);

  // ── Cleanup: restaurar modo original, quitar la cuenta de prueba y limpiar historial ──
  await supabase.from('usuarios').update({ reporte_gmail_modo: modoOriginal }).eq('id', QA_ID);
  await supabase.from('gmail_cuentas').delete().eq('usuario_id', QA_ID).eq('email', 'qa-probe@gmail.com');
  await supabase.from('conversaciones').delete().eq('usuario_id', QA_ID);

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks OK');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1); });
