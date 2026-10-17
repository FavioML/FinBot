// Por qué canal entró el mensaje de WhatsApp que se está procesando: texto, audio, imagen o
// archivo (el Excel).
//
// Existe para una sola pregunta de producto: cuánto pesa el audio. La nota de voz se transcribe y
// se reinyecta como texto (`handlers/webhook.js`), y desde ahí ningún dato la distingue de algo
// escrito: ni `transacciones` ni `conversaciones` guardan la marca. La skill `neto-usuarios`
// infería el canal de las filas y no podía separar audio de texto.
//
// **Por qué AsyncLocalStorage y no un parámetro.** Entre el webhook y `guardarTransaccion` hay
// media docena de caminos (el NLP con su dispatch, el multi-gasto, la imagen, el Excel, los
// rescates del webhook) y un parámetro tendría que viajar por todos. El que se olvidara de pasarlo
// no rompería nada: el evento saldría sin canal en silencio. El contexto del mensaje lo hereda
// todo lo que corre dentro de su procesamiento, que es exactamente "por qué canal entró ESTE
// mensaje". Fuera de un mensaje (crons, barrido de Gmail) no hay canal y `canalDeEntrada()`
// devuelve null.
const { AsyncLocalStorage } = require('async_hooks');

const contexto = new AsyncLocalStorage();

// `message.type` de Meta → canal. Un tipo que no está acá viaja con su propio nombre: hoy el
// webhook descarta todo lo que no sea estos cuatro antes de escribir plata, así que no debería
// aparecer en el evento, y si aparece es que alguien abrió un camino nuevo.
const CANAL_POR_TIPO = { text: 'texto', audio: 'audio', image: 'imagen', document: 'archivo' };

// Corre `fn` con un contexto propio, vacío hasta que el webhook fije el canal.
function conContextoDeMensaje(fn) {
  return contexto.run({ canal: null }, fn);
}

// Se llama con el `message.type` ORIGINAL, antes de que el bloque de audio lo pise con 'text'.
function fijarCanal(tipoMensaje) {
  const s = contexto.getStore();
  if (s) s.canal = CANAL_POR_TIPO[tipoMensaje] || tipoMensaje || null;
}

function canalDeEntrada() {
  const s = contexto.getStore();
  return (s && s.canal) || null;
}

module.exports = { conContextoDeMensaje, fijarCanal, canalDeEntrada, CANAL_POR_TIPO };
