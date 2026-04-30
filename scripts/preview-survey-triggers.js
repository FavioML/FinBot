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
  copyWakeUpInactiveNuevo, copyWakeUpInactiveChurn,
  copyWakeUpOnboardingNombre, copyWakeUpOnboardingEmail, copyWakeUpOnboardingGenerico,
  recibioMensajeRecienteProactivo, tuvoErrorReciente,
  contarTransacciones, contarTransaccionesUltimos,
} = require('../services/survey-triggers');

async function evaluar(usuario) {
  if (usuario.recordatorios_activos === false) return { trigger: null, reason: 'opted out (recordatorios_activos=false)' };
  if (!usuario.whatsapp) return { trigger: null, reason: 'sin whatsapp' };

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
    .in('event_type', ['webapp_invite_10tx', 'feedback_open_30tx', 'wake_up_inactive', 'wake_up_onboarding']);
  const sentOneshot = new Set((prevOneshot || []).map(e => e.event_type));

  // wake_up_onboarding: usuarios que NO completaron onboarding (>=7d desde registro)
  if (!usuario.onboarding_completado && dias >= 7 && !sentOneshot.has('wake_up_onboarding')) {
    let variant = 'generico';
    if (usuario.onboarding_paso === 101) variant = 'email';
    else if (usuario.onboarding_paso === 100 || usuario.onboarding_paso === 0) variant = 'nombre';
    return { trigger: 'wake_up_onboarding', dias: dias.toFixed(1), paso: usuario.onboarding_paso, variant };
  }

  // Resto de triggers requieren onboarding completo
  if (!usuario.onboarding_completado) {
    return { trigger: null, reason: 'onboarding incompleto (<7 dias o ya recibio wake-up)' };
  }

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

  // wake_up_inactive: ultimo en prioridad (catch-all para users viejos sin actividad)
  if (dias >= 30 && !sentOneshot.has('wake_up_inactive')) {
    const tx30d = await contarTransaccionesUltimos(usuario.id, 30);
    if (tx30d === 0) {
      return { trigger: 'wake_up_inactive', txTotal, dias: dias.toFixed(1), variant: txTotal === 0 ? 'nuevo' : 'churn' };
    }
  }

  return { trigger: null, reason: 'no aplica trigger', txTotal, dias: dias.toFixed(1) };
}

function getCopy(trigger, primerNombre, variant) {
  if (trigger === 'wake_up_inactive') {
    return variant === 'nuevo' ? copyWakeUpInactiveNuevo(primerNombre) : copyWakeUpInactiveChurn(primerNombre);
  }
  if (trigger === 'wake_up_onboarding') {
    if (variant === 'email') return copyWakeUpOnboardingEmail(primerNombre);
    if (variant === 'nombre') return copyWakeUpOnboardingNombre();
    return copyWakeUpOnboardingGenerico();
  }
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
    webapp_invite_10tx: 0, feedback_open_30tx: 0, wake_up_inactive: 0, wake_up_onboarding: 0, skipped: 0 };

  for (const u of usuarios) {
    const result = await evaluar(u);
    const primer = u.nombre ? u.nombre.split(' ')[0] : null;
    const labelUsuario = `${u.nombre || '(sin nombre)'} (${u.whatsapp})`;

    if (result.trigger) {
      sumario[result.trigger]++;
      console.log(`✓ ${labelUsuario}`);
      console.log(`  Trigger: ${result.trigger}${result.variant ? ' (' + result.variant + ')' : ''}`);
      if (result.txTotal !== undefined) console.log(`  Tx total: ${result.txTotal}, Dias: ${result.dias || '-'}`);
      console.log(`  Mensaje:\n  ${getCopy(result.trigger, primer, result.variant).replace(/\n/g, '\n  ')}\n`);
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
