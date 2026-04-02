const { supabase } = require('./db');
const log = require('./logger');

async function crearNotificacion(usuarioId, tipo, titulo, mensaje, datos = {}) {
  try {
    await supabase.from('notificaciones').insert({
      usuario_id: usuarioId,
      tipo,
      titulo,
      mensaje,
      datos,
      leida: false,
      fecha: new Date().toISOString(),
    });
  } catch (e) {
    log.error({ tag: 'NOTIF_DB', err: e.message }, 'Error creando notificacion');
  }
}

module.exports = { crearNotificacion };
