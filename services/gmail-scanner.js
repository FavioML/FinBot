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

// opts:
//   scanOpts      → ventana/caps del scan (se pasa tal cual a leerCorreosBancarios)
//   enviarAlertas → si false, NO manda la tarjeta WhatsApp por transacción (para el
//                   barrido histórico, donde 30 días = decenas de correos y sería spam)
//   historico     → cambia el mensaje de resumen final
async function escanearGmailYRegistrar(usuario, opts = {}) {
  const { scanOpts = {}, enviarAlertas = true, historico = false } = opts;
  const { error, mensajes } = await leerCorreosBancarios(usuario.id, scanOpts);
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
      // En el barrido histórico se registran en silencio: nada de una tarjeta por correo.
      if (enviarAlertas) {
        setTimeout(async function() {
          try { await getEnviarAlertaTransaccion()(usuario, txGuardada, resultado); } catch(e) { log.error({ tag: 'ALERTA', err: e.message }, 'Error alerta transacción'); }
          try {
            const { data: miRef } = await supabase.from('referidos').select('referrer_id').eq('referido_id', usuario.id).single();
            if (miRef) verificarProReferidos(miRef.referrer_id);
          } catch(e) { log.warn({ tag: 'REFERIDO', err: e.message }, 'Error verificando referido'); }
        }, 5000);
      }
    } catch (e) { log.error({ tag: 'CORREO', err: e.message }, 'Error procesando correo'); registrarError('CORREO', e.message, { stack: e.stack, usuarioId: usuario.id }); }
  }
  if (registradas === 0) {
    if (historico) return null;
    if (ignoradas > 0) return '*Sin correos nuevos*\n\n' + ignoradas + ' correo(s) ya estaban registrados.';
    return null;
  }
  if (historico) {
    // Un solo mensaje de resumen (sin volcar la lista completa: pueden ser decenas).
    return '\uD83D\uDCE5 *\u00A1Listo! Import\u00E9 tus \u00FAltimos 30 d\u00EDas*\n\n' + registradas + ' movimiento(s) agregados a tu dashboard.\n\n\uD83D\uDC49 M\u00EDralos en https://app.neto.pe';
  }
  return '\uD83D\uDCEC Revise tu Gmail \u2014 *' + registradas + ' movimiento(s) nuevo(s)*:\n\n' + resumen + '\n\u00bfLo revisamos?';
}

// Ventana y caps del barrido hist\u00F3rico \u00FAnico (30 d\u00EDas). Caps altos para poblar el
// dashboard pero acotados para no golpear la cuota de Gmail (~2 list + hasta 100 get).
const HISTORICO_SCAN_OPTS = { windowDays: 30, filterDays: 30, maxPerQuery: 100, maxProcess: 100 };

// Barrido hist\u00F3rico \u00FAnico tras la primera conexi\u00F3n de Gmail. Registra en silencio los
// movimientos de los \u00FAltimos 30 d\u00EDas y marca usuarios.historico_importado para no repetir.
async function escanearHistoricoInicial(usuario) {
  if (usuario.historico_importado) return null;
  log.info({ tag: 'HIST', usuarioId: usuario.id }, 'Barrido hist\u00F3rico 30d iniciado');
  const resultado = await escanearGmailYRegistrar(usuario, {
    scanOpts: HISTORICO_SCAN_OPTS,
    enviarAlertas: false,
    historico: true,
  });
  // Si la auth fall\u00F3, NO marcar el flag: el usuario podr\u00EDa reconectar y a\u00FAn merecer el barrido.
  if (resultado && resultado.authError) return resultado;
  // Marcar como importado pase lo que pase (0 o N correos): el scan corri\u00F3 OK.
  const { error: updErr } = await supabase.from('usuarios')
    .update({ historico_importado: true }).eq('id', usuario.id);
  if (updErr) log.warn({ tag: 'HIST', usuarioId: usuario.id, err: updErr.message }, 'No se pudo marcar historico_importado');
  usuario.historico_importado = true;
  log.info({ tag: 'HIST', usuarioId: usuario.id }, 'Barrido hist\u00F3rico 30d completado');
  return resultado;
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
          // Sin WhatsApp de resumen: era ruido. Cada transaccion detectada ya manda su
          // propia tarjeta "Nuevo gasto" (enviarAlertaTransaccion, gateada por
          // usuario.alertas_transaccion). El resumen del escaneo vive en la webapp.
          await crearNotificacion(usuario.id, 'sistema', 'Escaneo de correo completado', 'Se detectaron nuevos movimientos en tu correo bancario', { link: '/dashboard/transacciones' });
        }
      } catch (e) { log.error({ tag: 'AUTO', whatsapp: usuario.whatsapp, err: e.message }, 'Error escaneo usuario'); }
    }
  } catch (e) { log.error({ tag: 'AUTO', err: e.message }, 'Error general escaneo'); notificarErrorAdmin('AUTO_SCAN', e.message); registrarError('AUTO_SCAN', e.message, { stack: e.stack }); }
}

module.exports = { escanearGmailYRegistrar, escaneoAutomatico, escanearHistoricoInicial };
