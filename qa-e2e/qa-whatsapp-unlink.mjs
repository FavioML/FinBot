// Harness del "cambiar número" self-serve (Hueco 1.1 del follow-up web-first).
//
// La ruta POST /api/whatsapp/unlink pone `usuarios.whatsapp = null` en la fila de
// la sesión. Este harness valida a nivel DB (service-role) el INVARIANTE que hace
// seguro ese cambio y que cierra el ciclo real:
//
//   1) Desvincular (whatsapp -> null) NO toca nada más: la data financiera, la
//      conexión Gmail, el plan Pro y el auth_id quedan intactos.
//   2) Re-vincular el número correcto con el reverse-OTP existente funciona: con el
//      survivor en whatsapp=null, merge_and_link(survivor=web, loser=filaNúmero)
//      adopta el número nuevo (whatsapp = COALESCE(loser, survivor), migr 046) sin
//      perder ni duplicar data y sin degradar el Pro.
//
// El UPDATE de la ruta es trivial; lo que se prueba aquí es que el modelo sostiene
// el flujo entero unlink -> re-OTP -> número corregido.
//
// Requiere la migración 046 aplicada (merge_and_link). Se limpia solo (try/finally,
// filas is_test_user con marcador QA-UNLINK).
//
// Uso: node qa-whatsapp-unlink.mjs
// Service role: SUPABASE_SERVICE_ROLE_KEY del entorno, de ~/.config/neto/qa.env, o de webapp/.env.local.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const TAG = 'QA-UNLINK';

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
  qaEnv.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  webEnv.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !SERVICE) {
  console.error(`[${TAG}] Falta SUPABASE_URL o SERVICE_ROLE_KEY (qa.env / env / webapp/.env.local).`);
  process.exit(2);
}

const db = createClient(SUPA, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const RUN = randomUUID().slice(0, 8);
const numero = () => '519' + String(Math.floor(10000000 + Math.random() * 89999999));

async function crearUsuario({ whatsapp = null, authId = null, plan = 'free', premiumVence = null, gmailToken = null }) {
  const { data, error } = await db.from('usuarios').insert({
    whatsapp,
    supabase_auth_id: authId,
    nombre: `QA-UNLINK ${RUN}`,
    plan,
    premium_vence: premiumVence,
    gmail_access_token: gmailToken,
    onboarding_completado: true,
    is_test_user: true,
  }).select('id').single();
  if (error) throw new Error('crearUsuario: ' + error.message);
  return data.id;
}

async function seedHijos(usuarioId, marca) {
  await db.from('transacciones').insert([
    { usuario_id: usuarioId, monto: 10, monto_pen: 10, tipo: 'gasto', categoria: 'Otros', comercio: `${marca}-a`, fecha: '2026-07-01' },
    { usuario_id: usuarioId, monto: 20, monto_pen: 20, tipo: 'gasto', categoria: 'Otros', comercio: `${marca}-b`, fecha: '2026-07-02' },
  ]);
  await db.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: `Cat-${marca}`, emoji: '🧪' });
}

async function contarTx(usuarioId) {
  const { count } = await db.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', usuarioId);
  return count || 0;
}
async function existeUsuario(id) {
  const { data } = await db.from('usuarios').select('id').eq('id', id).maybeSingle();
  return !!data;
}
async function borrarUsuario(id) {
  if (id) await db.from('usuarios').delete().eq('id', id);
}

// 1) Desvincular no toca nada más que el escalar whatsapp.
async function escenarioUnlinkSeguro() {
  console.log(`\n[${TAG}] 1) Unlink: whatsapp -> null sin dañar data/gmail/plan/auth_id`);
  let uid;
  try {
    const authWeb = randomUUID();
    const numB = numero();
    uid = await crearUsuario({
      authId: authWeb,
      whatsapp: numB,
      plan: 'premium',
      premiumVence: '2027-01-01',
      gmailToken: 'tok-QA',
    });
    await seedHijos(uid, 'pre');
    const txAntes = await contarTx(uid);
    ok(txAntes === 2, `seed: 2 tx (got ${txAntes})`);

    // Espejo exacto de lo que hace la ruta: UPDATE whatsapp=null WHERE id=uid.
    const { error } = await db.from('usuarios').update({ whatsapp: null }).eq('id', uid);
    ok(!error, `update sin error${error ? ': ' + error.message : ''}`);

    const { data: row } = await db.from('usuarios')
      .select('whatsapp, plan, premium_vence, supabase_auth_id, gmail_access_token')
      .eq('id', uid).single();
    ok(row.whatsapp === null, 'whatsapp quedó en null');
    ok(row.supabase_auth_id === authWeb, 'auth_id intacto');
    ok(row.plan === 'premium', 'plan Pro intacto (no degradado)');
    ok(String(row.premium_vence).startsWith('2027-01-01'), 'premium_vence intacto');
    ok(row.gmail_access_token === 'tok-QA', 'conexión Gmail intacta');
    const txDespues = await contarTx(uid);
    ok(txDespues === 2, `transacciones intactas (2, got ${txDespues})`);
  } finally {
    await borrarUsuario(uid);
  }
}

// 2) Ciclo completo: tras el unlink, re-vincular el número correcto vía merge.
async function escenarioRelinkTrasUnlink() {
  console.log(`\n[${TAG}] 2) Re-link post-unlink: merge adopta el número A (whatsapp COALESCE)`);
  let web, filaA;
  try {
    const authWeb = randomUUID();
    // La fila web ya pasó por el unlink: whatsapp = null, pero con su data y su Pro.
    web = await crearUsuario({ authId: authWeb, whatsapp: null, plan: 'premium', premiumVence: '2027-01-01' });
    await seedHijos(web, 'web');
    // El número correcto (A) que el usuario ahora prueba por reverse-OTP.
    const numA = numero();
    filaA = await crearUsuario({ whatsapp: numA });
    await seedHijos(filaA, 'wa');

    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: web, p_loser: filaA });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'linked', `resultado 'linked' (got '${result}')`);
    ok(!(await existeUsuario(filaA)), 'fila del número A plegada y borrada');

    const { data: surv } = await db.from('usuarios')
      .select('whatsapp, plan, supabase_auth_id').eq('id', web).single();
    ok(surv.whatsapp === numA, `survivor adoptó el número A (${surv.whatsapp} === ${numA})`);
    ok(surv.supabase_auth_id === authWeb, 'survivor conserva su auth_id');
    ok(surv.plan === 'premium', 'Pro conservado tras el merge');
    const txSurv = await contarTx(web);
    ok(txSurv === 4, `data unificada (4 tx, got ${txSurv})`);
  } finally {
    await borrarUsuario(web);
    await borrarUsuario(filaA);
  }
}

(async () => {
  console.log(`[${TAG}] Cambiar número self-serve — run ${RUN}`);
  try {
    await escenarioUnlinkSeguro();
    await escenarioRelinkTrasUnlink();
  } catch (e) {
    console.error(`[${TAG}] Error fatal:`, e.message);
    fail++;
  }
  console.log(`\n[${TAG}] Resultado: ${pass} ok, ${fail} fallos`);
  process.exit(fail === 0 ? 0 : 1);
})();
