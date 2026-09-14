/**
 * Dry-run de checkSurveyTriggers.
 *
 * Para cada usuario elegible, evalua los 6 triggers y reporta cual matchearia
 * SIN enviar WhatsApp ni insertar en survey_events.
 *
 * Uso:
 *   node scripts/preview-survey-triggers.js
 *   node scripts/preview-survey-triggers.js --whatsapp 51XXXX  # solo un usuario
 *
 * Util para:
 *   - Verificar quien recibiria mensaje hoy antes de activar el cron en prod
 *   - Debug post-deploy si un usuario esperado no recibio mensaje
 *
 * Los dos `wake_up_*` se apagaron el 14-sep-2026 y salieron tambien de aca: un preview que
 * los siguiera reportando mostraria avisos que el cron ya no manda.
 *
 * ⚠️ REIMPLEMENTA la logica del cron en vez de llamarlo, asi que puede divergir y HOY diverge.
 * Auditado el 01-sep-2026 (item 23); las tres son PREEXISTENTES y quedan sin cerrar a
 * proposito —cerrarlas es reescribir el script para que llame a los `maybe*` de verdad, que es
 * otro trabajo— pero se nombran para que nadie lea este output como el veredicto del cron:
 *
 *   · corta todo con `!onboarding_completado`, cosa que el cron solo hace dentro de
 *     `maybeReminderD14` (el cron SI le manda `reminder_d3`/`d7` a quien no termino el alta);
 *   · no filtra `cuenta_borrada_at`, que el cron si; hasta el 01-sep la lapida caia de rebote
 *     en el corte por falta de numero, y ese corte ya no esta;
 *   · descarta el `{ error }` de sus dos lecturas de `survey_events`: con la lectura caida los
 *     `Set` quedan vacios y reporta un trigger que el unique index rechazaria. El cron lee el
 *     error y lanza. O sea que falla hacia "si lo mandaria".
 */

require('dotenv').config();
const { supabase } = require('../lib/db');
const {
  copyReminderD3, copyReminderD7, copyReminderD14, copyReminderD30,
  copyWebappInvite, copyFeedback30,
  recibioMensajeRecienteProactivo, tuvoErrorReciente,
  contarTransacciones, contarTransaccionesUltimos,
  IN_APP_RECORDATORIO,
} = require('../services/survey-triggers');

async function evaluar(usuario) {
  if (usuario.recordatorios_activos === false) return { trigger: null, reason: 'opted out (recordatorios_activos=false)' };
  // Aca habia un `if (!usuario.whatsapp) return { reason: 'sin whatsapp' }` que espejaba el
  // corte del cron. Los dos se fueron el 01-sep-2026 (item 23): sin numero el aviso sale igual
  // por la campana. Lo que queda es la exencion por trigger, mas abajo, en los dos que piden
  // una respuesta escrita.

  if (await recibioMensajeRecienteProactivo(usuario.id)) {
    return { trigger: null, reason: 'mensaje proactivo en ultimos 7d' };
  }
  if (await tuvoErrorReciente(usuario.id)) {
    return { trigger: null, reason: 'tuvo error en ultimas 24h' };
  }

  const txTotal = await contarTransacciones(usuario.id);
  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;

  // Check one-shots (DB enforce uniqueness)
  const { data: prevOneshot } = await supabase.from('survey_events')
    .select('event_type').eq('user_id', usuario.id)
    .in('event_type', ['webapp_invite_10tx', 'feedback_open_30tx']);
  const sentOneshot = new Set((prevOneshot || []).map(e => e.event_type));

  if (!usuario.onboarding_completado) {
    return { trigger: null, reason: 'onboarding incompleto' };
  }

  // Los dos `usuario.whatsapp` de abajo espejan las exenciones declaradas en
  // `maybeFeedback30` y `maybeReminderD14`: el mensaje es una pregunta abierta y la campana no
  // tiene donde contestarla.
  if (usuario.whatsapp && txTotal >= 30 && !sentOneshot.has('feedback_open_30tx')) {
    return { trigger: 'feedback_open_30tx', txTotal };
  }
  if (txTotal >= 10 && !usuario.supabase_auth_id && !sentOneshot.has('webapp_invite_10tx')) {
    return { trigger: 'webapp_invite_10tx', txTotal };
  }

  // Check reminders
  const { data: prevReminders } = await supabase.from('survey_events')
    .select('event_type').eq('user_id', usuario.id)
    .in('event_type', ['reminder_d3', 'reminder_d7', 'reminder_d14', 'reminder_d30']);
  const sentReminders = new Set((prevReminders || []).map(e => e.event_type));

  if (dias >= 30 && dias < 31 && txTotal > 0 && !sentReminders.has('reminder_d30')) {
    const tx14 = await contarTransaccionesUltimos(usuario.id, 14);
    if (tx14 === 0) return { trigger: 'reminder_d30', txTotal, dias: dias.toFixed(1) };
  }
  if (usuario.whatsapp && dias >= 14 && dias < 15 && !sentReminders.has('reminder_d14')) {
    const tx14 = await contarTransaccionesUltimos(usuario.id, 14);
    if (tx14 < 3) return { trigger: 'reminder_d14', txTotal, tx14, dias: dias.toFixed(1) };
  }
  if (dias >= 7 && dias < 8 && txTotal === 0 && !sentReminders.has('reminder_d7')) {
    return { trigger: 'reminder_d7', txTotal, dias: dias.toFixed(1) };
  }
  if (dias >= 3 && dias < 4 && txTotal === 0 && !sentReminders.has('reminder_d3')) {
    return { trigger: 'reminder_d3', txTotal, dias: dias.toFixed(1) };
  }

  return { trigger: null, reason: 'no aplica trigger', txTotal, dias: dias.toFixed(1) };
}

function getCopy(trigger, primerNombre) {
  const c = {
    reminder_d3: copyReminderD3, reminder_d7: copyReminderD7,
    reminder_d14: copyReminderD14, reminder_d30: copyReminderD30,
    webapp_invite_10tx: copyWebappInvite, feedback_open_30tx: copyFeedback30,
  };
  return c[trigger] ? c[trigger](primerNombre) : '';
}

async function main() {
  const args = process.argv.slice(2);
  const whatsappFilter = args.find(a => a.startsWith('--whatsapp'))?.split('=')[1] || args[args.indexOf('--whatsapp') + 1];

  let query = supabase.from('usuarios')
    .select('id, whatsapp, nombre, created_at, recordatorios_activos, onboarding_completado, onboarding_paso, supabase_auth_id');
  if (whatsappFilter) query = query.eq('whatsapp', whatsappFilter);

  const { data: usuarios, error } = await query;
  if (error) { console.error(error); process.exit(1); }

  console.log(`\n=== Dry-run survey triggers — ${usuarios.length} usuario(s) ===\n`);

  const sumario = { reminder_d3: 0, reminder_d7: 0, reminder_d14: 0, reminder_d30: 0,
    webapp_invite_10tx: 0, feedback_open_30tx: 0, skipped: 0 };

  for (const u of usuarios) {
    const result = await evaluar(u);
    const primer = u.nombre ? u.nombre.split(' ')[0] : null;
    const labelUsuario = `${u.nombre || '(sin nombre)'} (${u.whatsapp || 'sin numero, web-first'})`;

    if (result.trigger) {
      sumario[result.trigger]++;
      console.log(`✓ ${labelUsuario}`);
      console.log(`  Trigger: ${result.trigger}`);
      if (result.txTotal !== undefined) console.log(`  Tx total: ${result.txTotal}, Dias: ${result.dias || '-'}`);
      console.log(`  Mensaje WhatsApp:\n  ${getCopy(result.trigger, primer).replace(/\n/g, '\n  ')}`);
      // Sin numero, el WhatsApp de arriba es exactamente lo que la persona NO va a recibir: lo
      // unico que le llega es la campana. Imprimir solo el copy de WhatsApp dejaba el preview
      // ciego justo para la poblacion que el item 23 agrego al bucle.
      const inApp = IN_APP_RECORDATORIO[result.trigger];
      if (inApp) console.log(`  Campana: ${inApp.titulo}\n           ${inApp.cuerpo}\n           -> ${inApp.link}`);
      // Los dos que no estan en el mapa NO son iguales: `webapp_invite_10tx` sale por
      // SOLO_WHATSAPP y no escribe ninguna campana, y `feedback_open_30tx` arma la suya con
      // titulo propio y el cuerpo derivado del WhatsApp.
      else if (result.trigger === 'webapp_invite_10tx') console.log('  Campana: NINGUNA (SOLO_WHATSAPP: el mensaje ES la invitacion a crear la cuenta web)');
      else console.log('  Campana: la arma el call-site (titulo propio, cuerpo derivado del WhatsApp)');
      console.log('');
    } else {
      sumario.skipped++;
      if (whatsappFilter) {
        console.log(`✗ ${labelUsuario}`);
        console.log(`  Skip: ${result.reason}`);
        if (result.txTotal !== undefined) console.log(`  Tx total: ${result.txTotal}, Dias: ${result.dias || '-'}`);
        console.log();
      }
    }
  }

  console.log('=== Sumario ===');
  for (const [k, v] of Object.entries(sumario)) {
    if (v > 0) console.log(`  ${k}: ${v}`);
  }
  console.log('\nNo se envio ningun WhatsApp ni se modifico la DB. Dry-run completo.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
