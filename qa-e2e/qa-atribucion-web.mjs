#!/usr/bin/env node
/**
 * EL ALTA WEB GUARDA SU CANAL — contra PRODUCCIÓN, por la cadena real.
 *
 * Cierra el último tramo de la atribución (audit `memory/audits/2026-09-09_seo-adquisicion_neto.md`,
 * Acción 1): `usuarios.origen` solo lo escribía WhatsApp y el alta web ya era la mayoría. Desde el
 * 2026-09-10 el middleware guarda el `?utm_source` en la cookie `neto_origen` y `/auth/callback` lo
 * escribe en la fila que crea (`webapp/src/lib/atribucion.ts`).
 *
 * **Por qué contra prod y por HTTP, no con vitest ni con un navegador.** Los tests de la webapp
 * prueban el working tree con Supabase mockeado; lo que no pueden decir es si lo DESPLEGADO
 * encadena las dos mitades: que el `Set-Cookie` que sale del middleware en Vercel sea el que el
 * callback lee, y que el INSERT pase el CHECK de la base real. Y no hace falta un navegador: el
 * login se cierra con un magic link generado por la admin API, sin mandar un correo, y la cookie
 * se encadena a mano — la del paso A es LITERALMENTE la que viaja en el paso B, no una inventada.
 *
 * Tres casos:
 *   A. la entrada con `?utm_source` devuelve la cookie saneada (y la entrada sin UTM, ninguna);
 *   B. el alta con esa cookie nace con origen = el canal y origen_cta = 'web', y la cookie se consume;
 *   C. el alta sin cookie nace con origen = 'directo'. NO null: null es "alta anterior a la medición".
 *
 * **Escribe en producción y limpia lo suyo.** Crea dos usuarios de Auth (`@qa.neto.pe`, no reciben
 * correo) y el callback les crea la fila de `usuarios` + categorías. Apenas se lee la fila se le pone
 * `is_test_user = true`, para que un corte a mitad de corrida no ensucie el número que esto mide, y
 * al final se borra todo y se COMPRUEBA que no quedó nada. Nada de esto toca `transacciones` ni
 * `deudas`, así que el borrado no deja filas en `borrados_auditoria` (su trigger vive solo ahí).
 *
 * Usa REST directo con la service key y el sujeto fijado por id, no `qa-guard`: la fila la crea el
 * callback con `is_test_user = false`, y la barrera exige lo contrario antes de dejar operar.
 *
 * NO va al canary: se rompe CON commit (vive en el repo que se despliega) y crea usuarios de Auth
 * en cada corrida. Se corre a mano al tocar la cadena de atribución web.
 *
 *   node qa-e2e/qa-atribucion-web.mjs
 *
 * exit 0 = los tres casos pasan · 1 = alguno falla (o la limpieza dejó algo) · 2 = no pudo medir.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const TAG = 'QA-ATR-WEB';
const APP = (process.env.NETO_APP_URL || 'https://app.neto.pe').replace(/\/$/, '');

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

const qaEnv = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const webEnv = loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SUPA = (qaEnv.NETO_QA_URL || webEnv.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE = qaEnv.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || webEnv.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !SERVICE) {
  console.error(`[${TAG}] Falta SUPABASE_URL o SERVICE_ROLE_KEY (qa.env / env / webapp/.env.local).`);
  process.exit(2);
}

const RUN = randomBytes(4).toString('hex');
// Mayúsculas y punto a propósito: el caso A tiene que ver el SANEADO, no un eco del parámetro.
const UTM = 'QA-Atribucion.Web';
const ESPERADO = 'qa-atribucion.web';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); }
};

const supa = (ruta, init = {}) =>
  fetch(`${SUPA}${ruta}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

/** Devuelve { valor, attrs } del Set-Cookie con ese nombre, o null. */
function setCookie(res, nombre) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [par, ...attrs] = c.split(';');
    const i = par.indexOf('=');
    if (par.slice(0, i).trim() === nombre) {
      return { valor: decodeURIComponent(par.slice(i + 1)), attrs: attrs.map((a) => a.trim().toLowerCase()) };
    }
  }
  return null;
}

const creados = [];

async function crearAuth(email) {
  const r = await supa('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`crear usuario de Auth: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  creados.push(j.id);
  return j.id;
}

async function tokenHash(email) {
  const r = await supa('/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type: 'magiclink', email }) });
  const j = await r.json().catch(() => ({}));
  const hash = j.hashed_token || j.properties?.hashed_token;
  if (!r.ok || !hash) throw new Error(`generate_link: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return hash;
}

async function filas(authId) {
  const r = await supa(`/rest/v1/usuarios?select=id,origen,origen_cta,whatsapp&supabase_auth_id=eq.${authId}`);
  if (!r.ok) throw new Error(`leer usuarios: HTTP ${r.status}`);
  return r.json();
}

/** Recorre el callback como lo haría el navegador que vuelve del magic link. */
async function alta(etiqueta, cookie) {
  const email = `qa-atr-web-${RUN}-${etiqueta}@qa.neto.pe`;
  const authId = await crearAuth(email);
  const hash = await tokenHash(email);
  const res = await fetch(`${APP}/auth/callback?token_hash=${encodeURIComponent(hash)}&type=magiclink`, {
    redirect: 'manual',
    headers: cookie ? { Cookie: `neto_origen=${encodeURIComponent(cookie)}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const [fila] = await filas(authId);
  // Primero sacarla del número, después mirar: un corte entre este punto y la limpieza no puede
  // dejar un alta falsa contando como tráfico real.
  if (fila) await supa(`/rest/v1/usuarios?id=eq.${fila.id}`, { method: 'PATCH', body: JSON.stringify({ is_test_user: true }) });
  return { res, fila };
}

async function limpiar() {
  let limpio = true;
  for (const authId of creados) {
    for (const f of await filas(authId)) {
      await supa(`/rest/v1/categorias_usuario?usuario_id=eq.${f.id}`, { method: 'DELETE' });
      const r = await supa(`/rest/v1/usuarios?id=eq.${f.id}&supabase_auth_id=eq.${authId}`, { method: 'DELETE' });
      if (!r.ok) console.log(`    borrar usuarios ${f.id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    await supa(`/auth/v1/admin/users/${authId}`, { method: 'DELETE' });
    const quedanFilas = (await filas(authId)).length;
    const quedaAuth = (await supa(`/auth/v1/admin/users/${authId}`)).status !== 404;
    if (quedanFilas || quedaAuth) {
      limpio = false;
      console.log(`    QUEDÓ basura de ${authId}: filas=${quedanFilas} auth=${quedaAuth}`);
    }
  }
  return limpio;
}

async function main() {
  console.log(`[${TAG}] ${APP} — run ${RUN}`);

  console.log(`\n[${TAG}] A) La entrada con ?utm_source deja la cookie del origen, saneada`);
  const entrada = await fetch(`${APP}/?utm_source=${encodeURIComponent(UTM)}&utm_medium=qa`, { redirect: 'manual' });
  const c = setCookie(entrada, 'neto_origen');
  ok(entrada.status === 307 && new URL(entrada.headers.get('location'), APP).pathname === '/login',
    `rebota a /login (got ${entrada.status} → ${entrada.headers.get('location')})`);
  ok(c?.valor === ESPERADO, `neto_origen = "${ESPERADO}" (got ${JSON.stringify(c?.valor)})`);
  ok(!!c && c.attrs.includes('httponly') && c.attrs.includes('secure'), 'la cookie es HttpOnly y Secure');
  // Estos tres los decide el NAVEGADOR, y este harness reenvía la cookie a mano en el paso B, así
  // que si no se afirman acá no los mira nadie. `lax` es el que importa: el regreso de Google a
  // /auth/callback es cross-site, y con `strict` toda alta por OAuth saldría 'directo'.
  ok(!!c && c.attrs.includes('samesite=lax'), 'SameSite=Lax (viaja en el regreso de Google)');
  ok(!!c && c.attrs.includes('path=/'), 'Path=/ (la lee /auth/callback)');
  ok(!!c && c.attrs.includes('max-age=2592000'), 'Max-Age de 30 días');
  ok(new URL(entrada.headers.get('location'), APP).searchParams.get('utm_source') === ESPERADO,
    'el rebote a /login conserva el utm_source (quien salta del navegador de IG a Chrome llega sin cookies)');
  const control = await fetch(`${APP}/`, { redirect: 'manual' });
  ok(setCookie(control, 'neto_origen') === null, 'control: la entrada SIN utm no escribe cookie de origen');
  // El CTA Pro de la landing salta a /dashboard/pro, no a la raíz: es otro rebote, el que pasa
  // por la sesión, y otro return del middleware.
  const pro = await fetch(`${APP}/dashboard/pro?utm_source=${encodeURIComponent(UTM)}`, { redirect: 'manual' });
  ok(pro.status === 307 && setCookie(pro, 'neto_origen')?.valor === ESPERADO,
    `el CTA Pro (/dashboard/pro sin sesión) también deja la cookie (got ${pro.status}, ${JSON.stringify(setCookie(pro, 'neto_origen')?.valor)})`);

  console.log(`\n[${TAG}] B) El alta con esa cookie nace con su canal`);
  const b = await alta('utm', c?.valor);
  ok(b.res.status === 307 && new URL(b.res.headers.get('location') || '/', APP).pathname === '/dashboard',
    `el callback crea la cuenta y manda al dashboard (got ${b.res.status} → ${b.res.headers.get('location')})`);
  ok(!!b.fila, 'existe la fila de usuarios');
  ok(b.fila?.origen === ESPERADO, `origen = "${ESPERADO}" (got ${JSON.stringify(b.fila?.origen)})`);
  ok(b.fila?.origen_cta === 'web', `origen_cta = "web" (got ${JSON.stringify(b.fila?.origen_cta)})`);
  ok(b.fila?.whatsapp === null, 'es un alta web-first (sin número)');
  const consumida = setCookie(b.res, 'neto_origen');
  ok(consumida?.valor === '' && consumida.attrs.includes('max-age=0'), 'la cookie se consume al crear la cuenta');

  console.log(`\n[${TAG}] C) El alta sin cookie es 'directo', no null`);
  const cc = await alta('directo', null);
  ok(!!cc.fila, 'existe la fila de usuarios');
  ok(cc.fila?.origen === 'directo', `origen = "directo" (got ${JSON.stringify(cc.fila?.origen)})`);
  ok(cc.fila?.origen_cta === 'web', `origen_cta = "web" (got ${JSON.stringify(cc.fila?.origen_cta)})`);
}

let errorFatal = null;
try {
  await main();
} catch (e) {
  errorFatal = e;
  console.error(`\n[${TAG}] No se pudo medir: ${e.message}`);
} finally {
  console.log(`\n[${TAG}] Limpieza`);
  ok(await limpiar(), `no quedó nada de los ${creados.length} usuarios creados`);
}

console.log(`\n[${TAG}] Resultado: ${pass} ok, ${fail} fallos`);
process.exit(errorFatal && fail === 0 ? 2 : fail === 0 ? 0 : 1);
