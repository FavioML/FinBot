// Check de ENTORNO de Espacios contra prod — READ-ONLY, sin escribir una sola fila.
//
// Por qué existe (ver docs/SESION-espacios-postdeploy-gate.md): la LÓGICA de
// espacios (conservación, congelamiento, join, avisos, paridad TS↔CJS) ya la cazan
// los tests de CI sin tocar prod. Lo único que CI no ve es el ENTORNO de prod. Los
// 5 harness `qa-espacios-*.mjs` que lo verían escriben en prod (crean espacios,
// gastos, liquidan) y NO caben en un canary diario. Este check cubre el pedazo de
// entorno que SÍ se puede verificar sin escribir, y que además es el más ciego por
// la vía orgánica: Espacios tiene ~cero tráfico, así que un deploy que rompa sus
// endpoints se queda invisible semanas hasta que un usuario Pro pisa un 500.
//
// Lo que afirma (todo read-only, segundos, sin Chromium):
//   1. `GET /api/spaces` con la cookie SSR real de QA Pro → 200, `spaces` es array,
//      `isPro===true`. Ejercita: endpoint real + cookie SSR real (no mock) + lectura
//      service-role de `space_*` + el join a `shared_spaces`. QA Free → `isPro===false`
//      (sanity de gating por plan, sin escribir).
//   2. La columna `space_expenses.split_snapshot` EXISTE en el schema de prod
//      (migraciones 034/035 aplicadas). Se afirma con un SELECT service-role de esa
//      columna (limit 1): si la migración no corrió, PostgREST responde 400
//      "column does not exist" y esto falla ruidosamente. No depende de que haya
//      filas — la ausencia del error es la prueba.
//
// Lo que este check NO cubre, a propósito: el write/settle path en prod (liquidar
// ES escribir). Eso queda para correr a mano los 5 harness de escritura cuando un
// push toque espacios — el hook post-git-push lo RECUERDA, no lo ejecuta.
//
// La API exige la cookie SSR de @supabase/ssr (no acepta Bearer) → se forja igual
// que en qa-gating-score.mjs. La service-role key se lee del entorno o de
// webapp/.env.local (igual que qa-regla-lote.mjs).
//
// Exit 0 = entorno de espacios sano. Exit 1 = roto (endpoint 500/forma inesperada,
// isPro por plan mal, o columna split_snapshot ausente = migración no aplicada).
// Exit 2 = infra (creds/login/red, o falta la service-role key local) — no
// necesariamente una regresión.
//
// Usage: node qa-espacios-entorno.mjs
//
// Nota: `process.exitCode`, no `process.exit()`. En Windows, salir de golpe con el
// socket keep-alive de fetch aún abierto dispara una assertion de libuv y devuelve
// 127 en vez del código real.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    /* archivo ausente → devolver {} y dejar que el caller decida */
  }
  return env;
}

const fileEnv = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const pick = (k) => process.env[k] ?? fileEnv[k];

const ACCOUNTS = {
  pro: {
    url: pick('NETO_QA_URL'),
    anon: pick('NETO_QA_ANON'),
    email: pick('NETO_QA_EMAIL'),
    password: pick('NETO_QA_PASSWORD'),
    expectPro: true,
  },
  free: {
    url: pick('NETO_QA_FREE_URL') || pick('NETO_QA_URL'),
    anon: pick('NETO_QA_FREE_ANON') || pick('NETO_QA_ANON'),
    email: pick('NETO_QA_FREE_EMAIL'),
    password: pick('NETO_QA_FREE_PASSWORD') || pick('NETO_QA_PASSWORD'),
    expectPro: false,
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

// Service-role: solo para el SELECT de existencia de columna (read-only). Se toma
// del entorno o de webapp/.env.local, igual que qa-regla-lote.mjs.
function serviceKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const localPath = new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  return loadEnv(localPath).SUPABASE_SERVICE_ROLE_KEY;
}

function done(code, results) {
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = code;
  return code;
}

async function main() {
  const results = { checks: {}, facts: {} };

  // --- 1. Endpoints reales + gating por plan (cookie SSR real, read-only) ---
  for (const [plan, acct] of Object.entries(ACCOUNTS)) {
    if (!acct.email || !acct.password) return done(2, { verdict: `faltan creds QA para ${plan}` });
    let cookie;
    try {
      cookie = await forgeCookie(acct);
    } catch (e) {
      return done(2, { verdict: `login ${plan} falló`, error: String(e).split('\n')[0] });
    }
    try {
      const r = await fetch(`${APP}/api/spaces`, { headers: { cookie } });
      const body = await r.json().catch(() => null);
      results.facts[plan] = {
        status: r.status,
        spacesIsArray: Array.isArray(body && body.spaces),
        isPro: body && body.isPro,
        expectPro: acct.expectPro,
      };
    } catch (e) {
      return done(2, { verdict: `fetch /api/spaces ${plan} falló`, error: String(e).split('\n')[0] });
    }
  }

  // --- 2. Columna split_snapshot existe en prod (migraciones 034/035) ---
  const SERVICE = serviceKey();
  const SUPA = pick('NETO_QA_URL');
  if (!SERVICE || !SUPA) {
    return done(2, { verdict: 'falta service-role key o NETO_QA_URL para el check de columna', ...results });
  }
  let columnExists = null;
  let columnDetail = null;
  try {
    const r = await fetch(`${SUPA}/rest/v1/space_expenses?select=split_snapshot&limit=1`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    if (r.status === 200) {
      columnExists = true;
    } else {
      const text = await r.text();
      // 400 "column ... does not exist" = migración no aplicada (fallo real, exit 1).
      // Otro status (401/5xx) = infra.
      if (r.status === 400 && /does not exist/i.test(text)) {
        columnExists = false;
        columnDetail = text.slice(0, 200);
      } else {
        return done(2, { verdict: `SELECT split_snapshot infra ${r.status}`, detail: text.slice(0, 200), ...results });
      }
    }
  } catch (e) {
    return done(2, { verdict: 'SELECT split_snapshot falló (red)', error: String(e).split('\n')[0], ...results });
  }
  results.facts.split_snapshot = { columnExists, detail: columnDetail };

  // --- Aserciones ---
  const checks = {
    'pro: /api/spaces 200': results.facts.pro.status === 200,
    'free: /api/spaces 200': results.facts.free.status === 200,
    'pro: spaces es array': results.facts.pro.spacesIsArray === true,
    'free: spaces es array': results.facts.free.spacesIsArray === true,
    'pro: isPro true': results.facts.pro.isPro === true,
    'free: isPro false (sin leak de plan)': results.facts.free.isPro === false,
    'schema: columna split_snapshot existe (migración 034/035)': columnExists === true,
  };
  results.checks = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v ? 'PASS' : 'FAIL']));
  const allPass = Object.values(checks).every(Boolean);
  results.verdict = allPass ? 'PASS' : 'ENTORNO ESPACIOS ROTO';
  return done(allPass ? 0 : 1, results);
}

await main();
