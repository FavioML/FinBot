const { enviarWhatsapp } = require('./whatsapp');
const { enviarTelegram } = require('./telegram');
const log = require('./logger');
const { ADMIN_NUMBER } = require('./config');
let _lastNotify = 0;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min entre notificaciones (evitar spam)

/**
 * Canal único de notificaciones salientes al admin (Favio).
 * Prioriza Telegram (confiable, sin ventana de 24h) y cae a WhatsApp solo si
 * Telegram no está configurado o falla. El WhatsApp es best-effort: puede no
 * llegar si el admin está fuera de la ventana de servicio de 24h de Meta.
 */
async function notificarAdmin(mensaje) {
  try {
    const okTelegram = await enviarTelegram(mensaje);
    if (okTelegram) return;
    await enviarWhatsapp(ADMIN_NUMBER, mensaje);
  } catch (e) {
    log.error({ tag: 'ADMIN_NOTIFY', err: e.message }, 'Error notificando al admin');
  }
}

async function notificarErrorAdmin(tag, mensaje, detalles) {
  const ahora = Date.now();
  if (ahora - _lastNotify < COOLDOWN_MS) return; // cooldown
  _lastNotify = ahora;
  const texto = '🚨 *Error NETO*\n\n'
    + '📍 ' + tag + '\n'
    + '❌ ' + mensaje + '\n'
    + (detalles ? '\n📋 ' + String(detalles).substring(0, 200) : '')
    + '\n\n_' + new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }) + '_';
  await notificarAdmin(texto);
  log.info({ tag: 'ADMIN_NOTIFY' }, 'Notificación de error enviada al admin');
}

module.exports = { notificarAdmin, notificarErrorAdmin, ADMIN_NUMBER };
