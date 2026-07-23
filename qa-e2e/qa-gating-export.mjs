// Gating Free/Pro de la exportación de datos, por API (sin Chromium).
//
// "Exportar datos" (/api/export, botón en Configuración) es una feature Pro:
// devuelve TODA la data del usuario (transacciones, presupuestos, metas, perfil)
// como un JSON descargable. El gate vive en el server, no en el DOM:
//   - Pro:  status 200 y payload con la forma esperada.
//   - Free: status 403 y { upgrade: true } — NUNCA 200 (un 200 para Free filtra
//           el dump completo de datos de un usuario, la fuga más cara del producto).
//
// Por qué merece un slot diario: es un gate de datos (más sensible que el leak de
// `factors` que cubre gating-score), no depende de data sembrada (Free recibe 403
// tenga o no transacciones; Pro recibe 200 con arrays que pueden venir vacíos), es
// determinista y no levanta navegador — 2 logins + 2 fetch, segundos. Read-only:
// GET, no escribe nada en prod.
//
// La API exige la cookie de sesión SSR de @supabase/ssr (no acepta Bearer): se
// forja igual que en qa-gating-score y se manda en el header Cookie de un fetch
// plano.
//
// Exit 0 = gating OK. Exit 1 = gating roto (Free ve 200, o Pro recibe 403, o la
// forma del payload Pro cambió). Exit 2 = infra (login/red, o 429/5xx) — no
// necesariamente una regresión, el canary lo reporta distinto.
//
// Usage: node qa-gating-export.mjs
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
// process.env gana sobre el archivo: permite overrides operacionales (y forzar el
// camino de fallo apuntando el slot Free a la cuenta Pro).
const pick = (k) => process.env[k] ?? fileEnv[k];

const ACCOUNTS = {
  pro: {
    url: pick('NETO_QA_URL'),
    anon: pick('NETO_QA_ANON'),
    email: pick('NETO_QA_EMAIL'),
    password: pick('NETO_QA_PASSWORD'),
    expectStatus: 200,
  },
  free: {
    url: pick('NETO_QA_FREE_URL') || pick('NETO_QA_URL'),
    anon: pick('NETO_QA_FREE_ANON') || pick('NETO_QA_ANON'),
    email: pick('NETO_QA_FREE_EMAIL'),
    password: pick('NETO_QA_FREE_PASSWORD') || pick('NETO_QA_PASSWORD'),
    expectStatus: 403,
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

// La forma que un export Pro válido debe tener. Las arrays pueden venir vacías
// (QA users sin data sembrada) — se verifica la forma, no el contenido.
function proShapeOk(body) {
  return !!body
    && Array.isArray(body.transacciones)
    && Array.isArray(body.presupuestos)
    && Array.isArray(body.metas_ahorro)
    && body.resumen && typeof body.resumen === 'object';
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
    let status, body;
    try {
      const r = await fetch(`${APP}/api/export`, { headers: { cookie } });
      status = r.status;
      body = await r.json().catch(() => null);
    } catch (e) {
      return done(2, { verdict: `fetch /api/export ${plan} falló`, error: String(e).split('\n')[0] });
    }
    // 429 (rate-limit in-memory) o 5xx = infra, no una regresión de gating.
    if (status === 429 || status >= 500) {
      return done(2, { verdict: `/api/export ${plan} devolvió ${status} (infra, no gating)`, facts });
    }
    facts[plan] = {
      status,
      expectStatus: acct.expectStatus,
      upgradeFlag: !!(body && body.upgrade),
      shapeOk: plan === 'pro' ? proShapeOk(body) : undefined,
    };
  }

  const checks = {
    'pro: /api/export 200': facts.pro.status === 200,
    'pro: payload con forma esperada': facts.pro.shapeOk === true,
    'free: /api/export 403 (sin fuga del dump)': facts.free.status === 403,
    'free: respuesta marca upgrade': facts.free.upgradeFlag === true,
  };
  results.facts = facts;
  results.checks = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v ? 'PASS' : 'FAIL']));
  const allPass = Object.values(checks).every(Boolean);
  results.verdict = allPass ? 'PASS' : 'GATING EXPORT ROTO';
  return done(allPass ? 0 : 1, results);
}

await main();
