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
import { instalarGuard, permitirUsuarioDePrueba } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const supabase = instalarGuard(require, '../lib/db');

const WEBAPP = process.env.QA_WEBAPP_URL || 'https://app.neto.pe';
const RUN = Date.now();
const WA = '51900' + String(RUN).slice(-6);

// ── Spy de salida: instalado ANTES de requerir cron/checks ───────────────────────────
// `checkTrialExpiry` es un cron BULK: barre TODOS los usuarios con el trial por vencer, no
// solo el throwaway. La barrera qa-guard cubre las escrituras a Supabase, pero
// `notificarUsuario` manda el WhatsApp ANTES del insert in-app (lib/notify-user.js:128) y ese
// envío es HTTP a Meta, que la barrera no ve. Sin este spy, correr este harness le manda
// "tu prueba Pro termina en 3 días" a usuarios REALES que caigan en la ventana.
//
// Va acá arriba porque notify-user destructura `enviarWhatsapp` al cargar: si el require de
// cron/checks ocurre primero, se queda con la función real y el spy llega tarde.
//
// A diferencia de qa-cron-deudas.mjs, que LANZA ante un destino ajeno, acá se registra y se
// descarta: dentro de checkTrialExpiry cada usuario va en su propio try/catch, así que un
// throw se convertiría en una línea de log y nadie lo vería. Registrarlo permite asertarlo.
const enviosAjenos = [];
const waPath = require.resolve('../lib/whatsapp.js');
const waReal = require(waPath);
const realEnviar = waReal.enviarWhatsapp;
require.cache[waPath].exports = {
  ...waReal,
  enviarWhatsapp: async (to, msg, opts = {}) => {
    // Al throwaway se le delega al real: tiene is_test_user, así que saltea Meta pero SÍ
    // escribe notification_deliveries, que es lo que este harness quiere ejercer.
    if (String(to) === WA) return realEnviar(to, msg, opts);
    enviosAjenos.push(String(to));
    return { ok: true, skipped: 'qa_destino_ajeno' };
  },
};

const trial = require('../lib/trial');
const { guardarTransaccion } = require('../services/transactions');
const { checkTrialExpiry } = require('../cron/checks');
const { activarPro } = require('../lib/pro-payment');
const { sembrarDescuentoReferido, DSCTO_REFERIDO_DIAS } = require('../services/referrals');
const { requiereLectura, comandoRequiereLectura } = require('../handlers/intents-acceso');
const { hoyPeru, sumarDias } = require('../lib/dates');

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

// ── "No se pudo medir" (exit 2) vs "el trial/muro se rompió" (exit 1) ────────────────
//
// Existe por UNA razón concreta: este harness corre `checkTrialExpiry`, un cron BULK contra
// la Supabase de producción. Con gente real en la ventana del cron, lo único que impedía que
// les llegara un WhatsApp era el spy de arriba, y lo único que impedía que se les bajara el
// plan era que la barrera `qa-guard` abortara la escritura DENTRO del `try/catch` por usuario
// del cron — donde un throw es una línea de log que nadie ve. Nunca se midió que eso funcione,
// y no se puede medir un día con la ventana vacía.
//
// Así que en vez de confiar en esas dos redes, no se corre. El spy y la barrera siguen puestos
// (defensa en profundidad: protegen si alguien alguna vez saltea este gate), pero ya no son lo
// que sostiene la seguridad — la sostiene no ejecutar el cron.
class Inconcluso extends Error {}
const inconcluso = (motivo) => { throw new Inconcluso(motivo); };

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
  await activarPro({ usuario: uRef, tipoPlan: 'mensual', aprobadoPor: 'qa-trial', enviarLinkGmail: false, guardarHistorial: false });
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
  // ── Pre-vuelo: GATE, no reporte ───────────────────────────────────────────
  //
  // Hasta el 09-ago-2026 esto medía el radio del cron bulk y solo lo IMPRIMÍA
  // (`check(..., true, ...)`, o sea que pasaba siempre). Un número impreso no protege a
  // nadie: la corrida seguía igual y le pasaba el cron por encima a quien estuviera en la
  // ventana. Ahora, si hay UNA sola persona real ahí, el harness no corre el cron y sale
  // inconcluso. Es la diferencia entre documentar el riesgo y no correrlo.
  //
  // La ventana de acá (`trial_vence <= hoy+AVISO_DIAS_ANTES`) es SUPERCONJUNTO de las tres
  // queries que checkTrialExpiry ejecuta de verdad: aviso d11 (`= hoy+3`), aviso d14
  // (`= hoy`) y downgrade (`< hoy`). Sobre-reporta y nunca sub-reporta, que es la única
  // dirección aceptable: sobre-reportar cuesta un exit 2 de más, sub-reportar significa que
  // el cron toca a alguien que este gate no contó. Si algún día se agrega una rama con una
  // ventana MÁS ANCHA que hoy+AVISO_DIAS_ANTES, esta cota deja de valer y hay que ampliarla
  // acá. `AVISO_DIAS_ANTES` se importa de lib/trial.js, así que mover esa constante ya está
  // cubierto; lo que no está cubierto es una rama nueva.
  const { data: enVentana, error: eVentana } = await supabase.from('usuarios')
    .select('id, is_test_user, trial_vence')
    .eq('trial_estado', 'activo').lte('trial_vence', sumarDias(hoyPeru(), trial.AVISO_DIAS_ANTES));
  // Sin poder MEDIR el radio no se corre tampoco: un error de lectura leído como "no había
  // nadie" es exactamente el fallo que este gate viene a evitar.
  if (eVentana) inconcluso('no se pudo medir el radio del cron bulk: ' + eVentana.message);
  const realesEnVentana = (enVentana || []).filter((u) => u.is_test_user !== true && u.id !== userId);
  if (realesEnVentana.length > 0) {
    inconcluso('hay ' + realesEnVentana.length + ' usuario(s) REAL(es) en la ventana de checkTrialExpiry ' +
      '(vencen ' + [...new Set(realesEnVentana.map((u) => u.trial_vence))].sort().join(', ') + '). ' +
      'No se corre el cron: a esa gente le tocaría el aviso de fin de trial o el downgrade al muro. ' +
      'Volvé a correrlo un día con la ventana vacía.');
  }
  check('pre-vuelo: la ventana del cron bulk está vacía de usuarios reales', true,
    '0 reales (' + (enVentana || []).length + ' filas en ventana, todas de prueba)');
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
  check('el cron bulk no le escribió a NINGÚN usuario real',
    enviosAjenos.length === 0,
    enviosAjenos.length ? 'destinos ajenos: ' + [...new Set(enviosAjenos)].join(', ') : 'solo al throwaway');

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
    // Sin esto el rescate era decoración: la re-lectura por `whatsapp` NO cosecha el id en la
    // barrera (solo `id`/`usuario_id` fijan sujeto), así que los DELETE de abajo abortaban y
    // el huérfano sobrevivía en producción. Verificado contra la barrera real.
    if (userId) await permitirUsuarioDePrueba(userId);
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
let infra = null;
try { await run(); } catch (e) {
  if (e instanceof Inconcluso) { infra = e; console.log('INCONCLUSO — ' + e.message); }
  else { fatal = e; console.log('FAIL excepción — ' + e.message); }
}
// Corre siempre: el gate del pre-vuelo aborta DESPUÉS de haber sembrado el throwaway, así
// que hay una fila en PRODUCCIÓN que sacar aunque no se haya medido nada.
try { await cleanup(); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);

// Un check rojo GANA sobre el inconcluso: lo ya medido es un veredicto y no se degrada a
// "no pude opinar". La incertidumbre solo empuja hacia el lado ruidoso.
//
// `process.exitCode`, NO `process.exit()`: en Windows salir con sockets keep-alive de fetch
// abiertos devuelve 127, y un exit 2 que llega como 127 se lee como fallo desconocido.
if (fallidos.length || fatal) {
  console.log('==> REGRESIÓN (exit 1)');
  process.exitCode = 1;
} else if (infra) {
  console.log('==> INCONCLUSO (exit 2) — ' + infra.message);
  process.exitCode = 2;
} else {
  console.log('==> OK');
  process.exitCode = 0;
}
