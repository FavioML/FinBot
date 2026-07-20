// Verifies the "host pays" espacios gating + custom-split-drives-balances + default-split endpoint.
// Asserts against PROD post-deploy. Cleans up every space it creates.
//   Part A (Free): create 1 space ok, 2nd owned space 403, split-rules 403, budgets 403,
//                  default-split 200 + persists, GET isPro=false.
//   Part B (Pro+Free member): Pro space, Free joins, custom rule 70/30 drives the real balance.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = 'https://app.neto.pe';
const env = {};
for (const l of readFileSync(join(homedir(), '.config', 'neto', 'qa.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
async function forge(P) {
  const SUPA = env[P + 'URL'] || env.NETO_QA_URL, ANON = env[P + 'ANON'] || env.NETO_QA_ANON;
  const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env[P + 'EMAIL'], password: env[P + 'PASSWORD'] || env.NETO_QA_PASSWORD }) });
  const s = await g.json(); const ref = new URL(SUPA).hostname.split('.')[0];
  const v = 'base64-' + Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
  const MAX = 3180, domain = new URL(APP).hostname, ck = [];
  if (v.length <= MAX) ck.push({ name: `sb-${ref}-auth-token`, value: v }); else for (let i = 0, p = 0; p < v.length; i++, p += MAX) ck.push({ name: `sb-${ref}-auth-token.${i}`, value: v.slice(p, p + MAX) });
  return ck.map(c => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));
}
const br = await chromium.launch();
async function ctxFor(P) {
  const ctx = await br.newContext(); await ctx.addCookies(await forge(P));
  const pg = await ctx.newPage(); await pg.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' }); await pg.waitForTimeout(800);
  const api = (path, opts) => pg.evaluate(async ({ path, opts }) => { const r = await fetch(path, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; }, { path, opts: opts || {} });
  return { ctx, api };
}
const J = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const JP = (o) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const R = { A_free: {}, B_balances: {} };

// ---------- Part A: Free gating ----------
{
  const { ctx, api } = await ctxFor('NETO_QA_FREE_');
  const freeUid = env.NETO_QA_FREE_USUARIO_ID;
  const created = [];
  const s1 = await api('/api/spaces', J({ name: 'QA_GATE_FREE_1', type: 'custom' }));
  R.A_free.create1 = s1.status; const id1 = s1.body?.id; if (id1) created.push(id1);
  const s2 = await api('/api/spaces', J({ name: 'QA_GATE_FREE_2', type: 'custom' }));
  R.A_free.create2_expect403 = s2.status; if (s2.body?.id) created.push(s2.body.id);
  if (id1) {
    R.A_free.splitRules_expect403 = (await api(`/api/spaces/${id1}/split-rules`, JP({ rules: [{ id: 'r1', category: 'Alimentación', splits: { [freeUid]: 100 } }] }))).status;
    R.A_free.budgets_expect403 = (await api(`/api/spaces/${id1}/budgets`, JP({ budgets: [{ id: 'b1', category: 'Alimentación', limit: 200 }] }))).status;
    R.A_free.defaultSplit_expect200 = (await api(`/api/spaces/${id1}/default-split`, JP({ splits: { [freeUid]: 100 } }))).status;
    const det = await api(`/api/spaces/${id1}`);
    R.A_free.detIsPro_expectFalse = det.body?.isPro;
    R.A_free.detSplitRulesLen_expect0 = (det.body?.splitRules || []).length;
    R.A_free.ownerPct_expect100 = det.body?.members?.find(m => m.user_id === freeUid)?.split_percentage;
  }
  for (const id of created) await api(`/api/spaces/${id}`, { method: 'DELETE' });
  R.A_free.cleaned = created.length;
  await ctx.close();
}

// ---------- Part B: Pro space, Free joins, custom rule drives balance ----------
{
  const pro = await ctxFor('NETO_QA_');
  const free = await ctxFor('NETO_QA_FREE_');
  const proUid = env.NETO_QA_USUARIO_ID, freeUid = env.NETO_QA_FREE_USUARIO_ID;
  const sp = await pro.api('/api/spaces', J({ name: 'QA_GATE_PRO_BAL', type: 'custom' }));
  const spId = sp.body?.id;
  R.B_balances.proCreate = sp.status;
  try {
    const det0 = await pro.api(`/api/spaces/${spId}`);
    const code = det0.body?.space?.invite_code;
    // Free joins
    const joined = await free.api('/api/spaces/join', J({ code }));
    R.B_balances.freeJoin = joined.status;
    // Pro sets custom rule 70/30 for Alimentación
    R.B_balances.ruleStatus_expect200 = (await pro.api(`/api/spaces/${spId}/split-rules`, JP({ rules: [{ id: 'r1', category: 'Alimentación', splits: { [proUid]: 70, [freeUid]: 30 } }] }))).status;
    R.B_balances.budgetStatus_expect200 = (await pro.api(`/api/spaces/${spId}/budgets`, JP({ budgets: [{ id: 'b1', category: 'Alimentación', limit: 500 }] }))).status;
    // Two expenses paid by pro: 100 Alimentación (ruled 70/30), 100 Transporte (default 50/50)
    await pro.api(`/api/spaces/${spId}/expenses`, J({ amount: 100, description: 'QA alim', category: 'Alimentación' }));
    await pro.api(`/api/spaces/${spId}/expenses`, J({ amount: 100, description: 'QA trans', category: 'Transporte' }));
    const det = await pro.api(`/api/spaces/${spId}`);
    R.B_balances.isPro_expectTrue = det.body?.isPro;
    const bal = det.body?.balance || {};
    // Expected: Alim pro +30/free -30 ; Trans pro +50/free -50 => pro +80 / free -80
    R.B_balances.proBalance_expect80 = Math.round((bal[proUid] ?? 0) * 100) / 100;
    R.B_balances.freeBalance_expectNeg80 = Math.round((bal[freeUid] ?? 0) * 100) / 100;
    R.B_balances.ruleApplied = Math.abs((bal[proUid] ?? 0) - 80) < 0.5; // false if 50/50 (would be 100)
  } catch (e) { R.B_balances.err = String(e).split('\n')[0]; }
  if (spId) R.B_balances.cleanup = (await pro.api(`/api/spaces/${spId}`, { method: 'DELETE' })).status;
  await pro.ctx.close(); await free.ctx.close();
}

console.log(JSON.stringify(R, null, 2));
await br.close();
