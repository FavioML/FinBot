// E2E del ALTA por WhatsApp (onboarding), el front door del producto, punta a punta
// por el webhook real contra la Supabase real.
//
// El alta se reordenó para que el valor llegue antes que la identidad (baseline
// 2026-07-31: 21 de 82 usuarios se caían ANTES de usar Neto una sola vez, 17 de
// ellos en nombre y email). El camino feliz de hoy es:
//   usuario nuevo → "hola" → paso 100 (pide nombre) → nombre → alta COMPLETA
//   → primer gasto → link de activación a la webapp al pie de la confirmación
//   → al tercer gasto el empujón escala
// Ya no se pide email (paso 101 retirado) ni se elige plan en el alta.
//
// Cada mensaje es una llamada de webhook independiente que RE-LEE el usuario, así que
// el avance de onboarding_paso entre pasos es exactamente el flujo real (no un atajo).
//
// OJO, esto SÍ toca OpenAI: registrar un gasto pasa por el NLP real (a diferencia
// del viejo camino Free, que era todo texto fijo). Son ~4 llamadas a gpt-4o-mini
// por corrida. Y ESCRIBE (crea y muta usuarios) → manual post-deploy, NO canary.
//
// Aislamiento total: usuarios THROWAWAY con whatsapp único por corrida,
// is_test_user=true (cero envíos Meta; además enviarWhatsapp está stubeado). Al
// final borra sus transacciones, conversaciones y filas. No toca a ningún usuario
// real ni a los QA persistentes.
//
// Correr:  node qa-e2e/qa-e2e-onboarding.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const { verificarTokenActivacion } = require('../lib/activacion');

const RUN = Date.now();
const WA = 'qa-onb-' + RUN;
const WA_SKIP = 'qa-onb-skip-' + RUN;
const WA_GASTO = 'qa-onb-gasto-' + RUN;
const NOMBRE = 'Ana Prueba';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

const creados = [];

async function getUser(h, wa) {
  const { data } = await h.supabase.from('usuarios')
    .select('id, nombre, email, plan, onboarding_paso, onboarding_completado, supabase_auth_id')
    .eq('whatsapp', wa).maybeSingle();
  return data;
}

async function sembrar(h, wa) {
  const { data, error } = await h.supabase.from('usuarios').insert({
    whatsapp: wa, is_test_user: true,
    onboarding_paso: 0, onboarding_completado: false, nombre: null, plan: 'free',
  }).select('id').single();
  if (data) creados.push(data.id);
  return { data, error };
}

// Envía un mensaje de texto por el webhook y devuelve { status, reply }.
async function paso(h, texto, wa = WA) {
  const before = h.sent.length;
  const status = await h.postText(texto, wa);
  const reply = (await h.waitForReply(before)).trim();
  return { status, reply };
}

// Extrae el link de activación de una respuesta, si lo trae.
function extraerToken(texto) {
  const m = (texto || '').match(/\/activar\?t=([A-Za-z0-9_.\-]+)/);
  return m ? m[1] : null;
}

async function run(h) {
  // ── Camino feliz: nombre → alta completa → gastos con empujón ──────────────
  const { data: creado, error: insErr } = await sembrar(h, WA);
  if (!check('se sembró el usuario throwaway', !insErr && !!creado, insErr ? insErr.message : 'id=' + creado?.id)) return;
  const userId = creado.id;

  const r1 = await paso(h, 'hola');
  check('el webhook acepta "hola"', r1.status === 200, 'status=' + r1.status);
  check('saluda como NETO y pide el nombre', /c[oó]mo te llamas/i.test(r1.reply), r1.reply.slice(0, 70).replace(/\n/g, ' '));
  let u = await getUser(h, WA);
  check('el estado avanzó a paso 100 (esperando nombre)', u?.onboarding_paso === 100, 'paso=' + u?.onboarding_paso);

  const r2 = await paso(h, NOMBRE);
  check('tras el nombre pide el PRIMER GASTO, no el correo',
    /gast[eé] 20 en taxi/i.test(r2.reply) && !/correo|email/i.test(r2.reply),
    r2.reply.slice(0, 80).replace(/\n/g, ' '));
  check('el alta ya no ofrece elegir plan',
    !/plan pro/i.test(r2.reply) && !/escribe \*free\*/i.test(r2.reply),
    'sin pitch Free/Pro');
  u = await getUser(h, WA);
  check('el nombre quedó guardado y el alta se cerró ahí mismo',
    u?.nombre === NOMBRE && u?.onboarding_completado === true && u?.onboarding_paso === 0,
    'nombre=' + u?.nombre + ' completado=' + u?.onboarding_completado + ' paso=' + u?.onboarding_paso);
  check('no se pidió ni guardó email', !u?.email, 'email=' + u?.email);

  // ── Primer gasto: se registra y trae el link de activación ─────────────────
  const r3 = await paso(h, 'gasté 20 en taxi');
  const { count: tx1 } = await h.supabase.from('transacciones')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', userId);
  check('el primer gasto se registró', tx1 === 1, 'transacciones=' + tx1);

  const token1 = extraerToken(r3.reply);
  check('la confirmación trae el link de activación', !!token1, r3.reply.slice(-90).replace(/\n/g, ' '));
  const payload = token1 ? verificarTokenActivacion(token1) : null;
  check('el token del link es válido y apunta a ESTE usuario',
    payload?.uid === userId, 'uid=' + payload?.uid + ' esperado=' + userId);

  // ── Segundo y tercer gasto: el empujón se repite y escala ──────────────────
  const r4 = await paso(h, 'gasté 15 en almuerzo');
  check('el segundo gasto vuelve a traer el link', !!extraerToken(r4.reply),
    r4.reply.slice(-60).replace(/\n/g, ' '));

  const r5 = await paso(h, 'gasté 32 en farmacia');
  const { count: tx3 } = await h.supabase.from('transacciones')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', userId);
  check('los tres gastos están registrados', tx3 === 3, 'transacciones=' + tx3);
  check('en el corte (3er gasto) el empujón escala y nombra cuántos lleva',
    !!extraerToken(r5.reply) && /3 gastos/.test(r5.reply),
    r5.reply.slice(-110).replace(/\n/g, ' '));
  check('el corte NO bloquea el registro (sin gate)', /32/.test(r5.reply), 'el gasto igual se confirmó');

  // ── Salida por "saltar": el nombre no es obligatorio ───────────────────────
  const { data: cSkip } = await sembrar(h, WA_SKIP);
  if (cSkip) {
    await paso(h, 'hola', WA_SKIP);
    const rSkip = await paso(h, 'saltar', WA_SKIP);
    const uSkip = await getUser(h, WA_SKIP);
    check('"saltar" cierra el alta sin nombre y pide el primer gasto',
      uSkip?.onboarding_completado === true && !uSkip?.nombre && /gast[eé] 20 en taxi/i.test(rSkip.reply),
      'nombre=' + uSkip?.nombre + ' completado=' + uSkip?.onboarding_completado);
  }

  // ── El primer mensaje YA es un gasto: no se pierde ─────────────────────────
  const { data: cGasto } = await sembrar(h, WA_GASTO);
  if (cGasto) {
    const rG = await paso(h, 'gasté 45 en mercado', WA_GASTO);
    const uG = await getUser(h, WA_GASTO);
    const { count: txG } = await h.supabase.from('transacciones')
      .select('id', { count: 'exact', head: true }).eq('usuario_id', cGasto.id);
    check('un primer mensaje que ya es un gasto se registra y cierra el alta',
      txG === 1 && uG?.onboarding_completado === true && uG?.onboarding_paso === 0,
      'transacciones=' + txG + ' completado=' + uG?.onboarding_completado);
    check('y ese primer gasto ya trae el link de activación', !!extraerToken(rG.reply),
      rG.reply.slice(-70).replace(/\n/g, ' '));
  }
}

async function cleanup(h) {
  // Rescate por si falló antes de capturar algún id.
  for (const wa of [WA, WA_SKIP, WA_GASTO]) {
    const u = await getUser(h, wa);
    if (u?.id && !creados.includes(u.id)) creados.push(u.id);
  }
  if (creados.length === 0) { check('limpieza: no quedó usuario throwaway', true, 'nada que borrar'); return; }
  for (const id of creados) {
    await h.supabase.from('transacciones').delete().eq('usuario_id', id);
    await h.supabase.from('conversaciones').delete().eq('usuario_id', id);
    await h.supabase.from('categorias_usuario').delete().eq('usuario_id', id);
    await h.supabase.from('usuarios').delete().eq('id', id);
  }
  const restantes = [];
  for (const wa of [WA, WA_SKIP, WA_GASTO]) {
    if (await getUser(h, wa)) restantes.push(wa);
  }
  check('se borraron los usuarios throwaway y sus datos', restantes.length === 0,
    restantes.length ? 'quedaron: ' + restantes.join(', ') : creados.length + ' borrados');
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
