const crypto = require('crypto');
const log = require('./../lib/logger');
const { enviarTelegramA } = require('../lib/telegram');
const { procesarComandoAdmin } = require('./admin-commands');

/**
 * Webhook entrante de Telegram. Permite al admin aprobar pagos Pro (/pago, /activar, /panel)
 * desde el mismo chat donde recibe las notificaciones de comprobante.
 *
 * Seguridad en dos capas:
 *  1. Header secreto `X-Telegram-Bot-Api-Secret-Token` (lo setea Telegram según setWebhook).
 *  2. Allowlist: solo se procesan mensajes del TELEGRAM_ADMIN_CHAT_ID.
 *
 * Responde 200 de inmediato (Telegram reintenta ante no-200) y procesa async.
 */

/** Comparación constante de strings para evitar timing attacks sobre el secret. */
function secretoValido(recibido) {
  const esperado = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (!esperado) return false;
  const a = Buffer.from(String(recibido || ''));
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Normaliza el texto a comando: trim, quita @botname del primer token, toLowerCase. */
function normalizarComando(texto) {
  let t = String(texto || '').trim();
  // /pago@neto_bot ... -> /pago ...  (Telegram añade @bot en grupos)
  t = t.replace(/^(\/\w+)@\w+/, '$1');
  return t.toLowerCase().trim();
}

async function telegramWebhookHandler(req, res) {
  // Capa 1: secret header. Si no coincide, no es Telegram → 401 (sin reintentos útiles).
  const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (!secretoValido(headerSecret)) {
    log.warn({ tag: 'TELEGRAM_IN' }, 'Webhook entrante rechazado: secret inválido');
    return res.sendStatus(401);
  }

  // ACK inmediato: evita que Telegram reintente mientras procesamos.
  res.sendStatus(200);

  try {
    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message || !message.text) return;

    const chatId = message.chat && message.chat.id;
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

    // Capa 2: allowlist. Solo el chat del admin puede ejecutar comandos.
    if (!adminChatId || String(chatId) !== String(adminChatId)) {
      log.warn({ tag: 'TELEGRAM_IN', chatId }, 'Mensaje de chat no autorizado, ignorado');
      return;
    }

    const cmd = normalizarComando(message.text);
    if (!cmd.startsWith('/')) {
      await enviarTelegramA(chatId, 'Comandos disponibles:\n/pago <num> <mensual|anual>\n/activar <num>\n/panel');
      return;
    }

    const respuesta = await procesarComandoAdmin(cmd);
    if (respuesta) {
      await enviarTelegramA(chatId, respuesta);
    } else {
      await enviarTelegramA(chatId, 'Comando no reconocido. Disponibles:\n/pago <num> <mensual|anual>\n/activar <num>\n/panel');
    }
  } catch (e) {
    log.error({ tag: 'TELEGRAM_IN', err: e.message, stack: e.stack }, 'Error procesando update de Telegram');
  }
}

module.exports = { telegramWebhookHandler };
