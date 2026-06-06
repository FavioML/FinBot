const log = require('./logger');

/**
 * Envía una notificación al admin por Telegram.
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
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    // Texto plano (sin parse_mode): así el envío nunca falla por markdown
    // desbalanceado en stacks o mensajes de usuario. Limpiamos los asteriscos
    // de bold de WhatsApp para que el mensaje se vea ordenado.
    const texto = String(mensaje).replace(/\*/g, '');
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (data && data.ok) {
      log.info({ tag: 'TELEGRAM' }, 'Notificación admin enviada');
      return true;
    }
    log.error({ tag: 'TELEGRAM', err: data && data.description }, 'Error enviando Telegram');
    return false;
  } catch (e) {
    log.error({ tag: 'TELEGRAM', err: e.message }, 'Excepción enviando Telegram');
    return false;
  }
}

module.exports = { enviarTelegram };
