// Gating Free/Pro del score, por API (sin Chromium).
//
// El Neto Score expone `factors` (el desglose de por qué tu score es X) solo a
// Pro. Un usuario Free debe recibir el número pero NO los factores. Este harness
// verifica ese límite en los DOS endpoints que lo sirven en producción:
//   - /api/score        — lo consulta la página del score.
//   - /api/dashboard     — el seed fast-path que carga CADA visita al dashboard,
//                          y que replica el mismo gate de `factors`/`history`.
// Verificar solo /api/score dejaba un hueco: un leak podía vivir en el seed que
// realmente hidrata la app mientras /api/score quedaba limpio.
//   - Pro:  status 200 y `factors` presente.
//   - Muro: status 402 — la ruta entera se niega, no "el número sí y los factores no".
//
// LA PREMISA ORIGINAL DE ESTE ARCHIVO YA NO EXISTE, y conviene decirlo fuerte porque
// cambia lo que el harness puede afirmar. Se escribió cuando había un plan Free
// permanente que veía el score sin el desglose, así que el gate interesante era
// "Free recibe 200 con `factors` ausente". Con el trial de 14 días (`e9449d0`,
// 01-ago) `free` dejó de ser un plan y pasó a ser el MURO: `requireLectura` niega
// /api/score y /api/dashboard con 402 antes de calcular nada.
//
// Consecuencia incómoda: los cuatro checks de leak (`free NO ve factors`, etc.)
// ahora pasan POR VACUIDAD — no hay payload donde pueda filtrarse nada. Se dejan,
// porque un 402 que empezara a traer cuerpo sería exactamente la regresión que
// buscan, pero se marcan como vacuos en el output para que nadie lea cuatro PASS y
// crea que se ejercitó un límite. El check que sí ejercita algo hoy es la negación.
//
// El leak Pro→Free que este archivo vigilaba solo puede volver si vuelve un plan
// gratuito con lectura parcial. Si eso pasa, esta cabecera hay que reescribirla,
// no ajustarle el número al status.
//
// Por qué merece un slot diario: es un check de gating (seguridad de producto),
// no depende de data sembrada (el score se calcula igual con o sin muchas
// transacciones), es determinista y no levanta navegador — 2 logins + 4 fetch,
// segundos. Read-only: no escribe nada en prod.
//
// La API exige la cookie de sesión SSR de @supabase/ssr (no acepta Bearer), así
// que se forja igual que en qa-login, pero se manda en el header Cookie de un
// fetch plano en vez de por Playwright.
//
// Exit 0 = gating OK. Exit 1 = gating roto (Free ve factors en /api/score o en el
// seed /api/dashboard, o Pro no los ve, o status inesperado). Exit 2 = infra
// (login/red) — no necesariamente una regresión.
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

    // El seed que hidrata el dashboard replica el mismo gate: `score.factors` solo
    // para Pro, y el history sin campos `factor_*` para Free.
    let dashStatus, dashHasFactors, dashHistoryLeak;
    try {
      const r = await fetch(`${APP}/api/dashboard`, { headers: { cookie } });
      dashStatus = r.status;
      const body = await r.json().catch(() => null);
      dashHasFactors = !!(body && body.score && body.score.factors);
      const hist = (body && body.scoreHistory && body.scoreHistory.history) || [];
      // Cualquier campo factor_* en una entrada del history = leak del desglose a Free.
      dashHistoryLeak = hist.some((h) => h && Object.keys(h).some((k) => k.startsWith('factor_')));
    } catch (e) {
      return done(2, { verdict: `fetch /api/dashboard ${plan} falló`, error: String(e).split('\n')[0] });
    }

    facts[plan] = {
      status, hasFactors, score, expectFactors: acct.expectFactors,
      dashStatus, dashHasFactors, dashHistoryLeak,
    };
  }

  // Aserciones de gating. El seed Pro solo trae `score.factors` si ya hay una fila
  // persistida; el fetch previo a /api/score (que calcula+persiste si falta) lo
  // garantiza, así que aquí sí se puede exigir en Pro.
  // Con el muro negando la ruta entera, los checks de leak no tienen payload que
  // inspeccionar. Se marcan para que cuatro PASS no se lean como cuatro límites
  // ejercitados — es la misma trampa que un guard verde por vacuidad.
  const muroNiega = facts.free.status === 402 && facts.free.dashStatus === 402;
  const vacuo = (etiqueta) => (muroNiega ? `${etiqueta} [vacuo: el muro no devuelve cuerpo]` : etiqueta);

  const checks = {
    'pro: /api/score 200': facts.pro.status === 200,
    'pro VE factors del score': facts.pro.hasFactors === true,
    'pro: /api/dashboard 200': facts.pro.dashStatus === 200,
    'pro VE factors en el seed': facts.pro.dashHasFactors === true,
    // Lo que hoy sí se ejercita: el muro corta la lectura agregada en los DOS
    // endpoints. Verificar solo /api/score dejaba fuera el seed que hidrata la app.
    'muro: /api/score niega, no 200': facts.free.status !== 200,
    'muro: /api/score 402': facts.free.status === 402,
    'muro: /api/dashboard niega, no 200': facts.free.dashStatus !== 200,
    'muro: /api/dashboard 402': facts.free.dashStatus === 402,
    [vacuo('muro: sin factors en /api/score')]: facts.free.hasFactors === false,
    [vacuo('muro: sin factors en el seed')]: facts.free.dashHasFactors === false,
    [vacuo('muro: seed history sin factor_*')]: facts.free.dashHistoryLeak === false,
  };
  results.muroNiegaLaRutaEntera = muroNiega;
  results.facts = facts;
  results.checks = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v ? 'PASS' : 'FAIL']));
  const allPass = Object.values(checks).every(Boolean);
  results.verdict = allPass ? 'PASS' : 'GATING ROTO';
  return done(allPass ? 0 : 1, results);
}

await main();
