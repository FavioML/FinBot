// Harness del merge de identidad web-first (migración 046, función merge_and_link).
//
// Verifica a nivel DB (service-role) el corazón del sprint de onboarding web: cuando
// una cuenta nacida en web vincula por reverse-OTP un número que ya tenía su propia
// fila, las dos filas se fusionan en UNA sola de forma atómica, sin duplicar ni perder
// data, sin degradar un Pro, y rechazando los bordes inseguros.
//
// Escenarios:
//   1) Merge feliz: survivor = fila web (auth_id, sin número), loser = fila WhatsApp
//      (número + data + premium). Tras el merge: loser borrado, survivor con el número,
//      TODOS los hijos repunteados (union), plan premium conservado (no-downgrade).
//   2) Conflicto auth_id: loser ya ligado a OTRA cuenta Google → 'conflict', 2 filas intactas.
//   3) Conflicto espacio compartido: ambos en el mismo space → 'conflict', 2 filas intactas.
//
// Requiere la migración 046 aplicada (la función merge_and_link debe existir).
// Se limpia solo (try/finally, filas is_test_user con marcador QA-MERGE).
//
// Uso: node qa-web-signup-merge.mjs
// Service role: SUPABASE_SERVICE_ROLE_KEY del entorno, de ~/.config/neto/qa.env, o de webapp/.env.local.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const TAG = 'QA-MERGE';

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

// Marcador único por corrida para aislar y limpiar.
const RUN = randomUUID().slice(0, 8);
const numero = () => '519' + String(Math.floor(10000000 + Math.random() * 89999999));

async function crearUsuario({ whatsapp = null, authId = null, plan = 'free', premiumVence = null }) {
  const { data, error } = await db.from('usuarios').insert({
    whatsapp,
    supabase_auth_id: authId,
    nombre: `QA-MERGE ${RUN}`,
    plan,
    premium_vence: premiumVence,
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
  await db.from('presupuestos').insert({ usuario_id: usuarioId, categoria: `Otros-${marca}`, monto_limite: 500, mes: 7, anio: 2026 });
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

async function escenarioFeliz() {
  console.log(`\n[${TAG}] 1) Merge feliz (web + WhatsApp premium → una fila)`);
  let survivor, loser;
  try {
    const authWeb = randomUUID();
    survivor = await crearUsuario({ authId: authWeb, plan: 'free' });
    loser = await crearUsuario({ whatsapp: numero(), plan: 'premium', premiumVence: '2027-01-01' });
    await seedHijos(survivor, 'web');   // el web ya registró algo por la app
    await seedHijos(loser, 'wa');       // el WhatsApp tenía su historial

    const txSurvAntes = await contarTx(survivor);
    const txLoserAntes = await contarTx(loser);
    ok(txSurvAntes === 2 && txLoserAntes === 2, `seed: 2 tx c/u (surv=${txSurvAntes}, loser=${txLoserAntes})`);

    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: survivor, p_loser: loser });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'linked', `resultado 'linked' (got '${result}')`);

    ok(!(await existeUsuario(loser)), 'loser borrado');
    ok(await existeUsuario(survivor), 'survivor vive');

    const { data: surv } = await db.from('usuarios').select('whatsapp, plan, premium_vence, supabase_auth_id').eq('id', survivor).single();
    ok(!!surv.whatsapp, `survivor quedó con número (${surv.whatsapp})`);
    ok(surv.plan === 'premium', 'survivor NO degradado (premium)');
    ok(String(surv.premium_vence).startsWith('2027-01-01'), 'premium_vence conservado');
    ok(surv.supabase_auth_id === authWeb, 'survivor conserva su auth_id');

    const txSurvDespues = await contarTx(survivor);
    ok(txSurvDespues === 4, `union de transacciones (4, got ${txSurvDespues})`);
    const { count: catCount } = await db.from('categorias_usuario').select('id', { count: 'exact', head: true }).eq('usuario_id', survivor);
    ok((catCount || 0) === 2, `categorías unidas (2, got ${catCount})`);
  } finally {
    await borrarUsuario(survivor);
    await borrarUsuario(loser);
  }
}

async function escenarioConflictoAuth() {
  console.log(`\n[${TAG}] 2) Conflicto: número ligado a otra cuenta Google`);
  let survivor, loser;
  try {
    survivor = await crearUsuario({ authId: randomUUID() });
    loser = await crearUsuario({ whatsapp: numero(), authId: randomUUID() }); // ya tiene OTRO auth_id
    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: survivor, p_loser: loser });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'conflict', `resultado 'conflict' (got '${result}')`);
    ok(await existeUsuario(survivor), 'survivor intacto');
    ok(await existeUsuario(loser), 'loser intacto (no se tocó)');
  } finally {
    await borrarUsuario(survivor);
    await borrarUsuario(loser);
  }
}

async function escenarioConflictoEspacio() {
  console.log(`\n[${TAG}] 3) Conflicto: ambos en el mismo espacio compartido`);
  let survivor, loser, spaceId;
  try {
    survivor = await crearUsuario({ authId: randomUUID() });
    loser = await crearUsuario({ whatsapp: numero() });
    const { data: space, error: eSpace } = await db.from('shared_spaces')
      .insert({ name: `QA-MERGE ${RUN}`, invite_code: `QAM${RUN}`, created_by: survivor }).select('id').single();
    if (eSpace) throw new Error('crear space: ' + eSpace.message);
    spaceId = space.id;
    await db.from('space_members').insert([
      { space_id: spaceId, user_id: survivor },
      { space_id: spaceId, user_id: loser },
    ]);
    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: survivor, p_loser: loser });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'conflict', `resultado 'conflict' (got '${result}')`);
    ok(await existeUsuario(survivor) && await existeUsuario(loser), 'ambas filas intactas');
  } finally {
    if (spaceId) await db.from('shared_spaces').delete().eq('id', spaceId);
    await borrarUsuario(survivor);
    await borrarUsuario(loser);
  }
}

async function escenarioColisiones() {
  console.log(`\n[${TAG}] 4) Colisiones de unique (categorías/presupuesto idénticos a ambos lados)`);
  let survivor, loser;
  try {
    survivor = await crearUsuario({ authId: randomUUID() });
    loser = await crearUsuario({ whatsapp: numero() });
    // Mismos nombres a ambos lados: sin dedup, el merge abortaría por unique_violation.
    for (const uid of [survivor, loser]) {
      await db.from('categorias_usuario').insert([
        { usuario_id: uid, nombre: 'Alimentación', emoji: '🍽️' },
        { usuario_id: uid, nombre: 'Transporte', emoji: '🚌' },
      ]);
      await db.from('presupuestos').insert({ usuario_id: uid, categoria: 'Comida', monto_limite: 300, mes: 7, anio: 2026 });
    }
    // Dato único solo del lado WhatsApp: debe migrar igual.
    await db.from('categorias_usuario').insert({ usuario_id: loser, nombre: 'SoloWhatsApp', emoji: '📲' });

    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: survivor, p_loser: loser });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'linked', `resultado 'linked' pese a colisiones (got '${result}')`);
    ok(!(await existeUsuario(loser)), 'loser borrado');

    const { count: alim } = await db.from('categorias_usuario').select('id', { count: 'exact', head: true }).eq('usuario_id', survivor).eq('nombre', 'Alimentación');
    ok(alim === 1, `'Alimentación' deduplicada (1, got ${alim})`);
    const { count: solo } = await db.from('categorias_usuario').select('id', { count: 'exact', head: true }).eq('usuario_id', survivor).eq('nombre', 'SoloWhatsApp');
    ok(solo === 1, `categoría única del WhatsApp migró (1, got ${solo})`);
    const { count: pres } = await db.from('presupuestos').select('id', { count: 'exact', head: true }).eq('usuario_id', survivor).eq('categoria', 'Comida').eq('mes', 7).eq('anio', 2026);
    ok(pres === 1, `presupuesto duplicado deduplicado (1, got ${pres})`);
  } finally {
    await borrarUsuario(survivor);
    await borrarUsuario(loser);
  }
}

(async () => {
  console.log(`[${TAG}] Merge de identidad web-first — run ${RUN}`);
  try {
    await escenarioFeliz();
    await escenarioConflictoAuth();
    await escenarioConflictoEspacio();
    await escenarioColisiones();
  } catch (e) {
    console.error(`[${TAG}] Error fatal:`, e.message);
    fail++;
  }
  console.log(`\n[${TAG}] Resultado: ${pass} ok, ${fail} fallos`);
  process.exit(fail === 0 ? 0 : 1);
})();
