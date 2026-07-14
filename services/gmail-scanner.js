const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { registrarError } = require('../lib/error-monitor');
const { notificarErrorAdmin } = require('../lib/admin-notify');
const { hoyPeru } = require('../lib/dates');
const { leerCorreosBancarios } = require('../gmail');
const { parsearCorreoBancario } = require('./parsers');
const { guardarTransaccion } = require('./transactions');
const { obtenerCategoriasUsuario } = require('./categories');
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

// Throttle de notificaciones de auth expirada: máx 1 vez cada 24h por usuario
const authErrorNotifiedAt = new Map();

async function notificarAuthExpirada(usuario) {
  const last = authErrorNotifiedAt.get(usuario.id) || 0;
  if (Date.now() - last < 24 * 60 * 60 * 1000) return; // ya notificado hoy
  authErrorNotifiedAt.set(usuario.id, Date.now());
  log.warn({ tag: 'AUTH', usuarioId: usuario.id }, 'Gmail desconectado — notificando usuario');
  await enviarWhatsapp(usuario.whatsapp,
    '⚠️ *Tu Gmail se desconectó*\n\n' +
    'Neto ya no puede leer tus correos bancarios para registrar tus gastos automáticamente.\n\n' +
    'Escríbeme *"conectar gmail"* para reconectarte y que todo vuelva a funcionar 👇'
  );
}

async function escanearGmailYRegistrar(usuario) {
  const { error, mensajes } = await leerCorreosBancarios(usuario.id);
  if (error === 'no_auth') return null;
  if (error === 'AUTH_EXPIRED') return { authError: true };
  if (!mensajes.length) return null;
  let registradas = 0; let ignoradas = 0; let resumen = '';
  // Fetch categorías custom una sola vez por batch (no por correo)
  let categoriasCustom = null;
  try { categoriasCustom = await obtenerCategoriasUsuario(usuario.id); }
  catch(e) { log.warn({ tag: 'CATS', err: e.message }, 'No se pudieron cargar categorías custom'); }
  for (const msg of mensajes) {
    try {
      const textoParseo = msg.texto || msg.snippet;
      const claveDedup = msg.id;
      const { data: existente } = await supabase.from('transacciones').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).single();
      if (existente) { ignoradas++; continue; }
      const { data: excluido } = await supabase.from('gmail_excluidos').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).single();
      if (excluido) { ignoradas++; continue; }
      const resultado = await parsearCorreoBancario(textoParseo, msg.asunto, categoriasCustom);
      if (!resultado.monto) continue;
      const txGuardada = await guardarTransaccion(usuario.id, { ...resultado, fecha: msg.fecha || resultado.fecha, descripcion_original: claveDedup });
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
  return '\uD83D\uDCEC Revise tu Gmail \u2014 *' + registradas + ' movimiento(s) nuevo(s)*:\n\n' + resumen + '\n\u00bfLo revisamos?';
}

async function escaneoAutomatico() {
  log.info({ tag: 'AUTO' }, 'Escaneo automático iniciado');
  try {
    // Bug fix: incluir usuarios con token legacy Y usuarios con cuentas en gmail_cuentas
    const [{ data: usuariosLegacy }, { data: cuentasGmail }] = await Promise.all([
      supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null),
      supabase.from('gmail_cuentas').select('usuario_id').eq('activa', true),
    ]);

    const idsLegacy = new Set((usuariosLegacy || []).map(u => u.id));
    const idsSoloNuevos = [...new Set((cuentasGmail || []).map(c => c.usuario_id))].filter(id => !idsLegacy.has(id));

    let todosLosUsuarios = usuariosLegacy || [];
    if (idsSoloNuevos.length > 0) {
      const { data: usuariosNuevos } = await supabase.from('usuarios').select('*').in('id', idsSoloNuevos);
      todosLosUsuarios = [...todosLosUsuarios, ...(usuariosNuevos || [])];
    }

    if (!todosLosUsuarios.length) return;
    for (const usuario of todosLosUsuarios) {
      try {
        const planConfigAuto = getUserPlanConfig(usuario);
        if (planConfigAuto.maxGmailAccounts === 0) continue;
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado && resultado.authError) {
          // Gmail desconectado — notificar al usuario (máx 1 vez/24h)
          await notificarAuthExpirada(usuario);
        } else if (resultado && typeof resultado === 'string' && resultado.includes('movimiento')) {
          await enviarWhatsapp(usuario.whatsapp, '\uD83D\uDD04 *Escaneo automatico*\n\n' + resultado);
          await crearNotificacion(usuario.id, 'sistema', 'Escaneo de correo completado', 'Se detectaron nuevos movimientos en tu correo bancario', { link: '/dashboard/transacciones' });
        }
      } catch (e) { log.error({ tag: 'AUTO', whatsapp: usuario.whatsapp, err: e.message }, 'Error escaneo usuario'); }
    }
  } catch (e) { log.error({ tag: 'AUTO', err: e.message }, 'Error general escaneo'); notificarErrorAdmin('AUTO_SCAN', e.message); registrarError('AUTO_SCAN', e.message, { stack: e.stack }); }
}

module.exports = { escanearGmailYRegistrar, escaneoAutomatico };
