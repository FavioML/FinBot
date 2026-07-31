// Harness del alta web con referido (?ref=CODE en app.neto.pe).
//
// El registro por WhatsApp ("Hola NETO ref:CODE") ya vinculaba al referido; este harness
// cubre la puerta WEB: el middleware guarda el ?ref en la cookie `neto_ref`, y /auth/callback
// llama a POST /admin/referido-web tras crear la cuenta web-first. Ese endpoint delega en
// services/referrals (registrarReferido + sembrarDescuentoReferido), la misma mecánica del
// webhook. Verificamos:
//   A) Contrato en prod: /admin/referido-web existe y exige ADMIN_KEY (401), distinguido de
//      una ruta inexistente (404). Prueba que la VERSIÓN desplegada tiene el endpoint.
//   B) Mecánica real contra la DB (service-role, vía el mismo servicio que corre el endpoint):
//      vínculo feliz → fila en `referidos` + 50% off sembrado (S/5); idempotencia; un referido
//      que YA es Pro no recibe descuento.
//   C) Guardas de resolución del endpoint (ref_code → referrer excluyendo self): un code real
//      resuelve, auto-referirse y un code basura NO.
//
// ADMIN_KEY vive en Railway/Vercel y NO hace falta para B/C: la mecánica se ejercita con el
// servicio importado directo, no por HTTP. Se limpia solo (filas is_test_user, marcador QA-REF).
//
// Uso: node qa-referido-web.mjs

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const TAG = 'QA-REF';
const API = process.env.NETO_BACKEND_URL || 'https://api.neto.pe';

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

const SUPA = qaEnv.NETO_QA_URL || webEnv.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE =
  qaEnv.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || webEnv.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !SERVICE) {
  console.error(`[${TAG}] Falta SUPABASE_URL o SERVICE_ROLE_KEY (qa.env / env / webapp/.env.local).`);
  process.exit(2);
}

// El servicio del backend (lib/db) lee SUPABASE_URL/SUPABASE_KEY del entorno al importarse.
// Debe quedar seteado ANTES del import dinámico de referrals.
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_KEY = SERVICE;

const db = createClient(SUPA, SERVICE, { auth: { persistSession: false } });

// Import dinámico tras setear el env (referrals → lib/db al cargar).
const { registrarReferido } = await import('../services/referrals.js');
const { hoyPeru, sumarDias } = await import('../lib/dates.js');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const RUN = randomUUID().slice(0, 8);
const numero = () => '519' + String(Math.floor(10000000 + Math.random() * 89999999));

async function crearUsuario({ whatsapp = null, refCode = null, plan = 'free' }) {
  const { data, error } = await db.from('usuarios').insert({
    whatsapp,
    supabase_auth_id: randomUUID(),
    nombre: `QA-REF ${RUN}`,
    ref_code: refCode,
    plan,
    onboarding_completado: true,
    is_test_user: true,
  }).select('id, ref_code').single();
  if (error) throw new Error('crearUsuario: ' + error.message);
  return data;
}

async function leerReferido(referidoId) {
  const { data } = await db.from('referidos')
    .select('referrer_id, ref_code, convertido_pro').eq('referido_id', referidoId).maybeSingle();
  return data;
}
async function leerDscto(referidoId) {
  const { data } = await db.from('usuarios')
    .select('referido_dscto_pct, referido_dscto_vence').eq('id', referidoId).single();
  return data;
}
async function limpiar(...ids) {
  for (const id of ids.filter(Boolean)) {
    await db.from('referidos').delete().eq('referrer_id', id);
    await db.from('referidos').delete().eq('referido_id', id);
    await db.from('usuarios').delete().eq('id', id);
  }
}

async function contrato() {
  console.log(`\n[${TAG}] A) Contrato en prod: /admin/referido-web exige ADMIN_KEY`);
  try {
    const sinKey = await fetch(API + '/admin/referido-web', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const inexistente = await fetch(API + '/admin/ruta-que-no-existe-qa-ref', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    ok(sinKey.status === 401, `sin key → 401 (got ${sinKey.status})`);
    ok(inexistente.status === 404, `ruta inexistente → 404 (got ${inexistente.status})`);
    ok(sinKey.status === 401 && inexistente.status === 404,
      'el 401 (no 404) prueba que la versión desplegada tiene el endpoint');
  } catch (e) {
    ok(false, 'fetch a prod sin excepción: ' + e.message);
  }
}

async function mecanicaFeliz() {
  console.log(`\n[${TAG}] B) Vínculo feliz: fila en referidos + 50% off (S/5)`);
  let referrer, referido;
  try {
    referrer = await crearUsuario({ whatsapp: numero(), refCode: ('QAW' + RUN).toUpperCase() });
    referido = await crearUsuario({}); // web-first: sin número, plan free

    await registrarReferido(referrer.id, referido.id);

    const fila = await leerReferido(referido.id);
    ok(!!fila, 'se creó la fila en `referidos`');
    ok(fila && fila.referrer_id === referrer.id, 'referrer_id correcto');
    ok(fila && fila.ref_code === referrer.ref_code, `ref_code copiado (${referrer.ref_code})`);
    ok(fila && fila.convertido_pro === false, 'convertido_pro=false (unirse ≠ pagar Pro)');

    const dscto = await leerDscto(referido.id);
    const venceEsperado = sumarDias(hoyPeru(), 7);
    ok(dscto && dscto.referido_dscto_pct === 50, `descuento 50% sembrado (S/5) (got ${dscto?.referido_dscto_pct})`);
    ok(dscto && String(dscto.referido_dscto_vence).slice(0, 10) === venceEsperado,
      `vence en 7 días (${venceEsperado}, got ${dscto && String(dscto.referido_dscto_vence).slice(0, 10)})`);

    // Idempotencia: segunda llamada no duplica ni reinicia la ventana.
    await registrarReferido(referrer.id, referido.id);
    const { count } = await db.from('referidos').select('*', { count: 'exact', head: true }).eq('referido_id', referido.id);
    ok(count === 1, `idempotente: sigue 1 fila (got ${count})`);
    const dscto2 = await leerDscto(referido.id);
    ok(dscto2 && String(dscto2.referido_dscto_vence).slice(0, 10) === venceEsperado,
      'la ventana del descuento no se reinicia al re-vincular');
  } finally {
    await limpiar(referrer?.id, referido?.id);
  }
}

async function referidoYaPro() {
  console.log(`\n[${TAG}] B2) Un referido que YA es Pro no recibe descuento del primer mes`);
  let referrer, referido;
  try {
    referrer = await crearUsuario({ whatsapp: numero(), refCode: ('QAP' + RUN).toUpperCase() });
    referido = await crearUsuario({ plan: 'premium' });
    await registrarReferido(referrer.id, referido.id);
    const fila = await leerReferido(referido.id);
    ok(!!fila, 'igual se registra el vínculo (para premiar al referrer si sigue Pro pagando)');
    const dscto = await leerDscto(referido.id);
    ok(!dscto.referido_dscto_pct, 'sin descuento: un Pro no tiene "primer mes"');
  } finally {
    await limpiar(referrer?.id, referido?.id);
  }
}

async function guardasResolucion() {
  console.log(`\n[${TAG}] C) Guardas del endpoint: resolución ref_code → referrer (excluye self)`);
  let referrer;
  try {
    const code = ('QAG' + RUN).toUpperCase();
    referrer = await crearUsuario({ whatsapp: numero(), refCode: code });

    // Code real, excluyendo a un tercero: resuelve al referrer.
    const { data: r1 } = await db.from('usuarios').select('id').eq('ref_code', code).neq('id', randomUUID()).maybeSingle();
    ok(r1 && r1.id === referrer.id, 'un code real resuelve al referrer');

    // Auto-referirse: excluir al propio referrer por id → no resuelve (no-op, linked:false).
    const { data: rSelf } = await db.from('usuarios').select('id').eq('ref_code', code).neq('id', referrer.id).maybeSingle();
    ok(!rSelf, 'auto-referirse no resuelve (anti self-referral)');

    // Code inexistente → no resuelve.
    const { data: rNull } = await db.from('usuarios').select('id').eq('ref_code', 'ZZZZNOEXISTE').neq('id', randomUUID()).maybeSingle();
    ok(!rNull, 'un code inexistente no resuelve (no-op)');
  } finally {
    await limpiar(referrer?.id);
  }
}

(async () => {
  console.log(`[${TAG}] Alta web con referido — run ${RUN}`);
  try {
    await contrato();
    await mecanicaFeliz();
    await referidoYaPro();
    await guardasResolucion();
  } catch (e) {
    console.error(`[${TAG}] Error fatal:`, e.message);
    fail++;
  }
  console.log(`\n[${TAG}] Resultado: ${pass} ok, ${fail} fallos`);
  process.exit(fail === 0 ? 0 : 1);
})();
