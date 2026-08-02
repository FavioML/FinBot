// E2E de la APROBACIÓN del flujo Pro (Free → premium), complemento de
// qa-e2e-pago-pro.mjs (ese cubre "solicitud pendiente"; este cubre "aprobación").
//
// Es donde de verdad se mueve la plata y vive el código más riesgoso, hoy sin red
// end-to-end contra Postgres real:
//   · reclamarPagoPendiente = CLAIM ATÓMICO (UPDATE ... WHERE estado='pendiente'):
//     cierra la ventana TOCTOU de doble-activación (doble-tap Telegram, reintento
//     del callback, doble-click en el panel). Solo UNA ejecución gana la fila.
//   · activarPro = flip a premium + MATEMÁTICA DE RENOVACIÓN: apila el periodo SOBRE
//     el premium_vence vigente (no desde hoy) y NUNCA acorta. Se rompe en silencio.
//   · el COMP (Pro regalado por POST /admin/activar o el comando /activar): mismo camino
//     con esConversionPagada:false. Sella el trial, no acorta, y se registra a S/0.
//
// No pasa por webhook ni Vision: invoca directo el camino de aprobación de
// lib/pro-payment.js (el mismo que usa el endpoint admin / callback Telegram / /pago).
// El harness se usa solo por su stub de enviarWhatsapp (para capturar "¡Pago
// confirmado!") y su handle de Supabase real.
//
// Aislamiento total: usuario THROWAWAY Free (whatsapp/email únicos, is_test_user=true)
// con filas `pagos` pendientes sembradas directo (sin Storage, sin Vision → barato).
// Autolimpieza completa (notificaciones + conversaciones + pagos + usuario).
// Escribe a `pagos`/`usuarios` reales → manual post-deploy, NO canary.
//
// Correr:  node qa-e2e/qa-e2e-aprobacion-pro.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

// Por si el .env local trajera claves Telegram: forzar que cualquier notificación
// caiga al fallback WhatsApp (stubeado) y no dispare un Telegram real.
delete process.env.TELEGRAM_ADMIN_CHAT_ID;
delete process.env.TELEGRAM_BOT_TOKEN;

import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

// OJO (mismo gotcha que qa-e2e-pago-pro): NO requerir pro-payment.js antes del
// harness. activarPro hace `const { enviarWhatsapp } = require('./whatsapp')` y captura
// la fn por destructuring al cargarse; si se carga antes del swap del stub, "¡Pago
// confirmado!" se va a Meta real y no se captura. Se resuelve DESPUÉS del harness.
let reclamarPagoPendiente, activarPro;

const RUN = Date.now();
const WA = 'qa-apro-' + RUN;
const EMAIL = 'qa-apro-' + RUN + '@neto-test.local';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

let userId = null;

// Réplica EXACTA de la matemática de vencimiento de activarPro (mensual, mesesAdd=1):
// base = premium_vence vigente si es futuro, si no hoy; vence = base +1 mes.
function calcVenceMensual(premiumVenceStr) {
  const hoy = new Date();
  let base = hoy;
  if (premiumVenceStr) {
    const actual = new Date(premiumVenceStr + 'T12:00:00');
    if (!isNaN(actual.getTime()) && actual > hoy) base = actual;
  }
  const vence = new Date(base.getFullYear(), base.getMonth() + 1, base.getDate());
  return vence.toISOString().split('T')[0];
}

async function getUser(h) {
  const { data } = await h.supabase.from('usuarios')
    // trial_estado/trial_vence van en el select porque activarPro RAMIFICA por ellas (apila
    // sobre el fin del trial y lo sella como convertido). Una fila parcial decidiría distinto
    // que producción, que lee el usuario completo.
    .select('id, whatsapp, plan, estado_pago, tipo_plan, premium_desde, premium_vence, pago_pendiente, esperando_comprobante, trial_estado, trial_vence')
    .eq('id', userId).single();
  return data;
}

async function getPago(h, pagoId) {
  const { data } = await h.supabase.from('pagos')
    .select('id, estado, tipo_plan, monto, premium_desde, premium_vence, aprobado_at, aprobado_por')
    .eq('id', pagoId).single();
  return data;
}

async function seedPagoPendiente(h) {
  const { data, error } = await h.supabase.from('pagos').insert({
    usuario_id: userId, monto: 10, moneda: 'PEN', tipo_plan: 'mensual',
    metodo_pago: 'Yape', estado: 'pendiente', origen: 'whatsapp', comprobante_url: null,
  }).select('id').single();
  if (error) throw new Error('seed pago: ' + error.message);
  return data.id;
}

async function run(h) {
  // ── Sembrar usuario throwaway Free con pago pendiente ────────────────────────
  const { data: creado, error: insErr } = await h.supabase.from('usuarios').insert({
    whatsapp: WA, email: EMAIL, nombre: 'Aprob Prueba', is_test_user: true,
    plan: 'free', estado_pago: 'pendiente', pago_pendiente: true,
    premium_desde: null, premium_vence: null,
    onboarding_paso: 0, onboarding_completado: true,
  }).select('id').single();
  if (!check('se sembró el usuario throwaway Free', !insErr && !!creado, insErr ? insErr.message : 'id=' + creado?.id)) return;
  userId = creado.id;

  const pago1 = await seedPagoPendiente(h);
  check('se sembró la fila `pagos` pendiente (P1)', !!pago1, 'id=' + pago1);

  // ══ TEST A — aprobación feliz (usuario sin premium previo) ═══════════════════
  const uFresh = await getUser(h);
  const r1 = await reclamarPagoPendiente({ pagoId: pago1, aprobadoPor: 'qa-e2e' });
  check('reclamarPagoPendiente(P1) gana la fila (pendiente → aprobado)',
    !!r1 && r1.estado === 'aprobado', r1 ? 'estado=' + r1.estado : 'null (no reclamó)');

  const before = h.sent.length;
  // esConversionPagada:true = lo que manda el flujo real de aprobación (webapp/Telegram//pago).
  // Decide el copy ("¡Pago confirmado!"), el monto registrado y el premio al referrer.
  await activarPro({ usuario: uFresh, tipoPlan: 'mensual', aprobadoPor: 'qa-e2e', pagoId: pago1, enviarOAuth: false, esConversionPagada: true });

  const uA = await getUser(h);
  const expV1 = calcVenceMensual(null);
  check('usuario quedó premium/pagado/mensual, flags limpios',
    uA?.plan === 'premium' && uA?.estado_pago === 'pagado' && uA?.tipo_plan === 'mensual' &&
    uA?.pago_pendiente === false && uA?.esperando_comprobante === false,
    'plan=' + uA?.plan + ' estado_pago=' + uA?.estado_pago + ' tipo=' + uA?.tipo_plan +
    ' pendiente=' + uA?.pago_pendiente);
  check('premium_vence = hoy + 1 mes (' + expV1 + ')', uA?.premium_vence === expV1, 'vence=' + uA?.premium_vence);
  check('premium_desde quedó seteado', !!uA?.premium_desde, 'desde=' + uA?.premium_desde);

  const pA = await getPago(h, pago1);
  check('la fila `pagos` P1 quedó aprobada, con plan/periodo/aprobado_at',
    pA?.estado === 'aprobado' && !!pA?.premium_desde && !!pA?.premium_vence &&
    !!pA?.aprobado_at && pA?.tipo_plan === 'mensual',
    'estado=' + pA?.estado + ' vence=' + pA?.premium_vence + ' aprobado_at=' + (pA?.aprobado_at ? 'sí' : 'no'));

  const msgUser = h.sent.slice(before).filter((s) => s.to === WA).map((s) => s.msg).join('\n');
  check('el usuario recibió "¡Pago confirmado!"',
    /pago confirmado/i.test(msgUser), msgUser.slice(0, 60).replace(/\n/g, ' '));

  const V1 = uA?.premium_vence;

  // ══ TEST B — idempotencia del claim atómico (doble-tap NO apila) ═════════════
  const before2 = h.sent.length;
  const r2 = await reclamarPagoPendiente({ pagoId: pago1, aprobadoPor: 'qa-e2e' });
  check('segundo reclamo de P1 devuelve null (ya no está pendiente)', r2 === null, 'r2=' + (r2 === null ? 'null' : 'fila'));
  // Con r2=null NO se llama activarPro (así lo hace el flujo real). El vencimiento
  // y el conteo de filas deben quedar EXACTAMENTE igual: sin segundo mes, sin duplicado.
  const uB = await getUser(h);
  const { count: nPagosB } = await h.supabase.from('pagos')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', userId);
  check('doble-tap no apiló otro mes (premium_vence intacto)', uB?.premium_vence === V1, 'vence=' + uB?.premium_vence + ' (V1=' + V1 + ')');
  check('doble-tap no duplicó fila en `pagos` (sigue 1)', nPagosB === 1, 'filas=' + nPagosB);
  check('doble-tap no emitió otro "¡Pago confirmado!"', h.sent.length === before2, (h.sent.length - before2) + ' mensajes nuevos');

  // ══ TEST C — renovación: apila sobre el vence vigente, no desde hoy ══════════
  const pago2 = await seedPagoPendiente(h);
  check('se sembró la fila `pagos` pendiente (P2) para renovación', !!pago2, 'id=' + pago2);
  const uPrev = await getUser(h); // ya premium con vence V1 futuro
  const r3 = await reclamarPagoPendiente({ pagoId: pago2, aprobadoPor: 'qa-e2e' });
  check('reclamarPagoPendiente(P2) gana la fila', !!r3 && r3.estado === 'aprobado', r3 ? 'estado=' + r3.estado : 'null');
  await activarPro({ usuario: uPrev, tipoPlan: 'mensual', aprobadoPor: 'qa-e2e', pagoId: pago2, enviarOAuth: false, esConversionPagada: true });

  const uC = await getUser(h);
  const expV2 = calcVenceMensual(V1); // apilado SOBRE V1
  const hoyMas1 = calcVenceMensual(null); // lo que sería si (mal) contara desde hoy
  check('renovación apila sobre premium_vence vigente (' + expV2 + '), no desde hoy',
    uC?.premium_vence === expV2, 'vence=' + uC?.premium_vence + ' esperado=' + expV2);
  check('renovación NO acortó ni contó desde hoy',
    uC?.premium_vence > V1 && uC?.premium_vence !== hoyMas1,
    'vence=' + uC?.premium_vence + ' V1=' + V1 + ' hoy+1=' + hoyMas1);
  const { count: nPagosC } = await h.supabase.from('pagos')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', userId).eq('estado', 'aprobado');
  check('quedan 2 filas `pagos` aprobadas (alta + renovación)', nPagosC === 2, 'aprobadas=' + nPagosC);

  // ══ TEST D — COMP (POST /admin/activar): Pro regalado, sin pago ══════════════
  // Hasta el 2026-08-02 esa ruta escribía su propio UPDATE de 4 columnas en vez de llamar
  // activarPro. Los tres agujeros que dejaba se verifican acá contra Postgres real.
  // El usuario entra al comp con Pro vigente (V2) y un trial 'activo' ya vencido: la
  // combinación exacta en la que el UPDATE a mano acortaba el vencimiento y dejaba la fila
  // en 'activo' para que checkTrialExpiry la bajara a `plan:'free'` esa misma noche.
  const V2 = uC?.premium_vence;
  const { error: errSeedTrial } = await h.supabase.from('usuarios')
    .update({ trial_estado: 'activo', trial_vence: '2020-01-01' }).eq('id', userId);
  check('se sembró el trial activo (ya vencido) sobre el usuario premium', !errSeedTrial,
    errSeedTrial ? errSeedTrial.message : 'trial_estado=activo trial_vence=2020-01-01');

  const before4 = h.sent.length;
  const uComp = await getUser(h);
  await activarPro({
    usuario: uComp, tipoPlan: 'mensual', aprobadoPor: 'admin:comp',
    enviarOAuth: false, esConversionPagada: false,
  });

  const uD = await getUser(h);
  const expV3 = calcVenceMensual(V2);
  check('el comp NO acorta la suscripción vigente (apila sobre ' + V2 + ')',
    uD?.premium_vence === expV3, 'vence=' + uD?.premium_vence + ' esperado=' + expV3);
  check('el comp sella el trial (convertido): checkTrialExpiry ya no lo baja a free',
    uD?.trial_estado === 'convertido', 'trial_estado=' + uD?.trial_estado);

  const { data: pagosComp } = await h.supabase.from('pagos')
    .select('monto, estado, aprobado_por').eq('usuario_id', userId).eq('aprobado_por', 'admin:comp');
  check('el comp queda registrado en `pagos` a S/0 (constancia sí, caja del mes no)',
    pagosComp?.length === 1 && Number(pagosComp[0].monto) === 0 && pagosComp[0].estado === 'aprobado',
    'filas=' + pagosComp?.length + ' monto=' + pagosComp?.[0]?.monto);
  const compMsgs = h.sent.slice(before4).filter((s) => s.to === WA);
  check('el comp igual le avisa al usuario (un solo aviso, el de activarPro)',
    compMsgs.length === 1, compMsgs.length + ' mensajes');
  // Al regalado no se le confirma un cobro que no existió, ni se le nombra un precio.
  const compTexto = compMsgs.map((s) => s.msg).join('\n');
  check('el comp NO recibe "¡Pago confirmado!" ni el precio',
    !/pago confirmado/i.test(compTexto) && !/S\/\s*\d/.test(compTexto),
    compTexto.slice(0, 60).replace(/\n/g, ' '));
}

async function cleanup(h) {
  if (!userId) {
    const { data } = await h.supabase.from('usuarios').select('id').eq('whatsapp', WA).maybeSingle();
    userId = data?.id || null;
  }
  if (!userId) { check('limpieza: no quedó usuario throwaway', true, 'nada que borrar'); return; }
  await h.supabase.from('notificaciones').delete().eq('usuario_id', userId);
  await h.supabase.from('conversaciones').delete().eq('usuario_id', userId);
  const { error: delPagos } = await h.supabase.from('pagos').delete().eq('usuario_id', userId);
  check('se borraron las filas de `pagos`', !delPagos, delPagos ? delPagos.message : 'ok');
  const { error: delErr } = await h.supabase.from('usuarios').delete().eq('id', userId);
  const { data: gone } = await h.supabase.from('usuarios').select('id').eq('id', userId).maybeSingle();
  check('se borró el usuario throwaway y sus dependencias',
    !delErr && !gone, delErr ? delErr.message : 'id=' + userId + ' borrado');
}

const h = await startWebhookHarness();
// Requerir DESPUÉS del harness: pro-payment se carga con el stub de whatsapp ya en cache.
({ reclamarPagoPendiente, activarPro } = require(path.join(appRoot, 'lib/pro-payment.js')));
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(h); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
