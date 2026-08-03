const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru, sumarMeses, sumarDias } = require('../lib/dates');
const { getUserPlanConfig } = require('../helpers/db-helpers');
const { generarResumenSemanal, generarResumenMensual, generarResumenDiario } = require('../services/summaries');
const { verificarAlertasProactivas } = require('../services/recommendations');
const { obtenerDeudasProximasVencer } = require('../services/debts');
const { notificarUsuario, CANALES } = require('../lib/notify-user');
const { ADMIN_NUMBER, PRO_PRECIOS } = require('../lib/config');
const { WEBAPP_URL } = require('../lib/constants');
const { formatFecha } = require('../lib/formatters');
const { notificarAdmin } = require('../lib/admin-notify');
const { checkSurveyTriggers } = require('../services/survey-triggers');
const { solicitarComprobante } = require('../lib/pro-payment');
const { planCostReminders } = require('../lib/cost-reminders');
const { mensajeActivacionDia2, construirLinkActivacion } = require('../lib/activacion');
const { mensajeMuro, estaEnMuro, esProPagado, AVISO_DIAS_ANTES } = require('../lib/trial');
const { revocarAccesoGmail } = require('../gmail');
const analytics = require('../lib/analytics');

/**
 * Cola para el aviso de vencimiento cuando además se le soltó el Gmail.
 *
 * Va acá y no dentro de `mensajeMuro` a propósito: ese formateador ramifica por `trial_estado`
 * y ya produjo un bug caro por decidir con una fila incompleta. Se queda puro. Acá la línea es
 * condicional al RESULTADO real de la revocación, no a una suposición sobre el usuario.
 *
 * Desconectar en silencio algo que el usuario conectó a propósito se lee como un bug la
 * próxima vez que abre /dashboard/pro y ve "Conecta tu Gmail" sin explicación.
 */
function avisoGmailDesconectado(revocadas) {
  if (!revocadas) return '';
  return '\n\n📧 También desconectamos tu Gmail. Al renovar lo reconectas en un clic.';
}

async function checkResumenMensual() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDate() !== 1 || horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    // Sin filtro por gmail_access_token: el resumen se arma con transacciones, presupuestos,
    // metas y deudas — no depende de Gmail. Exigirlo dejaba fuera a la mayoria de usuarios Pro
    // en silencio. Si no hay movimientos, generarResumenMensual ya devuelve null.
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios').select('*').eq('plan', 'premium');
    if (errUsuarios) log.error({ tag: 'MENSUAL', err: errUsuarios.message }, 'Query usuarios fallo: el resumen mensual no se envio a nadie');
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenMensual(usuario);
        if (resumen) {
          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'resumen_mensual', mensaje: resumen,
            titulo: 'Tu resumen mensual',
            cuerpo: resumen.replace(/[*_]/g, '').substring(0, 400),
            link: '/dashboard',
          });
        }
      } catch(e) { log.error({ tag: 'MENSUAL', whatsapp: usuario.whatsapp, err: e.message }, 'Error resumen mensual usuario'); }
    }
  } catch(e) { log.error({ tag: 'MENSUAL', err: e.message }, 'Error general resumen mensual'); }
}

async function checkResumenSemanal() {
  const horaLima = new Date(Date.now() - 5 * 60 * 60 * 1000);
  if (horaLima.getUTCDay() !== 1 || horaLima.getUTCHours() !== 8 || horaLima.getUTCMinutes() > 14) return;
  try {
    // Mismo criterio que el resumen mensual: sin filtro por gmail_access_token.
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios').select('*').eq('plan', 'premium');
    if (errUsuarios) log.error({ tag: 'SEMANAL', err: errUsuarios.message }, 'Query usuarios fallo: el resumen semanal no se envio a nadie');
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenSemanal(usuario);
        if (resumen) {
          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'resumen_semanal', mensaje: resumen,
            titulo: 'Tu resumen semanal',
            cuerpo: resumen.replace(/[*_]/g, '').substring(0, 400),
            link: '/dashboard',
          });
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

          // El copy vendía el Free viejo ("historial completo, no solo este mes"), que
          // describía un plan gratuito permanente que ya no existe: hoy `free` ES el muro
          // y no tiene historial ninguno. A quien le llega esto ya terminó su prueba, así
          // que lo que hay que nombrar es lo que perdió, no un límite que nunca tuvo.
          const upsellMsg = '🎉 ' + (primerNombre ? primerNombre + ', ¡' : '¡') + 'llevas 1 mes usando Neto!\n\n' +
            'Sigo anotando todo lo que me mandas, y ahí está todo guardado. Con *Neto Pro* vuelves a verlo:\n\n' +
            '✅ Gráficos y desglose por categoría\n' +
            '✅ Historial completo, sin límite de meses\n' +
            '✅ Presupuestos, metas y reportes\n' +
            '✅ Lectura automática de tus correos bancarios\n\n' +
            '💰 *S/' + PRO_PRECIOS.mensual + '/mes* o *S/' + PRO_PRECIOS.anual + '/año*\n\n' +
            '📲 Yapea al *970398192* y envíame la captura.\n\n' +
            '_Escribe /premium para más info._';

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

          // A los 28-30 días de registro: casi siempre ya activó su cuenta web. Es el mensaje
          // comercial de mayor valor del producto y salía por el canal menos fiable.
          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'pro_upsell_d28', mensaje: upsellMsg,
            titulo: 'Llevas 1 mes usando Neto',
            link: '/dashboard/pro',
          });
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

        // El destinatario es Pro y lleva >=3 días sin escribir: por construcción, la
        // población con más chances de estar fuera de la ventana de 24h de Meta. El mensaje
        // que persigue a un inactivo era justo el que menos se entregaba.
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'inactivity', mensaje: msg,
          titulo: 'Hace ' + diasSinTx + ' días que no registras nada',
          tipoInApp: 'recordatorio', link: '/dashboard',
        });
        totalInactivity++;
      } catch(e) { /* silencioso por usuario */ }
    }

    if (totalInactivity > 0 || totalUpsell > 0) {
      log.info({ tag: 'INACTIVITY', inactivity: totalInactivity, upsell: totalUpsell, candidates: usuarios.length },
        'Recordatorios de inactividad enviados');
    }
  } catch(e) { log.error({ tag: 'INACTIVITY', err: e.message }, 'Error recordatorio inactividad'); }
}

// Este cron NUNCA puede tocar a alguien que está corriendo su prueba. La invariante que lo
// separaba del trial era "durante el trial premium_vence queda NULL", pero eso es un dato y
// los datos se ensucian: un ex-pagador que arranca un trial trae el premium_vence de su
// suscripción anterior, y sus tres queries lo agarraban. Pasó de verdad el 2026-08-01 — el
// trial duró 78 minutos y el usuario recibió "tu plan Pro venció, ahora estás en Free".
//
// `iniciarTrialSiCorresponde` ahora limpia esa columna, así que este filtro es la segunda
// red y no la primera. Va igual porque el downgrade es la operación destructiva: si las dos
// fallan, alguien pierde acceso pagado o prometido.
//
// Se escribe con `.or()` y no con `.neq()` porque `.neq('trial_estado','activo')` descarta
// las filas con la columna en NULL (`NULL <> 'activo'` es NULL en SQL), que son la mayoría.
const SIN_TRIAL_ACTIVO = 'trial_estado.is.null,trial_estado.neq.activo';

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
        .eq('plan', 'premium').eq('premium_vence', en3dias)
        .or(SIN_TRIAL_ACTIVO);
      if (porVencer && porVencer.length > 0) {
        for (const usuario of porVencer) {
          try {
            // Dedup: ¿ya avisamos hoy a este usuario?
            const { data: yaAviso } = await supabase.from('notificaciones')
              .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
              .eq('titulo', 'Plan Pro vence en 3 días').gte('fecha', inicioHoy).limit(1);
            if (yaAviso && yaAviso.length > 0) continue;

            const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
            await notificarUsuario({
              canales: CANALES.AMBOS,
              usuarioId: usuario.id, whatsapp: usuario.whatsapp,
              tipo: 'premium_expiry_3d',
              mensaje: '⚠️ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* vence en 3 días (' + usuario.premium_vence + ').\n\n¿Quieres renovar?\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Renueva antes para no perder acceso._',
              // El título es la clave del dedup de arriba: cambiarlo sin cambiar esa query
              // reintroduce el bug de 24 notificaciones idénticas por día.
              titulo: 'Plan Pro vence en 3 días', tipoInApp: 'recordatorio',
              cuerpo: 'Tu plan NETO Pro vence el ' + usuario.premium_vence + '. Renueva para no perder acceso.',
              link: '/dashboard/configuracion',
            });
            await solicitarComprobante(usuario.id);
          } catch(e) { log.error({ tag: 'EXPIRY_WARN', userId: usuario.id, err: e.message }, 'Error warning premium 3d'); }
        }
      }

      // Aviso "vence HOY" — el día exacto del vencimiento (antes no existía: había 3d antes y
      // el downgrade al día siguiente, pero nada el día clave). Free-form + in-app, dedup por día.
      const { data: venceHoy } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence')
        .eq('plan', 'premium').eq('premium_vence', hoy)
        .or(SIN_TRIAL_ACTIVO);
      if (venceHoy && venceHoy.length > 0) {
        for (const usuario of venceHoy) {
          try {
            const { data: yaAvisoHoy } = await supabase.from('notificaciones')
              .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
              .eq('titulo', 'Plan Pro vence hoy').gte('fecha', inicioHoy).limit(1);
            if (yaAvisoHoy && yaAvisoHoy.length > 0) continue;

            const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
            await notificarUsuario({
              canales: CANALES.AMBOS,
              usuarioId: usuario.id, whatsapp: usuario.whatsapp,
              tipo: 'premium_expiry_hoy',
              mensaje: '🔔 ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* vence *hoy*.\n\nRenuévalo hoy para no perder acceso.\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.',
              titulo: 'Plan Pro vence hoy', tipoInApp: 'recordatorio',
              cuerpo: 'Tu plan NETO Pro vence hoy. Renueva para no perder acceso.',
              link: '/dashboard/configuracion',
            });
            await solicitarComprobante(usuario.id);
          } catch(e) { log.error({ tag: 'EXPIRY_HOY', userId: usuario.id, err: e.message }, 'Error aviso vence hoy'); }
        }
      }
    }

    // Expirados — downgrade a free
    const { data: expirados } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence')
      .eq('plan', 'premium').not('premium_vence', 'is', null).lt('premium_vence', hoy)
      .or(SIN_TRIAL_ACTIVO);
    if (!expirados || expirados.length === 0) return;
    for (const usuario of expirados) {
      try {
        await supabase.from('usuarios').update({ plan: 'free' }).eq('id', usuario.id);
        // Bajar el plan corta la LECTURA de correos, pero el grant seguía vivo en Google y el
        // cupo ocupado para siempre. Se suelta acá mismo, sin gracia.
        const { revocadas } = await revocarAccesoGmail(usuario.id, { motivo: 'premium_vencido' });
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'premium_expired',
          mensaje: '⏰ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* venció.\n\nAhora estás en el plan Free (historial limitado a 1 mes).\n\n¿Quieres renovar?\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Tus datos siguen guardados. Al renovar recuperas acceso completo._' + avisoGmailDesconectado(revocadas),
          titulo: 'Plan Pro expirado',
          cuerpo: 'Tu plan NETO Pro venció. Ahora estás en el plan Free.',
          link: '/dashboard/configuracion',
        });
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
    const { data: usuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        // El muro es de LECTURA, y esto es una lectura: el mensaje dice cuánto llevas
        // gastado de tu límite por categoría y cuánto bajó tu score. `ver_presupuesto` y
        // `ver_neto_score` están los dos en INTENTS_LECTURA, o sea que por WhatsApp se
        // cobran — pero este cron los empujaba gratis, y encima sin que el usuario los
        // pidiera. Eran 6 usuarios en el muro recibiéndolo cada miércoles.
        if (estaEnMuro(usuario)) continue;
        const alerta = await verificarAlertasProactivas(usuario.id, usuario.nombre);
        if (alerta) {
          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'alerta_presupuesto', mensaje: alerta,
            titulo: 'Alerta de presupuesto', tipoInApp: 'recordatorio',
            link: '/dashboard/presupuestos',
          });
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
          // Ya no se pide "completar el registro": el registro es esto. Se pide
          // el primer gasto, que es lo único que hace que Neto sirva de algo.
          nudge = '👋 ' + (primerNombre ? primerNombre + ', a' : 'A') + 'nótame un gasto y te muestro cómo funciono.\n\n' +
            '📝 _"gasté 20 en taxi"_\n' +
            '📸 O mándame la foto de un Yape\n\n' +
            '_Si prefieres, dime *saltar* y lo dejamos para después._';
        } else if (u.onboarding_paso === 101) {
          // El paso del email ya no existe (migración 051). Si igual queda alguien
          // acá, se le pide un gasto, nunca el correo.
          nudge = '👋 ' + (primerNombre || 'Hola') + ', tu cuenta ya está lista.\n\n' +
            'Anótame tu primer gasto: _"gasté 20 en taxi"_ 📝';
        }
        if (nudge) {
          await notificarUsuario({
            canales: CANALES.SOLO_WHATSAPP,
            motivo: 'le habla a quien registró cero gastos y todavía no tiene cuenta web: no hay campana donde mostrar nada, y el mensaje ES el empujón para que empiece',
            usuarioId: u.id, whatsapp: u.whatsapp, tipo: 'onboarding', mensaje: nudge,
          });
          if (u.onboarding_paso === 0) {
            await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', u.id);
          }
        }
      } catch(e) { /* silencioso por usuario */ }
    }
  } catch(e) { log.error({ tag: 'ONBOARDING_REMINDER', err: e.message }, 'Error recordatorio onboarding'); }
}

// Empujón del día 2 a activar la cuenta web. El corte del flujo nuevo es "al
// tercer gasto o al día 2, lo que llegue primero": esto cubre la segunda mitad,
// para el que registró uno o dos gastos y no volvió a abrir el chat.
//
// El día 2 no es arbitrario: la ventana de 24h de Meta se cuenta desde el ÚLTIMO
// mensaje del usuario, así que un empujón al día 7 sencillamente no se entrega
// (los 16 survey_wake_up del barrido de churn tuvieron 0 respuestas y 0 entregas
// confirmadas). Por eso se exige que haya escrito hace menos de 23h: si la
// ventana ya se cerró, no se gasta el envío ni se quema el ledger.
async function checkActivacionDia2() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() < 9 || horaLima.getHours() >= 21) return;
  try {
    const hace48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: usuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, supabase_auth_id, activacion_nudge_at')
      .is('supabase_auth_id', null)      // sin cuenta web = el objetivo
      .is('activacion_nudge_at', null)   // ledger: un solo envío por usuario
      .not('whatsapp', 'is', null)
      .gte('created_at', hace48h)
      .lte('created_at', hace24h);
    if (!usuarios || usuarios.length === 0) return;

    const limiteVentana = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    for (const u of usuarios) {
      try {
        // Solo a quien YA registró algo: sin un gasto propio el link no tiene qué
        // mostrar, y a ese usuario lo trabaja checkRecordatorioOnboarding.
        const { count: conteoTx } = await supabase.from('transacciones')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', u.id);
        if (!conteoTx) continue;

        // ¿Sigue abierta la ventana de 24h? El último turno del usuario en
        // `conversaciones` es la única marca de "cuándo escribió por última vez".
        const { data: ultimoTurno } = await supabase.from('conversaciones')
          .select('created_at').eq('usuario_id', u.id).eq('rol', 'usuario')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!ultimoTurno || ultimoTurno.created_at < limiteVentana) continue;

        const mensaje = mensajeActivacionDia2(u, conteoTx);
        if (!mensaje) continue;   // sin secreto configurado no hay link que mandar
        const { wa } = await notificarUsuario({
          canales: CANALES.SOLO_WHATSAPP,
          motivo: 'la query selecciona supabase_auth_id IS NULL: no hay cuenta web donde aterrizar el aviso, y el mensaje ES el link para crearla',
          usuarioId: u.id, whatsapp: u.whatsapp, tipo: 'activacion', mensaje,
        });
        // El ledger se marca aunque Meta rechace: reintentar fuera de ventana no
        // cambia el resultado y solo acumula filas blocked_24h.
        if (wa && !wa.skipped) {
          await supabase.from('usuarios').update({ activacion_nudge_at: new Date().toISOString() }).eq('id', u.id);
          analytics.capture(u.id, 'wa_activation_link_sent', { conteo_tx: conteoTx, canal: 'cron' });
        }
      } catch (e) { /* silencioso por usuario */ }
    }
  } catch (e) { log.error({ tag: 'ACTIVACION_DIA2', err: e.message }, 'Error empujón activación día 2'); }
}

// ─── Fin del trial: dos avisos y el downgrade ────────────────────────────────
//
// Día 11 (faltan 3), día 14 (último día), y al día 15 cae al muro. Corre cada hora con
// gate >=9am Lima: el gate evita mandar de madrugada y permite catch-up si se cae una
// corrida, y la idempotencia real la da el dedup por día contra `notificaciones` — el
// mismo esquema que checkPremiumExpiry, que sin él mandaba el aviso 24 veces al día.
//
// NO colisiona con checkPremiumExpiry: durante el trial `premium_vence` queda NULL, y las
// tres queries de ese cron filtran por premium_vence (= en3dias, = hoy, IS NOT NULL). Los
// usuarios en prueba le son invisibles.
//
// Sobre la entrega: el aviso sale free-form mientras `trial_por_vencer` no esté aprobada
// por Meta (flag WA_TRIAL_TEMPLATE_ENABLED, ver docs/whatsapp-templates.md). A diferencia
// del win-back — que tuvo 0 entregas confirmadas porque perseguía inactivos de 70-143 días
// —, esta población es la de MEJOR caso para la ventana de 24h: por construcción registró
// un gasto hace <=14 días. Aun así no se asume: cada envío se etiqueta (`trial_d11`/
// `trial_d14`) y `notification_deliveries` guarda el wamid, así que delivered_at dice la
// verdad y a las dos semanas se decide con datos si la plantilla vale el gasto.
// El canal garantizado, mientras tanto, es la notificación in-app.
async function checkTrialExpiry() {
  try {
    const hoy = hoyPeru();
    const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
    const inicioHoy = new Date(hoy + 'T00:00:00-05:00').toISOString();
    const usaTemplate = process.env.WA_TRIAL_TEMPLATE_ENABLED === 'true';

    if (horaLima.getHours() >= 8) {
      const avisos = [
        { fecha: sumarDias(hoy, AVISO_DIAS_ANTES), titulo: 'Tu prueba Pro termina en 3 días', tipo: 'trial_d11', cuando: 'en 3 días', via: 'd11' },
        { fecha: hoy, titulo: 'Tu prueba Pro termina hoy', tipo: 'trial_d14', cuando: 'hoy', via: 'd14' },
      ];
      for (const aviso of avisos) {
        const { data: porVencer } = await supabase.from('usuarios')
          .select('id, whatsapp, nombre, trial_vence, supabase_auth_id')
          .eq('trial_estado', 'activo').eq('trial_vence', aviso.fecha);
        if (!porVencer || porVencer.length === 0) continue;
        for (const usuario of porVencer) {
          try {
            const { data: yaAviso } = await supabase.from('notificaciones')
              .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
              .eq('titulo', aviso.titulo).gte('fecha', inicioHoy).limit(1);
            if (yaAviso && yaAviso.length > 0) continue;

            const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
            // Al que nunca activó su cuenta web se le empuja a activarla, no a pagar: está
            // por terminar 14 días de Pro sin haber visto una sola vez lo que se le está
            // por acabar. Pedirle plata por algo que no vio no puede funcionar.
            const cuerpo = usuario.supabase_auth_id
              ? 'Después de eso sigo anotando todos tus gastos, pero el dashboard, el historial y los reportes quedan cerrados.\n\n' +
                'Para seguir con todo abierto:\n💰 *S/' + PRO_PRECIOS.mensual + '/mes* o *S/' + PRO_PRECIOS.anual + '/año*\n' +
                '👉 ' + WEBAPP_URL + '/dashboard/pro'
              : 'Y todavía no has entrado ni una vez a ver tus gastos en gráficos.\n\n' +
                'Míralos ahora, mientras sigue abierto:\n👉 ' + (construirLinkActivacion(usuario.id) || WEBAPP_URL + '/dashboard');
            // formatFecha y no el ISO crudo: el muro ya dice "29-jul-26" y ver "2026-08-04"
            // en el aviso previo delata dos manos escribiendo el mismo flujo.
            const venceLegible = formatFecha(String(usuario.trial_vence).slice(0, 10));
            const msg = '⏳ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u prueba de *Neto Pro* termina ' +
              aviso.cuando + (aviso.via === 'd11' ? ' (' + venceLegible + ')' : '') + '.\n\n' + cuerpo;

            const tpl = usaTemplate ? {
              name: 'trial_por_vencer', language: { code: 'es' },
              components: [{ type: 'body', parameters: [
                { type: 'text', text: primerNombre || 'Hola' },
                { type: 'text', text: aviso.via === 'd11' ? 'en 3 días (' + venceLegible + ')' : 'hoy' },
              ] }],
            } : null;

            const { wa } = await notificarUsuario({
              canales: CANALES.AMBOS,
              usuarioId: usuario.id, whatsapp: usuario.whatsapp,
              tipo: aviso.tipo, mensaje: msg, template: tpl,
              titulo: aviso.titulo, tipoInApp: 'recordatorio', link: '/dashboard/pro',
            });
            // Solo se cuenta como "aviso" lo que Meta aceptó: un blocked_24h no avisó a nadie
            // y contarlo taparía justo el problema que se está midiendo.
            if (wa && wa.ok && !wa.skipped) {
              analytics.capture(usuario.id, 'wa_onboarding_step_ok', { paso: 310, via: aviso.via, canal: tpl ? 'template' : 'texto' });
            }
          } catch (e) { log.error({ tag: 'TRIAL_EXPIRY', userId: usuario.id, err: e.message }, 'Error avisando fin de trial'); }
        }
      }
    }

    // Vencidos → al muro. Sin gate horario: el downgrade no molesta a nadie de madrugada y
    // dejar a alguien con Pro un día de más por una corrida perdida sería peor.
    // `trial_estado`, `premium_desde` y `premium_vence` van en el select porque mensajeMuro
    // ramifica por ellas. Sin `trial_estado` la fila llegaba con `undefined`, el mensaje caía
    // en la rama de "nunca tuviste prueba" y le prometía 14 días gratis a quien acababa de
    // terminar los suyos — el único mensaje que el trial existe para mandar, y salía al revés.
    const { data: vencidos } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, trial_estado, trial_vence, premium_desde, premium_vence')
      .eq('trial_estado', 'activo').lt('trial_vence', hoy);
    if (!vencidos || vencidos.length === 0) return;
    for (const usuario of vencidos) {
      try {
        // Un UPDATE condicionado a trial_estado='activo' es el claim: si dos corridas se
        // solapan, solo una baja el plan y solo una avisa.
        const { data: bajado, error: errBaja } = await supabase.from('usuarios')
          .update({ plan: 'free', trial_estado: 'vencido' })
          .eq('id', usuario.id).eq('trial_estado', 'activo')
          .select('id').maybeSingle();
        if (errBaja) { log.error({ tag: 'TRIAL_EXPIRY', userId: usuario.id, err: errBaja.message }, 'No se pudo bajar el plan al vencer el trial'); continue; }
        if (!bajado) continue;   // otra corrida ganó
        // La fila en memoria es de ANTES del UPDATE. Se sincroniza para que mensajeMuro lea
        // el estado real y no el que tenía hace tres líneas.
        usuario.trial_estado = 'vencido';

        // Conectar Gmail ya es exclusivo de Pro pagado, así que un trial normal no llega acá
        // con cuentas. Se llama igual por los que quedaron conectados de antes del gate: es
        // barato (un select que devuelve vacío) y no depende de que el barrido pase primero.
        const { revocadas } = await revocarAccesoGmail(usuario.id, { motivo: 'trial_vencido' });

        const { count: conteoTx } = await supabase.from('transacciones')
          .select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id);
        const msg = mensajeMuro(usuario, conteoTx) + avisoGmailDesconectado(revocadas);
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'trial_vencido', mensaje: msg,
          titulo: 'Tu prueba Pro terminó',
          cuerpo: 'Sigo anotando todos tus gastos y no se borró nada. Para volver a verlos, activa Pro.',
          link: '/dashboard/pro',
        });
        analytics.capture(usuario.id, 'wa_onboarding_step_failed', { paso: 400, motivo: 'trial_vencido', conteo_tx: conteoTx || 0 });
        log.info({ tag: 'TRIAL_EXPIRY', userId: usuario.id }, 'Trial vencido, usuario al muro');
      } catch (e) { log.error({ tag: 'TRIAL_EXPIRY', userId: usuario.id, err: e.message }, 'Error bajando al muro'); }
    }
  } catch (e) { log.error({ tag: 'TRIAL_EXPIRY', err: e.message }, 'Error general check trial expiry'); }
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
        // El recordatorio ES el ledger ("le debes S/X a Y, vence el Z"), y eso es lectura.
        if (estaEnMuro(deuda.usuarios)) continue;
        const venc = new Date(deuda.fecha_vencimiento + 'T12:00:00');
        const diffDias = Math.round((venc - hoyDate) / 86400000);
        const enviados = Array.isArray(deuda.recordatorios_enviados) ? deuda.recordatorios_enviados : [];

        const reached = TOUCHES.filter(t => t.reached(diffDias));
        const touch = reached.find(t => !enviados.includes(t.key));
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
        // Si el flag está off, template=null → sale el texto libre (msgDeuda).
        const dTemplate = process.env.WA_TEMPLATES_ENABLED === 'true' ? {
          name: 'deuda_por_vencer', language: { code: 'es' },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: primerNombre || 'Hola' },
            { type: 'text', text: (deuda.tipo === 'me_deben' ? 'lo que te debe ' : 'tu deuda con ') + deuda.contraparte },
            { type: 'text', text: montoStr },
            { type: 'text', text: cd === 3 ? 'en 3 días' : cd === 1 ? 'mañana' : cd === 0 ? 'hoy' : 'hace 3 días' },
          ] }],
        } : null;
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: deuda.usuario_id, whatsapp: deuda.usuarios.whatsapp,
          tipo: 'deuda', mensaje: msgDeuda, template: dTemplate,
          titulo: cd === 0 ? 'Deuda vence hoy' : cd > 0 ? 'Deuda vence en ' + cd + ' días' : 'Deuda vencida hace ' + Math.abs(cd) + ' días',
          tipoInApp: 'deuda_vence',
          link: '/dashboard/deudas', datos: { deuda_id: deuda.id },
        });
        // Ledger: marca el touch enviado Y todos los touches ya alcanzados. Evita el back-fill de
        // copy caduco cuando la deuda entra ya vencida o se saltó un umbral (un touch menos avanzado
        // ya no aplica). Preserva el catch-up: se manda el más avanzado alcanzado que faltaba.
        const keysAlcanzados = [...new Set([...enviados, ...reached.map(t => t.key)])];
        await supabase.from('deudas').update({ recordatorios_enviados: keysAlcanzados }).eq('id', deuda.id);
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
        // El detector de fugas es una lectura agregada sobre la data del usuario
        // (`ver_fugas` está en INTENTS_LECTURA). Acá el plan solo elegía la CADENCIA —
        // free recibía la versión reducida el día 1 de cada mes —, que era coherente
        // cuando free era un plan gratuito y dejó de serlo cuando free pasó a ser el muro.
        // `PLAN_CONFIG.free.fugasFrequency` ya decía 'none' desde el sprint del trial;
        // este cron nunca leyó esa constante, así que la seguía mandando.
        if (estaEnMuro(usuario)) continue;

        // Miércoles y día 15.
        if (diaSemana !== 3 && dia !== 15) continue;

        const alertas = await generarAlertasFugas(usuario.id, true);
        if (alertas.length === 0) continue;

        const mensaje = await generarMensajeFugas(alertas, usuario.nombre, true);
        if (!mensaje) continue;

        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'fugas', mensaje,
          titulo: 'Fugas de gasto detectadas', tipoInApp: 'alerta_fugas',
          cuerpo: mensaje.replace(/[*_]/g, '').substring(0, 200),
          link: '/dashboard/alertas',
        });
        await guardarAlertas(usuario.id, alertas, mensaje);
      } catch (e) {
        // Saltar al siguiente usuario es correcto (una alerta menos es mejor que una
        // inventada), pero sin log un fallo sistemático se ve igual que "nadie tenía fugas".
        log.error({ tag: 'FUGAS_USER', err: e.message, usuarioId: usuario.id }, 'Fugas omitidas para el usuario');
      }
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
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'score_semanal', mensaje: msg,
          titulo: 'Tu Neto Score semanal', link: '/dashboard/score',
        });
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
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'checkin_planes', mensaje: msg,
          titulo: 'Check-in de tus planes de ahorro', tipoInApp: 'recordatorio',
          link: '/dashboard/planes',
        });
      } catch (e) { /* silent per user */ }
    }
  } catch (e) { log.error({ tag: 'CHECKIN_PLANES', err: e.message }, 'Error check-in planes'); }
}

// Recordatorio espacios compartidos: viernes 6pm Lima, balances >S/50 pendientes
async function checkRecordatorioEspacios() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDay() !== 5 || horaLima.getHours() !== 18 || horaLima.getMinutes() > 14) return;
  try {
    const { obtenerBalanceEspacio, ownerEsPro } = require('../services/shared-spaces');
    // Get all active spaces
    const { data: spaces } = await supabase.from('shared_spaces').select('id, name');
    if (!spaces || spaces.length === 0) return;

    for (const space of spaces) {
      try {
        // El balance de un espacio es lectura (`ver_balance_espacio` está en
        // INTENTS_LECTURA), y el tier que manda es el del DUEÑO, no el de cada miembro:
        // ese es el modelo "host paga" y este cron era el único camino que se lo saltaba
        // entero. Si el dueño cayó al muro, el espacio deja de empujar balances a nadie.
        if (!(await ownerEsPro(space.id))) continue;
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
            await notificarUsuario({
              canales: CANALES.AMBOS,
              usuarioId: m.user_id, whatsapp: m.usuarios.whatsapp,
              tipo: 'espacios', mensaje: msg,
              titulo: 'Recordatorio de ' + space.name, tipoInApp: 'recordatorio',
              link: '/dashboard/espacios',
            });
          } catch (e) { /* silent */ }
        }
      } catch (e) { /* silent per space */ }
    }
  } catch (e) { log.error({ tag: 'ESPACIOS_REMIND', err: e.message }, 'Error recordatorio espacios'); }
}

/**
 * Costos operativos del admin (Favio). Corre 9am Lima diario. Toma los costos activos que vencen
 * hoy o están atrasados y manda un solo mensaje consolidado por el canal admin (Telegram-first,
 * via notificarAdmin). La lógica de qué hacer con cada costo vive en lib/cost-reminders.js (puro,
 * testeado); acá solo se aplican los efectos.
 *
 *  - MANUAL (auto_debit=false): recordatorio "por pagar" (vence hoy / atrasado). Dedup por-día vía
 *    last_reminder_sent_at (el cron corre cada ~15min entre 9:00 y 9:14). NO avanza next_due_date:
 *    eso pasa cuando el admin marca pagado desde la UI, para que el track refleje la realidad.
 *  - AUTO (auto_debit=true): se cobra solo → no se molesta con "págalo". El día del cobro se
 *    registra el pago en paid_history (para el P&L) y se avanza next_due_date (el propio avance es
 *    el guard de idempotencia), y se manda una línea informativa "se debita X, verifica que pasó".
 */
async function checkRecordatoriosCostos() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const hoy = hoyPeru();
    const { data: costos } = await supabase.from('admin_costs')
      .select('id, label, amount_pen, currency, amount_original, frequency, next_due_date, active, auto_debit, last_reminder_sent_at, paid_history')
      .eq('active', true)
      .lte('next_due_date', hoy);

    if (!costos || costos.length === 0) return;

    const { toNotify, toAutoProcess } = planCostReminders(costos, hoy);

    // 1) Auto-débito: registrar el cobro (paid_history) y avanzar la fecha, por costo. Solo se
    //    anuncia el que se registró bien (si el update falla, no mentimos que se debitó).
    const costById = new Map(costos.map((c) => [c.id, c]));
    const autoLines = [];
    for (const a of toAutoProcess) {
      const original = costById.get(a.id);
      const history = Array.isArray(original && original.paid_history) ? original.paid_history : [];
      const { error } = await supabase.from('admin_costs')
        .update({ paid_history: [...history, a.paidEntry], next_due_date: a.newNextDue, active: a.newActive })
        .eq('id', a.id);
      if (error) {
        log.error({ tag: 'COSTOS_REMIND', id: a.id, err: error.message }, 'Error auto-procesando costo');
        continue;
      }
      let line = '• ' + a.label + ' — S/ ' + a.amount_pen.toFixed(2);
      if (a.currency === 'USD' && a.amount_original) line += ' ($' + a.amount_original.toFixed(2) + ')';
      autoLines.push(line);
    }

    // 2) Manual: líneas de recordatorio + total a pagar a mano.
    let manualTotal = 0;
    const manualLines = toNotify.map((m) => {
      manualTotal += m.amount_pen;
      let line = '• ' + m.label + ' — S/ ' + m.amount_pen.toFixed(2);
      if (m.currency === 'USD' && m.amount_original) line += ' ($' + m.amount_original.toFixed(2) + ')';
      line += m.estado === 'atrasado'
        ? ' — ATRASADO (hace ' + m.dias_atraso + (m.dias_atraso === 1 ? ' día' : ' días') + ')'
        : ' — vence hoy';
      return line;
    });

    if (manualLines.length === 0 && autoLines.length === 0) return;

    let msg = '💸 Costos operativos\n\n';
    if (manualLines.length > 0) {
      msg += 'Por pagar:\n' + manualLines.join('\n') + '\n';
      msg += '\nTotal a pagar: S/ ' + manualTotal.toFixed(2) + '\n';
      msg += 'Márcalos como pagados en app.neto.pe/admin/costs\n';
    }
    if (autoLines.length > 0) {
      if (manualLines.length > 0) msg += '\n';
      msg += 'Débito automático hoy (verifica que pasó en tu tarjeta):\n' + autoLines.join('\n') + '\n';
    }

    await notificarAdmin(msg.trim());

    if (toNotify.length > 0) {
      const ids = toNotify.map((m) => m.id);
      await supabase.from('admin_costs')
        .update({ last_reminder_sent_at: new Date().toISOString() })
        .in('id', ids);
    }

    log.info({ tag: 'COSTOS_REMIND', manual: toNotify.length, auto: toAutoProcess.length, total: manualTotal.toFixed(2) },
      'Recordatorios/débitos de costos procesados');
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
          // Con `setMonth` el "mismo día" era mentira: un cobro del 31 saltaba al 3 del mes
          // subsiguiente y, como el avance es iterativo, se quedaba en el 3 para siempre.
          // El aviso solo sale si faltan exactamente SUB_LEAD_DIAS, así que el recordatorio
          // simplemente dejaba de salir. `sumarMeses` recorta al último día del mes destino.
          if (!/^\d{4}-\d{2}-\d{2}/.test(String(sub.ultimo_pago))) continue;
          let meses = 1;
          let next = new Date(sumarMeses(sub.ultimo_pago, meses) + 'T12:00:00');
          while (next < hoyDate && meses < 25) {
            meses++;
            next = new Date(sumarMeses(sub.ultimo_pago, meses) + 'T12:00:00');
          }
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

          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'suscripcion_cobro', mensaje: msg,
            titulo, tipoInApp: 'recordatorio',
            link: '/dashboard/suscripciones',
          });
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

        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'resumen_diario', mensaje: resumen,
          titulo: 'Tu resumen de hoy',
          cuerpo: resumen.replace(/[*_]/g, '').substring(0, 400),
          link: '/dashboard',
        });
        enviados++;
      } catch (e) { /* silent per user */ }
    }
    if (enviados > 0) log.info({ tag: 'RESUMEN_DIARIO', enviados }, 'Resúmenes diarios (manos libres) enviados');
  } catch (e) { log.error({ tag: 'RESUMEN_DIARIO', err: e.message }, 'Error resumen diario manos libres'); }
}

// Limpieza periódica de OTPs de verificación web vencidos (evita acumulación de filas muertas;
// el unique index por supabase_auth_id ya reemplaza al regenerar, esto borra los abandonados).
/**
 * Barrido de accesos a Gmail colgados: cuentas activas de quien ya no es Pro pagado.
 *
 * Lo que corrige es un permiso VIVO, no un cupo: el cupo de Google se pierde al conectar y no
 * vuelve (ver `revocarAccesoGmail`). Lo que este barrido evita es seguir teniendo permiso de
 * lectura sobre la bandeja de alguien que dejó de pagar.
 *
 * Las dos bajas de plan (checkTrialExpiry, checkPremiumExpiry) ya revocan en el momento, así
 * que en régimen esto no debería encontrar nada. Existe igual, y no como script de una vez,
 * porque se cuela por caminos que no pasan por esos crons: un downgrade por SQL a mano
 * (pasó el 01-ago), un cron que muere a mitad del loop, un plan cambiado desde el panel admin.
 *
 * NO notifica: a estos usuarios ya se les avisó cuando venció su plan, y un WhatsApp sobre
 * algo que pasó hace semanas se lee como spam. Por eso está exento en
 * `tests/cron/lecturas-proactivas.test.js`.
 */
async function checkGmailHuerfanos() {
  try {
    // La verdad de "quién tiene cupo tomado" está en gmail_cuentas, así que se arranca de ahí
    // y no de usuarios: barre también al que ya no aparecería en una query por plan.
    const { data: cuentas } = await supabase.from('gmail_cuentas')
      .select('usuario_id, usuarios!inner(id, plan, trial_estado)')
      .eq('activa', true);
    if (!cuentas || cuentas.length === 0) return;

    const huerfanos = [...new Map(
      cuentas.filter((c) => !esProPagado(c.usuarios)).map((c) => [c.usuario_id, c.usuarios]),
    ).keys()];
    if (huerfanos.length === 0) return;

    let revocadasTotal = 0;
    for (const usuarioId of huerfanos) {
      try {
        const { revocadas } = await revocarAccesoGmail(usuarioId, { motivo: 'barrido_huerfanos' });
        revocadasTotal += revocadas;
      } catch (e) {
        log.error({ tag: 'GMAIL_HUERFANOS', usuarioId, err: e.message }, 'No se pudo revocar; se reintenta mañana');
      }
    }
    log.info({ tag: 'GMAIL_HUERFANOS', usuarios: huerfanos.length, revocadas: revocadasTotal }, 'Accesos a Gmail de no-pagadores revocados');
  } catch (e) {
    log.error({ tag: 'GMAIL_HUERFANOS', err: e.message }, 'Error general en el barrido de accesos Gmail');
  }
}

async function limpiarOTPVencidos() {
  try {
    await supabase.from('webapp_otp').delete().lt('expires_at', new Date().toISOString());
  } catch (e) { log.warn({ tag: 'OTP_CLEANUP', err: e.message }, 'Error limpiando OTPs vencidos'); }
}

module.exports = {
  checkResumenMensual,
  checkResumenSemanal,
  checkResumenDiarioManosLibres,
  limpiarOTPVencidos,
  checkGmailHuerfanos,
  checkRecordatorioDiario,
  checkPremiumExpiry,
  checkTrialExpiry,
  checkAlertasProactivas,
  checkRecordatorioOnboarding,
  checkActivacionDia2,
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
