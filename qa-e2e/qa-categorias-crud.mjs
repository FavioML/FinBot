// E2E del CRUD completo de categorías desde el panel (app.neto.pe).
//
// Cubre el POST nuevo de /api/categories (crear raíz + sub sin registrar gasto),
// más rename/delete y los casos borde que el rework introduce:
//   - crear raíz y sub (201 + fila devuelta)
//   - crear duplicado activo → 409 (NO 500, NO 201): el unique constraint
//     (usuario_id, nombre, padre_id) se maneja con gracia
//   - sub con padre ajeno/inexistente → 404 (ownership)
//   - renombrar raíz y sub (200 + reflejado en GET)
//   - subcategoría "system" (id null): materializar al renombrar (crea fila real
//     + tombstone del nombre viejo) y tombstone al eliminar → aparecen en
//     deletedSubNames del GET (para que el default hardcodeado no reaparezca)
//   - reactivación: borrar una raíz y recrearla con el mismo nombre reactiva la
//     MISMA fila (200, mismo id), en vez de chocar con el constraint
//
// Auth: password grant + cookie SSR forjada (ver qa-idor-cross-user.mjs). Las
// llamadas van directo a /api/* con la cookie (sin browser, robusto). Oráculo
// service-role solo para limpiar (hard-delete de filas QA-CRUD*). Self-cleaning.
//
// Uso: node qa-categorias-crud.mjs
// Creds: ~/.config/neto/qa.env. Exit 0 = todo PASS, 1 = alguna falló, 2 = setup.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const TAG = 'QA-CRUD';

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
// Categorías no están gateadas por plan: cualquier usuario QA sirve.
const USER = {
  email: env.NETO_QA_EMAIL,
  password: env.NETO_QA_PASSWORD,
  uid: env.NETO_QA_USUARIO_ID,
};
const SERVICE =
  env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !USER.email || !USER.password || !USER.uid) {
  console.error('Faltan creds en ~/.config/neto/qa.env (NETO_QA_* con NETO_QA_USUARIO_ID).');
  process.exit(2);
}
if (!SERVICE) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (qa.env, entorno o webapp/.env.local).');
  process.exit(2);
}

const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;
const today = new Date().toISOString().slice(0, 10);

// --- oráculo service-role (ignora RLS), solo para limpiar ---
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

const results = { app: APP, user: USER.uid, checks: {} };
let allPass = true;
function record(name, pass, note) {
  results.checks[name] = pass ? 'PASS' : `FAIL${note ? ` (${note})` : ''}`;
  if (!pass) allPass = false;
}

// Hard-delete de todo lo marcado QA-CRUD para este usuario (subs antes que raíces por el FK padre_id).
async function cleanup() {
  const like = `ilike.${TAG}*`;
  await sb(`transacciones?usuario_id=eq.${USER.uid}&comercio=${like}`, { method: 'DELETE' }).catch(() => {});
  await sb(`presupuestos?usuario_id=eq.${USER.uid}&categoria=${like}`, { method: 'DELETE' }).catch(() => {});
  await sb(`reglas_comercio?usuario_id=eq.${USER.uid}&comercio_pattern=${like}`, { method: 'DELETE' }).catch(() => {});
  await sb(`categorias_usuario?usuario_id=eq.${USER.uid}&padre_id=not.is.null&nombre=${like}`, { method: 'DELETE' }).catch(() => {});
  await sb(`categorias_usuario?usuario_id=eq.${USER.uid}&padre_id=is.null&nombre=${like}`, { method: 'DELETE' }).catch(() => {});
}

const cookie = await login(USER);
await cleanup(); // por si una corrida previa dejó basura

try {
  // 1. Crear raíz
  const root = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Root` });
  const rootId = root.json?.id;
  record('crear raíz -> 201 + fila', root.status === 201 && !!rootId, `status=${root.status}`);

  // 2. Duplicado activo -> 409 (ni 500 ni 201)
  const dup = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Root` });
  record('duplicado activo -> 409 (no 500)', dup.status === 409, `status=${dup.status}`);

  // 3. Crear sub
  const sub = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Sub`, padreId: rootId });
  const subId = sub.json?.id;
  record('crear sub -> 201 + fila', sub.status === 201 && !!subId, `status=${sub.status}`);

  // 3b. Sub con padre inexistente/ajeno -> 404
  const badSub = await api(cookie, 'POST', '/api/categories', {
    nombre: `${TAG} Bad`, padreId: '00000000-0000-0000-0000-000000000000',
  });
  record('sub con padre inválido -> 404', badSub.status === 404, `status=${badSub.status}`);

  // 4. Renombrar raíz + verificar en GET
  const renRoot = await api(cookie, 'PUT', '/api/categories', { id: rootId, nombre: `${TAG} Root2` });
  record('renombrar raíz -> 200', renRoot.status === 200, `status=${renRoot.status}`);

  let cats = (await api(cookie, 'GET', '/api/categories')).json || [];
  let rootObj = cats.find((c) => c.id === rootId);
  record('rename raíz reflejado en GET', rootObj?.nombre === `${TAG} Root2`, rootObj?.nombre);

  // 5. Renombrar sub
  const renSub = await api(cookie, 'PUT', '/api/categories', { id: subId, nombre: `${TAG} Sub2` });
  record('renombrar sub -> 200', renSub.status === 200, `status=${renSub.status}`);

  // 6. Materializar sub system (rename): crea fila real + tombstone del nombre viejo
  const sys = await api(cookie, 'PUT', '/api/categories', {
    system: true, padreId: rootId, oldNombre: `${TAG} Def`, nombre: `${TAG} Mat`,
  });
  record('materializar sub system -> 200', sys.status === 200, `status=${sys.status}`);

  cats = (await api(cookie, 'GET', '/api/categories')).json || [];
  rootObj = cats.find((c) => c.id === rootId);
  const subNames = (rootObj?.subcategorias || []).map((s) => s.nombre.toLowerCase());
  const deleted = (rootObj?.deletedSubNames || []).map((s) => s.toLowerCase());
  record('sub materializada visible en GET', subNames.includes(`${TAG.toLowerCase()} mat`), subNames.join(','));
  record('tombstone del viejo en deletedSubNames', deleted.includes(`${TAG.toLowerCase()} def`), deleted.join(','));

  // 7. Tombstone al eliminar una sub system (default hardcodeado)
  const delSys = await api(cookie, 'DELETE',
    `/api/categories?system=true&padreId=${rootId}&nombre=${encodeURIComponent(`${TAG} Ghost`)}`);
  record('delete sub system -> 200', delSys.status === 200, `status=${delSys.status}`);
  cats = (await api(cookie, 'GET', '/api/categories')).json || [];
  rootObj = cats.find((c) => c.id === rootId);
  const deleted2 = (rootObj?.deletedSubNames || []).map((s) => s.toLowerCase());
  record('ghost en deletedSubNames', deleted2.includes(`${TAG.toLowerCase()} ghost`), deleted2.join(','));

  // 8. Eliminar sub real -> desaparece del GET
  const delSub = await api(cookie, 'DELETE', `/api/categories?id=${subId}&sub=true`);
  record('eliminar sub -> 200', delSub.status === 200, `status=${delSub.status}`);
  cats = (await api(cookie, 'GET', '/api/categories')).json || [];
  rootObj = cats.find((c) => c.id === rootId);
  const stillThere = (rootObj?.subcategorias || []).some((s) => s.id === subId);
  record('sub eliminada no aparece en GET', !stillThere);

  // 9. Reactivación: borrar raíz y recrearla con el mismo nombre reactiva la misma fila
  const delRoot = await api(cookie, 'DELETE', `/api/categories?id=${rootId}`);
  record('eliminar raíz -> 200', delRoot.status === 200, `status=${delRoot.status}`);
  const react = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Root2` });
  record('recrear reactiva la fila (200, mismo id)',
    react.status === 200 && react.json?.id === rootId, `status=${react.status} id=${react.json?.id}`);

  // 10. Desvinculación de transacciones al borrar (aviso + detach)
  const txroot = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Txroot` });
  const txrootId = txroot.json.id;
  const txsub = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Txsub`, padreId: txrootId });
  const txsubId = txsub.json.id;
  for (const c of ['t1', 't2']) {
    await api(cookie, 'POST', '/api/transactions', { monto: 6, tipo: 'gasto', moneda: 'PEN', comercio: `${TAG} ${c}`, categoria: `${TAG} Txroot`, subcategoria: `${TAG} Txsub`, fecha: today, metodo_pago: 'Efectivo' });
  }

  // usage: cuenta las tx ligadas a la sub
  const usageSub = await api(cookie, 'GET', `/api/categories/usage?nombre=${encodeURIComponent(`${TAG} Txroot`)}&sub=${encodeURIComponent(`${TAG} Txsub`)}`);
  record('usage cuenta tx de la sub (>=2)', usageSub.status === 200 && (usageSub.json?.count ?? 0) >= 2, `count=${usageSub.json?.count}`);
  const usageRoot = await api(cookie, 'GET', `/api/categories/usage?nombre=${encodeURIComponent(`${TAG} Txroot`)}`);
  record('usage cuenta tx de la raíz (>=2)', usageRoot.status === 200 && (usageRoot.json?.count ?? 0) >= 2, `count=${usageRoot.json?.count}`);

  // Borrar la sub → tx quedan con la categoría padre (subcategoria null); no reaparece
  await api(cookie, 'DELETE', `/api/categories?id=${txsubId}&sub=true`);
  let txAfter = await sb(`transacciones?usuario_id=eq.${USER.uid}&comercio=ilike.${TAG}*&select=categoria,subcategoria`);
  const subDetached = (txAfter || []).length >= 2 && (txAfter || []).every((t) => t.subcategoria === null && (t.categoria || '').toLowerCase() === `${TAG} txroot`.toLowerCase());
  record('sub-delete desvincula tx (sub=null, cat intacta)', subDetached, JSON.stringify(txAfter));
  cats = (await api(cookie, 'GET', '/api/categories')).json || [];
  const txrootObj = cats.find((c) => c.id === txrootId);
  record('sub borrada NO reaparece pese a tx', !(txrootObj?.subcategorias || []).some((s) => s.nombre.toLowerCase() === `${TAG.toLowerCase()} txsub`));

  // Borrar la raíz → tx a "Por revisar" (categoria null, subcategoria sin_categoria)
  await api(cookie, 'DELETE', `/api/categories?id=${txrootId}`);
  txAfter = await sb(`transacciones?usuario_id=eq.${USER.uid}&comercio=ilike.${TAG}*&select=categoria,subcategoria`);
  // needsReview() lowercatea sub antes de comparar, así que "Sin_categoria"
  // (el trigger de DB capitaliza) igual cae en "Por revisar". Assert CI.
  const rootDetached = (txAfter || []).length >= 2 && (txAfter || []).every((t) => t.categoria === null && (t.subcategoria || '').toLowerCase() === 'sin_categoria');
  record('root-delete manda tx a Por revisar', rootDetached, JSON.stringify(txAfter));

  // 11. Renombrar reetiqueta transacciones + presupuestos + reglas
  const rnroot = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Rnroot` });
  const rnrootId = rnroot.json.id;
  const rnsub = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Rnsub`, padreId: rnrootId });
  const rnsubId = rnsub.json.id;
  await api(cookie, 'POST', '/api/transactions', { monto: 9, tipo: 'gasto', moneda: 'PEN', comercio: `${TAG} rn`, categoria: `${TAG} Rnroot`, subcategoria: `${TAG} Rnsub`, fecha: today, metodo_pago: 'Efectivo' });
  const mm = Number(today.slice(5, 7));
  const yy = Number(today.slice(0, 4));
  await sb('presupuestos', { method: 'POST', body: JSON.stringify({ usuario_id: USER.uid, categoria: `${TAG} Rnroot`, monto_limite: 100, mes: mm, anio: yy, alerta_porcentaje: 80 }) }).catch(() => {});
  await sb('reglas_comercio', { method: 'POST', body: JSON.stringify({ usuario_id: USER.uid, comercio_pattern: `${TAG} wong`, categoria: `${TAG} Rnroot`, subcategoria: `${TAG} Rnsub` }) }).catch(() => {});

  // Renombrar la sub → reetiqueta subcategoria en las 3 tablas
  await api(cookie, 'PUT', '/api/categories', { id: rnsubId, nombre: `${TAG} Rnsub2` });
  // Renombrar la raíz → reetiqueta categoria en las 3 tablas
  await api(cookie, 'PUT', '/api/categories', { id: rnrootId, nombre: `${TAG} Rnroot2` });

  const eqCI = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
  const txRn = (await sb(`transacciones?usuario_id=eq.${USER.uid}&comercio=eq.${encodeURIComponent(`${TAG} rn`)}&select=categoria,subcategoria`))?.[0];
  record('rename raíz reetiqueta tx.categoria', eqCI(txRn?.categoria, `${TAG} Rnroot2`), txRn?.categoria);
  record('rename sub reetiqueta tx.subcategoria', eqCI(txRn?.subcategoria, `${TAG} Rnsub2`), txRn?.subcategoria);
  const budRn = (await sb(`presupuestos?usuario_id=eq.${USER.uid}&categoria=ilike.${TAG}*&select=categoria`))?.[0];
  record('rename raíz reetiqueta presupuesto', eqCI(budRn?.categoria, `${TAG} Rnroot2`), budRn?.categoria);
  const regRn = (await sb(`reglas_comercio?usuario_id=eq.${USER.uid}&comercio_pattern=eq.${encodeURIComponent(`${TAG} wong`)}&select=categoria,subcategoria`))?.[0];
  record('rename reetiqueta regla (cat+sub)', eqCI(regRn?.categoria, `${TAG} Rnroot2`) && eqCI(regRn?.subcategoria, `${TAG} Rnsub2`), JSON.stringify(regRn));

  // Ningún 500 en toda la corrida
  const any500 = Object.values(results.checks).some((v) => /status=500/.test(v));
  record('ningún 500 en el flujo', !any500);
} finally {
  await cleanup();
}

results.verdict = allPass ? 'ALL PASS' : 'HAY FALLOS';
console.log(JSON.stringify(results, null, 2));
process.exit(allPass ? 0 : 1);
