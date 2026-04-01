const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { getUserPlanConfig } = require('../helpers/db-helpers');
const { generarResumenSemanal, generarResumenMensual } = require('../services/summaries');
const { verificarAlertasProactivas } = require('../services/recommendations');
const { obtenerDeudasProximasVencer } = require('../services/debts');

async function checkResumenMensual() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDate() !== 1 || horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenMensual(usuario);
        if (resumen) await enviarWhatsapp(usuario.whatsapp, resumen);
      } catch(e) { log.error({ tag: 'MENSUAL', whatsapp: usuario.whatsapp, err: e.message }, 'Error resumen mensual usuario'); }
    }
  } catch(e) { log.error({ tag: 'MENSUAL', err: e.message }, 'Error general resumen mensual'); }
}

async function checkResumenSemanal() {
  const horaLima = new Date(Date.now() - 5 * 60 * 60 * 1000);
  if (horaLima.getUTCDay() !== 1 || horaLima.getUTCHours() !== 8 || horaLima.getUTCMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenSemanal(usuario);
        if (resumen) await enviarWhatsapp(usuario.whatsapp, resumen);
      } catch(e) { log.error({ tag: 'SEMANAL', whatsapp: usuario.whatsapp, err: e.message }, 'Error resumen semanal usuario'); }
    }
  } catch(e) { log.error({ tag: 'SEMANAL', err: e.message }, 'Error general resumen semanal'); }
}

async function checkRecordatorioDiario() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 20 || horaLima.getMinutes() > 14) return;
  const hoy = hoyPeru();
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, plan, recordatorios_activos, created_at')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        const planConfig = getUserPlanConfig(usuario);
        if (!planConfig.recordatorios) {
          if (usuario.created_at) {
            const diasDesdeRegistro = Math.floor((Date.now() - new Date(usuario.created_at).getTime()) / 86400000);
            if (diasDesdeRegistro >= 28 && diasDesdeRegistro <= 30) {
              const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
              await enviarWhatsapp(usuario.whatsapp, '🎉 ' + (primerNombre ? primerNombre + ', ¡' : '¡') + 'llevas 1 mes usando Neto!\n\nCon *NETO Pro* desbloqueas:\n\n✅ Historial completo (no solo este mes)\n✅ Lectura automática de correos bancarios\n✅ Recordatorios diarios + consejos IA\n✅ Exportar tus datos\n\n💰 *S/10/mes* o *S/99/año*\n\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._');
            }
          }
          continue;
        }
        const { data: txsHoy } = await supabase.from('transacciones').select('id')
          .eq('usuario_id', usuario.id).eq('fecha', hoy).limit(1);
        if (txsHoy && txsHoy.length > 0) continue;
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        const msg = '📝 ' + (primerNombre ? primerNombre + ', ¿' : '¿') + 'registraste tus gastos de hoy?\n\n' +
          'Escríbeme así:\n_"gasté 30 en almuerzo"_\n_"taxi 15 soles"_\n\nO envía una foto de tu Yape/Plin.\n\n' +
          '_Para desactivar recordatorios escribe /silenciar_';
        await enviarWhatsapp(usuario.whatsapp, msg);
      } catch(e) { /* silencioso por usuario */ }
    }
  } catch(e) { log.error({ tag: 'RECORDATORIO', err: e.message }, 'Error recordatorio diario'); }
}

async function checkPremiumExpiry() {
  try {
    const hoy = hoyPeru();
    const { data: expirados } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence')
      .eq('plan', 'premium').not('premium_vence', 'is', null).lt('premium_vence', hoy);
    if (!expirados || expirados.length === 0) return;
    for (const usuario of expirados) {
      try {
        await supabase.from('usuarios').update({ plan: 'free' }).eq('id', usuario.id);
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        await enviarWhatsapp(usuario.whatsapp, '⏰ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* venció.\n\nAhora estás en el plan Free (historial limitado a 1 mes).\n\n¿Quieres renovar?\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Tus datos siguen guardados. Al renovar recuperas acceso completo._');
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
        if (alerta) await enviarWhatsapp(usuario.whatsapp, alerta);
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
          await enviarWhatsapp(u.whatsapp, nudge);
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

    for (const deuda of deudasProximas) {
      try {
        if (deuda.usuarios.recordatorios_activos === false) continue;
        const venc = new Date(deuda.fecha_vencimiento + 'T12:00:00');
        const diffDias = Math.round((venc - hoyDate) / 86400000);
        const sym = deuda.moneda === 'USD' ? '$' : 'S/';
        const primerNombre = deuda.usuarios.nombre ? deuda.usuarios.nombre.split(' ')[0] : null;
        const saludo = primerNombre ? primerNombre + ', ' : '';
        const montoStr = sym + ' ' + parseFloat(deuda.monto_pendiente).toFixed(2);

        let msgDeuda = null;
        if (diffDias === 3) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '📅 ' + saludo + 'en 3 días vence lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Ya te pagó?'
            : '📅 ' + saludo + 'en 3 días vence tu deuda con *' + deuda.contraparte + '* (' + montoStr + '). ¡No te olvides!';
        } else if (diffDias === 1) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '⏰ ' + saludo + 'mañana vence lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Ya te pagó?\n\n_Responde "sí, ya me pagó" o "todavía no"._'
            : '⏰ ' + saludo + 'mañana vence tu deuda con *' + deuda.contraparte + '* (' + montoStr + '). ¡Que no se te pase!';
        } else if (diffDias === 0) {
          msgDeuda = '🔴 ' + saludo + '¡Hoy vence ' + (deuda.tipo === 'me_deben' ? 'lo que te debe' : 'tu deuda con') + ' *' + deuda.contraparte + '* (' + montoStr + ')!';
        } else if (diffDias === -3) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '⚠️ ' + saludo + 'ya pasaron 3 días desde que venció lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Le recuerdas?'
            : '⚠️ ' + saludo + 'tu deuda con *' + deuda.contraparte + '* lleva 3 días vencida (' + montoStr + '). ¿Ya pagaste?';
        }

        if (msgDeuda) {
          await enviarWhatsapp(deuda.usuarios.whatsapp, msgDeuda);
        }
      } catch (e) { /* silent per debt */ }
    }
  } catch (e) { log.error({ tag: 'DEUDA_REMINDER', err: e.message }, 'Error recordatorio deudas'); }
}

module.exports = {
  checkResumenMensual,
  checkResumenSemanal,
  checkRecordatorioDiario,
  checkPremiumExpiry,
  checkAlertasProactivas,
  checkRecordatorioOnboarding,
  checkRecordatorioDeudas,
};
