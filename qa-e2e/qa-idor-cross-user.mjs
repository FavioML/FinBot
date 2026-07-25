// Adversarial cross-user IDOR harness for app.neto.pe.
//
// Los harness E2E existentes usan UN solo usuario por plan, asi que nunca prueban
// el peor caso multi-tenant: el usuario A operando sobre IDs de B. Este cierra ese
// hueco. Corre con DOS usuarios QA REALES (A = Pro, el atacante; B = Free, la
// victima) mas un ORACULO service-role que dice la verdad de fondo.
//
// Para cada grupo de endpoints (transactions, budgets, goals, export, score,
// spaces, recurring/override, notifications):
//   1) se siembra data de B (via su propia sesion API, o via el oraculo),
//   2) A intenta leer/editar/borrar esos IDs (por body, query o path),
//   3) se asertan DOS cosas:
//        a) la respuesta NO es un 200 con data de B (ni una escritura efectiva), y
//        b) el ORACULO re-lee la fila de B y confirma que quedo IGUAL.
//
// (b) es la prueba de verdad: varias rutas responden 200/success a una escritura
// cross-user porque el `.eq('usuario_id', ...)` la vuelve un no-op (0 filas). El
// 200 no delata nada; la re-lectura del oraculo si. Es la leccion "verifica el
// efecto, no el HTTP 200" del harness qa-regla-lote.
//
// Uso: node qa-idor-cross-user.mjs
// Creds: ~/.config/neto/qa.env (NETO_QA_* = A Pro, NETO_QA_FREE_* = B Free).
// Service role: SUPABASE_SERVICE_ROLE_KEY del entorno o de webapp/.env.local.
// Se limpia solo (try/finally + marcadores QA-IDOR deterministas).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const TAG = 'QA-IDOR';
const OVR_KEY = 'qa-idor-clave-variante';

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

// A = Pro = atacante. B = Free = victima.
const A = { email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD, uid: env.NETO_QA_USUARIO_ID };
const B = { email: env.NETO_QA_FREE_EMAIL, password: env.NETO_QA_FREE_PASSWORD, uid: env.NETO_QA_FREE_USUARIO_ID };

// Fuente preferente: el mismo qa.env que ya guarda las demas creds del canary
// (una sola fuente de verdad, desacoplada del .env.local de dev del webapp).
// Fallbacks: entorno del proceso, y por ultimo webapp/.env.local (compat).
const SERVICE =
  env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !A.email || !A.password || !B.email || !B.password) {
  console.error('Faltan creds en ~/.config/neto/qa.env (NETO_QA_* y NETO_QA_FREE_*).');
  process.exit(2);
}
if (!SERVICE) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (qa.env, entorno o webapp/.env.local).');
  process.exit(2);
}

const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

// --- oraculo: REST directo sobre Supabase con service role (ignora RLS) ---
async function sb(path, init = {}) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
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
  if (!grant.ok) throw new Error(`Password grant fallo para ${user.email}: ${grant.status}`);
  const session = await grant.json();
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  const pairs = [];
  if (value.length <= MAX) pairs.push(`${cookieName}=${value}`);
  else for (let i = 0, p = 0; p < value.length; i++, p += MAX) pairs.push(`${cookieName}.${i}=${value.slice(p, p + MAX)}`);
  return pairs.join('; ');
}

// --- llamar a /api/* como un usuario (cookie en el header, sin browser) ---
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

const today = new Date().toISOString().slice(0, 10);
const results = { app: APP, attacker: A.uid, victim: B.uid, checks: {} };
const seeded = {};

// Registra un check. `effectSafe` = la data de B quedo intacta (lo critico).
// `leak` = la respuesta expuso data de B (lo peor). `status` se guarda para ver
// que rutas responden 200/success a un no-op cross-user (cosmetico, no vuln).
function record(name, { status, effectSafe, leak = false, note }) {
  results.checks[name] = { status, effectSafe: effectSafe ? 'SAFE' : 'BREACH', ...(leak ? { leak: 'LEAK' } : {}), ...(note ? { note } : {}) };
}

// Limpieza best-effort por marcadores (por si una corrida previa dejo basura).
async function preclean() {
  await sb(`transacciones?usuario_id=eq.${B.uid}&comercio=eq.${encodeURIComponent(TAG)}`, { method: 'DELETE' }).catch(() => {});
  await sb(`presupuestos?usuario_id=eq.${B.uid}&categoria=eq.${encodeURIComponent(TAG)}`, { method: 'DELETE' }).catch(() => {});
  // aportes de metas marcadas se borran al borrar la meta (FK) — primero aportes.
  const metas = await sb(`metas_ahorro?usuario_id=eq.${B.uid}&nombre=eq.${encodeURIComponent(TAG)}&select=id`).catch(() => []);
  for (const m of metas || []) await sb(`meta_aportes?meta_id=eq.${m.id}`, { method: 'DELETE' }).catch(() => {});
  await sb(`metas_ahorro?usuario_id=eq.${B.uid}&nombre=eq.${encodeURIComponent(TAG)}`, { method: 'DELETE' }).catch(() => {});
  await sb(`notificaciones?usuario_id=eq.${B.uid}&titulo=eq.${encodeURIComponent(TAG)}`, { method: 'DELETE' }).catch(() => {});
  for (const uid of [A.uid, B.uid]) await sb(`recurrentes_overrides?usuario_id=eq.${uid}&clave_variante=eq.${encodeURIComponent(OVR_KEY)}`, { method: 'DELETE' }).catch(() => {});
  const spaces = await sb(`shared_spaces?name=eq.${encodeURIComponent(TAG)}&created_by=eq.${B.uid}&select=id`).catch(() => []);
  for (const s of spaces || []) {
    await sb(`space_settlements?space_id=eq.${s.id}`, { method: 'DELETE' }).catch(() => {});
    await sb(`space_expenses?space_id=eq.${s.id}`, { method: 'DELETE' }).catch(() => {});
    await sb(`space_members?space_id=eq.${s.id}`, { method: 'DELETE' }).catch(() => {});
    await sb(`shared_spaces?id=eq.${s.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

async function cleanup() {
  await preclean();
}

let cookieA, cookieB;

try {
  await preclean();
  cookieA = await login(A);
  cookieB = await login(B);

  // --- sanity: las dos cookies autentican de verdad ---
  // A (Pro) puede exportar y el JSON trae SU email (no el de B) = auth + sin fuga.
  const exp = await api(cookieA, 'GET', '/api/export');
  const expStr = JSON.stringify(exp.json || {});
  const aAuthOk = exp.status === 200 && exp.json?.user?.email === A.email;
  const aNoLeakB = !expStr.includes(B.email) && !expStr.includes(B.uid);
  record('sanity: A autentica (export propio)', { status: exp.status, effectSafe: aAuthOk });
  // export es inmune a IDOR (no toma id): confirmamos que no filtra a B por accidente.
  record('export: A no ve data de B', { status: exp.status, effectSafe: aNoLeakB, leak: !aNoLeakB });
  // B (Free) autenticado pero bloqueado por plan = su cookie SI vale (si no, seria 401).
  const expB = await api(cookieB, 'GET', '/api/export');
  record('sanity: B autentica (export 403 por plan Free, no 401)', { status: expB.status, effectSafe: expB.status === 403 });

  // ============ SEED de la victima B ============
  // tx / budget / goal / aporte / override via la propia sesion API de B (camino real);
  // notif y space via oraculo (no hay POST, y B-Free tiene tope de 1 espacio).
  const txSeed = await api(cookieB, 'POST', '/api/transactions', {
    monto: 13.5, tipo: 'gasto', moneda: 'PEN', comercio: TAG, categoria: 'Otros', fecha: today, metodo_pago: 'Efectivo',
  });
  seeded.txId = txSeed.json?.id;

  const budgetSeed = await api(cookieB, 'POST', '/api/budgets', {
    categoria: TAG, monto_limite: 100, alerta_porcentaje: 80,
  });
  seeded.budgetId = budgetSeed.json?.id;

  const goalSeed = await api(cookieB, 'POST', '/api/goals', {
    nombre: TAG, monto_objetivo: 500, monto_actual: 0,
  });
  seeded.goalId = goalSeed.json?.id;

  const aporteSeed = await api(cookieB, 'POST', '/api/goals/aportes', {
    meta_id: seeded.goalId, monto: 50, tipo: 'aporte', nota: TAG,
  });
  seeded.aporteId = aporteSeed.json?.aporte?.id;

  await api(cookieB, 'POST', '/api/recurring/override', {
    dominio: 'suscripcion', clave_variante: OVR_KEY, oculto: true, label_canonico: TAG,
  });

  const notifSeed = await sb('notificaciones', {
    method: 'POST',
    body: JSON.stringify({ usuario_id: B.uid, tipo: 'test', titulo: TAG, mensaje: 'qa idor', datos: {}, leida: false, fecha: new Date().toISOString() }),
  });
  seeded.notifId = notifSeed?.[0]?.id;

  const spaceSeed = await sb('shared_spaces', {
    method: 'POST',
    body: JSON.stringify({ name: TAG, type: 'custom', invite_code: ('IDOR' + Math.random().toString(36).slice(2, 5)).toUpperCase(), created_by: B.uid }),
  });
  seeded.spaceId = spaceSeed?.[0]?.id;
  await sb('space_members', {
    method: 'POST',
    body: JSON.stringify({ space_id: seeded.spaceId, user_id: B.uid, role: 'owner', split_percentage: 50 }),
  });

  results.seeded = {
    tx: !!seeded.txId, budget: !!seeded.budgetId, goal: !!seeded.goalId,
    aporte: !!seeded.aporteId, notif: !!seeded.notifId, space: !!seeded.spaceId,
  };
  const seedOk = Object.values(results.seeded).every(Boolean);
  record('seed de la victima B completo (test no vacuo)', { status: seedOk ? 200 : 500, effectSafe: seedOk });
  if (!seedOk) throw new Error('El seed de B fallo; abortando para no dar falsos PASS. seeded=' + JSON.stringify(seeded));

  // helper oraculo: fila de B por id
  const row = async (tabla, id, cols = '*') => (await sb(`${tabla}?id=eq.${id}&select=${cols}`))?.[0];

  // ============ ATAQUES de A sobre IDs de B ============

  // ---- /api/transactions ----
  let r;
  r = await api(cookieA, 'PUT', '/api/transactions', { id: seeded.txId, monto: 99999, tipo: 'gasto', moneda: 'PEN', categoria: 'HACKED', fecha: today });
  {
    const tx = await row('transacciones', seeded.txId, 'monto,categoria');
    record('transactions PUT id de B', { status: r.status, effectSafe: tx && Number(tx.monto) === 13.5 && tx.categoria === 'Otros' });
  }
  r = await api(cookieA, 'PATCH', '/api/transactions', { ids: [seeded.txId], updates: { categoria: 'HACKED' } });
  {
    const tx = await row('transacciones', seeded.txId, 'categoria');
    const noop = r.json?.updated === 0;
    record('transactions PATCH id de B (lote)', { status: r.status, effectSafe: tx?.categoria === 'Otros', note: noop ? 'updated:0 (no-op scoped)' : 'updated!=0' });
  }
  r = await api(cookieA, 'DELETE', `/api/transactions?id=${seeded.txId}`);
  {
    const tx = await row('transacciones', seeded.txId, 'id');
    record('transactions DELETE id de B', { status: r.status, effectSafe: !!tx });
  }

  // ---- /api/budgets ----
  r = await api(cookieA, 'PUT', '/api/budgets', { id: seeded.budgetId, categoria: 'HACKED', monto_limite: 1, alerta_porcentaje: 10 });
  {
    const bg = await row('presupuestos', seeded.budgetId, 'categoria,monto_limite');
    record('budgets PUT id de B', { status: r.status, effectSafe: bg && bg.categoria === TAG && Number(bg.monto_limite) === 100 });
  }
  r = await api(cookieA, 'DELETE', `/api/budgets?id=${seeded.budgetId}`);
  {
    const bg = await row('presupuestos', seeded.budgetId, 'id');
    record('budgets DELETE id de B', { status: r.status, effectSafe: !!bg, note: r.status === 200 ? 'success:true en delete de 0 filas (cosmetico)' : undefined });
  }

  // ---- /api/goals ----
  r = await api(cookieA, 'PUT', '/api/goals', { id: seeded.goalId, nombre: 'HACKED', monto_objetivo: 1, monto_actual: 1 });
  {
    const g = await row('metas_ahorro', seeded.goalId, 'nombre');
    record('goals PUT id de B', { status: r.status, effectSafe: g?.nombre === TAG });
  }
  r = await api(cookieA, 'DELETE', `/api/goals?id=${seeded.goalId}`);
  {
    const g = await row('metas_ahorro', seeded.goalId, 'id');
    record('goals DELETE id de B', { status: r.status, effectSafe: !!g, note: r.status === 200 ? 'success:true en delete de 0 filas (cosmetico)' : undefined });
  }
  r = await api(cookieA, 'POST', `/api/goals/${seeded.goalId}/abandon`);
  {
    const g = await row('metas_ahorro', seeded.goalId, 'status');
    record('goals/[id]/abandon meta de B', { status: r.status, effectSafe: g?.status !== 'abandoned' });
  }

  // ---- /api/goals/aportes ----
  r = await api(cookieA, 'GET', `/api/goals/aportes?meta_id=${seeded.goalId}`);
  {
    const leak = r.status === 200 && Array.isArray(r.json) && r.json.length > 0;
    record('goals/aportes GET meta de B', { status: r.status, effectSafe: !leak, leak });
  }
  r = await api(cookieA, 'POST', '/api/goals/aportes', { meta_id: seeded.goalId, monto: 77, tipo: 'aporte' });
  {
    const aportes = await sb(`meta_aportes?meta_id=eq.${seeded.goalId}&select=id`);
    record('goals/aportes POST a meta de B', { status: r.status, effectSafe: (aportes || []).length === 1 });
  }
  r = await api(cookieA, 'DELETE', `/api/goals/aportes?id=${seeded.aporteId}`);
  {
    const ap = await row('meta_aportes', seeded.aporteId, 'id');
    record('goals/aportes DELETE aporte de B', { status: r.status, effectSafe: !!ap });
  }

  // ---- /api/score ---- (sin id de cliente: sin superficie IDOR; solo sanity)
  r = await api(cookieA, 'GET', '/api/score');
  record('score GET (solo propio, sin vector cross-user)', { status: r.status, effectSafe: r.status === 200 && typeof r.json?.score === 'number', note: 'score/backfill comparte el mismo chokepoint (requireNetoUser), tampoco toma id' });

  // ---- /api/recurring/override ---- (upsert/delete scoped por usuario_id)
  r = await api(cookieA, 'POST', '/api/recurring/override', { dominio: 'suscripcion', clave_variante: OVR_KEY, oculto: false, label_canonico: 'HACKED' });
  {
    const ovr = (await sb(`recurrentes_overrides?usuario_id=eq.${B.uid}&clave_variante=eq.${encodeURIComponent(OVR_KEY)}&select=oculto,label_canonico`))?.[0];
    record('recurring/override POST clave de B', { status: r.status, effectSafe: ovr && ovr.oculto === true && ovr.label_canonico === TAG, note: 'crea el override PROPIO de A, no toca el de B' });
  }
  r = await api(cookieA, 'DELETE', `/api/recurring/override?dominio=suscripcion&clave_variante=${encodeURIComponent(OVR_KEY)}`);
  {
    const ovr = (await sb(`recurrentes_overrides?usuario_id=eq.${B.uid}&clave_variante=eq.${encodeURIComponent(OVR_KEY)}&select=usuario_id`))?.[0];
    record('recurring/override DELETE clave de B', { status: r.status, effectSafe: !!ovr });
  }

  // ---- /api/notifications/inbox ----
  r = await api(cookieA, 'PUT', '/api/notifications/inbox', { ids: [seeded.notifId] });
  {
    const nt = await row('notificaciones', seeded.notifId, 'leida');
    record('notifications/inbox PUT (marcar leida) id de B', { status: r.status, effectSafe: nt?.leida === false, note: r.status === 200 ? 'success:true en update de 0 filas (cosmetico)' : undefined });
  }
  r = await api(cookieA, 'DELETE', `/api/notifications/inbox?id=${seeded.notifId}`);
  {
    const nt = await row('notificaciones', seeded.notifId, 'id');
    record('notifications/inbox DELETE id de B', { status: r.status, effectSafe: !!nt, note: r.status === 200 ? 'success:true en delete de 0 filas (cosmetico)' : undefined });
  }

  // ---- /api/spaces/* (membresia) — A NO es miembro del espacio de B ----
  r = await api(cookieA, 'GET', `/api/spaces/${seeded.spaceId}`);
  {
    const leak = r.status === 200 && !!r.json?.space;
    record('spaces [id] GET espacio de B (no miembro)', { status: r.status, effectSafe: r.status === 403 && !leak, leak });
  }
  r = await api(cookieA, 'PUT', `/api/spaces/${seeded.spaceId}`, { name: 'HACKED' });
  {
    const s = await row('shared_spaces', seeded.spaceId, 'name');
    record('spaces [id] PUT (rename) espacio de B', { status: r.status, effectSafe: s?.name === TAG });
  }
  r = await api(cookieA, 'POST', `/api/spaces/${seeded.spaceId}/expenses`, { amount: 10, description: 'HACKED', category: 'Otros' });
  {
    const exps = await sb(`space_expenses?space_id=eq.${seeded.spaceId}&select=id`);
    record('spaces [id]/expenses POST en espacio de B', { status: r.status, effectSafe: (exps || []).length === 0 });
  }
  r = await api(cookieA, 'POST', `/api/spaces/${seeded.spaceId}/settle`, { to_user: B.uid, amount: 5 });
  {
    const setts = await sb(`space_settlements?space_id=eq.${seeded.spaceId}&select=id`);
    record('spaces [id]/settle POST en espacio de B', { status: r.status, effectSafe: (setts || []).length === 0 });
  }
  r = await api(cookieA, 'PUT', `/api/spaces/${seeded.spaceId}/default-split`, { splits: { [B.uid]: 90 } });
  {
    const mem = (await sb(`space_members?space_id=eq.${seeded.spaceId}&user_id=eq.${B.uid}&select=split_percentage`))?.[0];
    record('spaces [id]/default-split PUT en espacio de B', { status: r.status, effectSafe: mem && Number(mem.split_percentage) === 50 });
  }
  r = await api(cookieA, 'DELETE', `/api/spaces/${seeded.spaceId}/members?userId=${B.uid}`);
  {
    const mem = (await sb(`space_members?space_id=eq.${seeded.spaceId}&user_id=eq.${B.uid}&select=user_id`))?.[0];
    record('spaces [id]/members DELETE en espacio de B', { status: r.status, effectSafe: !!mem });
  }
  r = await api(cookieA, 'DELETE', `/api/spaces/${seeded.spaceId}`);
  {
    const s = await row('shared_spaces', seeded.spaceId, 'id');
    record('spaces [id] DELETE espacio de B', { status: r.status, effectSafe: !!s });
  }

} catch (e) {
  results.error = String(e).split('\n')[0];
} finally {
  await cleanup().catch((e) => { results.cleanupError = String(e).split('\n')[0]; });
}

// --- veredicto ---
const entries = Object.entries(results.checks);
const breaches = entries.filter(([, c]) => c.effectSafe !== 'SAFE').map(([k]) => k);
const leaks = entries.filter(([, c]) => c.leak === 'LEAK').map(([k]) => k);
results.summary = {
  total: entries.length,
  safe: entries.filter(([, c]) => c.effectSafe === 'SAFE').length,
  breaches,
  leaks,
};
results.allPass = breaches.length === 0 && !results.error;

console.log(JSON.stringify(results, null, 2));

// Convencion del canary: exit 1 = breach REAL (A leyo/escribio data de B),
// exit 2 = infra (login/seed/red se cayo y no se pudo completar el barrido).
// Un breach manda sobre un error: si algo cross-user paso, es 1 aunque ademas
// falle algo de infra.
if (breaches.length > 0) process.exit(1);
if (results.error) process.exit(2);
process.exit(0);
