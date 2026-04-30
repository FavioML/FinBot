/**
 * Survey Triggers — UPDATE-05
 *
 * Sistema de engagement por WhatsApp + invite a webapp.
 * Reglas operativas (basadas en research docs/research/whatsapp-surveys-research.md):
 *
 *   - Maximo 1 mensaje proactivo cada 7 dias por usuario (anti-fatiga + WhatsApp Quality Rating)
 *   - Respeta usuarios.recordatorios_activos = false (opt-out global)
 *   - No manda si hubo error reciente del usuario en ultimas 24h
 *   - One-shot triggers (webapp_invite_10tx, feedback_open_30tx, nps_inapp) usan unique
 *     constraint en DB para garantizar entrega unica
 *   - Hora de envio: 10am Lima (research: 9-11:30am es optimal en LATAM)
 */

const { supabase } = require('../lib/db');
const { enviarWhatsapp } = require('../lib/whatsapp');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');

const MIN_DAYS_BETWEEN_PROACTIVE = 7;
const ERROR_BLACKOUT_HOURS = 24;

/** Devuelve true si al usuario YA se le mando algun mensaje proactivo en los ultimos N dias. */
async function recibioMensajeRecienteProactivo(userId, dias = MIN_DAYS_BETWEEN_PROACTIVE) {
  const cutoff = new Date(Date.now() - dias * 86400000).toISOString();
  const { data } = await supabase.from('survey_events')
    .select('id')
    .eq('user_id', userId)
    .eq('channel', 'whatsapp')
    .gte('sent_at', cutoff)
    .limit(1);
  return Boolean(data && data.length > 0);
}

/** True si el usuario tuvo un error reciente. Evita encuestar tras una mala experiencia. */
async function tuvoErrorReciente(userId, horas = ERROR_BLACKOUT_HOURS) {
  const cutoff = new Date(Date.now() - horas * 3600 * 1000).toISOString();
  const { data: errs } = await supabase.from('errores')
    .select('id').eq('usuario_id', userId).gte('created_at', cutoff).limit(1);
  if (errs && errs.length > 0) return true;
  const { data: nlpErrs } = await supabase.from('nlp_errors')
    .select('id').eq('usuario_id', userId).gte('created_at', cutoff).limit(1);
  return Boolean(nlpErrs && nlpErrs.length > 0);
}

/** Cuenta transacciones del usuario (no eliminadas). */
async function contarTransacciones(userId) {
  const { count } = await supabase.from('transacciones')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', userId);
  return count || 0;
}

/** Cuenta transacciones del usuario en los ultimos N dias. */
async function contarTransaccionesUltimos(userId, dias) {
  const cutoff = new Date(Date.now() - dias * 86400000).toISOString().split('T')[0];
  const { count } = await supabase.from('transacciones')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', userId)
    .gte('fecha', cutoff);
  return count || 0;
}

/** Inserta survey_event marcando idempotencia para los one-shot tipos via unique index. */
async function registrarEvento({ userId, eventType, channel, messageSent, responseData = null }) {
  const { data, error } = await supabase.from('survey_events').insert({
    user_id: userId,
    event_type: eventType,
    channel,
    sent_at: new Date().toISOString(),
    message_sent: messageSent,
    response_data: responseData,
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return null; // duplicate (unique constraint hit) — idempotente
    throw error;
  }
  return data?.id || null;
}

/** Envia mensaje y registra el evento. Si falla, no registra (asi reintenta proxima vez). */
async function enviarYRegistrar(usuario, eventType, mensaje) {
  await enviarWhatsapp(usuario.whatsapp, mensaje);
  return registrarEvento({
    userId: usuario.id,
    eventType,
    channel: 'whatsapp',
    messageSent: mensaje,
  });
}

// ===== Generadores de copy =====

function copyReminderD3(primerNombre) {
  const saludo = primerNombre ? primerNombre + ', ¿' : '¿';
  return `Hola ${saludo}qué tal va tu semana?\n\n` +
    'Te escribo para recordarte que registrar gastos en Neto es súper rápido. Solo escríbeme cosas como:\n' +
    '_"gasté 25 en almuerzo"_\n_"taxi 12 soles"_\n\n' +
    'O envíame foto de tu Yape/Plin y yo lo registro por ti.\n\n' +
    '¿Te animas a probar con tu último gasto?\n\n' +
    '_Si no quieres más recordatorios escribe /silenciar_';
}

function copyReminderD7(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, una semana ya 👀\n\n` +
    'Sin pelo en la lengua: registrar gastos no es divertido pero saber a dónde se te va la plata, sí.\n\n' +
    'Tip rápido: la próxima vez que pagues algo con Yape, sácale screenshot y mándamelo. Te toma 2 segundos y yo hago el resto.\n\n' +
    '_Para silenciar recordatorios escribe /silenciar_';
}

function copyReminderD14(primerNombre) {
  const saludo = primerNombre ? primerNombre + ', vi' : 'Vi';
  return `Oye ${saludo} que estás usando Neto poco esta semana.\n\n` +
    '¿Hay algo que te complica o que esperabas que funcionara distinto? Cuéntame en una sola línea, lo leo todo.\n\n' +
    'Si solo tuviste una semana ocupada, ningún problema, sigue cuando quieras.\n\n' +
    '_/silenciar para no recibir más recordatorios_';
}

function copyReminderD30(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, hace dos semanas que no registras nada en Neto.\n\n` +
    '¿Pasó algo? ¿Encontraste otra forma de llevar tus gastos, o simplemente se te olvidó?\n\n' +
    'Si quieres retomarlo, mándame cualquier gasto de hoy y arrancamos. Si prefieres pausarlo, escribe /silenciar y dejamos de molestarte.';
}

function copyWebappInvite(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, ya registraste 10 gastos con Neto 🎯\n\n` +
    '¿Sabías que también tienes una app web con tus charts, presupuestos visuales y reportes? Te toma 10 segundos entrar:\n\n' +
    '👉 https://app.neto.pe\n\n' +
    'Solo entras con tu Google y ya está, todo lo que registras por WhatsApp aparece ahí.\n\n' +
    '_Si no te interesa por ahora ningún problema, seguimos por aquí._';
}

function copyFeedback30(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, llevamos 30 gastos juntos, ya eres usuario veterano 🙌\n\n` +
    'Una pregunta corta para mejorar Neto: si pudieras cambiar UNA sola cosa del producto, ¿qué sería?\n\n' +
    'Lo que se te venga primero a la mente. Una línea basta.';
}

// ===== Triggers =====

/** Verifica si el usuario califica para reminder_d3 y manda el mensaje. */
async function maybeReminderD3(usuario) {
  const txCount = await contarTransacciones(usuario.id);
  if (txCount > 0) return false;

  const created = new Date(usuario.created_at).getTime();
  const dias = (Date.now() - created) / 86400000;
  if (dias < 3 || dias >= 4) return false;

  // No reenviar si ya recibio reminder_d3 antes
  const { data: prev } = await supabase.from('survey_events')
    .select('id').eq('user_id', usuario.id).eq('event_type', 'reminder_d3').limit(1);
  if (prev && prev.length > 0) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  await enviarYRegistrar(usuario, 'reminder_d3', copyReminderD3(primer));
  return true;
}

async function maybeReminderD7(usuario) {
  const txCount = await contarTransacciones(usuario.id);
  if (txCount > 0) return false;

  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 7 || dias >= 8) return false;

  const { data: prev } = await supabase.from('survey_events')
    .select('id').eq('user_id', usuario.id).eq('event_type', 'reminder_d7').limit(1);
  if (prev && prev.length > 0) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  await enviarYRegistrar(usuario, 'reminder_d7', copyReminderD7(primer));
  return true;
}

async function maybeReminderD14(usuario) {
  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 14 || dias >= 15) return false;

  if (!usuario.onboarding_completado) return false;

  const txUltimos14 = await contarTransaccionesUltimos(usuario.id, 14);
  if (txUltimos14 >= 3) return false; // uso saludable, no encuestar

  const { data: prev } = await supabase.from('survey_events')
    .select('id').eq('user_id', usuario.id).eq('event_type', 'reminder_d14').limit(1);
  if (prev && prev.length > 0) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  await enviarYRegistrar(usuario, 'reminder_d14', copyReminderD14(primer));
  return true;
}

async function maybeReminderD30(usuario) {
  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 30 || dias >= 31) return false;

  // Tuvo que haber usado antes (sino aplica reminder_d3/d7/d14, no churn early)
  const txTotal = await contarTransacciones(usuario.id);
  if (txTotal === 0) return false;

  const txUltimos14 = await contarTransaccionesUltimos(usuario.id, 14);
  if (txUltimos14 > 0) return false;

  const { data: prev } = await supabase.from('survey_events')
    .select('id').eq('user_id', usuario.id).eq('event_type', 'reminder_d30').limit(1);
  if (prev && prev.length > 0) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  await enviarYRegistrar(usuario, 'reminder_d30', copyReminderD30(primer));
  return true;
}

async function maybeWebappInvite(usuario) {
  // Si tiene supabase_auth_id, ya se logueo en webapp alguna vez. No reinvitar.
  if (usuario.supabase_auth_id) return false;

  const txCount = await contarTransacciones(usuario.id);
  if (txCount < 10) return false;

  // Idempotencia DB-level: si ya recibio webapp_invite_10tx el INSERT fallara con 23505
  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const eventoId = await registrarEvento({
    userId: usuario.id,
    eventType: 'webapp_invite_10tx',
    channel: 'whatsapp',
    messageSent: copyWebappInvite(primer),
  });
  if (!eventoId) return false; // ya existia, no reenviar

  // Solo si el insert paso, mandamos el mensaje
  await enviarWhatsapp(usuario.whatsapp, copyWebappInvite(primer));
  return true;
}

async function maybeFeedback30(usuario) {
  const txCount = await contarTransacciones(usuario.id);
  if (txCount < 30) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const eventoId = await registrarEvento({
    userId: usuario.id,
    eventType: 'feedback_open_30tx',
    channel: 'whatsapp',
    messageSent: copyFeedback30(primer),
  });
  if (!eventoId) return false;

  await enviarWhatsapp(usuario.whatsapp, copyFeedback30(primer));
  return true;
}

// ===== Orquestador =====

/**
 * Cron principal. Corre cada 15min entre 10:00-10:14 Lima.
 * Itera usuarios elegibles y aplica los 6 triggers en orden de prioridad.
 * Solo dispara MAX 1 mensaje por usuario por corrida (no spamear).
 */
async function checkSurveyTriggers() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;

  try {
    const { data: usuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, created_at, recordatorios_activos, onboarding_completado, supabase_auth_id')
      .eq('onboarding_completado', true);

    if (!usuarios || usuarios.length === 0) return;

    let totalSent = 0;
    for (const u of usuarios) {
      try {
        if (u.recordatorios_activos === false) continue;
        if (!u.whatsapp) continue;

        if (await recibioMensajeRecienteProactivo(u.id)) continue;
        if (await tuvoErrorReciente(u.id)) continue;

        // Orden de prioridad: triggers de progreso primero, recordatorios despues.
        // Un usuario solo recibe 1 mensaje por corrida.
        const triggers = [
          maybeFeedback30,
          maybeWebappInvite,
          maybeReminderD30,
          maybeReminderD14,
          maybeReminderD7,
          maybeReminderD3,
        ];

        for (const fn of triggers) {
          const sent = await fn(u);
          if (sent) {
            totalSent++;
            break;
          }
        }
      } catch (e) {
        log.error({ tag: 'SURVEY_TRIG', userId: u.id, err: e.message }, 'Error per-user en survey triggers');
      }
    }

    if (totalSent > 0) {
      log.info({ tag: 'SURVEY_TRIG', sent: totalSent, candidates: usuarios.length }, 'Survey triggers ejecutados');
    }
  } catch (e) {
    log.error({ tag: 'SURVEY_TRIG', err: e.message }, 'Error general survey triggers');
  }
}

module.exports = {
  checkSurveyTriggers,
  // exported for dry-run script
  copyReminderD3,
  copyReminderD7,
  copyReminderD14,
  copyReminderD30,
  copyWebappInvite,
  copyFeedback30,
  recibioMensajeRecienteProactivo,
  tuvoErrorReciente,
  contarTransacciones,
  contarTransaccionesUltimos,
};
