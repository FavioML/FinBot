// Verificación E2E del fix "Gmail para Pro web-only" (Hueco 4).
//
// Antes: /api/pro/gmail-auth-url para un usuario sin whatsapp generaba un state con
// num='' y sin identidad, así que el callback OAuth devolvía 404 tras el consent.
// Ahora el state lleva `uid` (usuario_id) y el callback resuelve por identidad.
//
// Este harness prueba el lado de GENERACIÓN end-to-end contra prod:
//   - Con el QA Pro user puesto en whatsapp=null (web-only), pide la URL de OAuth
//     autenticado (cookie @supabase/ssr forjada) y afirma que el `state` de la URL
//     lleva uid = usuario_id y num vacío. Restaura el whatsapp al terminar.
// El OAuth real contra Google no es automatizable; la resolución del callback queda
// cubierta por el unit test tests/gmail-oauth-state.test.js.
//
// Usage: node qa-gmail-webonly.mjs   (necesita SUPABASE_SERVICE_ROLE_KEY para el toggle)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clienteGuardado } from './lib/qa-guard.mjs';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
function loadEnv(path) { const e = {}; try { for (const l of readFileSync(path, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {} return e; }

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const webEnv = loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SUPA = env.NETO_QA_URL, ANON = env.NETO_QA_ANON, EMAIL = env.NETO_QA_EMAIL, PASSWORD = env.NETO_QA_PASSWORD;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || webEnv.SUPABASE_SERVICE_ROLE_KEY;
const USUARIO_ID = env.NETO_QA_USUARIO_ID || 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
if (!SUPA || !ANON || !EMAIL || !PASSWORD || !SERVICE) { console.error('Faltan creds/service en qa.env / webapp/.env.local'); process.exit(2); }

const db = clienteGuardado(SUPA, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l}`); } };

// leer payload del state SIN validar firma (solo inspección de contenido)
function leerState(url) {
  const state = new URL(url).searchParams.get('state');
  if (!state) return null;
  const payload = state.slice(0, state.lastIndexOf('.'));
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}

// cookie SSR forjada (password grant), mismo patrón que los otros harness web
async function cookieHeader() {
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!grant.ok) throw new Error('password grant ' + grant.status);
  const session = await grant.json();
  const ref = new URL(SUPA).hostname.split('.')[0];
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180, name = `sb-${ref}-auth-token`;
  const parts = value.length <= MAX ? [[name, value]] : [];
  if (!parts.length) for (let i = 0, p = 0; p < value.length; i++, p += MAX) parts.push([`${name}.${i}`, value.slice(p, p + MAX)]);
  return parts.map(([n, v]) => `${n}=${v}`).join('; ');
}

let originalWhatsapp;
try {
  const { data: before } = await db.from('usuarios').select('whatsapp').eq('id', USUARIO_ID).single();
  originalWhatsapp = before?.whatsapp ?? null;
  console.log(`[QA-GMAIL-WEBONLY] usuario ${USUARIO_ID} whatsapp original: ${JSON.stringify(originalWhatsapp)}`);

  // simular web-only
  await db.from('usuarios').update({ whatsapp: null }).eq('id', USUARIO_ID);

  const cookie = await cookieHeader();
  const res = await fetch(`${APP}/api/pro/gmail-auth-url`, { headers: { cookie } });
  const json = await res.json().catch(() => ({}));
  ok(res.status === 200, `GET /api/pro/gmail-auth-url -> 200 (got ${res.status})`);
  ok(!!json.url, 'devuelve una url de OAuth');

  const st = json.url ? leerState(json.url) : null;
  ok(!!st, 'la url trae un state decodificable');
  ok(st?.uid === USUARIO_ID, `el state lleva uid = usuario_id (got ${JSON.stringify(st?.uid)})`);
  ok(st?.num === '' , `num vacío para web-only (got ${JSON.stringify(st?.num)})`);
  ok(st?.origen === 'web', "origen 'web'");
} catch (e) {
  console.error('[QA-GMAIL-WEBONLY] error:', e.message);
  fail++;
} finally {
  // restaurar SIEMPRE el whatsapp original
  if (originalWhatsapp !== undefined) {
    await db.from('usuarios').update({ whatsapp: originalWhatsapp }).eq('id', USUARIO_ID);
    console.log(`[QA-GMAIL-WEBONLY] whatsapp restaurado a ${JSON.stringify(originalWhatsapp)}`);
  }
}

console.log(`\n[QA-GMAIL-WEBONLY] Resultado: ${pass} ok, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
