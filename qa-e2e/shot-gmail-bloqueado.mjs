// Screenshot de /dashboard/pro EN TRIAL: las tarjetas de bancos y Gmail bloqueadas.
// Pone al usuario QA free en trial, captura, y restaura. Mismo mecanismo que los otros shot-*.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clienteGuardado } from './lib/qa-guard.mjs';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
function loadEnv(p) { const e = {}; try { for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {} return e; }

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const webEnv = loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SUPA = env.NETO_QA_URL, ANON = env.NETO_QA_ANON;
const EMAIL = env.NETO_QA_FREE_EMAIL, PASSWORD = env.NETO_QA_FREE_PASSWORD;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || webEnv.SUPABASE_SERVICE_ROLE_KEY;
const USUARIO_ID = env.NETO_QA_FREE_USUARIO_ID;
const db = clienteGuardado(SUPA, SERVICE, { auth: { persistSession: false } });

const hoy = new Date();
const en9dias = new Date(hoy.getTime() + 9 * 864e5).toISOString().slice(0, 10);

const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;
const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const session = await grant.json();
const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180, domain = new URL(APP).hostname, parts = [];
if (value.length <= MAX) parts.push({ name: cookieName, value }); else for (let i = 0, p = 0; p < value.length; i++, p += MAX) parts.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
const toAdd = parts.map((c) => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));

let original;
try {
  const { data: before } = await db.from('usuarios')
    .select('plan, trial_estado, trial_vence, premium_vence').eq('id', USUARIO_ID).single();
  original = before;
  await db.from('usuarios').update({
    plan: 'premium', trial_estado: 'activo', trial_vence: en9dias, premium_vence: null,
  }).eq('id', USUARIO_ID);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => { try { localStorage.setItem('neto_welcome_seen', '1'); localStorage.setItem('neto_tour_v2', 'done'); } catch (e) {} });
  await context.addCookies(toAdd);
  const page = await context.newPage();
  await page.goto(`${APP}/dashboard/pro`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'qa-e2e/out-gmail-bloqueado-trial.png', fullPage: true });
  console.log('captura: qa-e2e/out-gmail-bloqueado-trial.png');

  const txt = await page.locator('body').innerText();
  for (const frase of ['Vuélvete Pro para activar esta función beta', 'Se activa con Pro pagado']) {
    console.log((txt.includes(frase) ? 'PASS ' : 'FAIL ') + 'copy visible: "' + frase + '"');
  }
  await browser.close();
} finally {
  if (original) await db.from('usuarios').update(original).eq('id', USUARIO_ID);
  console.log('usuario QA restaurado');
}
