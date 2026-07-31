// E2E de la fuga 7 (barrido de funnel, 2026-07-31): el usuario que elige Pro DURANTE el alta
// queda en onboarding_paso=2 esperando el comprobante. Antes del fix, solo el comando admin
// /pago lo devolvía a 0 (vía un flag opcional resetOnboarding); el botón de Telegram, el panel
// admin y /activar no. Como esperaComprobante() mira onboarding_paso === 2, esos usuarios
// quedaban atrapados: plan premium, y cada mensaje sin '/' respondido con "elige tu plan /
// mándame la captura". Pasó en producción el 2026-07-21 (pagó, aprobado a los 19s, 10 días
// trabado con 1 transacción).
//
// Complementa qa-e2e-aprobacion-pro.mjs: ese cubre la plata (claim atómico + renovación) con un
// usuario que YA terminó el alta; este cubre el estado del onboarding al aprobar.
//
// Va directo al camino de aprobación de lib/pro-payment.js, el mismo que usan el endpoint admin,
// el callback de Telegram y /pago. Usuarios THROWAWAY (is_test_user=true), autolimpieza completa.
// Escribe a `pagos`/`usuarios` reales → manual post-deploy, NO canary.
//
// Correr:  node qa-e2e/qa-onboarding-paso2-pro.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

delete process.env.TELEGRAM_ADMIN_CHAT_ID;
delete process.env.TELEGRAM_BOT_TOKEN;

import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

// Mismo gotcha que los otros harness de Pro: NO requerir pro-payment antes del harness.
// activarPro captura enviarWhatsapp por destructuring al cargarse.
let reclamarPagoPendiente, activarPro, esperaComprobante;

const RUN = Date.now();
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

const creados = [];

async function seedUsuario(h, { paso, completado, etiqueta }) {
  const { data, error } = await h.supabase.from('usuarios').insert({
    whatsapp: 'qa-p2-' + etiqueta + '-' + RUN,
    email: 'qa-p2-' + etiqueta + '-' + RUN + '@neto-test.local',
    nombre: 'Paso2 Prueba', is_test_user: true,
    plan: 'free', estado_pago: 'pendiente', pago_pendiente: true,
    premium_desde: null, premium_vence: null,
    // Sin gmail_access_token a propósito: es la condición que dispara el trigger de
    // usuario nuevo en handlers/onboarding.js si el alta no queda marcada como completa.
    onboarding_paso: paso, onboarding_completado: completado,
  }).select('id').single();
  if (error) throw new Error('seed usuario ' + etiqueta + ': ' + error.message);
  creados.push(data.id);
  return data.id;
}

async function seedPago(h, userId) {
  const { data, error } = await h.supabase.from('pagos').insert({
    usuario_id: userId, monto: 10, moneda: 'PEN', tipo_plan: 'mensual',
    metodo_pago: 'Yape', estado: 'pendiente', origen: 'whatsapp', comprobante_url: null,
  }).select('id').single();
  if (error) throw new Error('seed pago: ' + error.message);
  return data.id;
}

async function getUser(h, userId) {
  const { data } = await h.supabase.from('usuarios')
    .select('id, plan, onboarding_paso, onboarding_completado, esperando_comprobante, gmail_access_token, premium_vence')
    .eq('id', userId).single();
  return data;
}

async function run(h) {
  // ══ CASO A — el usuario trabado en el paso 2 (el bug de producción) ══════════
  const idA = await seedUsuario(h, { paso: 2, completado: false, etiqueta: 'a' });
  check('se sembró el usuario throwaway parado en el paso 2', !!idA, 'id=' + idA);

  const uAntes = await getUser(h, idA);
  check('precondición: esperaComprobante() lo da por atrapado antes de aprobar',
    esperaComprobante(uAntes) === true, 'paso=' + uAntes?.onboarding_paso);

  const pagoA = await seedPago(h, idA);
  const rA = await reclamarPagoPendiente({ pagoId: pagoA, aprobadoPor: 'qa-e2e' });
  check('reclamarPagoPendiente gana la fila', !!rA && rA.estado === 'aprobado', 'estado=' + rA?.estado);

  // Ruta idéntica a la del botón de Telegram y el panel admin: sin flags extra.
  await activarPro({ usuario: uAntes, tipoPlan: 'mensual', aprobadoPor: 'qa-e2e', pagoId: pagoA, enviarOAuth: false });

  const uA = await getUser(h, idA);
  check('quedó premium', uA?.plan === 'premium', 'plan=' + uA?.plan + ' vence=' + uA?.premium_vence);
  check('salió del paso 2', uA?.onboarding_paso === 0, 'paso=' + uA?.onboarding_paso);
  check('el alta quedó marcada como completa', uA?.onboarding_completado === true,
    'completado=' + uA?.onboarding_completado);
  check('esperaComprobante() ya NO lo atrapa: puede volver a usar Neto',
    esperaComprobante(uA) === false, 'paso=' + uA?.onboarding_paso + ' esperando=' + uA?.esperando_comprobante);
  // Réplica del trigger de entrada al alta en handlers/onboarding.js: sin token de Gmail,
  // onboarding_completado en false manda al usuario de vuelta a "¿cómo te llamas?" (paso 100)
  // aunque ya haya dado nombre y correo.
  check('el trigger de usuario nuevo ya no lo devuelve al paso 100',
    !(!uA?.gmail_access_token && !uA?.onboarding_completado),
    'gmail=' + (uA?.gmail_access_token ? 'sí' : 'no') + ' completado=' + uA?.onboarding_completado);

  // ══ CASO B — usuario parado en OTRO paso del alta: no lo arrastramos ═════════
  const idB = await seedUsuario(h, { paso: 101, completado: false, etiqueta: 'b' });
  const uBantes = await getUser(h, idB);
  const pagoB = await seedPago(h, idB);
  await reclamarPagoPendiente({ pagoId: pagoB, aprobadoPor: 'qa-e2e' });
  await activarPro({ usuario: uBantes, tipoPlan: 'mensual', aprobadoPor: 'qa-e2e', pagoId: pagoB, enviarOAuth: false });

  const uB = await getUser(h, idB);
  check('el usuario en paso 101 también queda premium', uB?.plan === 'premium', 'plan=' + uB?.plan);
  check('a ese NO se le toca el paso del alta (sigue en 101)', uB?.onboarding_paso === 101,
    'paso=' + uB?.onboarding_paso);
  check('ni se le marca el alta como completa', uB?.onboarding_completado === false,
    'completado=' + uB?.onboarding_completado);

  // ══ CASO C — usuario que ya terminó el alta: la renovación no pisa su estado ══
  const idC = await seedUsuario(h, { paso: 0, completado: true, etiqueta: 'c' });
  const uCantes = await getUser(h, idC);
  const pagoC = await seedPago(h, idC);
  await reclamarPagoPendiente({ pagoId: pagoC, aprobadoPor: 'qa-e2e' });
  await activarPro({ usuario: uCantes, tipoPlan: 'mensual', aprobadoPor: 'qa-e2e', pagoId: pagoC, enviarOAuth: false });

  const uC = await getUser(h, idC);
  check('el usuario ya onboardeado sigue en paso 0 y completo',
    uC?.onboarding_paso === 0 && uC?.onboarding_completado === true,
    'paso=' + uC?.onboarding_paso + ' completado=' + uC?.onboarding_completado);
}

async function cleanup(h) {
  if (creados.length === 0) { check('limpieza: nada que borrar', true, 'sin usuarios sembrados'); return; }
  for (const id of creados) {
    await h.supabase.from('notificaciones').delete().eq('usuario_id', id);
    await h.supabase.from('conversaciones').delete().eq('usuario_id', id);
    await h.supabase.from('pagos').delete().eq('usuario_id', id);
    await h.supabase.from('usuarios').delete().eq('id', id);
  }
  const { data: quedan } = await h.supabase.from('usuarios').select('id').in('id', creados);
  check('se borraron los usuarios throwaway y sus dependencias',
    !quedan || quedan.length === 0, 'sembrados=' + creados.length + ' quedan=' + (quedan?.length ?? 0));
}

const h = await startWebhookHarness();
({ reclamarPagoPendiente, activarPro, esperaComprobante } = require(path.join(appRoot, 'lib/pro-payment.js')));
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(h); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
