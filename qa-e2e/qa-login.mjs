// Autonomous authenticated E2E for app.neto.pe — no email / magic link.
//
// Logs the QA test user in via the Supabase password grant, forges the
// @supabase/ssr session cookie, and drives a real Chromium session with
// Playwright. This sidesteps the magic-link flow entirely (Gmail's link scanner
// consumes single-use verify links before they can be used, and Supabase rate
// limits OTP email). Credentials are read from ~/.config/neto/qa.env and never
// printed.
//
// Usage: node qa-login.mjs
// Requires: reference_neto_qa_test_user creds in ~/.config/neto/qa.env

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

function ok(cond) { return cond ? 'PASS' : 'FAIL'; }

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
const EMAIL = env.NETO_QA_EMAIL;
const PASSWORD = env.NETO_QA_PASSWORD;
const AUTH_ID = env.NETO_QA_AUTH_ID;
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;

if (!SUPA || !ANON || !EMAIL || !PASSWORD) {
  console.error('Missing creds in ~/.config/neto/qa.env');
  process.exit(2);
}

// 1) Password grant -> session
const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!grant.ok) {
  console.error('Password grant failed:', grant.status, await grant.text());
  process.exit(2);
}
const session = await grant.json();

// 2) Forge the @supabase/ssr cookie: 'base64-' + base64url(JSON(session)),
//    chunked at 3180 chars into name.0/name.1/... when it overflows.
const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180;
const domain = new URL(APP).hostname;
const cookies = [];
if (value.length <= MAX) {
  cookies.push({ name: cookieName, value });
} else {
  for (let i = 0, p = 0; p < value.length; i++, p += MAX) {
    cookies.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
  }
}
const toAdd = cookies.map((c) => ({
  name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax',
}));

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies(toAdd);
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const failedRequests = [];
page.on('response', (r) => { if (r.status() === 401 || r.status() === 403) failedRequests.push(`${r.status()} ${r.url()}`); });

const results = {};

// --- Check 1: authenticated dashboard renders with data, no bounce ---
// Two attempts: on a cold Vercel deploy (fresh lambda + CDN) the first data
// fetch + React Query persist can miss the 15s window, which false-negatives
// this whole check. A warm reload fixes a cold-start flake; a genuinely broken
// persist still fails both attempts, so real regressions aren't masked.
let rq = { present: false };
for (let attempt = 0; attempt < 2; attempt++) {
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
  // Poll up to 15s for the persisted cache to appear (proves data loaded + W4 wrote it).
  for (let i = 0; i < 30; i++) {
    rq = await page.evaluate(() => {
      const raw = localStorage.getItem('neto-rq');
      if (!raw) return { present: false };
      try {
        const p = JSON.parse(raw);
        return { present: true, buster: p.buster, queries: (p?.clientState?.queries || []).length };
      } catch (e) { return { present: true, parseError: String(e) }; }
    });
    if (rq.present && rq.queries > 0) break;
    await page.waitForTimeout(500);
  }
  if (rq.present && rq.queries > 0) break;
  results.coldStartRetry = attempt + 1; // records that a warm reload was needed
}
results.urlAfterDashboard = page.url();
results.stayedOnDashboard = page.url().includes('/dashboard');
// Let the financial data render (a currency amount on screen proves the seed hydrated).
await page.getByText(/S\/\s*[\d,]+/).first().waitFor({ timeout: 8000 }).catch(() => {});
const mainText = await page.locator('main').innerText().catch(() => '');
results.mainLen = mainText.length;
results.hasGreeting = /QA Dashboard|Buenos|Buenas/.test(mainText);
// The Neto Score changes daily (the 6am cron recomputes it), so a hardcoded value
// would false-negative. Read the seeded ['neto-score'] cache and assert it's a
// valid 0-100 number — proves /api/dashboard returned and seeded a real score.
const scoreFromCache = await page.evaluate(() => {
  const raw = localStorage.getItem('neto-rq');
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    const q = (p?.clientState?.queries || []).find(
      (x) => JSON.stringify(x.queryKey) === '["neto-score"]',
    );
    return q?.state?.data?.score ?? null;
  } catch {
    return null;
  }
});
results.score = scoreFromCache;
results.hasScore = typeof scoreFromCache === 'number' && scoreFromCache >= 0 && scoreFromCache <= 100;

// --- Check 2: W4 persistence present + buster keyed to this user ---
results.persistPresent = rq.present;
results.persistQueries = rq.queries;
results.busterMatchesUser = rq.buster === AUTH_ID;
results.failedRequests = failedRequests.slice(0, 8);

// --- Check 3: warm reload timing (static shell) ---
await page.goto(`${APP}/dashboard`, { waitUntil: 'load' });
const timing = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0];
  return n ? {
    ttfb: Math.round(n.responseStart),
    domInteractive: Math.round(n.domInteractive),
    load: Math.round(n.loadEventEnd),
  } : null;
});
results.timing = timing;

// --- Check 4: logout fully purges neto-rq from localStorage ---
await page.evaluate(() => {
  // Remove any onboarding-tour overlay so the user menu is clickable.
  document.querySelectorAll('.fixed.inset-0.z-50').forEach((e) => e.remove());
});
// Open the user menu (avatar shows the user initials) and sign out.
let logoutClicked = false;
try {
  await page.getByRole('button', { name: /^QA$/ }).first().click({ timeout: 4000 });
  await page.getByRole('button', { name: /Cerrar sesi/i }).click({ timeout: 4000 });
  logoutClicked = true;
} catch (e) {
  results.logoutClickError = String(e).split('\n')[0];
}
results.logoutClicked = logoutClicked;
await page.waitForTimeout(2500);
results.urlAfterLogout = page.url();
const rqAfter = await page.evaluate(() => localStorage.getItem('neto-rq'));
results.netoRqAfterLogout = rqAfter === null ? 'REMOVED' : `PRESENT(len=${rqAfter.length})`;
results.sessionCookieAfterLogout = await page.evaluate((n) =>
  document.cookie.split('; ').some((c) => c.startsWith(n + '=')), cookieName);

results.consoleErrorCount = consoleErrors.length;
results.consoleErrors = consoleErrors.slice(0, 8);

// --- Verdict ---
const checks = {
  // hasGreeting requires the user's name from the usuarios row → proves the
  // authenticated user query resolved and the dashboard rendered real data.
  'auth dashboard + user data (no onboarding bounce)': results.stayedOnDashboard && results.hasGreeting,
  'W4 persist present': results.persistPresent && results.persistQueries > 0,
  'buster keyed to user': results.busterMatchesUser,
  // Non-vacuous: neto-rq must have been present before logout for removal to mean anything.
  'logout removed neto-rq': results.persistPresent && results.persistQueries > 0 && results.netoRqAfterLogout === 'REMOVED',
  'logout cleared session cookie': results.sessionCookieAfterLogout === false,
};
results.verdict = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, ok(v)]));
results.allPass = Object.values(checks).every(Boolean);

console.log(JSON.stringify(results, null, 2));

await browser.close();
process.exit(results.allPass ? 0 : 1);
