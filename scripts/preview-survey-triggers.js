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
 */

require('dotenv').config();
const { supabase } = require('../lib/db');
const {
  copyReminderD3, copyReminderD7, copyReminderD14, copyReminderD30,
  copyWebappInvite, copyFeedback30,
  recibioMensajeRecienteProactivo, tuvoErrorReciente,
  contarTransacciones, contarTransaccionesUltimos,
} = require('../services/survey-triggers');

async function evaluar(usuario) {
  const reasons = [];
  if (usuario.recordatorios_activos === false) return { trigger: null, reason: 'opted out (recordatorios_activos=false)' };
  if (!usuario.whatsapp) return { trigger: null, reason: 'sin whatsapp' };
  if (!usuario.onboarding_completado) return { trigger: null, reason: 'onboarding incompleto' };

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

  if (txTotal >= 30 && !sentOneshot.has('feedback_open_30tx')) {
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
  if (dias >= 14 && dias < 15 && !sentReminders.has('reminder_d14')) {
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
    .select('id, whatsapp, nombre, created_at, recordatorios_activos, onboarding_completado, supabase_auth_id');
  if (whatsappFilter) query = query.eq('whatsapp', whatsappFilter);

  const { data: usuarios, error } = await query;
  if (error) { console.error(error); process.exit(1); }

  console.log(`\n=== Dry-run survey triggers — ${usuarios.length} usuario(s) ===\n`);

  const sumario = { reminder_d3: 0, reminder_d7: 0, reminder_d14: 0, reminder_d30: 0,
    webapp_invite_10tx: 0, feedback_open_30tx: 0, skipped: 0 };

  for (const u of usuarios) {
    const result = await evaluar(u);
    const primer = u.nombre ? u.nombre.split(' ')[0] : null;
    const labelUsuario = `${u.nombre || '(sin nombre)'} (${u.whatsapp})`;

    if (result.trigger) {
      sumario[result.trigger]++;
      console.log(`✓ ${labelUsuario}`);
      console.log(`  Trigger: ${result.trigger}`);
      if (result.txTotal !== undefined) console.log(`  Tx total: ${result.txTotal}, Dias: ${result.dias || '-'}`);
      console.log(`  Mensaje:\n  ${getCopy(result.trigger, primer).replace(/\n/g, '\n  ')}\n`);
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
