const { parsearRegistroManual } = require('./parsers');
const { guardarTransaccion } = require('./transactions');
const { hoyPeru } = require('../lib/dates');
const log = require('../lib/logger');

/**
 * Registra un gasto de alguien a quien NO podemos responder.
 *
 * El caso: un usuario activó un username de WhatsApp, así que Meta dejó de mandar su número
 * y manda solo el BSUID. Lo reconocemos porque se lo aprendimos antes (migración 065), pero
 * `enviarWhatsapp` necesita un número y enviar por BSUID no está habilitado en nuestra WABA.
 * O sea: sabemos quién es y qué gastó, y no tenemos boca para contestarle.
 *
 * Decisión de Favio (2026-08-08): registrar igual. Anotar el gasto es lo que el modelo promete
 * gratis para siempre, y perder el gasto de alguien IDENTIFICADO es peor que no confirmárselo.
 * Lo verá en el dashboard, que es el canal que sí le llega.
 *
 * Deliberadamente delgado: `parsearRegistroManual` es el mismo extractor del flujo normal y
 * `guardarTransaccion` es el que ya centraliza validación de monto, conversión USD→PEN y dedup.
 * Nada de lógica de dinero se reimplementa acá — si divergiera, este camino guardaría plata
 * distinta que el camino normal y nadie lo notaría, porque no hay respuesta que lo delate.
 *
 * No hay gate de plan a propósito: escribir nunca se corta, lo que se cobra es leer.
 *
 * @returns {Promise<{registrado: boolean, motivo: string}>}
 */
async function registrarGastoSilencioso(texto, usuario) {
  const limpio = (texto || '').trim();
  if (!limpio) return { registrado: false, motivo: 'sin_texto' };
  if (!usuario || !usuario.id) return { registrado: false, motivo: 'sin_usuario' };

  let datos;
  try {
    datos = await parsearRegistroManual(limpio, hoyPeru());
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'Parser falló');
    return { registrado: false, motivo: 'parser_error' };
  }

  // El usuario mandó algo que no es un gasto (una consulta, un saludo, un comando). No hay
  // nada que guardar y tampoco forma de responderle: se descarta, pero queda el log.
  if (!datos || !datos.ok) return { registrado: false, motivo: 'no_es_gasto' };

  try {
    await guardarTransaccion(usuario.id, { ...datos, descripcion_original: limpio.substring(0, 200) });
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'No se pudo guardar la transacción');
    return { registrado: false, motivo: 'guardado_error' };
  }

  log.info({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, tipo: datos.tipo }, 'Gasto registrado sin poder responder');
  return { registrado: true, motivo: 'ok' };
}

module.exports = { registrarGastoSilencioso };
