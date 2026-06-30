const log = require('./logger');

/** URL pública del backend (Railway) — base para registrar el webhook de Telegram. */
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'https://api.neto.pe';

/**
 * Envía un mensaje de Telegram a un chat específico.
 *
 * Texto plano (sin parse_mode): así el envío nunca falla por markdown desbalanceado
 * en stacks o mensajes de usuario. Limpiamos los asteriscos de bold de WhatsApp para
 * que el mensaje se vea ordenado.
 *
 * @param {string|number} chatId
 * @param {string} mensaje
 * @returns {Promise<boolean>} true si se envió, false si no hay token o falló.
 */
async function enviarTelegramA(chatId, mensaje) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const texto = String(mensaje).replace(/\*/g, '');
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (data && data.ok) {
      log.info({ tag: 'TELEGRAM' }, 'Mensaje Telegram enviado');
      return true;
    }
    log.error({ tag: 'TELEGRAM', err: data && data.description }, 'Error enviando Telegram');
    return false;
  } catch (e) {
    log.error({ tag: 'TELEGRAM', err: e.message }, 'Excepción enviando Telegram');
    return false;
  }
}

/**
 * Envía una notificación al admin por Telegram (al TELEGRAM_ADMIN_CHAT_ID).
 *
 * Canal confiable para alertas operativas: a diferencia de WhatsApp Cloud API,
 * no está sujeto a la ventana de servicio de 24h (que bloquea los mensajes
 * espontáneos del negocio hacia el admin si este no escribió en las últimas 24h,
 * con error 131047). Por eso las notificaciones de comprobante/error/tickets
 * van por aquí.
 *
 * Requiere TELEGRAM_BOT_TOKEN y TELEGRAM_ADMIN_CHAT_ID en el entorno.
 * @returns {Promise<boolean>} true si se envió, false si no está configurado o falló.
 */
async function enviarTelegram(mensaje) {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) return false;
  return enviarTelegramA(chatId, mensaje);
}

/**
 * Registra el webhook entrante de Telegram (setWebhook). Idempotente: se puede llamar
 * en cada arranque. Permite aprobar pagos (/pago, /activar, /panel) desde el mismo chat
 * donde llegan las notificaciones.
 *
 * Requiere TELEGRAM_BOT_TOKEN y TELEGRAM_WEBHOOK_SECRET. Si falta alguno, no hace nada
 * (el flujo de WhatsApp sigue funcionando igual).
 * @returns {Promise<boolean>}
 */
async function registrarWebhookTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) {
    log.warn({ tag: 'TELEGRAM' }, 'Webhook entrante no registrado: falta TELEGRAM_BOT_TOKEN o TELEGRAM_WEBHOOK_SECRET');
    return false;
  }
  const url = PUBLIC_BACKEND_URL.replace(/\/+$/, '') + '/telegram/webhook';
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: secret,
        allowed_updates: ['message'],
      }),
    });
    const data = await res.json();
    if (data && data.ok) {
      log.info({ tag: 'TELEGRAM', url }, 'Webhook entrante registrado');
      return true;
    }
    log.error({ tag: 'TELEGRAM', err: data && data.description }, 'Error registrando webhook entrante');
    return false;
  } catch (e) {
    log.error({ tag: 'TELEGRAM', err: e.message }, 'Excepción registrando webhook entrante');
    return false;
  }
}

module.exports = { enviarTelegram, enviarTelegramA, registrarWebhookTelegram };
