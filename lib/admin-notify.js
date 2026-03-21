const { enviarWhatsapp } = require('./whatsapp');
const log = require('./logger');

const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
let _lastNotify = 0;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min entre notificaciones (evitar spam)

async function notificarErrorAdmin(tag, mensaje, detalles) {
  const ahora = Date.now();
  if (ahora - _lastNotify < COOLDOWN_MS) return; // cooldown
  _lastNotify = ahora;
  try {
    const texto = '🚨 *Error NETO*\n\n'
      + '📍 ' + tag + '\n'
      + '❌ ' + mensaje + '\n'
      + (detalles ? '\n📋 ' + String(detalles).substring(0, 200) : '')
      + '\n\n_' + new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }) + '_';
    await enviarWhatsapp(ADMIN_NUMBER, texto);
    log.info({ tag: 'ADMIN_NOTIFY', to: ADMIN_NUMBER }, 'Notificación de error enviada al admin');
  } catch (e) {
    log.error({ tag: 'ADMIN_NOTIFY', err: e.message }, 'Error enviando notificación al admin');
  }
}

module.exports = { notificarErrorAdmin, ADMIN_NUMBER };
