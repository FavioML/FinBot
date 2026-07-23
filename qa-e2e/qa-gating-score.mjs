// Gating Free/Pro del score, por API (sin Chromium).
//
// El Neto Score expone `factors` (el desglose de por qué tu score es X) solo a
// Pro. Un usuario Free debe recibir el número pero NO los factores. Este harness
// verifica ese límite directamente contra /api/score en producción:
//   - Pro:  status 200 y `factors` presente.
//   - Free: status 200 y `factors` AUSENTE (si aparece = leak de una feature Pro
//           a Free, una regresión de negocio que qa-login no ve).
//
// Por qué merece un slot diario: es un check de gating (seguridad de producto),
// no depende de data sembrada (el score se calcula igual con o sin muchas
// transacciones), es determinista y no levanta navegador — 2 logins + 2 fetch,
// segundos. Read-only: no escribe nada en prod.
//
// La API exige la cookie de sesión SSR de @supabase/ssr (no acepta Bearer), así
// que se forja igual que en qa-login, pero se manda en el header Cookie de un
// fetch plano en vez de por Playwright.
//
// Exit 0 = gating OK. Exit 1 = gating roto (Free ve factors, o Pro no los ve, o
// status inesperado). Exit 2 = infra (login/red) — no necesariamente una regresión.
//
// Usage: node qa-gating-score.mjs
//
// Nota: se usa `process.exitCode` (no `process.exit()`). En Windows, salir de
// golpe mientras el socket keep-alive de fetch aún se cierra dispara una
// assertion de libuv (UV_HANDLE_CLOSING) y devuelve 127 en vez del código real.

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

const fileEnv = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
// process.env gana sobre el archivo: permite overrides operacionales (y de test)
// sin editar el archivo de creds.
const pick = (k) => process.env[k] ?? fileEnv[k];

// Ambos QA users viven en el mismo proyecto Supabase; solo cambia el user.
const ACCOUNTS = {
  pro: {
    url: pick('NETO_QA_URL'),
    anon: pick('NETO_QA_ANON'),
    email: pick('NETO_QA_EMAIL'),
    password: pick('NETO_QA_PASSWORD'),
    expectFactors: true,
  },
  free: {
    url: pick('NETO_QA_FREE_URL') || pick('NETO_QA_URL'),
    anon: pick('NETO_QA_FREE_ANON') || pick('NETO_QA_ANON'),
    email: pick('NETO_QA_FREE_EMAIL'),
    password: pick('NETO_QA_FREE_PASSWORD') || pick('NETO_QA_PASSWORD'),
    expectFactors: false,
  },
};

async function forgeCookie({ url, anon, email, password }) {
  const g = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!g.ok) throw new Error(`password grant ${g.status}`);
  const session = await g.json();
  const ref = new URL(url).hostname.split('.')[0];
  const cn = `sb-${ref}-auth-token`;
  const v = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  if (v.length <= MAX) return `${cn}=${v}`;
  const parts = [];
  for (let i = 0, p = 0; p < v.length; i++, p += MAX) parts.push(`${cn}.${i}=${v.slice(p, p + MAX)}`);
  return parts.join('; ');
}

function done(code, results) {
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = code;
  return code;
}

async function main() {
  const results = { checks: {} };
  const facts = {};

  for (const [plan, acct] of Object.entries(ACCOUNTS)) {
    if (!acct.email || !acct.password) return done(2, { verdict: `faltan creds QA para ${plan}` });
    let cookie;
    try {
      cookie = await forgeCookie(acct);
    } catch (e) {
      return done(2, { verdict: `login ${plan} falló`, error: String(e).split('\n')[0] });
    }
    let status, hasFactors, score;
    try {
      const r = await fetch(`${APP}/api/score`, { headers: { cookie } });
      status = r.status;
      const body = await r.json().catch(() => null);
      hasFactors = !!(body && body.factors);
      score = body && body.score;
    } catch (e) {
      return done(2, { verdict: `fetch /api/score ${plan} falló`, error: String(e).split('\n')[0] });
    }
    facts[plan] = { status, hasFactors, score, expectFactors: acct.expectFactors };
  }

  // Aserciones de gating.
  const checks = {
    'pro: /api/score 200': facts.pro.status === 200,
    'free: /api/score 200': facts.free.status === 200,
    'pro VE factors del score': facts.pro.hasFactors === true,
    'free NO ve factors (sin leak Pro→Free)': facts.free.hasFactors === false,
  };
  results.facts = facts;
  results.checks = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v ? 'PASS' : 'FAIL']));
  const allPass = Object.values(checks).every(Boolean);
  results.verdict = allPass ? 'PASS' : 'GATING ROTO';
  return done(allPass ? 0 : 1, results);
}

await main();
