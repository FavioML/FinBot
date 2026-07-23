// Canary de la PUERTA de seguridad del webhook de WhatsApp, contra PROD (api.neto.pe).
//
// Verifica que el gate HMAC de /webhook rechaza todo lo que no venga firmado por
// Meta. Es la defensa contra que cualquiera forje mensajes entrantes (registrar
// gastos falsos, disparar comandos como otro usuario, etc.). Si esta puerta se
// abre, es un agujero de seguridad crítico.
//
// Por qué es SEGURO contra prod y canariable:
//   - Solo ejercita la ruta de RECHAZO: requests sin firma / con firma inválida.
//     El backend los corta en el HMAC ANTES de procesar → cero writes, cero
//     OpenAI, cero WhatsApp enviado, cero efecto. Read-only puro.
//   - Veredicto binario, sin Chromium, sin data sembrada. Pega al deploy REAL.
//   - NO prueba el camino válido (firma buena → 200 → procesa): eso mandaría un
//     WhatsApp real y escribiría en prod. Ese camino lo cubre el E2E en proceso
//     qa-e2e-registro-gasto.mjs.
//
// Exit 0 = la puerta rechaza todo lo forjado. Exit 1 = GATE ROTO (prod aceptó un
// webhook sin firma o mal firmado → agujero de seguridad). Exit 2 = infra (red,
// 5xx, timeout): no se pudo determinar, no necesariamente roto.
//
// Correr:  node qa-e2e/qa-webhook-contract.mjs   (desde app/)

import crypto from 'crypto';

const API = process.env.NETO_API_URL || 'https://api.neto.pe';
const URL = API + '/webhook';

// Body mínimo. Da igual el contenido: se rechaza en el HMAC antes de parsearlo.
const BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

const results = [];
let infra = false;
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
}

// POST con headers arbitrarios. Devuelve el status, o null si la red falló (infra).
async function postRaw(headers) {
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: BODY,
    });
    return r.status;
  } catch (e) {
    console.log('  (infra) fetch falló: ' + String(e).split('\n')[0]);
    infra = true;
    return null;
  }
}

// Un status es "rechazo correcto" si es 403. Un 5xx/red = infra (no concluyente).
// Un 200 con un webhook forjado = GATE ROTO.
function assertRechazo(name, status) {
  if (status === null) return; // infra ya marcado
  if (status >= 500) { infra = true; console.log('  (infra) ' + name + ' devolvió ' + status); return; }
  check(name, status === 403, 'status=' + status + (status === 200 ? ' ← ¡ACEPTÓ UN WEBHOOK FORJADO!' : ''));
}

async function main() {
  // 1) Sin header de firma → 403 (el backend exige X-Hub-Signature-256).
  assertRechazo('rechaza webhook SIN firma', await postRaw({}));

  // 2) Firma con largo inválido → 403 (guarda de longitud antes de timingSafeEqual).
  assertRechazo('rechaza firma de largo inválido', await postRaw({ 'X-Hub-Signature-256': 'sha256=deadbeef' }));

  // 3) Firma bien formada (64 hex) pero con secreto EQUIVOCADO → 403.
  //    Mismo largo que la real → ejercita la comparación de digest, no la de largo.
  const sigFalsa = 'sha256=' + crypto.createHmac('sha256', 'secreto-que-no-es-el-de-meta').update(BODY).digest('hex');
  assertRechazo('rechaza firma con secreto equivocado', await postRaw({ 'X-Hub-Signature-256': sigFalsa }));

  // 4) GET /webhook con verify_token equivocado → 403 (handshake de Meta).
  //    Que un token cualquiera pasara el handshake permitiría re-suscribir el webhook.
  try {
    const r = await fetch(URL + '?hub.mode=subscribe&hub.verify_token=token-equivocado&hub.challenge=123');
    if (r.status >= 500) { infra = true; console.log('  (infra) GET handshake devolvió ' + r.status); }
    else check('rechaza el handshake GET con verify_token equivocado', r.status === 403, 'status=' + r.status);
  } catch (e) {
    infra = true;
    console.log('  (infra) GET handshake falló: ' + String(e).split('\n')[0]);
  }
}

await main();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fallidos.length > 0) {
  console.log(JSON.stringify({ verdict: 'GATE ROTO — prod aceptó un webhook forjado', fallidos: fallidos.map((f) => f.name) }, null, 2));
  process.exit(1);
}
if (infra) {
  console.log(JSON.stringify({ verdict: 'infra — no se pudo determinar (red/5xx)', api: API }, null, 2));
  process.exit(2);
}
console.log(JSON.stringify({ verdict: 'PASS — la puerta rechaza todo lo forjado', api: API }, null, 2));
process.exit(0);
