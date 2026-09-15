#!/usr/bin/env node
/**
 * EL LOGIN CON GOOGLE NO ADOPTA UNA FILA POR SU CORREO — contra PRODUCCIÓN, por la cadena real.
 *
 * Hasta el 15-sep-2026 `/auth/callback` buscaba `usuarios` por `email` y, si esa fila no tenía
 * `supabase_auth_id`, le escribía el de la sesión: sin token y sin prueba del número. El correo de
 * una fila de WhatsApp pudo ser DICTADO en el alta vieja, así que un error de tipeo que cayera en el
 * Gmail real de otra persona le entregaba esa cuenta. Ver `docs/DEFECTOS.md` (14-sep y 15-sep).
 *
 * Los tests de la webapp prueban el working tree con Supabase mockeado. Esto prueba lo DESPLEGADO
 * contra la base real, que es la única que tiene el índice `usuarios_email_lower_unique` del que
 * depende el caso B.
 *
 * Tres casos, mismo mecanismo que `qa-atribucion-web.mjs` (magic link por admin API, sin correo):
 *   A. existe una fila "de WhatsApp" (BSUID de harness, sin auth) con el correo X, y alguien entra
 *      con Google/magic link como X → esa fila NO se toca; nace un alta web SIN correo;
 *   B. igual, pero la fila tiene X con otras mayúsculas → mismo resultado. Antes caía a /onboarding
 *      (el INSERT chocaba con el índice y `createWebUser` lo leía como carrera de pestañas);
 *   C. control: un correo que no es de nadie → el alta nace CON su correo.
 *
 * **Escribe en producción y limpia lo suyo.** Las filas sembradas nacen `is_test_user = true` con
 * BSUID `PE.qa…` (el prefijo que la tabla `errores` ya reconoce como harness) y sin número, así que
 * nada le escribe a nadie. Las filas que crea el callback se marcan de test apenas se leen. Al final
 * se borra todo y se COMPRUEBA que no quedó nada.
 *
 * NO va al canary: se rompe con commit. Se corre a mano al tocar `/auth/callback` o `createWebUser`.
 *
 *   node qa-e2e/qa-login-sin-vinculo-email.mjs
 *
 * exit 0 = pasa · 1 = algún caso falla (o la limpieza dejó algo) · 2 = no pudo medir.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const TAG = 'QA-SIN-VINCULO';
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

const authCreados = [];
const filasSembradas = [];

async function sembrarFilaWhatsapp(etiqueta, email) {
  const r = await supa('/rest/v1/usuarios', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      bsuid: `PE.qa${RUN}${etiqueta}`,
      whatsapp: null,
      email,
      nombre: 'QA sin vinculo',
      is_test_user: true,
      onboarding_completado: true,
      onboarding_paso: 0,
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j) || !j[0]?.id) throw new Error(`sembrar fila: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  filasSembradas.push(j[0].id);
  return j[0].id;
}

async function crearAuth(email) {
  const r = await supa('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`crear usuario de Auth: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  authCreados.push(j.id);
  return j.id;
}

async function tokenHash(email) {
  const r = await supa('/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type: 'magiclink', email }) });
  const j = await r.json().catch(() => ({}));
  const hash = j.hashed_token || j.properties?.hashed_token;
  if (!r.ok || !hash) throw new Error(`generate_link: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return hash;
}

async function leer(filtro) {
  const r = await supa(`/rest/v1/usuarios?select=id,email,whatsapp,bsuid,supabase_auth_id&${filtro}`);
  if (!r.ok) throw new Error(`leer usuarios: HTTP ${r.status}`);
  return r.json();
}

async function login(email) {
  const authId = await crearAuth(email);
  const hash = await tokenHash(email);
  const res = await fetch(`${APP}/auth/callback?token_hash=${encodeURIComponent(hash)}&type=magiclink`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const [fila] = await leer(`supabase_auth_id=eq.${authId}`);
  // Si el callback creó una fila, fuera del número antes de mirarla.
  if (fila && !filasSembradas.includes(fila.id)) {
    await supa(`/rest/v1/usuarios?id=eq.${fila.id}`, { method: 'PATCH', body: JSON.stringify({ is_test_user: true }) });
  }
  return { res, authId, fila, destino: new URL(res.headers.get('location') || '/', APP).pathname };
}

async function casoAdopcion(etiqueta, emailFila, emailLogin) {
  const idWa = await sembrarFilaWhatsapp(etiqueta, emailFila);
  const l = await login(emailLogin);
  const [wa] = await leer(`id=eq.${idWa}`);
  ok(wa?.supabase_auth_id === null, `la fila de WhatsApp sigue SIN cuenta web (got auth=${JSON.stringify(wa?.supabase_auth_id)})`);
  ok(wa?.email === emailFila, 'la fila de WhatsApp conserva su correo');
  ok(!!l.fila && l.fila.id !== idWa, `el login creó un alta web aparte (got ${l.fila ? (l.fila.id === idWa ? 'la MISMA fila' : 'otra fila') : 'ninguna fila'})`);
  ok(l.fila?.whatsapp === null && l.fila?.bsuid === null, 'el alta web no hereda número ni BSUID');
  ok(l.fila?.email === null, `el alta web nace sin correo, que es de la otra fila (got ${JSON.stringify(l.fila?.email)})`);
  ok(l.res.status === 307 && l.destino === '/dashboard', `redirige al dashboard (got ${l.res.status} → ${l.destino})`);
}

async function limpiar() {
  let limpio = true;
  const ids = new Set(filasSembradas);
  for (const authId of authCreados) for (const f of await leer(`supabase_auth_id=eq.${authId}`)) ids.add(f.id);
  for (const id of ids) {
    await supa(`/rest/v1/categorias_usuario?usuario_id=eq.${id}`, { method: 'DELETE' });
    const r = await supa(`/rest/v1/usuarios?id=eq.${id}&is_test_user=eq.true`, { method: 'DELETE' });
    if (!r.ok) console.log(`    borrar usuarios ${id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  for (const authId of authCreados) await supa(`/auth/v1/admin/users/${authId}`, { method: 'DELETE' });
  for (const id of ids) {
    if ((await leer(`id=eq.${id}`)).length) { limpio = false; console.log(`    QUEDÓ la fila ${id}`); }
  }
  for (const authId of authCreados) {
    if ((await supa(`/auth/v1/admin/users/${authId}`)).status !== 404) { limpio = false; console.log(`    QUEDÓ el auth ${authId}`); }
  }
  return limpio;
}

async function main() {
  console.log(`[${TAG}] ${APP} — run ${RUN}`);

  console.log(`\n[${TAG}] A) Mismo correo: la fila de WhatsApp no se adopta`);
  const a = `qa-sv-${RUN}-a@qa.neto.pe`;
  await casoAdopcion('a', a, a);

  console.log(`\n[${TAG}] B) Mismo correo con otras mayúsculas: tampoco, y el alta no cae a /onboarding`);
  const b = `qa-sv-${RUN}-b@qa.neto.pe`;
  await casoAdopcion('b', b.toUpperCase(), b);

  console.log(`\n[${TAG}] C) Control: un correo libre nace con su correo`);
  const c = `qa-sv-${RUN}-c@qa.neto.pe`;
  const lc = await login(c);
  ok(!!lc.fila, 'existe la fila de usuarios');
  ok(lc.fila?.email === c, `el alta guarda su correo (got ${JSON.stringify(lc.fila?.email)})`);
  ok(lc.destino === '/dashboard', `redirige al dashboard (got ${lc.destino})`);
}

let errorFatal = null;
try {
  await main();
} catch (e) {
  errorFatal = e;
  console.error(`\n[${TAG}] No se pudo medir: ${e.message}`);
} finally {
  console.log(`\n[${TAG}] Limpieza`);
  ok(await limpiar(), `no quedó nada (${filasSembradas.length} sembradas, ${authCreados.length} de Auth)`);
}

console.log(`\n[${TAG}] Resultado: ${pass} ok, ${fail} fallos`);
process.exit(errorFatal && fail === 0 ? 2 : fail === 0 ? 0 : 1);
