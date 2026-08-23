// Adversarial E2E sweep for the PLANNING flows on app.neto.pe:
//   /dashboard/presupuestos, /dashboard/planes, /dashboard/deudas
// Runs for BOTH plans: `node qa-planning-sweep.mjs pro` and `node qa-planning-sweep.mjs free`.
//
// Two layers:
//  A) UI layer — navigates each page, captures console errors + 4xx/5xx, checks
//     key elements render, empty states, Free vs Pro gating. Overlays neutralized.
//  B) API layer — reproduces the goal-completion `status` desync bug on a THROWAWAY
//     goal (created + deleted, zero residue on seeded data), plus checks debt/goal
//     calculations against what the API returns.

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
const SUPA = env[P + 'URL'] || env.NETO_QA_URL;
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
await context.addInitScript(() => {
  try {
    localStorage.setItem('neto_tour_v2', 'true');
    localStorage.setItem('neto_welcome_seen', '1');
  } catch {}
});
const page = await context.newPage();

const consoleErrors = [];
const failed = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 300)));
page.on('response', (r) => {
  const u = r.url();
  if (r.status() >= 400 && (u.includes('/api/') || u.includes('/dashboard'))) failed.push(`${r.status()} ${r.request().method()} ${u.replace(APP, '')}`);
});

const log = (...a) => console.log(...a);
const R = { plan: PLAN, ui: {}, api: {} };
const settle = (ms = 1500) => page.waitForTimeout(ms);

// ---------- helper: authenticated fetch from within the page (uses SSR cookie) ----------
async function apiFetch(path, opts) {
  return page.evaluate(async ({ path, opts }) => {
    const res = await fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  }, { path, opts: opts || {} });
}

// ============ 1. PRESUPUESTOS ============
consoleErrors.length = 0; failed.length = 0;
await page.goto(`${APP}/dashboard/presupuestos`, { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: 'Presupuestos' }).first().waitFor({ timeout: 20000 }).catch(() => {});
await settle(2500);
R.ui.presupuestos = {
  overlay: await page.locator('.fixed.inset-0.z-50').count(),
  summaryCards: await page.getByText(/Total presupuestado/i).first().isVisible().catch(() => false),
  budgetCards: await page.locator('.glass-card').filter({ has: page.locator('svg') }).count().catch(() => 0),
  emptyState: await page.getByText(/Sin presupuestos/i).first().isVisible().catch(() => false),
  excededBanner: await page.getByText(/Excediste tu presupuesto/i).first().isVisible().catch(() => false),
};
// Open a category detail dialog (first budget card)
try {
  const firstCard = page.locator('div.cursor-pointer').filter({ hasText: '%' }).first();
  await firstCard.click({ timeout: 4000 });
  await settle(800);
  R.ui.presupuestos.detailDialogOpened = await page.getByRole('dialog').isVisible().catch(() => false);
  R.ui.presupuestos.detailHasGastadoLimite = await page.getByText(/Gastado \/ Límite/i).first().isVisible().catch(() => false);
  await page.keyboard.press('Escape').catch(() => {});
  await settle(400);
} catch (e) { R.ui.presupuestos.detailErr = String(e).split('\n')[0]; }
R.ui.presupuestos.console = [...consoleErrors];
R.ui.presupuestos.failed = [...failed];

// ============ 2. PLANES ============
consoleErrors.length = 0; failed.length = 0;
await page.goto(`${APP}/dashboard/planes`, { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: /Planes de ahorro/i }).first().waitFor({ timeout: 20000 }).catch(() => {});
await settle(2500);
R.ui.planes = {
  planesActivos: await page.getByText(/Planes activos/i).first().isVisible().catch(() => false),
  completadosSection: await page.getByText(/Planes completados/i).first().isVisible().catch(() => false),
  emptyState: await page.getByText(/Aún no tienes planes/i).first().isVisible().catch(() => false),
  proBadge: await page.getByText(/Pro/).first().isVisible().catch(() => false),
  nuevoBtn: await page.getByRole('button', { name: /Nuevo/i }).first().isVisible().catch(() => false),
};
// Count visible goal cards (cards with a progress % footer)
R.ui.planes.goalCardCount = await page.locator('.glass-card').filter({ hasText: '%' }).count().catch(() => 0);
R.ui.planes.console = [...consoleErrors];
R.ui.planes.failed = [...failed];

// ============ 3. DEUDAS ============
consoleErrors.length = 0; failed.length = 0;
await page.goto(`${APP}/dashboard/deudas`, { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: 'Deudas' }).first().waitFor({ timeout: 20000 }).catch(() => {});
await settle(2500);
R.ui.deudas = {
  loQueDebes: await page.getByText(/Lo que debes/i).first().isVisible().catch(() => false),
  teDeben: await page.getByText(/Te deben/i).first().isVisible().catch(() => false),
  tabs: await page.getByRole('tab').count().catch(() => 0),
};
// Cycle tabs and capture any errors / empty states
for (const tabName of ['Me deben', 'Saldadas', 'Compartidos', 'Lo que debo']) {
  const t = page.getByText(new RegExp(`^${tabName}`, 'i')).first();
  if (await t.isVisible().catch(() => false)) { await t.click().catch(() => {}); await settle(700); }
}
R.ui.deudas.compartidosEmpty = await page.getByText(/Sin gastos compartidos/i).first().isVisible().catch(() => false);
R.ui.deudas.console = [...consoleErrors];
R.ui.deudas.failed = [...failed];

// ============ API LAYER — ground truth + status desync reproduction ============
// Pull goals & debts as the app sees them
const goalsResp = await apiFetch('/api/goals');
const debtsResp = await apiFetch('/api/debts');
R.api.goalsStatus = goalsResp.status;
R.api.debtsStatus = debtsResp.status;

if (Array.isArray(goalsResp.body)) {
  const goals = goalsResp.body;
  // Replicate the page's active/completed split
  const active = goals.filter((g) => (g.status === 'active' || (!g.status && !g.completada)));
  const completed = goals.filter((g) => g.status === 'completed' || (!g.status && g.completada));
  R.api.goalCounts = { total: goals.length, active: active.length, completed: completed.length };
}

// ---- Reproduce the completion desync on a throwaway goal ----
const repro = { steps: [] };
try {
  // 1) create temp goal objetivo=100 actual=0
  const created = await apiFetch('/api/goals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'QA_STATUS_TEST_DELETE_ME', monto_objetivo: 100, monto_actual: 0, icono: '🎯' }),
  });
  const gid = created.body?.id;
  repro.steps.push({ create: created.status, id: gid });
  if (gid) {
    // 2a) PATH A: mark complete via PUT (toggleComplete path)
    await apiFetch('/api/goals', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: gid, nombre: 'QA_STATUS_TEST_DELETE_ME', monto_objetivo: '100', monto_actual: '100', icono: '🎯', fecha_limite: null, completada: true }),
    });
    let after = await apiFetch('/api/goals');
    let g = (after.body || []).find((x) => x.id === gid);
    repro.afterToggleComplete = { completada: g?.completada, status: g?.status,
      shownAsActive: g ? (g.status === 'active' || (!g.status && !g.completada)) : null,
      shownAsCompleted: g ? (g.status === 'completed' || (!g.status && g.completada)) : null };

    // reset via PUT completada:false
    await apiFetch('/api/goals', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: gid, nombre: 'QA_STATUS_TEST_DELETE_ME', monto_objetivo: '100', monto_actual: '0', icono: '🎯', fecha_limite: null, completada: false }),
    });

    // 2b) PATH B: complete via contribution to 100%
    const contrib = await apiFetch('/api/goals/aportes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta_id: gid, monto: 100, tipo: 'aporte' }),
    });
    repro.contribute = { status: contrib.status, milestone: contrib.body?.milestone };
    after = await apiFetch('/api/goals');
    g = (after.body || []).find((x) => x.id === gid);
    repro.afterContribute100 = { completada: g?.completada, status: g?.status,
      shownAsActive: g ? (g.status === 'active' || (!g.status && !g.completada)) : null,
      shownAsCompleted: g ? (g.status === 'completed' || (!g.status && g.completada)) : null };

    // 3) cleanup
    const del = await apiFetch(`/api/goals?id=${gid}`, { method: 'DELETE' });
    repro.steps.push({ delete: del.status });
  }
} catch (e) { repro.err = String(e).split('\n')[0]; }
R.api.statusDesyncRepro = repro;

log(`\n==== PLANNING SWEEP ${PLAN.toUpperCase()} ====`);
log(JSON.stringify(R, null, 2));

// ── Veredicto ───────────────────────────────────────────────────────────────
// Cada ruta trae sus propios `console` y `failed`, así que se afirman por ruta: saber CUÁL
// de las tres se rompió vale más que un contador global.
//
// Los 4xx se filtran por plan: con el usuario en el muro, un 402/403 es el gate funcionando.
const fallas = [];
let medidos = 0;
const afirmar = (ok, msg) => { medidos++; if (!ok) fallas.push(msg); };
// Angosto en DOS formas: la lista de consola trae "Failed to load resource: ... 402" y la de
// respuestas "402 GET /api/x". Un `\b402\b` suelto excusaría un error de JS que lo mencione.
const esperadoPorGating = (l) => PLAN === 'free' &&
  (/Failed to load resource.*\b(402|403)\b/.test(l) || /^\s*(402|403)\s/.test(l));

// El 402 del muro aparece TAMBIÉN como línea de consola ("Failed to load resource ... 402"),
// no solo como respuesta. Filtrar una lista y no la otra dejaba las tres rutas en rojo en
// `free` — medido el 09-ago.
for (const [ruta, d] of Object.entries(R.ui || {})) {
  const cons = (d.console || []).filter((l) => !esperadoPorGating(l));
  const fail = (d.failed || []).filter((f) => !esperadoPorGating(f));
  afirmar(cons.length === 0, `/dashboard/${ruta}: ${cons.length} errores de consola no explicados por el gating — ${cons.slice(0,2).join(' | ')}`);
  afirmar(fail.length === 0, `/dashboard/${ruta}: ${fail.length} respuestas 4xx/5xx no explicadas por el gating — ${fail.slice(0,2).join(' | ')}`);
}

// El invariante de metas: `status` tiene que moverse junto con `completada`. Una meta cumplida
// que sigue contándose como activa es el bug de be62837, y este repro existe para eso; hasta
// hoy calculaba `shownAsActive`/`shownAsCompleted` y no los afirmaba.
const rep = R.api?.statusDesyncRepro;
if (rep && rep.afterContribute100 && rep.afterContribute100.completada !== undefined) {
  afirmar(rep.afterContribute100.shownAsActive === false,
    'una meta COMPLETADA sigue apareciendo entre las activas: `status` se desincronizó de `completada` (ver be62837)');
  afirmar(rep.afterContribute100.shownAsCompleted === true,
    'una meta completada NO aparece entre las completadas');
}

// El `if (gid)` del repro puede saltearse SIN excepción: si `POST /api/goals` responde 4xx,
// `created.body?.id` viene undefined, `repro.err` nunca se setea, y las dos afirmaciones del
// invariante se evaporan mientras las 6 de rutas mantienen la corrida en verde. Un `if` que
// puede vaciar media cobertura necesita su propia rama de inconcluso, no el silencio.
const reproLlego = !!(rep && rep.afterContribute100 && rep.afterContribute100.completada !== undefined);
const inconcluso = Object.keys(R.ui || {}).length === 0
  ? 'no se visitó ninguna de las tres rutas de planeación'
  : (rep && rep.err ? 'el repro del invariante de metas se cayó y no llegó a medir: ' + rep.err
    : (!reproLlego
      ? 'el repro del invariante de metas no llegó a medir: no se pudo crear la meta de prueba '
        + `(create ${JSON.stringify(rep?.steps?.[0] ?? null)}), así que el invariante de be62837 no se vigiló`
      : null));

cerrar({ nombre: `PLANNING-SWEEP ${PLAN.toUpperCase()}`, fallas, medidos, inconcluso });

await browser.close();
