const { openai } = require('../lib/ai');
const log = require('../lib/logger');

/**
 * Media de WhatsApp → dato. Nada más.
 *
 * Esto vivía inline en `handlers/webhook.js`, entrelazado con los `enviarWhatsapp` de cada
 * rama de error. Se extrajo cuando hubo que correr el mismo pipeline para un usuario al que
 * NO se le puede responder: el que activó un username de WhatsApp y llega solo con su BSUID
 * (ver `services/registro-silencioso.js`).
 *
 * Por eso estas funciones **lanzan** en vez de contestar: quién avisa —y si hay a quién
 * avisarle— lo decide el llamador. El webhook conserva sus mensajes amables; el camino
 * silencioso solo loguea.
 *
 * El prompt de Vision vive acá y en ningún otro lado A PROPÓSITO: es quien decide el monto.
 * Duplicarlo es la misma divergencia de dinero que `registro-silencioso.js` evita delegando
 * en `guardarTransaccion` — con el agravante de que en el camino silencioso no hay respuesta
 * al usuario que delate la diferencia.
 */

// La versión de Graph con la que se venían bajando los media. No la subas sin probar:
// el endpoint de media es estable, pero el token y el phone_number_id son los mismos que
// usa el envío, y ahí sí hay diferencias entre versiones.
const GRAPH_VERSION = 'v19.0';

/**
 * Baja un media de WhatsApp: primero la metadata (que trae una URL firmada), después los bytes.
 *
 * @param {string} mediaId  el `id` que viene en `message.image.id` / `message.audio.id`
 * @param {object} [opts]
 * @param {string} [opts.tag]           tag de log ('IMAGEN' | 'AUDIO'), para no perder el rastro
 * @param {string} [opts.mimeFallback]  el mime que declaró el mensaje, si Meta no lo repite
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 * @throws si falta el mediaId, si Meta no devuelve URL, o si la descarga falla
 */
async function descargarMedia(mediaId, { tag = 'MEDIA', mimeFallback = null } = {}) {
  if (!mediaId) throw new Error('Mensaje sin media id');
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const metaToken = process.env.META_ACCESS_TOKEN;
  log.info({ tag, mediaId, phoneId, tokenOk: !!metaToken }, 'Descargando media');

  const metaUrl = 'https://graph.facebook.com/' + GRAPH_VERSION + '/' + mediaId + '?phone_number_id=' + phoneId;
  const metaRes = await fetch(metaUrl, { headers: { Authorization: 'Bearer ' + metaToken } });
  const metaJson = await metaRes.json();
  log.debug({ tag, metaJson: JSON.stringify(metaJson).slice(0, 200) }, 'Meta response');
  if (!metaJson.url) throw new Error('Meta no devolvió URL: ' + JSON.stringify(metaJson).slice(0, 100));

  const binRes = await fetch(metaJson.url, { headers: { Authorization: 'Bearer ' + metaToken } });
  if (!binRes.ok) throw new Error('Error descargando media: ' + binRes.status);
  const buffer = Buffer.from(await binRes.arrayBuffer());
  const mimeType = metaJson.mime_type || mimeFallback || 'application/octet-stream';
  log.info({ tag, mimeType, size: buffer.byteLength }, 'Media descargado');
  return { buffer, mimeType };
}

/**
 * Transcribe una nota de voz. gpt-4o-mini-transcribe: ~mitad del costo de whisper-1 y mejor
 * calidad en español. `language:'es'` ancla el idioma.
 *
 * @returns {Promise<string>} el texto transcrito, ya trimmeado (puede ser '')
 */
async function transcribirAudio(buffer, mimeType) {
  // La extensión debe coincidir con el contenedor o Whisper rechaza el archivo.
  const mime = mimeType || 'audio/ogg';
  const ext = mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a'
    : mime.includes('wav') ? 'wav' : mime.includes('amr') ? 'amr' : 'ogg';
  const { toFile } = require('openai');
  const file = await toFile(buffer, 'audio.' + ext, { type: mime });
  const transcripcion = await openai.audio.transcriptions.create({
    file,
    model: 'gpt-4o-mini-transcribe',
    language: 'es',
  });
  return (transcripcion.text || '').trim();
}

// El prompt fija `moneda` como enum y no como literal "PEN". Con el literal —así estuvo hasta
// el 10-ago (B15)— TODA captura en dólares entraba como soles: el modelo devolvía lo único que
// el esquema le permitía y `guardarTransaccion` lo convertía a `monto_pen` a la par 1:1. Un
// consumo de US$40 quedaba anotado como S/40 y nadie lo delataba, porque la respuesta que ve el
// usuario también dice soles.
//
// La regla de abajo es la misma que `services/parsers.js` ya aplica a los correos bancarios,
// adaptada a una imagen. Con una diferencia que acá importa más: el DEFAULT explícito es PEN.
// Yape y Plin operan solo en soles y son el grueso del tráfico de este camino, así que un "S/"
// mal leído no puede convertirse en USD — eso rompería el caso mayoritario para arreglar el
// minoritario. El USD hay que ganárselo con un símbolo visible o un comercio internacional.
function promptVision(hoy) {
  return 'Esta imagen es una captura de pantalla de una transacción financiera (Yape, Plin, banco peruano). Puede ser un GASTO (pago enviado) o un INGRESO (dinero recibido). Extrae los datos y devuelve SOLO JSON válido, sin texto extra:\n{"tipo":"gasto"|"ingreso","monto":numero,"moneda":"PEN"|"USD","comercio":"nombre del destinatario (si gasto) o remitente (si ingreso)","categoria":"Alimentación|Transporte|Vivienda|Salud|Entretenimiento|Compras|Educación|Finanzas|Trabajo_Negocio|Otros","subcategoria":"descripcion breve o null","metodo_pago":"Yape|Plin|BCP|BBVA|Interbank|Scotiabank|Falabella|Ripley|BanBif|Efectivo|null","tarjeta_last4":"los 4 ultimos digitos de la tarjeta/cuenta si aparecen (ej. \\"terminada en 1234\\", \\"****1234\\") o null","fecha":"YYYY-MM-DD","descripcion_original":"texto clave de la imagen","motivo":"nota/motivo del pago si aparece o null"}\n\nREGLA CRÍTICA DE MONEDA (aplicar SIEMPRE antes de asignar moneda):\n- Por DEFECTO moneda="PEN". Solo pon "USD" si hay evidencia explícita en la imagen.\n- Yape y Plin operan ÚNICAMENTE en soles: si la captura es de Yape o Plin → moneda="PEN" siempre, sin excepción.\n- Si el monto aparece con "$", "USD" o "US$" → moneda: "USD"\n- Si el monto aparece con "S/", "S/.", "PEN" o "soles" → moneda: "PEN"\n- Comercios internacionales que SIEMPRE son USD: Netflix, NETFLIX.COM, DLOCAL*NETFLIX, Spotify, Disney+, Amazon Prime, YouTube Premium, Apple, Steam, Xbox, PlayStation, Google One, iCloud, ChatGPT, OpenAI, Claude, Claude.AI, Anthropic, Canva, Dropbox, Adobe, Microsoft 365, GitHub, Notion, Figma, Slack, Zoom, Shopify\n- Si ves "$ 8.73" o "$8.73" en la imagen → monto: 8.73, moneda: "USD"\n- Tarjeta de crédito BCP/BBVA/Interbank con símbolo "$" → moneda: "USD"\n- NUNCA registres en PEN un consumo cuyo monto lleva el símbolo "$" en la imagen\n- El monto va SIEMPRE sin símbolo ni separador de miles: "S/ 1,234.50" → 1234.50\n\nTARJETA:\n- tarjeta_last4 = SOLO los 4 ultimos digitos de la tarjeta o cuenta si son visibles en la imagen (ej: "Tarjeta terminada en 1234" o "****1234" → "1234"). Nunca inventes numeros. Si no se ven, usa null. Yape/Plin normalmente no muestran tarjeta → null.\n\nREGLAS PARA DETECTAR TIPO:\n- GASTO: "¡Yapeaste!", "Pago exitoso", "Enviado a", "Realizaste un yapeo/plin", monto enviado\n- INGRESO: "¡Te yapearon!", "Recibiste", "Yapeo recibido", "Plin recibido", "Enviado por" (alguien te envió dinero)\n- Para ingresos: categoria="Finanzas", subcategoria=null, comercio=nombre de quien envía\n\nMÉTODO DE PAGO (metodo_pago):\n- Si la pantalla es de Yape (verde, logo Yape, "¡Yapeaste!" o "¡Te yapearon!") → metodo_pago="Yape"\n- Si la pantalla es de Plin (morado/azul, logo Plin, "¡Pago exitoso!") → metodo_pago="Plin"\n- Si es notificación de BCP, BBVA, Interbank, Scotiabank u otro banco → metodo_pago=nombre del banco\n- Si no se puede determinar → metodo_pago=null\n\nMOTIVO Y CATEGORIZACIÓN:\n- El campo "motivo" es la nota/mensaje que el usuario escribe al enviar el pago (ej: "pollo a la brasa", "almuerzo", "cumpleaños")\n- Si hay motivo, USALO para determinar la categoría y subcategoría (ej: motivo "pollo a la brasa" → Alimentación > Restaurantes)\n- Si el nombre del destinatario/comercio sugiere una categoría, úsalo también (ej: "Polleria Rokys" → Alimentación > Restaurantes, "Farmacia" → Salud)\n- El motivo tiene PRIORIDAD sobre el nombre del comercio para categorizar\n- subcategoria debe ser una descripción breve en español, o null si no aplica. NUNCA escribas la palabra "null" como texto.\n\nFORMATOS DE APPS:\n- Yape: pantalla verde con "¡Yapeaste!" (gasto) o "¡Te yapearon!" (ingreso), monto grande, nombre del destinatario/remitente, campo "Motivo" o "Nota" debajo\n- Plin: pantalla con "¡Pago exitoso!" y monto en verde, datos de "Enviado a" (gasto) o "Recibido de" (ingreso), código de operación, campo "Mensaje"\n- Bancos (BCP, BBVA, Interbank, etc.): notificación de consumo/depósito\n\nSi la imagen NO muestra ningún pago o transacción, devuelve: {"tipo":"no_pago"}\nFecha de hoy si no se ve en la imagen: ' + hoy;
}

/**
 * Corre Vision sobre la captura y devuelve el objeto parseado.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} hoy  fecha de hoy en Lima (YYYY-MM-DD), el default cuando la imagen no la muestra
 * @returns {Promise<object>} `{tipo:'no_pago'}` o los datos de la transacción
 * @throws si el modelo no devuelve JSON parseable
 */
async function extraerPagoDeImagen(buffer, mimeType, hoy) {
  const mime = mimeType || 'image/jpeg';
  const base64 = Buffer.from(buffer).toString('base64');
  const visionRes = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptVision(hoy) },
        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + base64, detail: 'high' } }
      ]
    }],
    temperature: 0, max_tokens: 400
  });
  const rawV = visionRes.choices[0].message.content.trim();
  log.debug({ tag: 'IMAGEN', response: rawV.slice(0, 200) }, 'GPT vision response');

  try {
    const start = rawV.indexOf('{'); const end = rawV.lastIndexOf('}');
    return JSON.parse(start >= 0 ? rawV.slice(start, end + 1) : rawV);
  } catch (pe) {
    throw new Error('GPT no devolvió JSON válido: ' + rawV.slice(0, 100));
  }
}

module.exports = { descargarMedia, transcribirAudio, extraerPagoDeImagen, promptVision, GRAPH_VERSION };
