// Harness E2E de la recurrencia de presupuestos (POST /api/budgets/apply-forward).
//
// apply-forward "espeja" una categoría desde un mes fuente hacia TODOS los meses
// posteriores ya materializados: propaga altas/cambios hacia adelante y borra hacia
// adelante lo que se quitó en el fuente. Es la primitiva "para siempre".
//
// Mismo patrón que qa-money-edge: auth por password-grant → cookie SSR forjada,
// ORÁCULO service-role que re-lee las filas (la prueba de verdad), self-cleaning
// por marcador de categoría (QA-RECUR*). Se usan meses MUY futuros (current+6/+7)
// para que "el último mes materializado" sea el del propio harness y no toque data real.
//
// Uso: node qa-budgets-recurrence.mjs            (contra https://app.neto.pe)
//      NETO_APP_URL=http://localhost:3000 node qa-budgets-recurrence.mjs   (dev local)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const CAT = 'QA-RECUR';

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* opcional */ }
  return env;
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
const U = { email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD, uid: env.NETO_QA_USUARIO_ID };
const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !U.email || !U.password || !U.uid) {
  console.error('Faltan creds en ~/.config/neto/qa.env (NETO_QA_*).');
  process.exit(2);
}
if (!SERVICE) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (entorno o webapp/.env.local).');
  process.exit(2);
}

const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

async function sb(path, init = {}) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function login(user) {
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!grant.ok) throw new Error(`Password grant falló: ${grant.status}`);
  const session = await grant.json();
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  const pairs = [];
  if (value.length <= MAX) pairs.push(`${cookieName}=${value}`);
  else for (let i = 0, p = 0; p < value.length; i++, p += MAX) pairs.push(`${cookieName}.${i}=${value.slice(p, p + MAX)}`);
  return pairs.join('; ');
}

async function api(cookie, method, path, body) {
  const r = await fetch(`${APP}${path}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  const text = await r.text().catch(() => '');
  try { json = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  return { status: r.status, json, text };
}

function addMonths(anio, mes, delta) {
  const d = anio * 12 + (mes - 1) + delta;
  return { anio: Math.floor(d / 12), mes: (d % 12) + 1 };
}

// Subcategorías presentes en un mes (según el oráculo). null (fila total) → '(total)'.
async function subsEn(mes, anio) {
  const rows = await sb(
    `presupuestos?usuario_id=eq.${U.uid}&categoria=eq.${CAT}&mes=eq.${mes}&anio=eq.${anio}&select=subcategoria`,
  );
  return new Set((rows || []).map(r => (r.subcategoria == null ? '(total)' : r.subcategoria.toLowerCase())));
}

const results = [];
function ok(name, cond, note) { results.push({ name, pass: !!cond, note }); }

async function cleanup() {
  await sb(`presupuestos?usuario_id=eq.${U.uid}&categoria=eq.${CAT}`, { method: 'DELETE' }).catch(() => {});
}

let cookie;
try {
  await cleanup();
  cookie = await login(U);

  const exp = await api(cookie, 'GET', '/api/export');
  ok('sanity: QA autentica', exp.status === 200, `status ${exp.status}`);

  // Meses de trabajo: muy futuros para que M2 sea "el último materializado".
  const now = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const curAnio = parseInt(now.split('-')[0], 10);
  const curMes = parseInt(now.split('-')[1], 10);
  const M1 = addMonths(curAnio, curMes, 6);   // fuente
  const M2 = addMonths(curAnio, curMes, 7);   // siguiente (materializado)
  const M0 = addMonths(curAnio, curMes, 5);   // anterior a la fuente (NO debe tocarse)

  // Seed: total + 'alquiler' en M0, M1 y M2 (tres meses materializados con la misma config).
  for (const m of [M0, M1, M2]) {
    await api(cookie, 'POST', '/api/budgets', { categoria: CAT, monto_limite: 1000, mes: m.mes, anio: m.anio });
    await api(cookie, 'POST', '/api/budgets', { categoria: CAT, subcategoria: 'alquiler', monto_limite: 900, mes: m.mes, anio: m.anio });
  }
  const seedM2 = await subsEn(M2.mes, M2.anio);
  ok('seed: M2 tiene total + alquiler', seedM2.has('(total)') && seedM2.has('alquiler'), [...seedM2].join(','));

  // ── Escenario A: agregar 'internet' en M1 y espejar hacia adelante ──
  await api(cookie, 'POST', '/api/budgets', { categoria: CAT, subcategoria: 'internet', monto_limite: 100, mes: M1.mes, anio: M1.anio });
  const fwdA = await api(cookie, 'POST', '/api/budgets/apply-forward', { categoria: CAT, mes: M1.mes, anio: M1.anio });
  ok('apply-forward A → 200', fwdA.status === 200, `status ${fwdA.status} ${fwdA.text?.slice(0, 80)}`);
  const a_M2 = await subsEn(M2.mes, M2.anio);
  ok('A: internet se propagó a M2', a_M2.has('internet'), [...a_M2].join(','));
  ok('A: M2 conserva total + alquiler', a_M2.has('(total)') && a_M2.has('alquiler'), [...a_M2].join(','));
  const a_M0 = await subsEn(M0.mes, M0.anio);
  ok('A: M0 (anterior a la fuente) NO recibió internet', !a_M0.has('internet'), [...a_M0].join(','));

  // ── Escenario B: eliminar 'alquiler' en M1 y espejar → desaparece hacia adelante ──
  const rowAlqM1 = (await sb(`presupuestos?usuario_id=eq.${U.uid}&categoria=eq.${CAT}&mes=eq.${M1.mes}&anio=eq.${M1.anio}&subcategoria=eq.Alquiler&select=id`))?.[0];
  await api(cookie, 'DELETE', `/api/budgets?id=${rowAlqM1?.id}`);
  const fwdB = await api(cookie, 'POST', '/api/budgets/apply-forward', { categoria: CAT, mes: M1.mes, anio: M1.anio });
  ok('apply-forward B → 200', fwdB.status === 200, `status ${fwdB.status}`);
  const b_M2 = await subsEn(M2.mes, M2.anio);
  ok('B: alquiler eliminado también en M2', !b_M2.has('alquiler'), [...b_M2].join(','));
  ok('B: M2 conserva internet + total', b_M2.has('internet') && b_M2.has('(total)'), [...b_M2].join(','));

  // ── Escenario C: idempotencia — repetir apply-forward no rompe ni duplica ──
  const fwdC = await api(cookie, 'POST', '/api/budgets/apply-forward', { categoria: CAT, mes: M1.mes, anio: M1.anio });
  const cRows = await sb(`presupuestos?usuario_id=eq.${U.uid}&categoria=eq.${CAT}&mes=eq.${M2.mes}&anio=eq.${M2.anio}&select=id,subcategoria`);
  const cKeys = (cRows || []).map(r => (r.subcategoria == null ? '(total)' : r.subcategoria.toLowerCase()));
  const cDup = cKeys.length !== new Set(cKeys).size;
  ok('C: apply-forward idempotente → 200', fwdC.status === 200, `status ${fwdC.status}`);
  ok('C: sin filas duplicadas en M2', !cDup, cKeys.join(','));

  // ── Escenario D: "solo este mes" — POST sin apply-forward NO propaga ──
  await api(cookie, 'POST', '/api/budgets', { categoria: CAT, subcategoria: 'gimnasio', monto_limite: 80, mes: M1.mes, anio: M1.anio });
  const d_M2 = await subsEn(M2.mes, M2.anio);
  ok('D: gimnasio (sin apply-forward) NO se propagó a M2', !d_M2.has('gimnasio'), [...d_M2].join(','));

} catch (e) {
  ok('harness sin excepción', false, e.message);
} finally {
  await cleanup().catch(() => {});
}

const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\n${'═'.repeat(64)}\nQA BUDGETS RECURRENCE — ${APP}\n${'═'.repeat(64)}`);
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.note ? `  (${r.note})` : ''}`);
console.log(`${'─'.repeat(64)}\n${pass}/${results.length} PASS${fail ? ` · ${fail} FAIL` : ' · TODO VERDE'}\n`);
process.exit(fail ? 1 : 0);
