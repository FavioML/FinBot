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
const { notificarUsuario, CANALES } = require('../lib/notify-user');
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

/**
 * Titulo y deeplink de la mitad in-app de cada recordatorio. El texto del cuerpo lo deriva
 * el chokepoint del mensaje de WhatsApp; esto es lo unico que no se puede derivar.
 *
 * Van los dos canales porque estos mensajes persiguen justo a quien dejo de escribir: por
 * definicion, la poblacion con mas chances de estar fuera de la ventana de 24h de Meta.
 */
const IN_APP_RECORDATORIO = {
  reminder_d3: { titulo: 'Registrar un gasto toma 2 segundos', link: '/dashboard' },
  reminder_d7: { titulo: 'Una semana con Neto', link: '/dashboard' },
  reminder_d14: { titulo: '¿Algo te complica con Neto?', link: '/dashboard' },
  reminder_d30: { titulo: 'Hace dos semanas que no registras nada', link: '/dashboard' },
};

/** Envia mensaje y registra el evento. Si falla, no registra (asi reintenta proxima vez). */
async function enviarYRegistrar(usuario, eventType, mensaje) {
  const inApp = IN_APP_RECORDATORIO[eventType];
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id,
    whatsapp: usuario.whatsapp || null,
    tipo: 'survey_' + eventType,
    mensaje,
    titulo: inApp ? inApp.titulo : 'Un recordatorio de Neto',
    tipoInApp: 'recordatorio',
    link: inApp ? inApp.link : '/dashboard',
  });
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

function copyWakeUpInactiveNuevo(primerNombre) {
  const saludo = primerNombre ? primerNombre + ', hace' : 'Hace';
  return `Hola ${saludo} tiempo que no hablamos.\n\n` +
    'Te registraste en Neto pero quizás no llegaste a probarlo aún. ¿Quieres que te muestre cómo va? Solo escríbeme un gasto cualquiera, ej:\n\n' +
    '_"gasté 30 en almuerzo"_\n\n' +
    'Y verás lo rápido que es. Si ya no te interesa, escribe /silenciar y no te molesto más.';
}

function copyWakeUpInactiveChurn(primerNombre) {
  const saludo = primerNombre ? primerNombre + ', hace' : 'Hace';
  return `Hola ${saludo} tiempo que no registras nada en Neto.\n\n` +
    'Sin reproches: ¿pasó algo, encontraste otra forma de llevar tus gastos, o simplemente se te olvidó? Si quieres retomarlo, mándame cualquier gasto de hoy y arrancamos.\n\n' +
    'Si prefieres pausarlo definitivamente, escribe /silenciar.';
}

function copyFeedback30(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, llevamos 30 gastos juntos, ya eres usuario veterano 🙌\n\n` +
    'Una pregunta corta para mejorar Neto: si pudieras cambiar UNA sola cosa del producto, ¿qué sería?\n\n' +
    'Lo que se te venga primero a la mente. Una línea basta.';
}

function copyWakeUpOnboardingNombre() {
  return 'Hola, te registraste en Neto hace unos días pero el setup quedó a medias.\n\n' +
    'Solo me faltó saber cómo te llamas. Escríbeme tu nombre y te activo en 30 segundos. Ej:\n\n' +
    '_Carlos_\n_María Fernanda_\n\n' +
    'Si ya no te interesa, escribe /silenciar y no te molesto más.';
}

function copyWakeUpOnboardingEmail(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, casi lo logramos pero el setup quedó a medias.\n\n` +
    'Solo me faltó tu email para activarte. Escríbeme tu correo y arrancamos. Ej:\n\n' +
    '_juan@gmail.com_\n\n' +
    'Es el último paso, prometido. Si no te interesa más, escribe /silenciar.';
}

function copyWakeUpOnboardingGenerico() {
  return 'Hola, vi que te registraste en Neto pero el setup quedó incompleto.\n\n' +
    '¿Quieres que te ayude a terminar? Solo escríbeme tu nombre y te guío paso a paso.\n\n' +
    'Si prefieres, escribe /silenciar y no te molesto más.';
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
  await notificarUsuario({
    canales: CANALES.SOLO_WHATSAPP,
    motivo: 'el trigger exige supabase_auth_id NULL (arriba): el destinatario no tiene cuenta web, y el mensaje ES la invitación a crearla',
    usuarioId: usuario.id, whatsapp: usuario.whatsapp,
    tipo: 'survey_webapp_invite_10tx', mensaje: copyWebappInvite(primer),
  });
  return true;
}

/**
 * Wake-up para usuarios con >=30 dias desde registro y 0 transacciones en
 * los ultimos 30 dias. One-shot por usuario garantizado por unique index.
 * Copy distinto segun si nunca uso (tx_total = 0) o si uso pero churned.
 */
async function maybeWakeUpInactive(usuario) {
  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 30) return false;

  const tx30d = await contarTransaccionesUltimos(usuario.id, 30);
  if (tx30d > 0) return false; // sigue activo, no aplica

  const txTotal = await contarTransacciones(usuario.id);
  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const mensaje = txTotal === 0
    ? copyWakeUpInactiveNuevo(primer)
    : copyWakeUpInactiveChurn(primer);

  // Idempotencia DB-level: si ya recibio wake_up_inactive el INSERT fallara con 23505
  const eventoId = await registrarEvento({
    userId: usuario.id,
    eventType: 'wake_up_inactive',
    channel: 'whatsapp',
    messageSent: mensaje,
  });
  if (!eventoId) return false;

  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id, whatsapp: usuario.whatsapp || null,
    tipo: 'survey_wake_up_inactive', mensaje,
    titulo: 'Hace tiempo que no registras nada',
    tipoInApp: 'recordatorio', link: '/dashboard',
  });
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

  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id, whatsapp: usuario.whatsapp || null,
    tipo: 'survey_feedback_open_30tx', mensaje: copyFeedback30(primer),
    titulo: 'Llevamos 30 gastos juntos',
    link: '/dashboard',
  });
  return true;
}

/**
 * Wake-up para usuarios que NO completaron onboarding y llevan >=7 dias atascados.
 * El cron checkRecordatorioOnboarding existente solo dispara entre 3-6h
 * post-registro, por lo que estos usuarios nunca vuelven a recibir mensaje.
 *
 * Variantes segun onboarding_paso:
 *   100 / 0  : esperando nombre (mas comun)
 *   101      : esperando email (ya dio nombre)
 *   otro     : caso raro, copy generico
 *
 * One-shot por usuario via unique index. NOTA: este trigger es el unico que
 * NO requiere onboarding_completado; los demas triggers implicitamente lo
 * requieren porque chequean tx_count.
 */
async function maybeWakeUpOnboarding(usuario) {
  if (usuario.onboarding_completado === true) return false;

  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 7) return false;

  let mensaje;
  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  if (usuario.onboarding_paso === 101) {
    mensaje = copyWakeUpOnboardingEmail(primer);
  } else if (usuario.onboarding_paso === 100 || usuario.onboarding_paso === 0) {
    mensaje = copyWakeUpOnboardingNombre();
  } else {
    mensaje = copyWakeUpOnboardingGenerico();
  }

  const eventoId = await registrarEvento({
    userId: usuario.id,
    eventType: 'wake_up_onboarding',
    channel: 'whatsapp',
    messageSent: mensaje,
  });
  if (!eventoId) return false;

  // El canal se bifurca por lo que el usuario TIENE, igual que checkRecordatorioOnboarding.
  //
  // Antes salia SOLO_WHATSAPP con un motivo que afirmaba "no tiene cuenta web donde mostrarle
  // nada", y eso nunca estuvo garantizado: el trigger filtra por `onboarding_completado`, no
  // por `supabase_auth_id`. Medido el 20-ago-2026 sobre `survey_events` —el ledger real de este
  // trigger, mas viejo que `notification_deliveries`— de los **25 destinatarios historicos, 3
  // tienen cuenta web**. (Una medicion anterior decia "9, ninguno": salio de la tabla nueva, o
  // sea de un subconjunto, y se leyo como si fuera la poblacion.)
  //
  // Y el arreglo obvio —cortar con `if (usuario.supabase_auth_id) return false`— era al reves:
  // el runner ya descarta a quien no tiene WhatsApp, asi que eso solo silenciaba a quien tiene
  // las DOS cosas, o sea justo a quien si tiene campana donde verlo.
  const comun = {
    usuarioId: usuario.id, whatsapp: usuario.whatsapp,
    tipo: 'survey_wake_up_onboarding', mensaje,
  };
  if (usuario.supabase_auth_id) {
    await notificarUsuario({
      canales: CANALES.AMBOS,
      ...comun,
      titulo: 'Te falta terminar de configurar Neto',
      // Cuerpo propio, por lo mismo que en `checkRecordatorioOnboarding`: sin el, el chokepoint
      // deriva el cuerpo in-app del mensaje de WhatsApp, y los tres copys de este trigger piden
      // que la persona ESCRIBA su nombre o su correo por chat y ofrecen "/silenciar". Ninguna de
      // las tres es una accion que exista en la campana. (La primera version de este arreglo se
      // olvido este `cuerpo`: el mismo defecto que corregia el archivo de al lado, en el mismo
      // commit.)
      cuerpo: 'Tu alta quedó a medias. Termínala por WhatsApp y Neto empieza a anotar tus gastos.',
      tipoInApp: 'recordatorio', link: '/dashboard',
    });
  } else {
    await notificarUsuario({
      canales: CANALES.SOLO_WHATSAPP,
      motivo: 'la rama exige supabase_auth_id nulo: sin cuenta web no hay campana donde mostrar nada',
      ...comun,
    });
  }
  return true;
}

// ===== Medición de respuestas (T2) =====

/**
 * Marca que el usuario RESPONDIÓ a un mensaje proactivo reciente. Best-effort,
 * fire-and-forget: se llama desde el webhook cuando entra un mensaje del usuario.
 *
 * Cierra el loop de medición del audit 2026-07-03: antes `responded_at` solo se
 * seteaba manual (admin) o por NPS webapp, por eso salía 0 en TODOS los recordatorios
 * WhatsApp aunque el usuario respondiera. Ahora una respuesta del usuario dentro de los
 * 7 días de un envío proactivo marca ese survey_event como respondido.
 */
async function marcarRespuestaProactiva(usuarioId, replyText) {
  try {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: ev } = await supabase.from('survey_events')
      .select('id, response_data')
      .eq('user_id', usuarioId).eq('channel', 'whatsapp')
      .is('responded_at', null)
      .gte('sent_at', cutoff)
      .order('sent_at', { ascending: false }).limit(1);
    if (!ev || ev.length === 0) return;
    const prev = (ev[0].response_data && typeof ev[0].response_data === 'object') ? ev[0].response_data : {};
    await supabase.from('survey_events').update({
      responded_at: new Date().toISOString(),
      response_data: { ...prev, user_replied: true, reply_text: String(replyText || '').substring(0, 300) },
    }).eq('id', ev[0].id);
  } catch (e) {
    // best-effort: nunca romper el flujo de mensaje entrante
  }
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
    // No filtramos por onboarding_completado aqui: el trigger maybeWakeUpOnboarding
    // necesita ver a los que NO completaron. Los demas triggers implicitamente
    // requieren completion porque dependen de tx_count > 0.
    const { data: usuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, created_at, recordatorios_activos, onboarding_completado, onboarding_paso, supabase_auth_id')
      // Una cuenta borrada (migracion 073) sobrevive como lapida y esta query no tiene NINGUN
      // otro filtro. Lo unico que la salvaba era el `if (!u.whatsapp) continue` de abajo, que
      // es un efecto lateral de otra decision y no una regla: el dia que la lapida conserve el
      // numero por cualquier motivo, el survey se le manda a alguien que pidio irse.
      .is('cuenta_borrada_at', null);

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
          maybeWakeUpOnboarding,
          maybeWakeUpInactive,
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
  marcarRespuestaProactiva,
  // exported for dry-run script
  copyReminderD3,
  copyReminderD7,
  copyReminderD14,
  copyReminderD30,
  copyWebappInvite,
  copyFeedback30,
  copyWakeUpInactiveNuevo,
  copyWakeUpInactiveChurn,
  copyWakeUpOnboardingNombre,
  copyWakeUpOnboardingEmail,
  copyWakeUpOnboardingGenerico,
  recibioMensajeRecienteProactivo,
  tuvoErrorReciente,
  contarTransacciones,
  contarTransaccionesUltimos,
};
