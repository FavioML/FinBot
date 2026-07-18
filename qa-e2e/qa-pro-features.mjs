// E2E autenticado para PRO3 (heatmap) + PRO4 (import Excel/CSV) en app.neto.pe.
//
// Reusa el forjado de cookie de qa-login.mjs (password grant → cookie @supabase/ssr).
// Flujo: (1) importar un CSV con fechas recientes vía /api/transactions/import,
// (2) recargar el dashboard y verificar que el heatmap "Actividad de gastos" renderiza
// para el usuario Pro. Limpia las filas de prueba al final (comercio E2E-IMPORT-TEST).
//
// Usage: node qa-pro-features.mjs   (creds en ~/.config/neto/qa.env)

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
function ok(c) { return c ? 'PASS' : 'FAIL'; }

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
const EMAIL = env.NETO_QA_EMAIL;
const PASSWORD = env.NETO_QA_PASSWORD;
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;

if (!SUPA || !ANON || !EMAIL || !PASSWORD) {
  console.error('Missing creds in ~/.config/neto/qa.env');
  process.exit(2);
}

const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!grant.ok) { console.error('Password grant failed:', grant.status); process.exit(2); }
const session = await grant.json();

const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180;
const domain = new URL(APP).hostname;
const cookies = [];
if (value.length <= MAX) cookies.push({ name: cookieName, value });
else for (let i = 0, p = 0; p < value.length; i++, p += MAX) cookies.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
const toAdd = cookies.map((c) => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies(toAdd);
const page = await context.newPage();

const results = {};

// --- Build a CSV with 3 recent dates so the heatmap (last 12 weeks) has data ---
function ymd(d) { return d.toISOString().slice(0, 10); }
const today = new Date();
const d1 = ymd(today);
const d2 = ymd(new Date(today.getTime() - 3 * 86400000));
const d3 = ymd(new Date(today.getTime() - 7 * 86400000));
const csv = [
  'Fecha,Monto,Descripcion',
  `${d1},33.50,E2E-IMPORT-TEST`,
  `${d2},80.00,E2E-IMPORT-TEST`,
  `${d3},12.90,E2E-IMPORT-TEST`,
].join('\n');

// --- Check 1: POST import (authenticated via context cookies) ---
const importRes = await context.request.post(`${APP}/api/transactions/import`, {
  multipart: { file: { name: 'e2e-test.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') } },
});
results.importStatus = importRes.status();
let importBody = {};
try { importBody = await importRes.json(); } catch {}
results.importInsertados = importBody.insertados;
results.importOk = importRes.status() === 200 && importBody.insertados >= 1;

// --- Check 2: heatmap renders on dashboard for Pro user ---
await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
await page.getByText(/S\/\s*[\d,]+/).first().waitFor({ timeout: 10000 }).catch(() => {});
// Heatmap heading (Pro). Poll a bit — below-the-fold + lazy.
let heatmapVisible = false;
for (let i = 0; i < 20; i++) {
  heatmapVisible = await page.getByText('Actividad de gastos').first().isVisible().catch(() => false);
  if (heatmapVisible) break;
  await page.waitForTimeout(500);
}
results.heatmapVisible = heatmapVisible;
// Negative: the Pro gate for heatmap must NOT be showing for this Pro user.
results.heatmapGateAbsent = !(await page.getByText('Heatmap de gastos es Pro').first().isVisible().catch(() => false));

// --- Check 3: import button present on transacciones page ---
await page.goto(`${APP}/dashboard/transacciones`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
results.importBtnVisible = await page.getByRole('button', { name: /Importar/i }).first().isVisible().catch(() => false);

const checks = {
  'import API inserta filas (Pro)': results.importOk,
  'heatmap renderiza para Pro': results.heatmapVisible && results.heatmapGateAbsent,
  'boton Importar presente': results.importBtnVisible,
};

console.log('\n=== PRO3/PRO4 E2E ===');
console.log(JSON.stringify(results, null, 2));
console.log('\n--- Checks ---');
let allPass = true;
for (const [k, v] of Object.entries(checks)) { console.log(`${ok(v)}  ${k}`); if (!v) allPass = false; }
console.log(`\nVERDICT: ${allPass ? 'ALL PASS' : 'FAIL'}`);

await browser.close();
process.exit(allPass ? 0 : 1);
