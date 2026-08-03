// E2E — la app distingue "Gmail conectado" de "conectado pero con el token muerto".
//
// El bug que cierra: cuando Google revoca el refresh token, la fila de `gmail_cuentas` queda
// en `activa = true`, así que `/api/pro/status` decía `gmailConectado: true` y la tarjeta de
// /dashboard/pro afirmaba "Gmail conectado ✓" mientras no se leía un solo correo. El único
// aviso vivía en un throttle en memoria que un redeploy borra.
//
// Se ejercitan las DOS superficies que consumen el estado, contra producción:
//   · `/api/pro/status`  → alimenta la tarjeta de /dashboard/pro
//   · `/api/dashboard`   → alimenta el banner del shell (viaja en el bootstrap consolidado)
//
// No toca ninguna cuenta de Gmail real ni habla con Google: siembra una fila de
// `gmail_cuentas` para el usuario QA, le mueve `auth_error_at`, y la borra. NO gasta cupo —
// el cupo se consume cuando alguien aprueba en la pantalla de Google, no al escribir una fila.
// El check final afirma que `gmail_cuentas` queda exactamente como estaba.
//
// Correr:  node qa-e2e/qa-gmail-estado-reconexion.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

const APP = 'https://app.neto.pe';
const EMAIL_QA = 'qa-estado-' + Date.now() + '@example.test';

// `guardarTokens` cifra los tokens antes de escribirlos y la clave real vive en Railway, no en
// el .env local. Se usa una de prueba: lo único que se escribe con ella es la fila throwaway
// que este harness borra al final, y la limpieza de `auth_error_at` —que es lo que se está
// verificando— no depende del cifrado.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a1'.repeat(32);

/** Mismo instante, aunque Postgres lo devuelva con +00:00 y JS con Z. */
const mismoInstante = (a, b) => !!a && !!b && new Date(a).getTime() === new Date(b).getTime();

function loadEnv(p) {
  try {
    const env = {};
    for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    return env;
  } catch { return {}; }
}
const qaEnv = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));

/** Cookie de sesión de Supabase, forjada desde un password grant (mismo patrón que los demás). */
async function loginQA() {
  const { NETO_QA_URL: SUPA, NETO_QA_ANON: ANON, NETO_QA_EMAIL: email, NETO_QA_PASSWORD: password } = qaEnv;
  if (!SUPA || !ANON || !email || !password) throw new Error('faltan credenciales QA en ~/.config/neto/qa.env');
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!grant.ok) throw new Error('password grant falló: ' + grant.status);
  const value = 'base64-' + Buffer.from(JSON.stringify(await grant.json()), 'utf8').toString('base64url');
  const name = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;
  const MAX = 3180;
  if (value.length <= MAX) return `${name}=${value}`;
  const pares = [];
  for (let i = 0, p = 0; p < value.length; i++, p += MAX) pares.push(`${name}.${i}=${value.slice(p, p + MAX)}`);
  return pares.join('; ');
}

const results = [];
function check(nombre, ok, detalle = '') {
  results.push({ nombre, ok });
  console.log((ok ? '  OK   ' : '  FALLA') + '  ' + nombre + (detalle ? '  [' + detalle + ']' : ''));
}

let cookie = null;
async function get(ruta) {
  const r = await fetch(APP + ruta, { headers: { cookie }, cache: 'no-store' });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}

let filaQA = null;

async function main() {
  cookie = await loginQA();
  const qaId = qaEnv.NETO_QA_USUARIO_ID;
  if (!qaId) throw new Error('falta NETO_QA_USUARIO_ID');

  // Barrido previo: una corrida que murió de golpe (Ctrl-C, kill) no ejecutó su `finally` y
  // dejó su fila. `gmail_cuentas` es el marcador de cupos — una sobra ahí lo hace mentir.
  const { data: sobrasPrevias } = await supabase.from('gmail_cuentas').select('id, email').eq('usuario_id', qaId);
  for (const f of sobrasPrevias || []) {
    console.log('  (limpiando sobra de una corrida anterior: ' + f.email + ')');
    await supabase.from('gmail_cuentas').delete().eq('id', f.id);
  }

  const { count: baseline } = await supabase.from('gmail_cuentas').select('id', { count: 'exact', head: true });
  console.log('  baseline gmail_cuentas: ' + baseline + ' filas\n');

  const { data: creada, error } = await supabase.from('gmail_cuentas')
    .insert({ usuario_id: qaId, email: EMAIL_QA, activa: true }).select('id').single();
  if (error) throw new Error('no se pudo sembrar la cuenta QA: ' + error.message);
  filaQA = creada.id;

  // ── Estado SANO ─────────────────────────────────────────────────────────────
  const sano = await get('/api/pro/status');
  check('/api/pro/status responde', sano.status === 200, 'status=' + sano.status);
  check('cuenta sana: conectado', sano.body?.gmailConectado === true);
  check('cuenta sana: NO necesita reconexión', sano.body?.gmailNecesitaReconexion === false,
    'valor=' + JSON.stringify(sano.body?.gmailNecesitaReconexion));
  check('el campo existe en la respuesta (si es undefined, el deploy es viejo)',
    sano.body && 'gmailNecesitaReconexion' in sano.body);

  const bootSano = await get('/api/dashboard');
  check('/api/dashboard trae el bloque gmail', bootSano.body && 'gmail' in bootSano.body);
  check('cuenta sana: el bootstrap no marca nada', bootSano.body?.gmail?.authErrorAt === null,
    'valor=' + JSON.stringify(bootSano.body?.gmail?.authErrorAt));

  // ── Estado CAÍDO ────────────────────────────────────────────────────────────
  const marca = new Date().toISOString();
  await supabase.from('gmail_cuentas').update({ auth_error_at: marca }).eq('id', filaQA);

  const caido = await get('/api/pro/status');
  check('token muerto: SIGUE conectado (activa=true protege el login_hint y el cupo)',
    caido.body?.gmailConectado === true);
  check('token muerto: Y necesita reconexión — los dos a la vez', caido.body?.gmailNecesitaReconexion === true);
  check('token muerto: se expone DESDE CUÁNDO, para poder decirlo en el copy',
    mismoInstante(caido.body?.gmailAuthErrorAt, marca), 'valor=' + caido.body?.gmailAuthErrorAt);

  const bootCaido = await get('/api/dashboard');
  check('el banner del shell recibe el estado por el bootstrap, sin fetch aparte',
    mismoInstante(bootCaido.body?.gmail?.authErrorAt, marca), 'valor=' + bootCaido.body?.gmail?.authErrorAt);

  // ── Reconectar limpia ───────────────────────────────────────────────────────
  // No se llama al OAuth real (gastaría cupo): se ejercita `guardarTokens`, que es la pieza
  // que toda conexión exitosa atraviesa y la única que limpia la marca.
  const { guardarTokens } = require(path.join(appRoot, 'gmail.js'));
  await guardarTokens(qaId, { access_token: 'qa-at', refresh_token: 'qa-rt', expiry_date: Date.now() + 3600_000 }, EMAIL_QA);

  const reconectado = await get('/api/pro/status');
  check('reconectar borra la marca: la cuenta vuelve a estar sana',
    reconectado.body?.gmailNecesitaReconexion === false && reconectado.body?.gmailConectado === true,
    'necesita=' + reconectado.body?.gmailNecesitaReconexion);
}

main()
  .catch((e) => { console.error('\nEXPLOTÓ: ' + e.message); results.push({ nombre: 'el harness terminó', ok: false }); })
  .finally(async () => {
    if (filaQA) {
      const { error } = await supabase.from('gmail_cuentas').delete().eq('id', filaQA);
      if (error) console.error('OJO: quedó la fila sembrada ' + filaQA + ': ' + error.message);
    }
    // guardarTokens también escribe los campos legacy en `usuarios`; devolverlos a null.
    const qaId = qaEnv.NETO_QA_USUARIO_ID;
    if (qaId) {
      await supabase.from('usuarios')
        .update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null })
        .eq('id', qaId);
    }
    const { count: final } = await supabase.from('gmail_cuentas').select('id', { count: 'exact', head: true });
    const { data: sobras } = await supabase.from('gmail_cuentas').select('id').eq('usuario_id', qaId);
    check('gmail_cuentas queda como estaba: la verificación no quema un cupo',
      (sobras || []).length === 0, 'filas totales=' + final);

    const ok = results.filter((r) => r.ok).length;
    console.log('\n' + ok + '/' + results.length + ' checks');
    process.exit(ok === results.length ? 0 : 1);
  });
