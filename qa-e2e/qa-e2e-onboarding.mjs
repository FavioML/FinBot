// E2E del ALTA por WhatsApp (onboarding), el front door del producto, punta a punta
// por el webhook real contra la Supabase real.
//
// Camino Free feliz, la máquina de estados de handlers/onboarding.js:
//   usuario nuevo → "hola" → paso 100 (pide nombre) → nombre → paso 101 (pide email)
//   → email → paso 1 (menú de plan) → "free" → plan=free + onboarding_completado=true.
//
// Cada mensaje es una llamada de webhook independiente que RE-LEE el usuario, así que
// el avance de onboarding_paso entre pasos es exactamente el flujo real (no un atajo).
// El camino Free NO toca OpenAI (los pasos son texto fijo por estado), así que es
// barato; pero ESCRIBE (crea y muta un usuario) → manual post-deploy, NO canary.
//
// Aislamiento total: usa un usuario THROWAWAY con whatsapp/email únicos por corrida,
// is_test_user=true (cero envíos Meta; además enviarWhatsapp está stubeado). Al
// final borra sus conversaciones y el usuario. No toca a ningún usuario real ni a
// los QA persistentes.
//
// Correr:  node qa-e2e/qa-e2e-onboarding.mjs   (desde app/)  → exit 0 si pasa.

import { startWebhookHarness } from './webhook-harness.mjs';

const RUN = Date.now();
const WA = 'qa-onb-' + RUN;
const EMAIL = 'qa-onb-' + RUN + '@neto-test.local';
const NOMBRE = 'Ana Prueba';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

async function getUser(h) {
  const { data } = await h.supabase.from('usuarios')
    .select('id, nombre, email, plan, onboarding_paso, onboarding_completado')
    .eq('whatsapp', WA).single();
  return data;
}

// Envía un mensaje de texto por el webhook y devuelve { status, reply }.
async function paso(h, texto) {
  const before = h.sent.length;
  const status = await h.postText(texto, WA);
  const reply = (await h.waitForReply(before)).trim();
  return { status, reply };
}

let userId = null;

async function run(h) {
  // ── Sembrar el usuario throwaway (estado de "recién llegado") ─────────────────
  const { data: creado, error: insErr } = await h.supabase.from('usuarios').insert({
    whatsapp: WA, is_test_user: true,
    onboarding_paso: 0, onboarding_completado: false, nombre: null, plan: 'free',
  }).select('id').single();
  if (!check('se sembró el usuario throwaway', !insErr && !!creado, insErr ? insErr.message : 'id=' + creado?.id)) return;
  userId = creado.id;

  // ── Paso 1: "hola" → pide el nombre (onboarding_paso 100) ────────────────────
  const r1 = await paso(h, 'hola');
  check('el webhook acepta "hola"', r1.status === 200, 'status=' + r1.status);
  check('saluda como NETO y pide el nombre', /c[oó]mo te llamas/i.test(r1.reply), r1.reply.slice(0, 70).replace(/\n/g, ' '));
  let u = await getUser(h);
  check('el estado avanzó a paso 100 (esperando nombre)', u?.onboarding_paso === 100, 'paso=' + u?.onboarding_paso);

  // ── Paso 2: nombre → pide el email (onboarding_paso 101) ─────────────────────
  const r2 = await paso(h, NOMBRE);
  check('confirma el nombre y pide el correo',
    r2.reply.includes(NOMBRE) && /correo|email/i.test(r2.reply),
    r2.reply.slice(0, 70).replace(/\n/g, ' '));
  u = await getUser(h);
  check('persistió el nombre y avanzó a paso 101',
    u?.nombre === NOMBRE && u?.onboarding_paso === 101,
    'nombre=' + u?.nombre + ' paso=' + u?.onboarding_paso);

  // ── Paso 3: email → muestra el menú de plan (onboarding_paso 1) ──────────────
  const r3 = await paso(h, EMAIL);
  check('muestra el menú de plan Free/Pro',
    /elige tu plan/i.test(r3.reply) && /free/i.test(r3.reply) && /pro/i.test(r3.reply),
    r3.reply.slice(0, 70).replace(/\n/g, ' '));
  u = await getUser(h);
  check('persistió el email y avanzó a paso 1',
    u?.email === EMAIL && u?.onboarding_paso === 1,
    'email=' + u?.email + ' paso=' + u?.onboarding_paso);

  // ── Paso 4: "free" → alta completada ─────────────────────────────────────────
  const r4 = await paso(h, 'free');
  check('da la bienvenida a Neto Free', /neto free|bienvenido/i.test(r4.reply), r4.reply.slice(0, 70).replace(/\n/g, ' '));
  u = await getUser(h);
  check('alta completada: plan=free, onboarding_completado=true, paso=0',
    u?.plan === 'free' && u?.onboarding_completado === true && u?.onboarding_paso === 0,
    'plan=' + u?.plan + ' completado=' + u?.onboarding_completado + ' paso=' + u?.onboarding_paso);
}

async function cleanup(h) {
  if (!userId) {
    // Por si falló antes de capturar el id pero el usuario existe.
    const u = await getUser(h);
    userId = u?.id || null;
  }
  if (!userId) { check('limpieza: no quedó usuario throwaway', true, 'nada que borrar'); return; }
  await h.supabase.from('conversaciones').delete().eq('usuario_id', userId);
  const { error: delErr } = await h.supabase.from('usuarios').delete().eq('id', userId);
  const gone = await getUser(h);
  check('se borró el usuario throwaway y sus conversaciones',
    !delErr && !gone, delErr ? delErr.message : 'id=' + userId + ' borrado');
}

const h = await startWebhookHarness();
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(h); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
