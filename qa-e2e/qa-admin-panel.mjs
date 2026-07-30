// Harness E2E del panel admin (/admin y /api/admin/*).
//
// Existe porque la auditoría del panel (2026-07-30) encontró métricas MAL, no solo lentas:
// las rutas traían filas crudas de `transacciones` y agregaban en JS, y PostgREST corta la
// respuesta en 1000 filas. Con 2123 filas el embudo reportaba 21 de 44 usuarios activados
// (25% vs 52% real) sin un solo error visible. Un bug así no lo ve un smoke test de status
// 200: hay que comparar contra la base.
//
// Por eso el ORÁCULO de este harness pagina a propósito (Range headers) para contar lo que
// las rutas contaban mal. Si alguien vuelve a introducir una agregación sin paginar ni
// agregar en SQL, la comparación falla.
//
// Mismo patrón de auth que el resto de qa-e2e: password grant → cookie SSR forjada.
// Usa la cuenta admin DEDICADA (admin-qa@neto.pe), no la cuenta personal ni el usuario QA
// normal: así el caso "un usuario común NO entra al panel" sigue siendo comprobable.
//
// Es READ-ONLY: solo GET. No aprueba pagos, no borra usuarios, no escribe nada.
//
// Uso: node qa-admin-panel.mjs            (contra https://app.neto.pe)
//      NETO_APP_URL=http://localhost:3000 node qa-admin-panel.mjs   (dev local)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';

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
const ADMIN = { email: env.NETO_QA_ADMIN_EMAIL, password: env.NETO_QA_ADMIN_PASSWORD };
// Usuario QA normal: sirve para probar que NO puede entrar al panel.
const PLAIN = { email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD };
const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !ADMIN.email || !ADMIN.password) {
  console.error('Faltan creds en ~/.config/neto/qa.env (NETO_QA_URL, NETO_QA_ANON, NETO_QA_ADMIN_*).');
  process.exit(2);
}
if (!SERVICE) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (entorno o webapp/.env.local).');
  process.exit(2);
}

const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

async function login(user) {
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!grant.ok) throw new Error(`Password grant falló para ${user.email}: ${grant.status}`);
  const session = await grant.json();
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  const pairs = [];
  if (value.length <= MAX) pairs.push(`${cookieName}=${value}`);
  else for (let i = 0, p = 0; p < value.length; i++, p += MAX) pairs.push(`${cookieName}.${i}=${value.slice(p, p + MAX)}`);
  return pairs.join('; ');
}

// GET con medición de latencia end-to-end (la que sufre el navegador, no la de la función).
async function get(cookie, path) {
  const t0 = performance.now();
  const r = await fetch(`${APP}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
  });
  const text = await r.text().catch(() => '');
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  return { status: r.status, json, ms, len: text.length };
}

// --- ORÁCULO: lee la base directo, paginando, sin pasar por las RPC del panel ---
// Deliberadamente NO usa admin_user_tx_stats: si el oráculo usara la misma función que la
// ruta, un bug en la función pasaría inadvertido por los dos lados.
async function sbPaginado(tabla, select) {
  const filas = [];
  const PASO = 1000;
  for (let desde = 0; ; desde += PASO) {
    const r = await fetch(`${SUPA}/rest/v1/${tabla}?select=${select}`, {
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        Range: `${desde}-${desde + PASO - 1}`,
      },
    });
    if (!r.ok) throw new Error(`oráculo ${tabla} -> ${r.status}`);
    const lote = await r.json();
    filas.push(...lote);
    if (lote.length < PASO) break;
  }
  return filas;
}

const results = [];
function ok(name, cond, note) { results.push({ name, pass: !!cond, note }); }

(async () => {
  console.log(`Panel admin contra ${APP}\n`);

  // ---------- 1. Guard: sin sesión y con sesión de usuario común ----------
  // /api/admin/check va aparte a propósito: NO es una ruta de datos, es la que el cliente
  // consulta para decidir si muestra el link al panel. Responder 200 con {isAdmin:false} es
  // su contrato correcto, no una fuga: no devuelve nada más que ese booleano.
  const RUTAS = [
    '/api/admin/stats',
    '/api/admin/users',
    '/api/admin/economics',
    '/api/admin/costs',
    '/api/admin/surveys',
    '/api/admin/tickets?limit=50',
    '/api/admin/nlp-errors?limit=100',
  ];

  for (const ruta of RUTAS) {
    const r = await get(null, ruta);
    ok(`guard sin sesión: ${ruta}`, r.status === 401 || r.status === 403, `-> ${r.status}`);
  }
  const checkAnon = await get(null, '/api/admin/check');
  ok('check sin sesión dice isAdmin:false', checkAnon.json?.isAdmin === false, `-> ${JSON.stringify(checkAnon.json)}`);

  if (PLAIN.email && PLAIN.password) {
    const cookiePlain = await login(PLAIN);
    for (const ruta of RUTAS) {
      const r = await get(cookiePlain, ruta);
      ok(`guard usuario común: ${ruta}`, r.status === 401 || r.status === 403, `-> ${r.status}`);
    }
    const checkPlain = await get(cookiePlain, '/api/admin/check');
    ok('check usuario común dice isAdmin:false', checkPlain.json?.isAdmin === false, `-> ${JSON.stringify(checkPlain.json)}`);
  } else {
    console.log('(sin NETO_QA_EMAIL/PASSWORD: me salto el chequeo de usuario común)\n');
  }

  // ---------- 2. Todas las rutas responden 200 con sesión admin ----------
  const cookie = await login(ADMIN);
  const checkAdmin = await get(cookie, '/api/admin/check');
  ok(
    'check admin dice isAdmin:true',
    checkAdmin.json?.isAdmin === true,
    checkAdmin.json?.isAdmin === false
      ? 'la cuenta admin QA no está en ADMIN_USER_IDS de Vercel'
      : `-> ${JSON.stringify(checkAdmin.json)}`,
  );

  const resp = {};
  const latencias = [];

  for (const ruta of RUTAS) {
    const r = await get(cookie, ruta);
    resp[ruta] = r.json;
    latencias.push({ ruta, ms: r.ms, kb: Math.round(r.len / 102.4) / 10 });
    ok(`200 admin: ${ruta}`, r.status === 200, `-> ${r.status} en ${r.ms}ms`);
  }

  // ---------- 3. Truncado: ninguna colección debe medir exactamente 1000 ----------
  // 1000 clavado es la firma del techo de PostgREST, no una casualidad estadística.
  for (const [ruta, json] of Object.entries(resp)) {
    if (!json) continue;
    for (const [clave, valor] of Object.entries(json)) {
      if (Array.isArray(valor) && valor.length === 1000) {
        ok(`sin truncado: ${ruta} .${clave}`, false, 'exactamente 1000 filas: huele a techo de PostgREST');
      }
    }
  }
  ok('sin truncado: ninguna colección clavada en 1000', !results.some(r => r.name.startsWith('sin truncado:') && !r.pass));

  // ---------- 4. Invariantes de actividad ----------
  const k = resp['/api/admin/stats']?.kpis || {};
  ok('DAU <= WAU', k.dau <= k.wau, `${k.dau} <= ${k.wau}`);
  ok('WAU <= MAU', k.wau <= k.mau, `${k.wau} <= ${k.mau}`);

  // ---------- 5. Embudo contra el oráculo ----------
  const txs = await sbPaginado('transacciones', 'usuario_id');
  const usuariosConTx = new Set(txs.map(t => t.usuario_id)).size;
  const usuarios = await sbPaginado('usuarios', 'id');

  const funnel = resp['/api/admin/stats']?.funnel || {};
  ok(
    'embudo: primera transacción == verdad de la base',
    funnel.firstTransaction === usuariosConTx,
    `panel dice ${funnel.firstTransaction}, la base dice ${usuariosConTx} (sobre ${txs.length} transacciones)`,
  );
  ok(
    'embudo: registrados == usuarios reales',
    funnel.registered === usuarios.length,
    `panel dice ${funnel.registered}, la base dice ${usuarios.length}`,
  );
  ok('embudo: registrados >= onboarding completo', funnel.registered >= funnel.onboardingComplete);
  ok('embudo: registrados >= primera transacción', funnel.registered >= funnel.firstTransaction);

  // ---------- 6. /users: los counts por usuario deben sumar el total real ----------
  const lista = resp['/api/admin/users']?.usuarios || [];
  const sumaTx = lista.reduce((acc, u) => acc + (u.transacciones || 0), 0);
  ok('users: total == usuarios reales', lista.length === usuarios.length, `${lista.length} vs ${usuarios.length}`);
  ok(
    'users: suma de transacciones por usuario == total real',
    sumaTx === txs.length,
    `suma ${sumaTx} vs ${txs.length} en la base`,
  );

  // ---------- 7. MAU contra el oráculo ----------
  const hace30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const txMes = await sbPaginado('transacciones', `usuario_id&created_at=gte.${hace30}`);
  ok(
    'MAU == verdad de la base',
    k.mau === new Set(txMes.map(t => t.usuario_id)).size,
    `panel dice ${k.mau}, la base dice ${new Set(txMes.map(t => t.usuario_id)).size}`,
  );

  // ---------- Reporte ----------
  console.log('Latencias (end-to-end, incluye red desde esta máquina):');
  for (const l of latencias.sort((a, b) => b.ms - a.ms)) {
    console.log(`  ${String(l.ms).padStart(5)}ms  ${String(l.kb).padStart(6)}kb  ${l.ruta}`);
  }
  const total = latencias.reduce((a, b) => a + b.ms, 0);
  console.log(`  ${String(total).padStart(5)}ms  TOTAL secuencial\n`);

  const fallos = results.filter(r => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  (${r.note})` : ''}`);
  }
  console.log(`\n${results.length - fallos.length}/${results.length} checks OK`);
  process.exit(fallos.length ? 1 : 0);
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
