const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { registrarError } = require('../lib/error-monitor');
const { notificarErrorAdmin } = require('../lib/admin-notify');
const { hoyPeru } = require('../lib/dates');
const { leerCorreosBancarios } = require('../gmail');
const { parsearCorreoBancario } = require('./parsers');
const { guardarTransaccion, necesitaConsulta, guardarConsultaPendiente, mensajeConsulta } = require('./transactions');
const { verificarProReferidos } = require('./referrals');
const { getUserPlanConfig } = require('../helpers/db-helpers');
const { crearNotificacion } = require('../lib/notifications-db');

// Lazy-loaded to avoid circular dependency
let _enviarAlertaTransaccion = null;
function getEnviarAlertaTransaccion() {
  if (!_enviarAlertaTransaccion) {
    _enviarAlertaTransaccion = require('./notifications').enviarAlertaTransaccion;
  }
  return _enviarAlertaTransaccion;
}

async function escanearGmailYRegistrar(usuario) {
  const { error, mensajes } = await leerCorreosBancarios(usuario.id);
  if (error === 'no_auth') return null;
  if (!mensajes.length) return null;
  let registradas = 0; let ignoradas = 0; let resumen = '';
  const txsConsultar = [];
  for (const msg of mensajes) {
    try {
      const textoParseo = msg.texto || msg.snippet;
      const claveDedup = msg.id;
      const { data: existente } = await supabase.from('transacciones').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).single();
      if (existente) { ignoradas++; continue; }
      const { data: excluido } = await supabase.from('gmail_excluidos').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).single();
      if (excluido) { ignoradas++; continue; }
      const resultado = await parsearCorreoBancario(textoParseo, msg.asunto);
      if (!resultado.monto) continue;
      const txGuardada = await guardarTransaccion(usuario.id, { ...resultado, fecha: msg.fecha || resultado.fecha, descripcion_original: claveDedup });
      if (txGuardada && necesitaConsulta(txGuardada)) txsConsultar.push(txGuardada);
      registradas++;
      resumen += '- ' + (resultado.tipo === 'ingreso' ? 'Ingreso' : 'Gasto') + ': ' + (resultado.comercio || resultado.banco || 'Sin nombre') + ' S/ ' + resultado.monto + '\n';
      setTimeout(async function() {
        try { await getEnviarAlertaTransaccion()(usuario, txGuardada, resultado); } catch(e) { log.error({ tag: 'ALERTA', err: e.message }, 'Error alerta transacción'); }
        try {
          const { data: miRef } = await supabase.from('referidos').select('referrer_id').eq('referido_id', usuario.id).single();
          if (miRef) verificarProReferidos(miRef.referrer_id);
        } catch(e) { log.warn({ tag: 'REFERIDO', err: e.message }, 'Error verificando referido'); }
      }, 5000);
    } catch (e) { log.error({ tag: 'CORREO', err: e.message }, 'Error procesando correo'); registrarError('CORREO', e.message, { stack: e.stack, usuarioId: usuario.id }); }
  }
  if (registradas === 0) { if (ignoradas > 0) return '*Sin correos nuevos*\n\n' + ignoradas + ' correo(s) ya estaban registrados.'; return null; }
  if (txsConsultar.length > 0) {
    setTimeout(async function() {
      for (var ii=0; ii<txsConsultar.length; ii++) {
        try { await guardarConsultaPendiente(usuario, txsConsultar[ii]); await enviarWhatsapp(usuario.whatsapp, mensajeConsulta(txsConsultar[ii])); await new Promise(function(r){setTimeout(r,2000);}); }
        catch(e) { log.error({ tag: 'CONSULTA', err: e.message }, 'Error consulta pendiente'); }
      }
    }, 3000);
  }
  return '\uD83D\uDCEC Revise tu Gmail \u2014 *' + registradas + ' movimiento(s) nuevo(s)*:\n\n' + resumen + '\n\u00bfLo revisamos?';
}

async function escaneoAutomatico() {
  log.info({ tag: 'AUTO' }, 'Escaneo automático iniciado');
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const planConfigAuto = getUserPlanConfig(usuario);
        if (planConfigAuto.maxGmailAccounts === 0) continue;
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado && resultado.includes('Registre')) {
          await enviarWhatsapp(usuario.whatsapp, '\uD83D\uDD04 *Escaneo automatico*\n\n' + resultado);
          await crearNotificacion(usuario.id, 'sistema', 'Escaneo de correo completado', 'Se detectaron nuevos movimientos en tu correo bancario', { link: '/dashboard/transacciones' });
        }
      } catch (e) { log.error({ tag: 'AUTO', whatsapp: usuario.whatsapp, err: e.message }, 'Error escaneo usuario'); }
    }
  } catch (e) { log.error({ tag: 'AUTO', err: e.message }, 'Error general escaneo'); notificarErrorAdmin('AUTO_SCAN', e.message); registrarError('AUTO_SCAN', e.message, { stack: e.stack }); }
}

module.exports = { escanearGmailYRegistrar, escaneoAutomatico };
