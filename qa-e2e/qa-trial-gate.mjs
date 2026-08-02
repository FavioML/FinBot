// E2E del TRIAL DE 14 DÍAS y del MURO que viene después.
//
// Lo que este harness cuida, que es el riesgo real del diseño: durante el trial
// `plan` vale 'premium'. Eso es lo que hace barato el cambio (los ~40 gates que
// miran esa columna entregan Pro sin tocarse), pero significa que TRES cosas
// distintas comparten un mismo valor: el que paga, el que prueba, y el que ya no
// tiene nada. Si alguna de las tres se confunde con otra, no explota nada — se ve
// como un usuario contento que nunca paga, o como un pagador al que le cortaron
// el servicio. Ninguno de los dos se detecta mirando producción.
//
// Corre contra la Supabase REAL con un usuario throwaway (se borra al final) y
// contra el backend de verdad: `iniciarTrialSiCorresponde`, `checkTrialExpiry` y
// `activarPro` se importan y se ejecutan, no se simulan.
//
// Lo que NO cubre, a propósito:
//   - El 402 de la webapp con sesión: necesita el usuario QA logueado, que ya
//     ejercita `qa-gate.mjs`. Acá se verifica el contrato sin sesión (401).
//   - Los envíos de WhatsApp: el throwaway usa un número 519xxxxx inexistente, así
//     que Meta responde error y `notification_deliveries` lo registra. Es lo
//     esperado; lo que se verifica es el efecto en DB, no la entrega.
//
// Correr:  node qa-e2e/qa-trial-gate.mjs   (desde app/)  → exit 0 si pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const supabase = instalarGuard(require, '../lib/db');
const trial = require('../lib/trial');
const { guardarTransaccion } = require('../services/transactions');
const { checkTrialExpiry } = require('../cron/checks');
const { activarPro } = require('../lib/pro-payment');
const { sembrarDescuentoReferido, DSCTO_REFERIDO_DIAS } = require('../services/referrals');
const { requiereLectura, comandoRequiereLectura } = require('../handlers/intents-acceso');
const { hoyPeru, sumarDias } = require('../lib/dates');

const WEBAPP = process.env.QA_WEBAPP_URL || 'https://app.neto.pe';
const RUN = Date.now();
const WA = '51900' + String(RUN).slice(-6);

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

let userId = null;
const leer = async (cols = '*') => {
  const { data } = await supabase.from('usuarios').select(cols).eq('id', userId).maybeSingle();
  return data;
};
const gasto = (monto, comercio) => guardarTransaccion(userId, {
  monto, moneda: 'PEN', comercio, categoria: 'Alimentación', subcategoria: 'restaurante',
  tipo: 'gasto', fecha: hoyPeru(), descripcion_original: 'qa-trial ' + RUN,
});

async function run() {
  // ── Sembrar el throwaway: free, sin trial, como cualquier usuario nuevo ────
  const { data: creado, error: insErr } = await supabase.from('usuarios').insert({
    whatsapp: WA, nombre: 'Trial Prueba', plan: 'free',
    onboarding_completado: true, is_test_user: true,
  }).select('id').single();
  if (!check('se sembró el usuario throwaway', !insErr && creado, insErr ? insErr.message : 'wa=' + WA)) return;
  userId = creado.id;

  // ── 1. El primer gasto arranca el trial ───────────────────────────────────
  const tx1 = await gasto(20, 'Menú QA');
  const u1 = await leer();
  check('el PRIMER gasto arranca el trial (estado activo)', u1.trial_estado === 'activo', 'estado=' + u1.trial_estado);
  check('el trial entrega Pro: plan pasa a premium', u1.plan === 'premium', 'plan=' + u1.plan);
  check('trial_vence = hoy + ' + trial.TRIAL_DIAS + ' días',
    String(u1.trial_vence).slice(0, 10) === sumarDias(hoyPeru(), trial.TRIAL_DIAS),
    'vence=' + u1.trial_vence);
  // premium_vence tiene que quedar NULL o checkPremiumExpiry (que filtra por esa
  // columna) empezaría a tratar los trials como suscripciones pagadas.
  check('premium_vence queda NULL durante el trial', u1.premium_vence == null, 'premium_vence=' + u1.premium_vence);
  check('la fila del gasto avisa que arrancó el trial (trialIniciado)', tx1 && tx1.trialIniciado === true,
    'trialIniciado=' + (tx1 && tx1.trialIniciado));

  // ── 2. El segundo gasto NO reinicia ni extiende ───────────────────────────
  const venceOriginal = String(u1.trial_vence).slice(0, 10);
  const tx2 = await gasto(35.5, 'Otro QA');
  const u2 = await leer();
  check('el segundo gasto NO extiende el trial', String(u2.trial_vence).slice(0, 10) === venceOriginal,
    'vence=' + u2.trial_vence);
  check('el segundo gasto no re-anuncia el trial', !tx2.trialIniciado, 'trialIniciado=' + tx2.trialIniciado);

  // ── 3. La cola de la confirmación anuncia el trial una sola vez ───────────
  const cola1 = await trial.colaConfirmacionGasto(u1, tx1, 1);
  check('la confirmación del primer gasto anuncia los ' + trial.TRIAL_DIAS + ' días',
    !!cola1 && cola1.includes(String(trial.TRIAL_DIAS) + ' días'), (cola1 || '').slice(0, 60).replace(/\n/g, ' '));
  const cola2 = await trial.colaConfirmacionGasto(u2, tx2, 2);
  check('la del segundo NO habla del muro (sigue en trial)',
    !cola2 || !cola2.includes('Van *S/'), (cola2 || '(null)').slice(0, 60).replace(/\n/g, ' '));

  // ── 4. Referidos: la ventana del 50% se ancla al FIN del trial ────────────
  // Sembrado DESPUÉS de arrancar el trial: es el camino que rompía el diseño viejo,
  // porque `plan` ya vale 'premium' y el corte por plan a secas lo dejaba sin descuento.
  await sembrarDescuentoReferido(userId);
  const uRef = await leer();
  check('el referido en trial SÍ recibe el 50% off', uRef.referido_dscto_pct === 50,
    'pct=' + uRef.referido_dscto_pct);
  check('la ventana del descuento vence ' + DSCTO_REFERIDO_DIAS + 'd DESPUÉS del trial, no del alta',
    String(uRef.referido_dscto_vence).slice(0, 10) === sumarDias(venceOriginal, DSCTO_REFERIDO_DIAS),
    'dscto_vence=' + uRef.referido_dscto_vence + ' vs trial_vence=' + venceOriginal);

  // ── 5. Pagar durante el trial no cuesta los días que faltaban ─────────────
  await activarPro({ usuario: uRef, tipoPlan: 'mensual', aprobadoPor: 'qa-trial', enviarOAuth: false, guardarHistorial: false });
  const uPago = await leer();
  check('al pagar en trial el periodo se apila sobre trial_vence (no sobre hoy)',
    String(uPago.premium_vence).slice(0, 10) > sumarDias(hoyPeru(), 30),
    'premium_vence=' + uPago.premium_vence);
  check('pagar sella el trial como convertido', uPago.trial_estado === 'convertido', 'estado=' + uPago.trial_estado);

  // ── 6. Un Pro pagado NO se gana otro trial con su próximo gasto ───────────
  const venceProAntes = String(uPago.premium_vence).slice(0, 10);
  await gasto(12, 'Post pago QA');
  const uPro = await leer();
  check('un gasto de un Pro pagado no le toca el plan', uPro.plan === 'premium', 'plan=' + uPro.plan);
  check('ni le reabre un trial', uPro.trial_estado === 'convertido', 'estado=' + uPro.trial_estado);
  check('ni le mueve el vencimiento', String(uPro.premium_vence).slice(0, 10) === venceProAntes,
    'premium_vence=' + uPro.premium_vence);

  // ── 7. El cron vence el trial y baja al muro ──────────────────────────────
  // Se rebobina la fila a "trial que venció ayer".
  await supabase.from('usuarios').update({
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyPeru(), -1),
    premium_vence: null, premium_desde: null,
  }).eq('id', userId);
  await checkTrialExpiry();
  const uMuro = await leer();
  check('checkTrialExpiry baja el plan a free', uMuro.plan === 'free', 'plan=' + uMuro.plan);
  check('y marca el trial como vencido', uMuro.trial_estado === 'vencido', 'estado=' + uMuro.trial_estado);
  const { data: notifs } = await supabase.from('notificaciones').select('titulo')
    .eq('usuario_id', userId).eq('titulo', 'Tu prueba Pro terminó');
  check('deja la notificación in-app (canal garantizado, no depende de Meta)',
    !!notifs && notifs.length >= 1, 'notificaciones=' + (notifs || []).length);

  // Correr de nuevo tiene que ser no-op: el claim condicionado a trial_estado='activo'
  // es lo que evita avisar dos veces si dos corridas se solapan.
  await checkTrialExpiry();
  const { data: notifs2 } = await supabase.from('notificaciones').select('id')
    .eq('usuario_id', userId).eq('titulo', 'Tu prueba Pro terminó');
  check('correr el cron de nuevo NO duplica el aviso', (notifs2 || []).length === (notifs || []).length,
    'antes=' + (notifs || []).length + ' después=' + (notifs2 || []).length);

  // ── 8. El muro: escribir sigue abierto, leer no ───────────────────────────
  check('estaEnMuro() reconoce al usuario vencido', trial.estaEnMuro(uMuro) === true);
  const tx3 = await gasto(48.9, 'Gasto en muro QA');
  check('REGISTRAR UN GASTO SIGUE FUNCIONANDO EN EL MURO (la promesa que no se negocia)',
    !!tx3 && !!tx3.id, tx3 ? 'id=' + tx3.id : 'no se guardó');
  const cola3 = await trial.nudgeMuro(uMuro);
  check('la confirmación en el muro deja el total del mes', !!cola3 && cola3.includes('Van *S/'),
    (cola3 || '(null)').slice(0, 70).replace(/\n/g, ' '));
  check('...y NO el desglose', !!cola3 && !cola3.includes('Alimentación'));

  const muroMsg = trial.mensajeMuro(uMuro, 3);
  check('el mensaje del muro nombra que la PRUEBA terminó', muroMsg.includes('prueba'), '');
  check('y aclara que no se borró nada', /no se borra nada/i.test(muroMsg), '');
  // Quien nunca tuvo trial no puede leer "tu prueba terminó": sería mentirle.
  const muroSinTrial = trial.mensajeMuro({ nombre: 'Ana', trial_estado: null }, 0);
  check('a quien NUNCA tuvo prueba se le ofrece, no se le dice que terminó',
    !muroSinTrial.includes('terminó') && muroSinTrial.includes(String(trial.TRIAL_DIAS) + ' días'),
    muroSinTrial.slice(0, 70).replace(/\n/g, ' '));

  // ── 9. Clasificación de intents y comandos ────────────────────────────────
  check('las consultas agregadas requieren plan',
    requiereLectura('listar_gastos_mes') && requiereLectura('ver_reporte') && requiereLectura('ver_total_gastado'));
  check('registrar y corregir NO requieren plan',
    !requiereLectura('registrar_manual') && !requiereLectura('deshacer_ultimo') && !requiereLectura('editar_monto'));
  check('los caminos de pago siguen abiertos',
    !requiereLectura('ver_premium') && !requiereLectura('estado_cuenta'));
  check('los comandos / de lectura están cubiertos',
    comandoRequiereLectura('/reporte julio') && comandoRequiereLectura('/mes') && !comandoRequiereLectura('/premium'));

  // ── 10. Contrato de la webapp sin sesión ──────────────────────────────────
  const rDash = await fetch(`${WEBAPP}/api/dashboard`);
  check('GET /api/dashboard sin sesión responde 401 (no 402: primero autentica)',
    rDash.status === 401, 'status=' + rDash.status);
  const rMuro = await fetch(`${WEBAPP}/api/pro/muro`);
  check('GET /api/pro/muro sin sesión responde 401', rMuro.status === 401, 'status=' + rMuro.status);
  const rWarm = await fetch(`${WEBAPP}/api/dashboard?warm=1`);
  check('el keep-warm sigue pasando sin auth (lo usa el cron de Railway)',
    rWarm.status === 200, 'status=' + rWarm.status);
}

async function cleanup() {
  if (!userId) {
    const { data } = await supabase.from('usuarios').select('id').eq('whatsapp', WA).maybeSingle();
    userId = data?.id || null;
  }
  if (!userId) { check('limpieza: no quedó usuario throwaway', true, 'nada que borrar'); return; }
  await supabase.from('transacciones').delete().eq('usuario_id', userId);
  await supabase.from('notificaciones').delete().eq('usuario_id', userId);
  await supabase.from('categorias_usuario').delete().eq('usuario_id', userId);
  await supabase.from('pagos').delete().eq('usuario_id', userId);
  await supabase.from('notification_deliveries').delete().eq('usuario_id', userId);
  const { error } = await supabase.from('usuarios').delete().eq('id', userId);
  const { data: sigue } = await supabase.from('usuarios').select('id').eq('id', userId).maybeSingle();
  check('se borró el usuario throwaway y todo lo suyo', !error && !sigue,
    error ? error.message : 'id=' + userId + ' borrado');
}

let fatal = null;
try { await run(); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
