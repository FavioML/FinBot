// Verifica el gate SERVER-SIDE del tour de onboarding (1 vez por CUENTA, no por navegador).
//
// Escenario:
//   1) Reset: usuarios.tour_visto = false para el QA Free.
//   2) Contexto A (navegador fresco, localStorage vacío): el tour DEBE aparecer. Se cierra
//      (clic en el backdrop → handleComplete) → dispara POST /api/user/tour-visto.
//   3) Se confirma que tour_visto pasó a true en la DB.
//   4) Contexto B (OTRO navegador fresco, localStorage vacío otra vez): el tour NO debe
//      aparecer — lo suprime el flag de la cuenta, no el localStorage. Eso es lo que prueba
//      que el gate es por cuenta y no por navegador.
//   5) Cleanup: tour_visto = false.
//
// Uso: node qa-tour-gate.mjs

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clienteGuardado } from './lib/qa-guard.mjs';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = env.NETO_QA_FREE_EMAIL;
const PASSWORD = env.NETO_QA_FREE_PASSWORD;
const USER_ID = env.NETO_QA_FREE_USUARIO_ID;
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;

if (!SUPA || !ANON || !EMAIL || !PASSWORD || !SERVICE || !USER_ID) {
  console.error('Faltan creds FREE / service-role en qa.env');
  process.exit(2);
}

const db = clienteGuardado(SUPA, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const okp = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l}`); } };

async function setTour(v) {
  const { error } = await db.from('usuarios').update({ tour_visto: v }).eq('id', USER_ID);
  if (error) throw new Error('setTour: ' + error.message);
}
async function getTour() {
  const { data } = await db.from('usuarios').select('tour_visto').eq('id', USER_ID).single();
  return data?.tour_visto;
}

// Cookies @supabase/ssr forjadas (misma técnica que qa-login.mjs).
const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!grant.ok) { console.error('password grant:', grant.status); process.exit(2); }
const session = await grant.json();
const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180;
const domain = new URL(APP).hostname;
const raw = [];
if (value.length <= MAX) raw.push({ name: cookieName, value });
else for (let i = 0, p = 0; p < value.length; i++, p += MAX) raw.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
const toAdd = raw.map((c) => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));

const TOUR_TEXT = /Registra tus gastos e ingresos/i;
async function freshContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addCookies(toAdd);
  return context;
}

let browser;
try {
  await setTour(false);
  console.log('[QA-TOUR] reset: tour_visto=false');
  browser = await chromium.launch();

  // --- Contexto A: tour_visto=false + localStorage vacío → el tour aparece ---
  console.log('\n[QA-TOUR] A) navegador fresco, cuenta sin ver el tour');
  const ctxA = await freshContext(browser);
  const pageA = await ctxA.newPage();
  await pageA.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
  const aparece = await pageA.getByText(TOUR_TEXT).first().waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
  okp(aparece, 'el tour aparece la primera vez');

  // Cerrarlo por el backdrop (handleComplete) y esperar el POST.
  const postPromise = pageA.waitForResponse((r) => r.url().includes('/api/user/tour-visto') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null);
  await pageA.mouse.click(20, 20); // backdrop, fuera de la card centrada
  const post = await postPromise;
  okp(!!post && post.status() === 200, `POST /api/user/tour-visto → ${post ? post.status() : 'sin respuesta'}`);
  await ctxA.close();

  // Confirmar persistencia en la cuenta.
  let persistido = false;
  for (let i = 0; i < 10 && !persistido; i++) { persistido = (await getTour()) === true; if (!persistido) await new Promise((r) => setTimeout(r, 400)); }
  okp(persistido, 'tour_visto=true persistido en la cuenta');

  // --- Contexto B: OTRO navegador fresco (localStorage vacío) → NO aparece ---
  console.log('\n[QA-TOUR] B) OTRO navegador fresco (localStorage vacío): NO debe aparecer');
  const ctxB = await freshContext(browser);
  const pageB = await ctxB.newPage();
  await pageB.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
  // Esperar más que el delay de 1.5s del tour para asegurar que NO se dispare.
  await pageB.waitForTimeout(4000);
  const reaparece = await pageB.getByText(TOUR_TEXT).first().isVisible().catch(() => false);
  okp(!reaparece, 'el tour NO reaparece en otro navegador (gate por cuenta, no por localStorage)');
  await ctxB.close();
} catch (e) {
  console.error('[QA-TOUR] error:', e.message);
  fail++;
} finally {
  if (browser) await browser.close();
  await setTour(false); // dejar el QA Free listo para futuras corridas
  console.log(`\n[QA-TOUR] Resultado: ${pass} ok, ${fail} fallos`);
  process.exit(fail === 0 ? 0 : 1);
}
