// Adversarial E2E sweep for /dashboard + /dashboard/transacciones on app.neto.pe.
// Runs for BOTH plans: `node qa-sweep.mjs pro` and `node qa-sweep.mjs free`.
// Captures console errors and all 4xx/5xx responses while exercising the real
// overview + transacciones interactions. Neutralizes onboarding overlays via
// addInitScript so clicks are not intercepted.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cerrar } from './lib/veredicto.mjs';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const PLAN = (process.argv[2] || 'pro').toLowerCase();
const P = PLAN === 'free' ? 'NETO_QA_FREE_' : 'NETO_QA_';

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env[P + 'URL'] || env.NETO_QA_URL; // Supabase URL shared
const ANON = env[P + 'ANON'] || env.NETO_QA_ANON;
const EMAIL = env[P + 'EMAIL'];
const PASSWORD = env[P + 'PASSWORD'] || env.NETO_QA_PASSWORD;
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;

if (!SUPA || !ANON || !EMAIL || !PASSWORD) {
  console.error(`Missing ${P}* creds in ~/.config/neto/qa.env`);
  process.exit(2);
}

const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!grant.ok) { console.error('Password grant failed:', grant.status, await grant.text()); process.exit(2); }
const session = await grant.json();

const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180;
const domain = new URL(APP).hostname;
const cookies = [];
if (value.length <= MAX) cookies.push({ name: cookieName, value });
else for (let i = 0, p = 0; p < value.length; i++, p += MAX) cookies.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
const toAdd = cookies.map((c) => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies(toAdd);
// Neutralize overlays BEFORE any page load.
await context.addInitScript(() => {
  try {
    localStorage.setItem('neto_tour_v2', 'true');
    localStorage.setItem('neto_welcome_seen', '1');
  } catch {}
});
const page = await context.newPage();

const consoleErrors = [];
const failed = [];
const apiCalls = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 300)));
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/')) apiCalls.push(`${r.status()} ${r.request().method()} ${u.replace(APP, '')}`);
  if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${u.replace(APP, '')}`);
});

const log = (...a) => console.log(...a);
const R = {};

async function settle(ms = 1500) { await page.waitForTimeout(ms); }
async function waitData() {
  await page.getByText(/S\/\s*[\d.,]+/).first().waitFor({ timeout: 20000 }).catch(() => {});
}

// ============ DASHBOARD ============
await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
await waitData();
await settle(2500);
R.dashUrl = page.url();

// Overlay still intercepting?
R.overlayPresent = await page.locator('.fixed.inset-0.z-50').count();

// Toggle to Anual
const anualTab = page.getByRole('tab', { name: /Total anual|^Anual$/ }).first();
R.anualTabFound = await anualTab.isVisible().catch(() => false);
if (R.anualTabFound) { await anualTab.click().catch(() => {}); await settle(1200); }
R.afterAnualHasYearSelect = await page.locator('button[role="combobox"]').first().isVisible().catch(() => false);
// Back to Mensual
const mensualTab = page.getByRole('tab', { name: /^Mensual$/ }).first();
if (await mensualTab.isVisible().catch(() => false)) { await mensualTab.click().catch(() => {}); await settle(1000); }

// Click first category donut legend → dialog
const legend = page.locator('text=Gastos por Categoria').first();
R.donutFound = await legend.isVisible().catch(() => false);
// Click a legend row (categoria) — pick the first legend item after the title
let dialogOpened = false;
try {
  // legend items are siblings; click the first colored-dot row text
  const firstCat = page.locator('div').filter({ hasText: /^\S+ .+\d+\.\d%$/ }).first();
  await page.locator('h3:has-text("Gastos por Categoria")').scrollIntoViewIfNeeded().catch(() => {});
  await settle(400);
  // Click by legend clickable area: category names appear with % — use a robust approach:
  const catRow = page.locator('.cursor-pointer', { hasText: '%' }).first();
  await catRow.click({ timeout: 4000 });
  await settle(700);
  dialogOpened = await page.getByRole('dialog').isVisible().catch(() => false);
} catch (e) { R.donutClickErr = String(e).split('\n')[0]; }
R.categoryDialogOpened = dialogOpened;
if (dialogOpened) {
  R.dialogHasTx = await page.getByRole('dialog').getByText(/transacci/).first().isVisible().catch(() => false);
  await page.keyboard.press('Escape').catch(() => {});
  await settle(500);
}

// "Ver todas" recurrentes present?
R.recurringVerTodos = await page.getByText(/Ver todos \(\d+\)/).first().isVisible().catch(() => false);
R.recurringCard = await page.getByText('Pagos recurrentes').first().isVisible().catch(() => false);

// InsightCard / advice — is /api/advice called for this plan?
R.adviceCalls = apiCalls.filter((c) => c.includes('/api/advice'));

R.dashConsoleErrors = [...consoleErrors];
R.dashFailed = [...failed];

// ============ TRANSACCIONES ============
consoleErrors.length = 0; failed.length = 0;
await page.goto(`${APP}/dashboard/transacciones`, { waitUntil: 'domcontentloaded' });
await page.getByText('Transacciones').first().waitFor({ timeout: 15000 }).catch(() => {});
await settle(2500);

// Wait for first row
const firstRow = page.locator('table tbody tr').first();
R.tableRows = await page.locator('table tbody tr').count().catch(() => 0);

// Summary count baseline
async function summaryCount() {
  const txt = await page.getByText('Transacciones', { exact: true }).locator('xpath=following::span[1]').first().innerText().catch(() => '');
  return txt.trim();
}

// Search test — type a merchant substring, verify row count shrinks/matches
const searchBox = page.getByPlaceholder(/Buscar/i).first();
R.searchFound = await searchBox.isVisible().catch(() => false);
if (R.searchFound) {
  await searchBox.fill('zzznotreal_xyz');
  await settle(900);
  R.searchNoResultRows = await page.locator('table tbody tr').count().catch(() => -1);
  R.searchEmptyState = await page.getByText(/Sin resultados/i).first().isVisible().catch(() => false);
  await searchBox.fill('');
  await settle(700);
}

// Por revisar banner
R.porRevisarBanner = await page.getByText(/por revisar/i).first().isVisible().catch(() => false);

// Bulk edit: select-all header checkbox → bar appears → open editar panel
let bulkBarShown = false, bulkPanelShown = false;
try {
  const headerCb = page.locator('table thead input[type="checkbox"]').first();
  if (await headerCb.isVisible().catch(() => false)) {
    await headerCb.check({ timeout: 3000 }).catch(() => {});
    await settle(500);
    bulkBarShown = await page.getByText(/seleccionada/).first().isVisible().catch(() => false);
    const editarBtn = page.getByRole('button', { name: /^Editar$/ }).first();
    if (await editarBtn.isVisible().catch(() => false)) {
      await editarBtn.click().catch(() => {});
      await settle(500);
      bulkPanelShown = await page.getByText(/Solo se actualizan los campos/).first().isVisible().catch(() => false);
    }
    // Cancel
    await page.getByRole('button', { name: /^Cancelar$/ }).first().click().catch(() => {});
  }
} catch (e) { R.bulkErr = String(e).split('\n')[0]; }
R.bulkBarShown = bulkBarShown;
R.bulkPanelShown = bulkPanelShown;

R.txConsoleErrors = [...consoleErrors];
R.txFailed = [...failed];
R.allApiSample = apiCalls.slice(-25);

log(`\n==== SWEEP ${PLAN.toUpperCase()} ====`);

// ── Veredicto ───────────────────────────────────────────────────────────────
// Las dos mitades se juzgan por separado porque fallan por motivos distintos, y sobre todo
// porque la de transacciones tiene una precondición de DATOS: sin filas en la tabla, sus
// flags valen `false` por vacío y no por regresión. Antes eso salía 0 igual y el JSON
// mostraba `tableRows: 0, searchFound: false` como si fuera un pase.
const fallas = [];
let medidos = 0;
let inconcluso = null;

const afirmar = (ok, msg) => { medidos++; if (!ok) fallas.push(msg); };

// Mitad dashboard: no depende de datos sembrados.
afirmar(R.overlayPresent === 0, `quedaron ${R.overlayPresent} overlays de onboarding tapando la vista`);
afirmar(R.anualTabFound === true, 'no se encontró la pestaña Anual');
afirmar(R.afterAnualHasYearSelect === true, 'la pestaña Anual no muestra el selector de año');
afirmar(R.donutFound === true, 'no se encontró el donut de categorías');
afirmar(R.categoryDialogOpened === true, 'el diálogo de categoría no abre al clickear el donut');
afirmar(R.dialogHasTx === true, 'el diálogo de categoría abre VACÍO (sin transacciones dentro)');
afirmar(R.recurringCard === true, 'no se encontró la tarjeta de Pagos Recurrentes');
afirmar(R.recurringVerTodos === true, 'la tarjeta de recurrentes no ofrece "Ver todos"');
afirmar(R.dashConsoleErrors.length === 0, `${R.dashConsoleErrors.length} errores de consola en /dashboard: ${R.dashConsoleErrors.slice(0,3).join(' | ')}`);
afirmar(R.dashFailed.length === 0, `${R.dashFailed.length} respuestas 4xx/5xx en /dashboard: ${R.dashFailed.slice(0,3).join(' | ')}`);

// Mitad transacciones: los errores de red y consola se afirman SIEMPRE (no dependen de que
// haya filas), los flags de interacción solo si la tabla trajo algo.
afirmar(R.txConsoleErrors.length === 0, `${R.txConsoleErrors.length} errores de consola en /transacciones: ${R.txConsoleErrors.slice(0,3).join(' | ')}`);
afirmar(R.txFailed.length === 0, `${R.txFailed.length} respuestas 4xx/5xx en /transacciones: ${R.txFailed.slice(0,3).join(' | ')}`);

if (R.tableRows > 0) {
  afirmar(R.searchFound === true, 'no se encontró el buscador de transacciones');
  afirmar(R.bulkBarShown === true, 'seleccionar filas no muestra la barra de acciones en lote');
  afirmar(R.bulkPanelShown === true, 'el panel de edición en lote no abre');
} else {
  // No es falla: sin filas esos tres flags son `false` por construcción.
  inconcluso = `la tabla de /dashboard/transacciones vino con 0 filas para el plan ${PLAN}, así que ` +
    'las afirmaciones de búsqueda y edición en lote no se pudieron evaluar (sus flags salen `false` ' +
    'por vacío, no por regresión). Verificá que el usuario QA de ese plan tenga transacciones';
}

log(JSON.stringify(R, null, 2));
cerrar({ nombre: `SWEEP ${PLAN.toUpperCase()}`, fallas, medidos, inconcluso });

await browser.close();
