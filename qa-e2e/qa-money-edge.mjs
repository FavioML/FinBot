// Harness E2E de montos límite en las rutas de dinero de app.neto.pe.
//
// Cierra el hueco que los harness "felices" no cubren: montos inválidos en los
// ENDPOINTS DE EDICIÓN. El barrido de edge cases (2026-07-24) encontró 4 BUGs:
//   P0  debts PUT action=abonar   — sin isFinite/tope/sobrepago → Infinity se
//        serializaba a null en deuda_abonos.monto → el reduce daba NaN →
//        monto_pendiente NaN → deuda ENVENENADA de forma permanente.
//   P1  goals PUT                 — objetivo crudo (parseFloat||0): 0/neg/Infinity.
//   P1  budgets PUT               — monto_limite crudo: 0/neg → pct = /0.
//   P1  services/budget.js        — único write de dinero del backend sin validarMonto.
//
// 2026-08-13 — se extiende con S′6 (auditoría CTO del 10-ago), la ÚLTIMA escritura de
// plata que quedaba fuera del validador: `PUT /api/spaces/[id]/budgets` solo miraba
// `Array.isArray` y escribía el JSONB crudo. Espacios es donde menos red hay (tablas
// service-role-only, RLS deny-all), y ese límite alimenta la barra de progreso y el
// "le toca X" de CADA miembro del espacio, no solo del que lo escribió.
//
// Este harness siembra data del QA Pro por su propia sesión API, dispara cada
// input inválido (1000000, Infinity vía "1e999", NaN, -5, 0, sobrepago) y asserta
// DOS cosas, igual que qa-idor: (a) la respuesta es 400 (rechazo), y (b) el ORÁCULO
// service-role re-lee la fila y confirma que NO se corrompió (el monto quedó finito
// y sin cambios). (b) es la prueba de verdad: el 400 solo dice que la ruta se quejó;
// que la deuda no quedó en NaN lo dice la re-lectura.
//
// Uso: node qa-money-edge.mjs
// Creds: ~/.config/neto/qa.env (NETO_QA_* = Pro). Service role: SUPABASE_SERVICE_ROLE_KEY
// del entorno o de webapp/.env.local. Se limpia solo (try/finally + marcador QA-MONEY).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const TAG = 'QA-MONEY';

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

// --- oráculo: REST directo con service role (ignora RLS) ---
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

// --- auth: password grant -> cookie SSR forjada (ver qa-login.mjs) ---
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

// Un número es "sano" si es finito (no null, no NaN, no Infinity). El envenenamiento
// dejaba monto_pendiente = null (Infinity serializado) o NaN.
function esFinito(v) { return v !== null && v !== undefined && Number.isFinite(Number(v)); }

const results = [];
let cookie;

function ok(name, cond, note) { results.push({ name, pass: !!cond, note }); }

// --- limpieza por marcador ---
async function cleanup() {
  const deudas = await sb(`deudas?usuario_id=eq.${U.uid}&contraparte=eq.${TAG}&select=id`).catch(() => []);
  for (const d of deudas || []) await sb(`deuda_abonos?deuda_id=eq.${d.id}`, { method: 'DELETE' }).catch(() => {});
  await sb(`deudas?usuario_id=eq.${U.uid}&contraparte=eq.${TAG}`, { method: 'DELETE' }).catch(() => {});
  const metas = await sb(`metas_ahorro?usuario_id=eq.${U.uid}&nombre=eq.${TAG}&select=id`).catch(() => []);
  for (const m of metas || []) await sb(`meta_aportes?meta_id=eq.${m.id}`, { method: 'DELETE' }).catch(() => {});
  await sb(`metas_ahorro?usuario_id=eq.${U.uid}&nombre=eq.${TAG}`, { method: 'DELETE' }).catch(() => {});
  await sb(`presupuestos?usuario_id=eq.${U.uid}&categoria=eq.${TAG}`, { method: 'DELETE' }).catch(() => {});
  // Espacios: los miembros primero (FK). Por nombre, que lleva el marcador; borrar por
  // `created_by` se llevaría por delante los espacios REALES del usuario QA.
  const esp = await sb(`shared_spaces?name=eq.${TAG}&select=id`).catch(() => []);
  for (const e of esp || []) {
    await sb(`space_expenses?space_id=eq.${e.id}`, { method: 'DELETE' }).catch(() => {});
    await sb(`space_settlements?space_id=eq.${e.id}`, { method: 'DELETE' }).catch(() => {});
    await sb(`space_members?space_id=eq.${e.id}`, { method: 'DELETE' }).catch(() => {});
  }
  await sb(`shared_spaces?name=eq.${TAG}`, { method: 'DELETE' }).catch(() => {});
}

try {
  await cleanup();
  cookie = await login(U);

  // sanity: la cookie autentica de verdad (export propio, no 401)
  const exp = await api(cookie, 'GET', '/api/export');
  ok('sanity: QA Pro autentica', exp.status === 200 && exp.json?.user?.email === U.email, `status ${exp.status}`);

  // ─────────────────────────────────────────────────────────────
  // P0 — debts PUT action=abonar: el envenenamiento permanente
  // ─────────────────────────────────────────────────────────────
  const nuevaDeuda = await api(cookie, 'POST', '/api/debts', {
    tipo: 'debo', contraparte: TAG, monto_original: 100, moneda: 'PEN',
  });
  ok('debts POST: crea deuda válida S/100', nuevaDeuda.status === 200 && esFinito(nuevaDeuda.json?.monto_pendiente), `status ${nuevaDeuda.status}`);
  const deudaId = nuevaDeuda.json?.id;

  if (deudaId) {
    // Infinity (el vector del envenenamiento): "1e999" → parseFloat → Infinity
    const abInf = await api(cookie, 'PUT', '/api/debts', { id: deudaId, action: 'abonar', monto: '1e999' });
    const trasInf = (await sb(`deudas?id=eq.${deudaId}&select=monto_pendiente`))?.[0];
    ok('debts abonar Infinity → 400', abInf.status === 400, `status ${abInf.status}`);
    ok('debts abonar Infinity → deuda NO envenenada (pendiente finito = 100)',
      esFinito(trasInf?.monto_pendiente) && Number(trasInf.monto_pendiente) === 100, `pendiente ${trasInf?.monto_pendiente}`);

    // Monto sobre el tope de la columna
    const abTope = await api(cookie, 'PUT', '/api/debts', { id: deudaId, action: 'abonar', monto: 1000000 });
    ok('debts abonar 1000000 (>tope) → 400', abTope.status === 400, `status ${abTope.status}`);

    // Sobrepago (guard nuevo en webapp; el backend ya lo tenía)
    const abOver = await api(cookie, 'PUT', '/api/debts', { id: deudaId, action: 'abonar', monto: 500 });
    const trasOver = (await sb(`deudas?id=eq.${deudaId}&select=monto_pendiente`))?.[0];
    ok('debts abonar sobrepago (500 > 100) → 400', abOver.status === 400, `status ${abOver.status}`);
    ok('debts abonar sobrepago → pendiente intacto (100)', Number(trasOver?.monto_pendiente) === 100, `pendiente ${trasOver?.monto_pendiente}`);

    // Abono válido: baja el pendiente correctamente
    const abOk = await api(cookie, 'PUT', '/api/debts', { id: deudaId, action: 'abonar', monto: 40 });
    const trasOk = (await sb(`deudas?id=eq.${deudaId}&select=monto_pendiente`))?.[0];
    ok('debts abonar válido (40) → 200', abOk.status === 200, `status ${abOk.status}`);
    ok('debts abonar válido → pendiente = 60', Number(trasOk?.monto_pendiente) === 60, `pendiente ${trasOk?.monto_pendiente}`);
  }

  // debts POST inválidos
  const dPostInf = await api(cookie, 'POST', '/api/debts', { tipo: 'debo', contraparte: TAG, monto_original: '1e999', moneda: 'PEN' });
  ok('debts POST Infinity → 400', dPostInf.status === 400, `status ${dPostInf.status}`);
  const dPostTope = await api(cookie, 'POST', '/api/debts', { tipo: 'debo', contraparte: TAG, monto_original: 1000000, moneda: 'PEN' });
  ok('debts POST 1000000 (>tope) → 400', dPostTope.status === 400, `status ${dPostTope.status}`);

  // ─────────────────────────────────────────────────────────────
  // P1 — goals PUT: objetivo corrupto
  // ─────────────────────────────────────────────────────────────
  const nuevaMeta = await api(cookie, 'POST', '/api/goals', { nombre: TAG, monto_objetivo: 1000, monto_actual: 0 });
  ok('goals POST: crea meta válida objetivo 1000', nuevaMeta.status === 200, `status ${nuevaMeta.status}`);
  const metaId = nuevaMeta.json?.id;

  if (metaId) {
    for (const [label, malo] of [['0', 0], ['negativo', -5], ['Infinity', '1e999'], ['>tope', 1000000]]) {
      const r = await api(cookie, 'PUT', '/api/goals', { id: metaId, nombre: TAG, monto_objetivo: malo, monto_actual: 0 });
      const tras = (await sb(`metas_ahorro?id=eq.${metaId}&select=monto_objetivo`))?.[0];
      ok(`goals PUT objetivo ${label} → 400`, r.status === 400, `status ${r.status}`);
      ok(`goals PUT objetivo ${label} → objetivo intacto (1000)`, Number(tras?.monto_objetivo) === 1000, `objetivo ${tras?.monto_objetivo}`);
    }
    const gOk = await api(cookie, 'PUT', '/api/goals', { id: metaId, nombre: TAG, monto_objetivo: 2000, monto_actual: 0 });
    ok('goals PUT objetivo válido (2000) → 200', gOk.status === 200, `status ${gOk.status}`);
  }

  // ─────────────────────────────────────────────────────────────
  // P1 — budgets PUT: límite corrupto (división por cero en el %)
  // ─────────────────────────────────────────────────────────────
  const nuevoPres = await api(cookie, 'POST', '/api/budgets', { categoria: TAG, monto_limite: 500 });
  ok('budgets POST: crea presupuesto válido S/500', nuevoPres.status === 200, `status ${nuevoPres.status}`);
  const presId = nuevoPres.json?.id;

  if (presId) {
    for (const [label, malo] of [['0', 0], ['negativo', -50], ['Infinity', '1e999'], ['>tope', 1000000]]) {
      const r = await api(cookie, 'PUT', '/api/budgets', { id: presId, categoria: TAG, monto_limite: malo });
      const tras = (await sb(`presupuestos?id=eq.${presId}&select=monto_limite`))?.[0];
      ok(`budgets PUT límite ${label} → 400`, r.status === 400, `status ${r.status}`);
      ok(`budgets PUT límite ${label} → límite intacto (500)`, Number(tras?.monto_limite) === 500, `límite ${tras?.monto_limite}`);
    }
    const bOk = await api(cookie, 'PUT', '/api/budgets', { id: presId, categoria: TAG, monto_limite: 800 });
    ok('budgets PUT límite válido (800) → 200', bOk.status === 200, `status ${bOk.status}`);
  }

  // ─────────────────────────────────────────────────────────────
  // S′6 — spaces/[id]/budgets PUT: el JSONB de presupuestos conjuntos
  //
  // El oráculo acá NO es la fila de un `presupuestos`: es `shared_spaces.budgets`, un
  // JSONB. Por eso se re-lee entero y se compara contra el límite sembrado. Un límite
  // Infinity no queda "raro" en la columna, queda `null` (JSON.stringify(Infinity)), y
  // la UI divide contra eso en la pantalla de todos los miembros.
  // ─────────────────────────────────────────────────────────────
  const nuevoEsp = await api(cookie, 'POST', '/api/spaces', { name: TAG, type: 'custom' });
  ok('spaces POST: el QA Pro crea un espacio', nuevoEsp.status === 201 && !!nuevoEsp.json?.id, `status ${nuevoEsp.status}`);
  const espId = nuevoEsp.json?.id;

  if (espId) {
    const leerBudgets = async () =>
      (await sb(`shared_spaces?id=eq.${espId}&select=budgets`))?.[0]?.budgets;

    // Semilla válida: es la línea base contra la que se mide "no se corrompió".
    //
    // Se RE-SIEMBRA antes de cada caso, por el service role y no por la ruta. Sin eso,
    // el primer caso que pase (o sea, con el código viejo: el primero de todos) deja el
    // JSONB corrupto y los "intacto (300)" siguientes miden esa corrupción en vez de la
    // suya — 20 fallos en cascada de los que solo uno es real. La corrida de control
    // contra prod lo mostró tal cual.
    const semilla = [{ id: 'sbud-qa', category: 'Transporte', limit: 300 }];
    const resembrar = () => sb(`shared_spaces?id=eq.${espId}`, {
      method: 'PATCH', body: JSON.stringify({ budgets: semilla }),
    });

    const seed = await api(cookie, 'PUT', `/api/spaces/${espId}/budgets`, { budgets: semilla });
    ok('spaces budgets PUT válido (S/300) → 200', seed.status === 200, `status ${seed.status}`);
    ok('spaces budgets PUT válido → persistió 300', Number((await leerBudgets())?.[0]?.limit) === 300);

    const malos = [
      ['Infinity', '1e999'],
      ['NaN', 'abc'],
      ['0', 0],
      ['negativo', -50],
      ['>tope', 1000000],
      ['null', null],
      // `Number(true) === 1`: sin filtro de tipo esto entraba como un límite de S/1.
      ['booleano', true],
      ['array', [1]],
    ];
    for (const [label, limit] of malos) {
      await resembrar();
      const r = await api(cookie, 'PUT', `/api/spaces/${espId}/budgets`, {
        budgets: [{ id: 'sbud-qa', category: 'Transporte', limit }],
      });
      const tras = await leerBudgets();
      ok(`spaces budgets límite ${label} → 400`, r.status === 400, `status ${r.status}`);
      ok(`spaces budgets límite ${label} → JSONB intacto (300)`,
        Array.isArray(tras) && tras.length === 1 && esFinito(tras[0]?.limit) && Number(tras[0].limit) === 300,
        `budgets ${JSON.stringify(tras)}`);
    }

    // La forma del objeto, no solo el número.
    for (const [label, budgets] of [
      ['no-array', { a: 1 }],
      ['item no-objeto', ['texto']],
      ['sin categoría', [{ id: 'x', limit: 100 }]],
      ['categoría duplicada', [{ id: 'a', category: 'Comida', limit: 10 }, { id: 'b', category: 'Comida', limit: 20 }]],
      ['lista sin cota', Array.from({ length: 51 }, (_, i) => ({ id: `b${i}`, category: `C${i}`, limit: 10 }))],
    ]) {
      await resembrar();
      const r = await api(cookie, 'PUT', `/api/spaces/${espId}/budgets`, { budgets });
      const tras = await leerBudgets();
      ok(`spaces budgets ${label} → 400`, r.status === 400, `status ${r.status}`);
      ok(`spaces budgets ${label} → JSONB intacto (300)`,
        Array.isArray(tras) && tras.length === 1 && Number(tras[0]?.limit) === 300,
        `budgets ${JSON.stringify(tras)}`);
    }

    // Lo válido sigue entrando, y solo con las tres llaves de la forma cerrada: si el
    // guard dejara pasar el objeto del cliente, `esPro` viajaría al JSONB.
    await resembrar();
    const okPut = await api(cookie, 'PUT', `/api/spaces/${espId}/budgets`, {
      budgets: [{ id: 'sbud-qa', category: 'Transporte', limit: 500, esPro: true }],
    });
    const trasOk = await leerBudgets();
    ok('spaces budgets PUT válido (500) → 200', okPut.status === 200, `status ${okPut.status}`);
    ok('spaces budgets PUT válido → persistió 500', Number(trasOk?.[0]?.limit) === 500, `budgets ${JSON.stringify(trasOk)}`);
    ok('spaces budgets → el JSONB solo lleva {id, category, limit}',
      trasOk?.[0] && Object.keys(trasOk[0]).sort().join(',') === 'category,id,limit',
      `llaves ${Object.keys(trasOk?.[0] || {}).join(',')}`);

    // Y la lista vacía (borrar el último presupuesto) no puede caer en el rechazo.
    const vacio = await api(cookie, 'PUT', `/api/spaces/${espId}/budgets`, { budgets: [] });
    ok('spaces budgets PUT [] (borrar el último) → 200', vacio.status === 200, `status ${vacio.status}`);
  }

} catch (e) {
  ok('harness sin excepción', false, e.message);
} finally {
  await cleanup().catch(() => {});
}

// --- reporte ---
const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\n${'═'.repeat(64)}\nQA MONEY EDGE — ${APP}\n${'═'.repeat(64)}`);
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.note ? `  (${r.note})` : ''}`);
console.log(`${'─'.repeat(64)}\n${pass}/${results.length} PASS${fail ? ` · ${fail} FAIL` : ' · TODO VERDE'}\n`);
process.exit(fail ? 1 : 0);
