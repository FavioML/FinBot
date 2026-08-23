// Adversarial E2E: Espacios gating (Free vs Pro) + Configuracion plan display + join/space + join/gasto.
// Usage: node qa-e2e/qa-espacios-config.mjs   DESDE `app/` — necesita el `.env` del backend
//                                             (usa `lib/db` para leer la precondición del fixture)
//
// Hunts (los cuatro se AFIRMAN; hasta el 22-ago-2026 los hunts 3 y 4 solo se imprimían):
//  (1) El muro de espacios: un Free no puede crear NI UNO. `FREE_LIMITS.spaces = 0` desde el
//      hallazgo M14 — este hunt decía "el límite es 1", que era el freemium muerto de abril.
//  (2) Free can create custom split-rules + shared budgets in a space they own
//      (those are Pro features: espacios_custom_split / espacios_shared_budget).
//      NO ALCANZABLE mientras el hunt 1 valga: sin espacio propio no hay dónde probarlo. Se
//      declara en la salida (`__featuresDeAdentro`) en vez de desaparecer. El sujeto que sí
//      las alcanza es el Free INVITADO a un espacio ajeno, y eso es un harness aparte.
//  (3) Configuracion "Tu plan" card shows the user's REAL plan (not hardcoded Pro).
//  (4) join/space + join/gasto public preview pages render without 500 Y muestran los datos.
// Cleans up every space it creates.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cerrar } from './lib/veredicto.mjs';
import 'dotenv/config';
import { createRequire } from 'module';
import { instalarGuard } from './lib/qa-guard.mjs';
const require = createRequire(import.meta.url);
const supabase = instalarGuard(require, '../lib/db');

const APP = 'https://app.neto.pe';
function loadEnv(path) {
  const env = {};
  for (const l of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2];
  }
  return env;
}
const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));

async function forge(prefix) {
  const SUPA = env[prefix + 'URL'] || env.NETO_QA_URL;
  const ANON = env[prefix + 'ANON'] || env.NETO_QA_ANON;
  const EMAIL = env[prefix + 'EMAIL'];
  const PASSWORD = env[prefix + 'PASSWORD'] || env.NETO_QA_PASSWORD;
  const ref = new URL(SUPA).hostname.split('.')[0];
  const cookieName = `sb-${ref}-auth-token`;
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!grant.ok) throw new Error(`grant ${prefix} ${grant.status}`);
  const session = await grant.json();
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180, domain = new URL(APP).hostname, cookies = [];
  if (value.length <= MAX) cookies.push({ name: cookieName, value });
  else for (let i = 0, p = 0; p < value.length; i++, p += MAX) cookies.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
  return cookies.map((c) => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));
}

const browser = await chromium.launch();
const R = { free: {}, pro: {}, join: {} };

async function makeCtx(prefix) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
  await ctx.addCookies(await forge(prefix));
  await ctx.addInitScript(() => { try { localStorage.setItem('neto_tour_v2', 'true'); localStorage.setItem('neto_welcome_seen', '1'); } catch {} });
  const page = await ctx.newPage();
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const api = (path, opts) => page.evaluate(async ({ path, opts }) => {
    const r = await fetch(path, opts); let b = null; try { b = await r.json(); } catch {}
    return { status: r.status, body: b };
  }, { path, opts: opts || {} });
  return { ctx, page, api };
}

// ================= FREE: espacios gating via API =================
{
  const { ctx, page, api } = await makeCtx('NETO_QA_FREE_');
  const created = [];
  try {
    const list = await api('/api/spaces');
    R.free.isPro = list.body?.isPro;
    R.free.existingSpaces = (list.body?.spaces || []).length;

    // Create space #1
    const s1 = await api('/api/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA_FREE_SPACE_DELETE_1', type: 'custom' }) });
    R.free.create1Status = s1.status;
    const id1 = s1.body?.id; if (id1) created.push(id1);

    // Create space #2 — Free UI blocks a 2nd space; does the API?
    const s2 = await api('/api/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA_FREE_SPACE_DELETE_2', type: 'custom' }) });
    R.free.create2Status = s2.status;
    const id2 = s2.body?.id; if (id2) created.push(id2);
    R.free.secondSpaceAllowed = s2.status === 201; // BUG if true (Free limit = 1)

    // On space #1: try Pro-only features (custom split rule + shared budget)
    if (id1) {
      const uid = env.NETO_QA_FREE_USUARIO_ID || '';
      const rule = { id: `rule-${Date.now()}`, category: 'Alimentación', splits: { [uid]: 100 } };
      const sr = await api(`/api/spaces/${id1}/split-rules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: [rule] }) });
      R.free.splitRuleStatus = sr.status;
      R.free.splitRuleAllowed = sr.status === 200; // BUG if true (Pro feature)

      const budget = { id: `sbud-${Date.now()}`, category: 'Alimentación', limit: 200 };
      const bu = await api(`/api/spaces/${id1}/budgets`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budgets: [budget] }) });
      R.free.budgetStatus = bu.status;
      R.free.budgetAllowed = bu.status === 200; // BUG if true (Pro feature)

      // Confirm persisted + isPro flag on detail
      const det = await api(`/api/spaces/${id1}`);
      R.free.detailIsPro = det.body?.isPro;
      R.free.persistedSplitRules = (det.body?.splitRules || []).length;
      R.free.persistedBudgets = (det.body?.budgets || []).length;
    }

    // ---- Free espacios [id] page: are the Pro sections rendered/usable in UI? ----
    if (id1) {
      await page.goto(`${APP}/dashboard/espacios/${id1}`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Reglas de División').first().waitFor({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      R.free.uiSplitRulesSectionVisible = await page.getByText('Reglas de División').first().isVisible().catch(() => false);
      R.free.uiBudgetsSectionVisible = await page.getByText('Presupuestos Mensuales').first().isVisible().catch(() => false);
      // "Agregar regla" button present & enabled (Free would be using a Pro feature)
      R.free.uiAddRuleBtn = await page.getByRole('button', { name: /Agregar regla/ }).first().isVisible().catch(() => false);
    }
  } catch (e) { R.free.err = String(e).split('\n')[0]; }

  // ---- Configuracion plan display for Free ----
  try {
    await page.goto(`${APP}/dashboard/configuracion`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Tu plan').first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    // Badge next to name
    R.free.cfgBadgeFree = await page.getByText('Free', { exact: true }).first().isVisible().catch(() => false);
    R.free.cfgBadgeProNeto = await page.getByText('Neto Pro', { exact: true }).first().isVisible().catch(() => false);
    // "Plan actual" row value
    const planActualVal = await page.locator('span:has-text("Plan actual")').locator('xpath=following-sibling::span[1]').first().innerText().catch(() => '');
    R.free.cfgPlanActualText = planActualVal.trim();
    // Feature table: does the "Consejo IA" row show the premium value for a Free user?
    const consejoRow = await page.locator('tr:has-text("Consejo IA")').first().innerText().catch(() => '');
    R.free.cfgConsejoIARow = consejoRow.replace(/\s+/g, ' ').trim();
    const reportesRow = await page.locator('tr:has-text("Reportes PDF")').first().innerText().catch(() => '');
    R.free.cfgReportesRow = reportesRow.replace(/\s+/g, ' ').trim();
  } catch (e) { R.free.cfgErr = String(e).split('\n')[0]; }

  // Cleanup
  R.free.cleanup = [];
  for (const id of created) {
    const del = await api(`/api/spaces/${id}`, { method: 'DELETE' });
    R.free.cleanup.push(`${id.slice(0, 8)}:${del.status}`);
  }
  await ctx.close();
}

// ================= PRO: baseline + create invite for join test =================
let proInviteCode = null;
{
  const { ctx, page, api } = await makeCtx('NETO_QA_');
  try {
    const s = await api('/api/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA_PRO_JOIN_DELETE', type: 'custom' }) });
    R.pro.createStatus = s.status;
    const id = s.body?.id;
    if (id) {
      const inv = await api('/api/spaces/invite?code=' + (s.body?.invite_code || ''));
      // fetch space detail to read invite_code
      const det = await api(`/api/spaces/${id}`);
      proInviteCode = det.body?.space?.invite_code;
      R.pro.inviteCode = proInviteCode ? 'present' : 'missing';
      R.pro.spaceId = id;
      R.pro.__deleteId = id;
    }
    // Config page for Pro
    await page.goto(`${APP}/dashboard/configuracion`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Tu plan').first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const planActualVal = await page.locator('span:has-text("Plan actual")').locator('xpath=following-sibling::span[1]').first().innerText().catch(() => '');
    R.pro.cfgPlanActualText = planActualVal.trim();
    R.pro.cfgBadgeProNeto = await page.getByText('Neto Pro', { exact: true }).first().isVisible().catch(() => false);
  } catch (e) { R.pro.err = String(e).split('\n')[0]; }
  // keep ctx open for cleanup after join test
  R.pro.__ctx = ctx; R.pro.__api = api;
}

// ================= JOIN pages (cookieless guest) =================
{
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  const errs = [];
  guest.on('response', (r) => { if (r.status() >= 500 && r.url().includes(new URL(APP).hostname)) errs.push(`5xx ${r.url().replace(APP, '')}`); });

  // join/space with the real Pro invite
  if (proInviteCode) {
    await guest.goto(`${APP}/join/space/${proInviteCode}`, { waitUntil: 'domcontentloaded' });
    await guest.waitForTimeout(2500);
    R.join.spaceRealShowsName = await guest.getByText('QA_PRO_JOIN_DELETE').first().isVisible().catch(() => false);
    R.join.spaceRealBody = (await guest.locator('body').innerText().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
    R.join.spaceRealJoinBtn = await guest.getByRole('button', { name: /Unirme al espacio/ }).first().isVisible().catch(() => false);
  }
  // join/space with a bogus code → graceful invalid, no 500
  await guest.goto(`${APP}/join/space/BOGUSXYZ`, { waitUntil: 'domcontentloaded' });
  await guest.waitForTimeout(2000);
  R.join.spaceBogusInvalid = await guest.getByText(/Invitación no válida|inválido o expirado/).first().isVisible().catch(() => false);
  // join/gasto with a bogus code → graceful invalid, no 500
  await guest.goto(`${APP}/join/gasto/BOGUSXYZ`, { waitUntil: 'domcontentloaded' });
  await guest.waitForTimeout(2000);
  R.join.gastoBogusInvalid = await guest.getByText(/invalida o expirada|inválida/).first().isVisible().catch(() => false);
  R.join.gastoBogusBody = (await guest.locator('body').innerText().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');

  R.join.guest5xx = errs;
  await guestCtx.close();
}

// Cleanup Pro space
try {
  if (R.pro.__deleteId) {
    const del = await R.pro.__api(`/api/spaces/${R.pro.__deleteId}`, { method: 'DELETE' });
    R.pro.cleanup = del.status;
  }
  await R.pro.__ctx.close();
} catch (e) { R.pro.cleanupErr = String(e).split('\n')[0]; }

delete R.pro.__ctx; delete R.pro.__api; delete R.pro.__deleteId;

// ── Precondición: el "QA Free" tiene que estar DE VERDAD en el muro ──────────
// Mismo caso que qa-espacios-gating-verify, y por eso la comprobación es la misma: el trial
// arranca con el primer gasto, así que cualquier harness que le registre uno a este usuario
// lo deja en `plan='premium'` por 14 días. Y con `premium`, que las features Pro le abran es
// el comportamiento CORRECTO — los `*Allowed` de abajo saldrían "BUG" siendo todos falsos
// positivos. Medido el 09-ago-2026: estaba en trial activo hasta el 18-ago.
let preconFree = null;
try {
  const { data: uFree } = await supabase.from('usuarios')
    .select('plan, trial_estado, trial_vence').eq('id', env.NETO_QA_FREE_USUARIO_ID).maybeSingle();
  R.preconFree = uFree || null;
  if (!uFree) preconFree = 'no se pudo leer al usuario QA Free';
  else if (uFree.plan === 'premium') {
    preconFree = `el usuario "QA Free" NO está en el muro (plan=${uFree.plan}, trial_estado=${uFree.trial_estado}). ` +
      'Durante el trial `plan` vale `premium`, así que abrirle las features Pro es CORRECTO y la sección ' +
      "`free` no puede afirmar nada. Restaurá: UPDATE usuarios SET plan='free', trial_estado='vencido' " +
      `WHERE id='${env.NETO_QA_FREE_USUARIO_ID}'`;
  }
} catch (e) { preconFree = 'no se pudo comprobar el plan del QA Free: ' + e.message; }

// ── Veredicto ───────────────────────────────────────────────────────────────
//
// POR QUÉ ESTE BLOQUE CAMBIÓ (22-ago-2026)
//
// Corrido ese día contra producción, este harness imprimía su JSON y cerraba con
// **"OK (1 afirmaciones verdes)"** teniendo CINCO escritas. La antivacuidad de
// `veredicto.mjs` no lo vio porque mide "cero evaluadas", no "menos de las declaradas".
//
// Las cuatro que faltaban colgaban de `if (id1)`, y `id1` ya no puede existir: el muro
// dejó `FREE_LIMITS.spaces = 0` (hallazgo M14), así que un Free recibe 403 al crear su
// PRIMER espacio y nunca llega a tener uno propio donde probar split-rules ni budgets.
// No es un fallo transitorio del fixture: es permanente por diseño del producto.
//
// Y la quinta pasaba **por la razón equivocada**: afirmaba "un Free no creó un SEGUNDO
// espacio, el límite es 1" — el límite es 0 desde M14, y el segundo POST daba 403 porque
// el primero también, no porque el tope de 1 estuviera vigilado. Un negativo que rechaza
// por otra condición no es cobertura.
//
// Lo que este harness puede afirmar hoy, entonces, es OTRA cosa, y está escrita abajo.
// Lo que NO puede: las features Pro DENTRO de un espacio propio de un Free. El sujeto
// alcanzable para eso ya no es el dueño sino el Free INVITADO a un espacio ajeno (el
// modelo "host paga"), y eso es un harness nuevo, no un `if` más acá.
const fallas = [];
let medidos = 0;
const afirmar = (ok, msg) => { medidos++; if (!ok) fallas.push(msg); };

// Lo que el muro promete hoy: `spaces: 0`. Si esto se pone verde con un 201, el muro se
// abrió y hay que rever `FREE_LIMITS.spaces` y su espejo `PLAN_CONFIG.free.maxSpaces`.
if (!preconFree && R.free.create1Status !== undefined) {
  afirmar(R.free.create1Status === 403,
    `un Free pudo crear su PRIMER espacio (status ${R.free.create1Status}); el muro es spaces=0 desde M14`);
  afirmar(R.free.isPro === false, 'el listado de espacios le reporta isPro=true a un Free');
}

// Las features de adentro solo son alcanzables si el muro dejó pasar el espacio. Mientras
// `spaces=0`, esta rama no corre — pero se DECLARA, para que su ausencia se lea en la
// salida en vez de desaparecer como antes.
const dentroDelEspacio = R.free.splitRuleAllowed !== undefined;
if (!preconFree && dentroDelEspacio) {
  afirmar(R.free.splitRuleAllowed === false,
    `un Free pudo escribir reglas de división (status ${R.free.splitRuleStatus}); es feature Pro`);
  afirmar(R.free.budgetAllowed === false,
    `un Free pudo escribir presupuestos de espacio (status ${R.free.budgetStatus}); es feature Pro`);
  afirmar(R.free.detailIsPro === false, 'el detalle del espacio de un Free reporta isPro=true');
  afirmar(R.free.uiAddRuleBtn === false, 'la UI le ofrece "Agregar regla" a un Free');
}
R.free.__featuresDeAdentro = dentroDelEspacio
  ? 'ejercitadas'
  : 'NO alcanzables: el muro (spaces=0) corta antes de que el Free tenga un espacio propio. ' +
    'El sujeto que sí las alcanza es el Free INVITADO a un espacio ajeno — harness aparte.';

// Hunt (3) del docblock: la card "Tu plan" muestra el plan REAL. Se medía y no se afirmaba.
if (R.free.cfgPlanActualText !== undefined) {
  afirmar(R.free.cfgPlanActualText === 'Free',
    `la card "Tu plan" le muestra "${R.free.cfgPlanActualText}" a un usuario Free`);
}
if (R.pro.cfgPlanActualText !== undefined) {
  afirmar(R.pro.cfgPlanActualText === 'Neto Pro',
    `la card "Tu plan" le muestra "${R.pro.cfgPlanActualText}" a un usuario Pro`);
}

// Hunt (4): las pantallas públicas de join. Se medían enteras y NINGUNA se afirmaba, ni
// siquiera `guest5xx`, que es literalmente lo que el docblock promete ("render without 500").
afirmar((R.join.guest5xx || []).length === 0,
  `un invitado sin sesión recibió 5xx en las pantallas de join: ${(R.join.guest5xx || []).join(', ')}`);
if (R.join.spaceRealShowsName !== undefined) {
  afirmar(R.join.spaceRealShowsName === true,
    `/join/space no le muestra el nombre del espacio al invitado sin sesión. Cuerpo: "${R.join.spaceRealBody}"`);
  afirmar(R.join.spaceRealJoinBtn === true, '/join/space no le ofrece el botón "Unirme al espacio" al invitado');
}
afirmar(R.join.spaceBogusInvalid === true, '/join/space con código inexistente no muestra el aviso de invitación inválida');
afirmar(R.join.gastoBogusInvalid === true,
  `/join/gasto con código inexistente no muestra el aviso de invitación inválida. Cuerpo: "${R.join.gastoBogusBody}"`);

// Antivacuidad propia, más exigente que la del helper: el helper solo atrapa `medidos === 0`,
// y acá el modo de falla real fue salir OK con 1 de 5. Este piso cuenta las afirmaciones que
// NO dependen del muro ni del fixture, así que si alguna se evapora, la corrida lo dice.
const PISO = 6;
const inconcluso = preconFree
  || (R.free.err ? 'la sección free se cayó: ' + R.free.err : null)
  || (!proInviteCode ? 'no se pudo emitir el invite del espacio Pro, así que /join/space no se ejercitó' : null)
  || (medidos < PISO ? `solo se evaluaron ${medidos} afirmaciones y el piso es ${PISO}: el barrido perdió cobertura en silencio` : null);

cerrar({ nombre: 'ESPACIOS-CONFIG', fallas, medidos, inconcluso, R });
await browser.close();
