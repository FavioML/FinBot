const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { getUserPlanConfig } = require('../helpers/db-helpers');
const { generarResumenSemanal, generarResumenMensual, generarResumenDiario } = require('../services/summaries');
const { verificarAlertasProactivas } = require('../services/recommendations');
const { obtenerDeudasProximasVencer } = require('../services/debts');
const { crearNotificacion } = require('../lib/notifications-db');
const { ADMIN_NUMBER } = require('../lib/config');
const { notificarAdmin } = require('../lib/admin-notify');
const { checkSurveyTriggers } = require('../services/survey-triggers');
const { solicitarComprobante } = require('../lib/pro-payment');

async function checkResumenMensual() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDate() !== 1 || horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').eq('plan', 'premium').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenMensual(usuario);
        if (resumen) {
          await enviarWhatsapp(usuario.whatsapp, resumen, { tipo: 'resumen_mensual', usuarioId: usuario.id });
          await crearNotificacion(usuario.id, 'sistema', 'Tu resumen mensual', resumen.replace(/[*_]/g, '').substring(0, 400), { link: '/dashboard' });
        }
      } catch(e) { log.error({ tag: 'MENSUAL', whatsapp: usuario.whatsapp, err: e.message }, 'Error resumen mensual usuario'); }
    }
  } catch(e) { log.error({ tag: 'MENSUAL', err: e.message }, 'Error general resumen mensual'); }
}

async function checkResumenSemanal() {
  const horaLima = new Date(Date.now() - 5 * 60 * 60 * 1000);
  if (horaLima.getUTCDay() !== 1 || horaLima.getUTCHours() !== 8 || horaLima.getUTCMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').eq('plan', 'premium').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenSemanal(usuario);
        if (resumen) {
          await enviarWhatsapp(usuario.whatsapp, resumen, { tipo: 'resumen_semanal', usuarioId: usuario.id });
          await crearNotificacion(usuario.id, 'sistema', 'Tu resumen semanal', resumen.replace(/[*_]/g, '').substring(0, 400), { link: '/dashboard' });
        }
      } catch(e) { log.error({ tag: 'SEMANAL', whatsapp: usuario.whatsapp, err: e.message }, 'Error resumen semanal usuario'); }
    }
  } catch(e) { log.error({ tag: 'SEMANAL', err: e.message }, 'Error general resumen semanal'); }
}

/**
 * Recordatorio de inactividad — UPDATE-08
 *
 * Antes era un recordatorio DIARIO ("¿registraste tus gastos hoy?") que se
 * mandaba todos los dias a usuarios Pro sin tx hoy. Sustituido por:
 *
 *   - Cadencia: 1 mensaje cada 3 dias de inactividad (no diario)
 *   - Aplica a TODOS los usuarios con onboarding completo + recordatorios_activos
 *     (antes solo Pro). Free ya no recibia este cron, ahora si — pero solo si
 *     llevan 3+ dias sin tx, no diariamente
 *   - Anti-fatiga via survey_events: skip si recibio CUALQUIER mensaje proactivo
 *     en los ultimos 3 dias (incluye otros triggers de UPDATE-05/06/07)
 *   - Visible en /admin/surveys con event_type = 'inactivity_reminder'
 *
 * Adicional: el upsell a Pro de dia 28-30 (que estaba dentro del mismo cron)
 * tambien se migra a survey_events como pro_upsell_d28 one-shot.
 */
async function checkRecordatorioDiario() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 20 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, plan, recordatorios_activos, created_at')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;

    let totalInactivity = 0;
    let totalUpsell = 0;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        if (!usuario.whatsapp) continue;

        const planConfig = getUserPlanConfig(usuario);
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        const diasDesdeRegistro = Math.floor((Date.now() - new Date(usuario.created_at).getTime()) / 86400000);

        // Anti-fatiga: skip si recibio cualquier survey_event WhatsApp en ultimos 3 dias
        const cutoff3d = new Date(Date.now() - 3 * 86400000).toISOString();
        const { data: recentEvents } = await supabase.from('survey_events')
          .select('id').eq('user_id', usuario.id).eq('channel', 'whatsapp')
          .gte('sent_at', cutoff3d).limit(1);
        const recibioMensajeReciente = recentEvents && recentEvents.length > 0;

        // ===== Pro upsell (one-shot, dias 28-30 desde registro) =====
        if (!planConfig.recordatorios && diasDesdeRegistro >= 28 && diasDesdeRegistro <= 30) {
          if (recibioMensajeReciente) continue;

          const upsellMsg = '🎉 ' + (primerNombre ? primerNombre + ', ¡' : '¡') + 'llevas 1 mes usando Neto!\n\nCon *NETO Pro* desbloqueas:\n\n✅ Historial completo (no solo este mes)\n✅ Lectura automática de correos bancarios\n✅ Recordatorios de inactividad + consejos IA\n✅ Exportar tus datos\n\n💰 *S/10/mes* o *S/99/año*\n\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';

          // Idempotencia DB-level: one-shot via unique partial index
          const { data: insertResult, error: insertErr } = await supabase.from('survey_events').insert({
            user_id: usuario.id,
            event_type: 'pro_upsell_d28',
            channel: 'whatsapp',
            sent_at: new Date().toISOString(),
            message_sent: upsellMsg,
          }).select('id').single();
          if (insertErr) {
            if (insertErr.code === '23505') continue; // ya recibio el upsell antes
            throw insertErr;
          }

          await enviarWhatsapp(usuario.whatsapp, upsellMsg, { tipo: 'pro_upsell_d28', usuarioId: usuario.id });
          await solicitarComprobante(usuario.id);
          totalUpsell++;
          continue;
        }

        if (!planConfig.recordatorios) continue;

        // ===== Inactivity reminder (Pro: cada 3 dias de inactividad) =====
        // Buscar la ultima transaccion del usuario
        const { data: ultimaTx } = await supabase.from('transacciones')
          .select('fecha').eq('usuario_id', usuario.id)
          .order('fecha', { ascending: false }).limit(1);

        const ultimaFecha = ultimaTx && ultimaTx.length > 0 ? ultimaTx[0].fecha : null;
        if (!ultimaFecha) continue; // nunca uso, ya cubre wake_up_inactive/onboarding

        const diasSinTx = Math.floor((Date.now() - new Date(ultimaFecha + 'T12:00:00').getTime()) / 86400000);
        if (diasSinTx < 3) continue; // sigue activo

        if (recibioMensajeReciente) continue; // anti-fatiga

        const msg = (primerNombre ? primerNombre + ', hace' : 'Hace') + ' ' + diasSinTx + ' días que no registras nada en Neto.\n\n' +
          '¿Algo te complica o solo se te pasó? Recuerda que puedes:\n' +
          '• Escribirme un gasto: _"almuerzo 25 soles"_\n' +
          '• Mandarme foto de tu Yape/Plin\n\n' +
          '_Si prefieres pausar recordatorios escribe /silenciar_';

        // Registrar en survey_events ANTES de enviar (audit trail)
        await supabase.from('survey_events').insert({
          user_id: usuario.id,
          event_type: 'inactivity_reminder',
          channel: 'whatsapp',
          sent_at: new Date().toISOString(),
          message_sent: msg,
          response_data: { dias_sin_tx: diasSinTx },
        });

        await enviarWhatsapp(usuario.whatsapp, msg, { tipo: 'inactivity', usuarioId: usuario.id });
        totalInactivity++;
      } catch(e) { /* silencioso por usuario */ }
    }

    if (totalInactivity > 0 || totalUpsell > 0) {
      log.info({ tag: 'INACTIVITY', inactivity: totalInactivity, upsell: totalUpsell, candidates: usuarios.length },
        'Recordatorios de inactividad enviados');
    }
  } catch(e) { log.error({ tag: 'INACTIVITY', err: e.message }, 'Error recordatorio inactividad'); }
}

async function checkPremiumExpiry() {
  try {
    const hoy = hoyPeru();
    const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));

    // Avisos de vencimiento (3d antes + día exacto).
    // El cron corre cada 1h; sin dedup esto disparaba las 24 corridas del día (bug: 24
    // notificaciones idénticas por usuario). La idempotencia por día contra `notificaciones`
    // es lo que corta el 24x; el gate horario (>=8am) solo evita mandar de madrugada y permite
    // catch-up si se cae una corrida (sale en la primera corrida del día a partir de las 8am).
    if (horaLima.getHours() >= 8) {
      const en3dias = new Date(new Date(hoy + 'T12:00:00').getTime() + 3 * 86400000).toISOString().split('T')[0];
      const inicioHoy = new Date(hoy + 'T00:00:00-05:00').toISOString();
      const { data: porVencer } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence')
        .eq('plan', 'premium').eq('premium_vence', en3dias);
      if (porVencer && porVencer.length > 0) {
        for (const usuario of porVencer) {
          try {
            // Dedup: ¿ya avisamos hoy a este usuario?
            const { data: yaAviso } = await supabase.from('notificaciones')
              .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
              .eq('titulo', 'Plan Pro vence en 3 días').gte('fecha', inicioHoy).limit(1);
            if (yaAviso && yaAviso.length > 0) continue;

            const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
            await enviarWhatsapp(usuario.whatsapp, '⚠️ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* vence en 3 días (' + usuario.premium_vence + ').\n\n¿Quieres renovar?\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Renueva antes para no perder acceso._', { tipo: 'premium_expiry_3d', usuarioId: usuario.id });
            await crearNotificacion(usuario.id, 'recordatorio', 'Plan Pro vence en 3 días', 'Tu plan NETO Pro vence el ' + usuario.premium_vence + '. Renueva para no perder acceso.', { link: '/dashboard/configuracion' });
            await solicitarComprobante(usuario.id);
          } catch(e) { log.error({ tag: 'EXPIRY_WARN', userId: usuario.id, err: e.message }, 'Error warning premium 3d'); }
        }
      }

      // Aviso "vence HOY" — el día exacto del vencimiento (antes no existía: había 3d antes y
      // el downgrade al día siguiente, pero nada el día clave). Free-form + in-app, dedup por día.
      const { data: venceHoy } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence')
        .eq('plan', 'premium').eq('premium_vence', hoy);
      if (venceHoy && venceHoy.length > 0) {
        for (const usuario of venceHoy) {
          try {
            const { data: yaAvisoHoy } = await supabase.from('notificaciones')
              .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
              .eq('titulo', 'Plan Pro vence hoy').gte('fecha', inicioHoy).limit(1);
            if (yaAvisoHoy && yaAvisoHoy.length > 0) continue;

            const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
            await enviarWhatsapp(usuario.whatsapp, '🔔 ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* vence *hoy*.\n\nRenuévalo hoy para no perder acceso.\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.', { tipo: 'premium_expiry_hoy', usuarioId: usuario.id });
            await crearNotificacion(usuario.id, 'recordatorio', 'Plan Pro vence hoy', 'Tu plan NETO Pro vence hoy. Renueva para no perder acceso.', { link: '/dashboard/configuracion' });
            await solicitarComprobante(usuario.id);
          } catch(e) { log.error({ tag: 'EXPIRY_HOY', userId: usuario.id, err: e.message }, 'Error aviso vence hoy'); }
        }
      }
    }

    // Expirados — downgrade a free
    const { data: expirados } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence')
      .eq('plan', 'premium').not('premium_vence', 'is', null).lt('premium_vence', hoy);
    if (!expirados || expirados.length === 0) return;
    for (const usuario of expirados) {
      try {
        await supabase.from('usuarios').update({ plan: 'free' }).eq('id', usuario.id);
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        await enviarWhatsapp(usuario.whatsapp, '⏰ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* venció.\n\nAhora estás en el plan Free (historial limitado a 1 mes).\n\n¿Quieres renovar?\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Tus datos siguen guardados. Al renovar recuperas acceso completo._', { tipo: 'premium_expired', usuarioId: usuario.id });
        await crearNotificacion(usuario.id, 'sistema', 'Plan Pro expirado', 'Tu plan NETO Pro venció. Ahora estás en el plan Free.', { link: '/dashboard/configuracion' });
        await solicitarComprobante(usuario.id);
        log.info({ tag: 'EXPIRY', userId: usuario.id }, 'Premium expirado, downgradeado a free');
      } catch(e) { log.error({ tag: 'EXPIRY', userId: usuario.id, err: e.message }, 'Error downgradeando usuario'); }
    }
  } catch(e) { log.error({ tag: 'EXPIRY', err: e.message }, 'Error general check premium expiry'); }
}

async function checkAlertasProactivas() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDay() !== 3 || horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        const alerta = await verificarAlertasProactivas(usuario.id, usuario.nombre);
        if (alerta) {
          await enviarWhatsapp(usuario.whatsapp, alerta, { tipo: 'alerta_presupuesto', usuarioId: usuario.id });
          await crearNotificacion(usuario.id, 'recordatorio', 'Alerta de presupuesto', alerta.replace(/[*_]/g, ''), { link: '/dashboard/presupuestos' });
        }
      } catch (e) { /* silencioso por usuario */ }
    }
  } catch (e) { log.error({ tag: 'ALERTA_PROACTIVA', err: e.message }, 'Error alertas proactivas'); }
}

async function checkRecordatorioOnboarding() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() < 9 || horaLima.getHours() >= 21) return;
  try {
    const hace6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const hace3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, onboarding_paso, onboarding_completado')
      .or('onboarding_completado.is.null,onboarding_completado.eq.false')
      .gte('created_at', hace6h)
      .lte('created_at', hace3h)
      .in('onboarding_paso', [0, 100, 101]);
    if (!usuarios || usuarios.length === 0) return;
    for (const u of usuarios) {
      try {
        const primerNombre = u.nombre ? u.nombre.split(' ')[0] : null;
        let nudge = '';
        if (u.onboarding_paso === 0 || u.onboarding_paso === 100) {
          nudge = '👋 ' + (primerNombre ? primerNombre + ', t' : 'T') + 'e faltó completar tu registro en Neto.\n\n' +
            '¿Cómo te llamas? Escríbeme tu nombre y empezamos. 😊\n\n' +
            '_Solo toma 1 minuto._';
        } else if (u.onboarding_paso === 101) {
          nudge = '👋 ' + (primerNombre || 'Hola') + ', te faltó tu correo para completar el registro.\n\n' +
            '¿Cuál es tu email? Ej: _"juan@gmail.com"_\n\n' +
            '_Es el último paso, prometido._';
        }
        if (nudge) {
          await enviarWhatsapp(u.whatsapp, nudge, { tipo: 'onboarding', usuarioId: u.id });
          if (u.onboarding_paso === 0) {
            await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', u.id);
          }
        }
      } catch(e) { /* silencioso por usuario */ }
    }
  } catch(e) { log.error({ tag: 'ONBOARDING_REMINDER', err: e.message }, 'Error recordatorio onboarding'); }
}

async function checkRecordatorioDeudas() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const hoy = hoyPeru();
    const hoyDate = new Date(hoy + 'T12:00:00');
    const deudasProximas = await obtenerDeudasProximasVencer();
    if (!deudasProximas.length) return;

    // Touches en orden de urgencia (más avanzado primero). reached(d) = el touch ya "llegó".
    // Se envía a lo sumo 1 por corrida: el touch más avanzado alcanzado que aún no se mandó.
    // Esto da catch-up (si se perdió el de 3d, lo manda el día 2) sin duplicar (ledger en DB).
    const TOUCHES = [
      { key: 'p3', diff: -3, reached: d => d <= -3 },
      { key: 'v0', diff: 0,  reached: d => d <= 0 },
      { key: 'v1', diff: 1,  reached: d => d <= 1 },
      { key: 'v3', diff: 3,  reached: d => d <= 3 },
    ];

    for (const deuda of deudasProximas) {
      try {
        if (deuda.usuarios.recordatorios_activos === false) continue;
        const venc = new Date(deuda.fecha_vencimiento + 'T12:00:00');
        const diffDias = Math.round((venc - hoyDate) / 86400000);
        const enviados = Array.isArray(deuda.recordatorios_enviados) ? deuda.recordatorios_enviados : [];

        const touch = TOUCHES.find(t => t.reached(diffDias) && !enviados.includes(t.key));
        if (!touch) continue;
        const cd = touch.diff; // diffDias canónico del touch: copy estable aunque haya catch-up

        const sym = deuda.moneda === 'USD' ? '$' : 'S/';
        const primerNombre = deuda.usuarios.nombre ? deuda.usuarios.nombre.split(' ')[0] : null;
        const saludo = primerNombre ? primerNombre + ', ' : '';
        const montoStr = sym + ' ' + parseFloat(deuda.monto_pendiente).toFixed(2);

        let msgDeuda;
        if (cd === 3) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '📅 ' + saludo + 'en 3 días vence lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Ya te pagó?'
            : '📅 ' + saludo + 'en 3 días vence tu deuda con *' + deuda.contraparte + '* (' + montoStr + '). ¡No te olvides!';
        } else if (cd === 1) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '⏰ ' + saludo + 'mañana vence lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Ya te pagó?\n\n_Responde "sí, ya me pagó" o "todavía no"._'
            : '⏰ ' + saludo + 'mañana vence tu deuda con *' + deuda.contraparte + '* (' + montoStr + '). ¡Que no se te pase!';
        } else if (cd === 0) {
          msgDeuda = '🔴 ' + saludo + '¡Hoy vence ' + (deuda.tipo === 'me_deben' ? 'lo que te debe' : 'tu deuda con') + ' *' + deuda.contraparte + '* (' + montoStr + ')!';
        } else { // cd === -3
          msgDeuda = deuda.tipo === 'me_deben'
            ? '⚠️ ' + saludo + 'ya pasaron 3 días desde que venció lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Le recuerdas?'
            : '⚠️ ' + saludo + 'tu deuda con *' + deuda.contraparte + '* lleva 3 días vencida (' + montoStr + '). ¿Ya pagaste?';
        }

        // Template utility (entrega fuera de ventana 24h) cuando está habilitado y aprobado.
        // Si el flag está off, template=null → enviarWhatsapp usa el texto libre (msgDeuda).
        const dTemplate = process.env.WA_TEMPLATES_ENABLED === 'true' ? {
          name: 'deuda_por_vencer', language: { code: 'es' },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: primerNombre || 'Hola' },
            { type: 'text', text: (deuda.tipo === 'me_deben' ? 'lo que te debe ' : 'tu deuda con ') + deuda.contraparte },
            { type: 'text', text: montoStr },
            { type: 'text', text: cd === 3 ? 'en 3 días' : cd === 1 ? 'mañana' : cd === 0 ? 'hoy' : 'hace 3 días' },
          ] }],
        } : null;
        await enviarWhatsapp(deuda.usuarios.whatsapp, msgDeuda, { tipo: 'deuda', usuarioId: deuda.usuario_id, template: dTemplate });
        await crearNotificacion(
          deuda.usuario_id, 'deuda_vence',
          cd === 0 ? 'Deuda vence hoy' : cd > 0 ? 'Deuda vence en ' + cd + ' días' : 'Deuda vencida hace ' + Math.abs(cd) + ' días',
          msgDeuda.replace(/[*_]/g, ''),
          { link: '/dashboard/deudas', deuda_id: deuda.id }
        );
        // Ledger: registrar el touch para catch-up sin duplicar
        await supabase.from('deudas').update({ recordatorios_enviados: [...enviados, touch.key] }).eq('id', deuda.id);
      } catch (e) { /* silent per debt */ }
    }
  } catch (e) { log.error({ tag: 'DEUDA_REMINDER', err: e.message }, 'Error recordatorio deudas'); }
}

// ═══════════════════════════════════════════════════════════════
// DETECTOR DE FUGAS — Proactive spending leak alerts
// ═══════════════════════════════════════════════════════════════
const { generarAlertasFugas, generarMensajeFugas, guardarAlertas } = require('../services/spending-alerts');

async function checkDetectorFugas() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const dia = horaLima.getDate();
  const diaSemana = horaLima.getDay();
  const hora = horaLima.getHours();
  if (hora !== 11 || horaLima.getMinutes() > 14) return;

  try {
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;

    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        const isPro = (usuario.plan || 'free') === 'premium';

        // Free: only 1st of month. Pro: Wednesdays + 15th.
        if (!isPro && dia !== 1) continue;
        if (isPro && diaSemana !== 3 && dia !== 15) continue;

        const alertas = await generarAlertasFugas(usuario.id, isPro);
        if (alertas.length === 0) continue;

        const mensaje = await generarMensajeFugas(alertas, usuario.nombre, isPro);
        if (!mensaje) continue;

        await enviarWhatsapp(usuario.whatsapp, mensaje, { tipo: 'fugas', usuarioId: usuario.id });
        await guardarAlertas(usuario.id, alertas, mensaje);
        await crearNotificacion(usuario.id, 'alerta_fugas', 'Fugas de gasto detectadas', mensaje.replace(/[*_]/g, '').substring(0, 200), { link: '/dashboard/alertas' });
      } catch (e) { /* silent per user */ }
    }
    log.info({ tag: 'FUGAS' }, 'Detector de fugas ejecutado');
  } catch (e) { log.error({ tag: 'FUGAS', err: e.message }, 'Error detector de fugas'); }
}

// ═══════════════════════════════════════════════════════════════
// NETO SCORE — Daily calculation + weekly notification (Pro)
// ═══════════════════════════════════════════════════════════════
const { upsertScore, obtenerTendenciaScore, scoreLabel } = require('../services/neto-score');

async function checkCalcularNetoScore() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 6 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('id')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;
    let ok = 0;
    for (const u of usuarios) {
      try {
        await upsertScore(u.id);
        ok++;
      } catch (e) { /* silent per user */ }
    }
    log.info({ tag: 'SCORE', count: ok }, 'Neto Scores calculados');
  } catch (e) { log.error({ tag: 'SCORE', err: e.message }, 'Error calculando scores'); }
}

async function checkNotificacionScore() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  // Domingos 10am Lima
  if (horaLima.getDay() !== 0 || horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('plan', 'premium').eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        const trend = await obtenerTendenciaScore(usuario.id);
        if (!trend) continue;
        const label = scoreLabel(trend.current);
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
        let arrow = '→';
        let diffText = 'igual que la semana pasada';
        if (trend.diff > 0) { arrow = '↑'; diffText = '+' + trend.diff + ' vs semana pasada'; }
        else if (trend.diff < 0) { arrow = '↓'; diffText = trend.diff + ' vs semana pasada'; }

        const msg = '📊 ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u Neto Score semanal:\n\n' +
          '*' + trend.current + '/100* ' + arrow + ' — ' + label + '\n' +
          '(' + diffText + ')\n\n' +
          '_Escribe "mi score" para ver el desglose completo._';
        await enviarWhatsapp(usuario.whatsapp, msg, { tipo: 'score_semanal', usuarioId: usuario.id });
        await crearNotificacion(usuario.id, 'sistema', 'Tu Neto Score semanal', msg.replace(/[*_]/g, ''), { link: '/dashboard/score' });
      } catch (e) { /* silent per user */ }
    }
  } catch (e) { log.error({ tag: 'SCORE_NOTIF', err: e.message }, 'Error notificación score semanal'); }
}

// Check-in planes de ahorro: 1ro y 15 del mes, 11am Lima, Pro only
async function checkCheckInPlanes() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const dia = horaLima.getDate();
  if ((dia !== 1 && dia !== 15) || horaLima.getHours() !== 11 || horaLima.getMinutes() > 14) return;
  try {
    const { calcularRitmoAhorro } = require('../services/metas');
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('plan', 'premium').eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;

    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        const { data: metas } = await supabase.from('metas_ahorro').select('*')
          .eq('usuario_id', usuario.id).eq('completada', false)
          .not('status', 'eq', 'abandoned')
          .order('created_at', { ascending: false });
        if (!metas || metas.length === 0) continue;

        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
        let msg = '🎯 ' + (primerNombre ? primerNombre + ', ' : '') + 'check-in de tus planes de ahorro:\n';

        for (const m of metas) {
          const pct = m.monto_objetivo > 0 ? Math.round((parseFloat(m.monto_actual || 0) / parseFloat(m.monto_objetivo)) * 100) : 0;
          msg += '\n*' + m.nombre + '* — ' + pct + '%';
          if (m.fecha_limite) {
            const ritmo = calcularRitmoAhorro(m);
            if (ritmo.enRitmo !== null) {
              msg += ' ' + (ritmo.enRitmo ? '✅' : '⚠️');
              if (ritmo.montoMensual > 0) msg += ' (S/' + ritmo.montoMensual.toFixed(0) + '/mes)';
            }
          }
          if (m.monthly_quota) {
            msg += '\n  Cuota: S/ ' + parseFloat(m.monthly_quota).toFixed(0) + '/mes';
          }
        }
        msg += '\n\n_Escribe "ahorré X para [nombre]" para registrar un abono._';
        await enviarWhatsapp(usuario.whatsapp, msg, { tipo: 'checkin_planes', usuarioId: usuario.id });
        await crearNotificacion(usuario.id, 'recordatorio', 'Check-in de tus planes de ahorro', msg.replace(/[*_]/g, ''), { link: '/dashboard/planes' });
      } catch (e) { /* silent per user */ }
    }
  } catch (e) { log.error({ tag: 'CHECKIN_PLANES', err: e.message }, 'Error check-in planes'); }
}

// Recordatorio espacios compartidos: viernes 6pm Lima, balances >S/50 pendientes
async function checkRecordatorioEspacios() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDay() !== 5 || horaLima.getHours() !== 18 || horaLima.getMinutes() > 14) return;
  try {
    const { obtenerBalanceEspacio } = require('../services/shared-spaces');
    // Get all active spaces
    const { data: spaces } = await supabase.from('shared_spaces').select('id, name');
    if (!spaces || spaces.length === 0) return;

    for (const space of spaces) {
      try {
        const { debts } = await obtenerBalanceEspacio(space.id);
        if (!debts || debts.length === 0) continue;

        // Only remind for debts > S/50
        const significantDebts = debts.filter(d => d.amount > 50);
        if (significantDebts.length === 0) continue;

        // Get all members to notify
        const { data: members } = await supabase.from('space_members')
          .select('user_id, usuarios(whatsapp, nombre, recordatorios_activos)')
          .eq('space_id', space.id);

        for (const m of (members || [])) {
          if (!m.usuarios?.whatsapp || m.usuarios?.recordatorios_activos === false) continue;
          const myDebts = significantDebts.filter(d => d.from === m.user_id);
          if (myDebts.length === 0) continue;

          // Anti-fatiga: no repetir el mismo espacio a este miembro más de 1 vez cada 10 días
          // (el cron es semanal; sin esto se re-mandaba el mismo balance estancado cada viernes).
          const cutoff10d = new Date(Date.now() - 10 * 86400000).toISOString();
          const { data: yaRecordado } = await supabase.from('notificaciones')
            .select('id').eq('usuario_id', m.user_id).eq('tipo', 'recordatorio')
            .eq('titulo', 'Recordatorio de ' + space.name).gte('fecha', cutoff10d).limit(1);
          if (yaRecordado && yaRecordado.length > 0) continue;

          const primerNombre = m.usuarios.nombre?.split(' ')[0] || '';
          let msg = '🏠 ' + (primerNombre ? primerNombre + ', r' : 'R') + 'ecordatorio de *' + space.name + '*:\n\n';
          for (const d of myDebts) {
            msg += '  → Le debes S/ ' + d.amount.toFixed(2) + ' a ' + (d.toNombre?.split(' ')[0] || '?') + '\n';
          }
          msg += '\n_Escribe "le pagué X a [nombre] del ' + space.name + '" para registrar tu pago._';
          try {
            await enviarWhatsapp(m.usuarios.whatsapp, msg, { tipo: 'espacios', usuarioId: m.user_id });
            await crearNotificacion(m.user_id, 'recordatorio', 'Recordatorio de ' + space.name, msg.replace(/[*_]/g, ''), { link: '/dashboard/espacios' });
          } catch (e) { /* silent */ }
        }
      } catch (e) { /* silent per space */ }
    }
  } catch (e) { log.error({ tag: 'ESPACIOS_REMIND', err: e.message }, 'Error recordatorio espacios'); }
}

/**
 * Recordatorio de costos operativos al admin (Favio).
 * Corre 9am Lima diario. Busca filas en admin_costs con next_due_date = hoy
 * y manda un solo mensaje WhatsApp consolidado al ADMIN_NUMBER.
 *
 * NO avanza next_due_date automaticamente — eso lo hace el admin desde UI
 * cuando marca el costo como pagado. Asi el track refleja la realidad.
 *
 * Idempotencia: usa last_reminder_sent_at para evitar doble alerta el mismo dia
 * (el cron corre cada 15min entre 9:00 y 9:14).
 */
async function checkRecordatoriosCostos() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const hoy = hoyPeru();
    const { data: costos } = await supabase.from('admin_costs')
      .select('id, label, amount_pen, currency, amount_original, frequency, last_reminder_sent_at')
      .eq('active', true)
      .eq('next_due_date', hoy);

    if (!costos || costos.length === 0) return;

    const aNotificar = costos.filter(c => {
      if (!c.last_reminder_sent_at) return true;
      const last = new Date(c.last_reminder_sent_at);
      const lastDayLima = new Date(last.toLocaleString('en-US', { timeZone: 'America/Lima' }))
        .toISOString().split('T')[0];
      return lastDayLima !== hoy;
    });

    if (aNotificar.length === 0) return;

    let msg = '💸 *Recordatorio de costos — vencen hoy*\n\n';
    let totalPen = 0;
    for (const c of aNotificar) {
      const amount = parseFloat(c.amount_pen);
      totalPen += amount;
      const freqLabel = c.frequency === 'monthly' ? 'mensual'
        : c.frequency === 'yearly' ? 'anual' : 'único';
      let line = '• *' + c.label + '* — S/ ' + amount.toFixed(2);
      if (c.currency === 'USD' && c.amount_original) {
        line += ' ($' + parseFloat(c.amount_original).toFixed(2) + ')';
      }
      line += ' _(' + freqLabel + ')_\n';
      msg += line;
    }
    msg += '\n*Total a pagar hoy: S/ ' + totalPen.toFixed(2) + '*\n\n';
    msg += '_Cuando los pagues, marcalos como pagados desde app.neto.pe/admin/costs_';

    await notificarAdmin(msg);

    const ids = aNotificar.map(c => c.id);
    await supabase.from('admin_costs')
      .update({ last_reminder_sent_at: new Date().toISOString() })
      .in('id', ids);

    log.info({ tag: 'COSTOS_REMIND', count: aNotificar.length, total: totalPen.toFixed(2) },
      'Recordatorios de costos enviados al admin');
  } catch (e) {
    log.error({ tag: 'COSTOS_REMIND', err: e.message }, 'Error recordatorio costos');
  }
}

/**
 * Conversión de recordatorios (T2, audit 2026-07-03).
 * Corre 7am Lima diario. Para cada survey_event de recordatorio cuya ventana de 24h ya
 * cerró, marca conversion_within_24h=true si el usuario registró una transacción dentro de
 * las 24h posteriores al envío. Antes estas columnas nunca se escribían (siempre false) y el
 * panel admin graficaba conversión 0 estructural.
 *
 * conversion_within_7d (webapp_invite) NO se calcula: requiere un timestamp de login en webapp
 * que hoy no se registra (solo existe supabase_auth_id sin fecha). Queda pendiente.
 */
const REMINDER_CONV_TYPES = ['reminder_d3', 'reminder_d7', 'reminder_d14', 'reminder_d30', 'inactivity_reminder', 'wake_up_inactive', 'pro_upsell_d28'];

async function checkSurveyConversions() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 7 || horaLima.getMinutes() > 14) return;
  try {
    const desde = new Date(Date.now() - 14 * 86400000).toISOString();
    const hasta = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // ventana 24h ya cerrada
    const { data: eventos } = await supabase.from('survey_events')
      .select('id, user_id, sent_at')
      .in('event_type', REMINDER_CONV_TYPES)
      .eq('conversion_within_24h', false)
      .not('sent_at', 'is', null)
      .gte('sent_at', desde).lte('sent_at', hasta);
    if (!eventos || eventos.length === 0) return;

    let marcados = 0;
    for (const ev of eventos) {
      try {
        const fin = new Date(new Date(ev.sent_at).getTime() + 24 * 3600 * 1000).toISOString();
        const { count } = await supabase.from('transacciones')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', ev.user_id)
          .gte('created_at', ev.sent_at).lt('created_at', fin);
        if (count && count > 0) {
          await supabase.from('survey_events').update({ conversion_within_24h: true }).eq('id', ev.id);
          marcados++;
        }
      } catch (e) { /* silent per event */ }
    }
    if (marcados > 0) log.info({ tag: 'SURVEY_CONV', marcados, evaluados: eventos.length }, 'Conversiones de recordatorio marcadas');
  } catch (e) {
    log.error({ tag: 'SURVEY_CONV', err: e.message }, 'Error calculando conversiones');
  }
}

/**
 * Recordatorio de cobro de suscripciones (Pro) — 10am Lima diario.
 *
 * Neto detecta suscripciones desde las transacciones (no hay tabla con fecha de
 * cobro), así que la próxima fecha se estima como el mismo día del último pago,
 * adelantada mes a mes hasta caer en el futuro. Avisa SUB_LEAD_DIAS antes.
 *
 * Solo suscripciones con estado 'activa' (match de catálogo, no las 'posible' por
 * patrón, para no generar ruido). Gate a Pro (getUserPlanConfig().recordatorios),
 * consistente con el intent recordatorio_pago.
 *
 * Dedup por ciclo vía `notificaciones` (mismo patrón que checkRecordatorioEspacios):
 * 1 aviso por suscripción cada 25 días. Fuera de la ventana 24h de Meta el mensaje
 * se bloquea igual que el resto de recordatorios proactivos (se registra en
 * notification_deliveries); cuando haya template aprobado se puede reforzar.
 */
const SUB_LEAD_DIAS = 3;

async function checkRecordatorioSuscripciones() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;
  try {
    const { detectarSuscripciones } = require('../services/subscriptions');
    const hoy = hoyPeru();
    const hoyDate = new Date(hoy + 'T12:00:00');
    const { data: usuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;

    let enviados = 0;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        if (!usuario.whatsapp) continue;
        if (!getUserPlanConfig(usuario).recordatorios) continue; // Pro

        const { suscripciones_detectadas } = await detectarSuscripciones(usuario.id);
        if (!suscripciones_detectadas || suscripciones_detectadas.length === 0) continue;

        for (const sub of suscripciones_detectadas) {
          if (sub.estado !== 'activa' || !sub.ultimo_pago) continue;

          // Próxima fecha de cobro: mismo día del último pago, adelantado mes a mes.
          const base = new Date(sub.ultimo_pago + 'T12:00:00');
          if (isNaN(base.getTime())) continue;
          const next = new Date(base);
          next.setMonth(next.getMonth() + 1);
          let guard = 0;
          while (next < hoyDate && guard < 24) { next.setMonth(next.getMonth() + 1); guard++; }
          const diasFalta = Math.round((next - hoyDate) / 86400000);
          if (diasFalta !== SUB_LEAD_DIAS) continue;

          // Dedup por ciclo: ¿ya avisamos de esta suscripción en los últimos 25 días?
          const titulo = 'Cobro próximo: ' + sub.nombre;
          const cutoff25d = new Date(Date.now() - 25 * 86400000).toISOString();
          const { data: yaAviso } = await supabase.from('notificaciones')
            .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
            .eq('titulo', titulo).gte('fecha', cutoff25d).limit(1);
          if (yaAviso && yaAviso.length > 0) continue;

          const sym = sub.moneda === 'USD' ? '$' : 'S/';
          const montoStr = sym + ' ' + parseFloat(sub.monto_detectado).toFixed(2);
          const pn = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
          const dd = String(next.getDate()).padStart(2, '0');
          const msg = (sub.icono ? sub.icono + ' ' : '') + (pn ? pn + ', ' : '') +
            'en 3 días se te cobra *' + sub.nombre + '* (' + montoStr + '), el ' + dd + '.\n\n' +
            '_Si ya no la usas, es buen momento para cancelarla._';

          await enviarWhatsapp(usuario.whatsapp, msg, { tipo: 'suscripcion_cobro', usuarioId: usuario.id });
          await crearNotificacion(usuario.id, 'recordatorio', titulo, msg.replace(/[*_]/g, ''), { link: '/dashboard/suscripciones' });
          enviados++;
        }
      } catch (e) { /* silent per user */ }
    }
    if (enviados > 0) log.info({ tag: 'SUB_REMIND', enviados }, 'Recordatorios de suscripción enviados');
  } catch (e) { log.error({ tag: 'SUB_REMIND', err: e.message }, 'Error recordatorio suscripciones'); }
}

/**
 * Modo Manos Libres (Pro, opt-in) — 9pm Lima diario.
 *
 * Solo usuarios con manos_libres = true. Envía el resumen del día (generarResumenDiario,
 * que devuelve null si no hubo gastos → no se manda nada esos días). A diferencia del
 * cron de inactividad (UPDATE-08, anti-fatiga), este es explícitamente opt-in: el usuario
 * lo activa con /manoslibres o desde la webapp.
 */
async function checkResumenDiarioManosLibres() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 21 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, plan, recordatorios_activos, manos_libres')
      .eq('onboarding_completado', true).eq('manos_libres', true);
    if (!usuarios || usuarios.length === 0) return;

    let enviados = 0;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        if (!usuario.whatsapp) continue;
        if (!getUserPlanConfig(usuario).resumenDiario) continue; // Pro

        const resumen = await generarResumenDiario(usuario);
        if (!resumen) continue;

        await enviarWhatsapp(usuario.whatsapp, resumen, { tipo: 'resumen_diario', usuarioId: usuario.id });
        await crearNotificacion(usuario.id, 'sistema', 'Tu resumen de hoy', resumen.replace(/[*_]/g, '').substring(0, 400), { link: '/dashboard' });
        enviados++;
      } catch (e) { /* silent per user */ }
    }
    if (enviados > 0) log.info({ tag: 'RESUMEN_DIARIO', enviados }, 'Resúmenes diarios (manos libres) enviados');
  } catch (e) { log.error({ tag: 'RESUMEN_DIARIO', err: e.message }, 'Error resumen diario manos libres'); }
}

module.exports = {
  checkResumenMensual,
  checkResumenSemanal,
  checkResumenDiarioManosLibres,
  checkRecordatorioDiario,
  checkPremiumExpiry,
  checkAlertasProactivas,
  checkRecordatorioOnboarding,
  checkRecordatorioDeudas,
  checkRecordatorioSuscripciones,
  checkCalcularNetoScore,
  checkNotificacionScore,
  checkDetectorFugas,
  checkCheckInPlanes,
  checkRecordatorioEspacios,
  checkRecordatoriosCostos,
  checkSurveyTriggers,
  checkSurveyConversions,
};
