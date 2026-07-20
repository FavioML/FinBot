// Adversarial E2E: Espacios gating (Free vs Pro) + Configuracion plan display + join/space + join/gasto.
// Usage: node qa-espacios-config.mjs        (runs the full sweep; forges cookies for both plans)
//
// Hunts:
//  (1) Free can create >1 space via API (UI blocks at 1, does the API?)
//  (2) Free can create custom split-rules + shared budgets in a space they own
//      (those are Pro features: espacios_custom_split / espacios_shared_budget).
//  (3) Configuracion "Tu plan" card shows the user's REAL plan (not hardcoded Pro).
//  (4) join/space + join/gasto public preview pages render without 500.
// Cleans up every space it creates.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

console.log(JSON.stringify(R, null, 2));
await browser.close();
