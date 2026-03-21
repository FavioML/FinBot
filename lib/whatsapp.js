const log = require('./logger');

async function enviarWhatsapp(numero, mensaje) {
  try {
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_ACCESS_TOKEN;
    const dest = numero.replace(/^whatsapp:/i, '').replace(/^\+/, '');
    const response = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: dest, type: 'text', text: { body: mensaje } })
    });
    const data = await response.json();
    if (data.messages && data.messages[0]) { log.info({ tag: 'META', dest, msgId: data.messages[0].id }, 'Enviado'); }
    else { log.error({ tag: 'META', data }, 'Error enviando'); }
  } catch (e) { log.error({ tag: 'META', err: e.message }, 'Error enviando WhatsApp'); }
}

module.exports = { enviarWhatsapp };
