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
 * Envía una foto (bytes crudos, por multipart) al admin con botones inline debajo.
 *
 * Se usa para la solicitud de Pro: el admin ve la captura del comprobante y aprueba/rechaza
 * de un tap. Subimos los bytes directo a Telegram (multipart) en vez de pasar una URL: una
 * URL firmada de un bucket privado a veces no la alcanza Telegram y la foto sale en gris.
 * Los botones inline son exclusivos de Telegram; el caller decide el fallback.
 *
 * @param {string|number} chatId
 * @param {Buffer} fotoBuffer - bytes de la imagen.
 * @param {string} mimeType
 * @param {string} caption - texto plano (se limpian los asteriscos de bold).
 * @param {Array<Array<{text:string,callback_data:string}>>} inlineKeyboard
 * @returns {Promise<{ok:boolean, messageId?:number}>}
 */
async function enviarTelegramFotoConBotones(chatId, fotoBuffer, mimeType, caption, inlineKeyboard) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || !fotoBuffer) return { ok: false };
  try {
    const texto = String(caption || '').replace(/\*/g, '');
    const ext = (mimeType && mimeType.includes('png')) ? 'png' : 'jpg';
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', texto);
    form.append('reply_markup', JSON.stringify({ inline_keyboard: inlineKeyboard || [] }));
    form.append('photo', new Blob([fotoBuffer], { type: mimeType || 'image/jpeg' }), 'comprobante.' + ext);
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', { method: 'POST', body: form });
    const data = await res.json();
    if (data && data.ok) return { ok: true, messageId: data.result && data.result.message_id };
    log.error({ tag: 'TELEGRAM', err: data && data.description }, 'Error enviando foto con botones');
    return { ok: false };
  } catch (e) {
    log.error({ tag: 'TELEGRAM', err: e.message }, 'Excepción enviando foto con botones');
    return { ok: false };
  }
}

/**
 * Responde a un callback_query (tap de botón inline). Obligatorio para apagar el
 * spinner de carga del botón en el cliente de Telegram.
 * @returns {Promise<boolean>}
 */
async function responderCallback(callbackQueryId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !callbackQueryId) return false;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || undefined }),
    });
    return true;
  } catch (e) {
    log.error({ tag: 'TELEGRAM', err: e.message }, 'Excepción en answerCallbackQuery');
    return false;
  }
}

/**
 * Edita el caption de un mensaje-foto y le quita los botones (marca el resultado
 * tras aprobar/rechazar). Se usa editMessageCaption porque la notificación es una foto;
 * editMessageText fallaría sobre mensajes con media.
 * @returns {Promise<boolean>}
 */
async function editarCaptionTelegram(chatId, messageId, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || !messageId) return false;
  try {
    const texto = String(caption || '').replace(/\*/g, '');
    await fetch('https://api.telegram.org/bot' + token + '/editMessageCaption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        caption: texto,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    return true;
  } catch (e) {
    log.error({ tag: 'TELEGRAM', err: e.message }, 'Excepción editando caption');
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
        allowed_updates: ['message', 'callback_query'],
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

module.exports = {
  enviarTelegram,
  enviarTelegramA,
  enviarTelegramFotoConBotones,
  responderCallback,
  editarCaptionTelegram,
  registrarWebhookTelegram,
};
