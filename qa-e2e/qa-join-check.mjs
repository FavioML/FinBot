// Verifies collaborative join links render for an invited (unauthenticated) user.
// Generates invite codes on throwaway goal + debt as the PRO user, then opens
// /join/meta/[code] and /join/deuda/[code] in a COOKIELESS context (the invitee),
// checking the public preview renders (no 500, shows the item). Cleans up.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = 'https://app.neto.pe';
const env = {};
for (const l of readFileSync(join(homedir(), '.config', 'neto', 'qa.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2];
}
const SUPA = env.NETO_QA_URL, ANON = env.NETO_QA_ANON, ref = new URL(SUPA).hostname.split('.')[0];
const grant = await (await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD }),
})).json();
const value = 'base64-' + Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
const domain = new URL(APP).hostname;
const cookie = { name: `sb-${ref}-auth-token`, value, domain, path: '/', secure: true, sameSite: 'Lax' };

const browser = await chromium.launch();
const authCtx = await browser.newContext();
await authCtx.addCookies([cookie]);
const authP = await authCtx.newPage();
await authP.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
const api = (path, opts) => authP.evaluate(async ({ path, opts }) => {
  const r = await fetch(path, opts); let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}, { path, opts: opts || {} });

const R = {};
// Throwaway goal + invite
const g = await api('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'QA_JOIN_DELETE_ME', monto_objetivo: 500, monto_actual: 100, icono: '🎯' }) });
const gid = g.body?.id;
const gInvite = await api('/api/goals/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meta_id: gid }) });
R.goalInvite = { status: gInvite.status, code: gInvite.body?.invite_code, link: gInvite.body?.link };
// Throwaway debt + invite
const d = await api('/api/debts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: 'debo', contraparte: 'QA_JOIN_DELETE_ME', monto_original: 200, moneda: 'PEN' }) });
const did = d.body?.id;
const dInvite = await api('/api/debts/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deuda_id: did }) });
R.debtInvite = { status: dInvite.status, code: dInvite.body?.invite_code, link: dInvite.body?.link };

// Open join pages in cookieless (invitee) context
const guestCtx = await browser.newContext();
const guest = await guestCtx.newPage();
const guestErrors = [];
guest.on('console', (m) => { if (m.type() === 'error') guestErrors.push(m.text().slice(0, 200)); });
guest.on('response', (r) => { if (r.status() >= 500 && r.url().includes(domain)) guestErrors.push(`5xx ${r.url().replace(APP, '')}`); });

if (R.goalInvite.code) {
  await guest.goto(`${APP}/join/meta/${R.goalInvite.code}`, { waitUntil: 'domcontentloaded' });
  await guest.waitForTimeout(2500);
  R.joinMetaPage = {
    httpOk: !guestErrors.some((e) => e.includes('/join/meta')),
    showsGoalName: await guest.getByText(/QA_JOIN_DELETE_ME/).first().isVisible().catch(() => false),
    bodyText: (await guest.locator('body').innerText().catch(() => '')).slice(0, 200).replace(/\s+/g, ' '),
  };
}
if (R.debtInvite.code) {
  await guest.goto(`${APP}/join/deuda/${R.debtInvite.code}`, { waitUntil: 'domcontentloaded' });
  await guest.waitForTimeout(2500);
  R.joinDeudaPage = {
    httpOk: !guestErrors.some((e) => e.includes('/join/deuda')),
    bodyText: (await guest.locator('body').innerText().catch(() => '')).slice(0, 200).replace(/\s+/g, ' '),
  };
}
R.guestErrors = guestErrors;

// Cleanup
if (gid) R.cleanupGoal = (await api(`/api/goals?id=${gid}`, { method: 'DELETE' })).status;
if (did) R.cleanupDebt = (await api(`/api/debts?id=${did}`, { method: 'DELETE' })).status;

console.log(JSON.stringify(R, null, 2));
await browser.close();
