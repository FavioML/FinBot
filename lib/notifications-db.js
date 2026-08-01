const { supabase } = require('./db');
const log = require('./logger');

/**
 * Notificación in-app. Devuelve `true` si quedó escrita.
 *
 * El `catch` solo agarra excepciones, y **supabase-js no lanza**: un insert fallido vuelve
 * como `{ error }` y este código lo tiraba. O sea que el canal que la documentación llama
 * "el garantizado" (el que sostiene los avisos del trial cuando la ventana de 24h de Meta
 * está cerrada, ver docs/whatsapp-templates.md) podía no escribir nada sin dejar rastro.
 * Es el mismo modo de falla que se arregló en `iniciarTrialSiCorresponde`: sin leer el
 * `error`, un fallo de red es indistinguible del éxito.
 *
 * @returns {Promise<boolean>} true si se escribió
 */
async function crearNotificacion(usuarioId, tipo, titulo, mensaje, datos = {}) {
  try {
    const { error } = await supabase.from('notificaciones').insert({
      usuario_id: usuarioId,
      tipo,
      titulo,
      mensaje,
      datos,
      leida: false,
      fecha: new Date().toISOString(),
    });
    if (error) {
      log.error({ tag: 'NOTIF_DB', err: error.message, usuarioId, tipo, titulo },
        'No se pudo crear la notificación in-app');
      return false;
    }
    return true;
  } catch (e) {
    log.error({ tag: 'NOTIF_DB', err: e.message, usuarioId, tipo }, 'Excepción creando notificación');
    return false;
  }
}

module.exports = { crearNotificacion };
