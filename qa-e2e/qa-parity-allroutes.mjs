// Free-vs-Pro parity sweep over ALL 13 dashboard routes.
// For each plan, visits every route and captures:
//   - console errors + pageerrors
//   - 4xx/5xx responses
//   - whether a ProGate ("<feature> es Pro") lock is shown on the page
//   - final URL (catch unexpected redirects)
// Usage: node qa-parity-allroutes.mjs pro | free   (run both, diff the ProGate columns)

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = 'https://app.neto.pe';
const PLAN = (process.argv[2] || 'pro').toLowerCase();
const P = PLAN === 'free' ? 'NETO_QA_FREE_' : 'NETO_QA_';
function le(p) { const e = {}; for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2]; } return e; }
const env = le(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env[P + 'URL'] || env.NETO_QA_URL, ANON = env[P + 'ANON'] || env.NETO_QA_ANON, EMAIL = env[P + 'EMAIL'], PASSWORD = env[P + 'PASSWORD'] || env.NETO_QA_PASSWORD;
const ref = new URL(SUPA).hostname.split('.')[0], cn = `sb-${ref}-auth-token`;
const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const s = await g.json();
const v = 'base64-' + Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
const MAX = 3180, domain = new URL(APP).hostname, ck = [];
if (v.length <= MAX) ck.push({ name: cn, value: v }); else for (let i = 0, p = 0; p < v.length; i++, p += MAX) ck.push({ name: `${cn}.${i}`, value: v.slice(p, p + MAX) });

const br = await chromium.launch();
const ctx = await br.newContext({ viewport: { width: 1280, height: 1600 } });
await ctx.addCookies(ck.map(c => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' })));
await ctx.addInitScript(() => { try { localStorage.setItem('neto_tour_v2', 'true'); localStorage.setItem('neto_welcome_seen', '1'); } catch {} });
const page = await ctx.newPage();

const ROUTES = [
  ['overview', '/dashboard'],
  ['transacciones', '/dashboard/transacciones'],
  ['presupuestos', '/dashboard/presupuestos'],
  ['planes', '/dashboard/planes'],
  ['deudas', '/dashboard/deudas'],
  ['suscripciones', '/dashboard/suscripciones'],
  ['reportes', '/dashboard/reportes'],
  ['score', '/dashboard/score'],
  ['alertas', '/dashboard/alertas'],
  ['espacios', '/dashboard/espacios'],
  ['logros', '/dashboard/logros'],
  ['configuracion', '/dashboard/configuracion'],
  ['pro', '/dashboard/pro'],
];

const out = { plan: PLAN, routes: {} };
for (const [name, path] of ROUTES) {
  const consoleErrors = [], failed = [];
  const onConsole = (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); };
  const onPageErr = (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200));
  const onResp = (r) => { const u = r.url(); if (r.status() >= 400 && (u.includes('/api/') || u.includes(domain))) failed.push(`${r.status()} ${r.request().method()} ${u.replace(APP, '')}`); };
  page.on('console', onConsole); page.on('pageerror', onPageErr); page.on('response', onResp);

  await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Wait for content to hydrate
  await page.waitForTimeout(4000);

  // ProGate lock present? (the ProGate component renders "<X> es Pro")
  const proGateCount = await page.locator('text=/\\bes Pro\\b/').count().catch(() => 0);
  const proGateLabels = proGateCount > 0
    ? await page.locator('text=/\\bes Pro\\b/').allInnerTexts().catch(() => [])
    : [];

  out.routes[name] = {
    finalUrl: page.url().replace(APP, ''),
    proGate: proGateCount > 0,
    proGateLabels: [...new Set(proGateLabels.map(t => t.replace(/\s+/g, ' ').trim()))].slice(0, 4),
    consoleErrors: [...new Set(consoleErrors)],
    failed: [...new Set(failed)].filter(f => !/40[13] (GET|POST) \/api\/(advice|pro\/)/.test(f)), // advice 403 for free is expected gating
    rawFailed: [...new Set(failed)],
  };

  page.off('console', onConsole); page.off('pageerror', onPageErr); page.off('response', onResp);
}

console.log(JSON.stringify(out, null, 2));
await br.close();
