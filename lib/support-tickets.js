const { supabase } = require('./db');
const { enviarWhatsapp, META_ERR_FUERA_VENTANA } = require('./whatsapp');
const log = require('./logger');

/**
 * Responde a un ticket de soporte: manda el mensaje del admin al usuario por
 * WhatsApp (como NETO) y marca el ticket como respondido.
 *
 * Fuente única para las TRES puertas del admin: el comando /responder por
 * WhatsApp, el mismo comando por Telegram, y el panel de la webapp. Antes esta
 * lógica vivía sólo en el webhook de WhatsApp; el panel de la webapp escribía
 * columnas que no existen (`respuesta_admin`/`respondido_at`) y ni siquiera
 * mandaba el WhatsApp, así que "Responder" desde la web fallaba en silencio.
 *
 * Acepta el número directo (comandos, el admin lo teclea) o un `ticketId` (panel
 * webapp, que ya tiene la fila). Si sólo viene el número, actualiza el ticket
 * pendiente más reciente de ese número.
 *
 * Ojo con la ventana de 24h de Meta: si el usuario no escribió en las últimas
 * 24h, el WhatsApp libre no se entrega (error 131047) y esto devuelve el fallo.
 *
 * @param {{ numDestino?: string|null, mensaje: string, ticketId?: string|null }} args
 * @returns {Promise<{ ok: boolean, msg: string }>}
 */
async function responderTicket({ numDestino = null, mensaje, ticketId = null }) {
  const texto = String(mensaje || '').trim();
  if (!texto) return { ok: false, msg: 'Escribe el mensaje de respuesta.' };

  let numero = String(numDestino || '').replace(/\+/g, '').trim();
  let targetTicketId = ticketId || null;

  // Panel webapp: vino el id del ticket, resolvemos el número desde la fila.
  if (!numero && targetTicketId) {
    const { data: t } = await supabase
      .from('tickets_soporte').select('whatsapp').eq('id', targetTicketId).maybeSingle();
    numero = t && t.whatsapp ? String(t.whatsapp).replace(/\+/g, '').trim() : '';
  }

  if (!numero) return { ok: false, msg: 'No encontré el número del ticket.' };

  try {
    // enviarWhatsapp NO lanza ante error de Meta: devuelve { ok, code, error }. Hay que
    // mirar el retorno, o el ✅ sería un falso positivo (ej: fuera de la ventana de 24h).
    const envio = await enviarWhatsapp(
      numero,
      '👤 *Respuesta del equipo Neto:*\n\n' + texto +
      '\n\n_Si necesitas más ayuda, cuéntanos o escríbenos a hola@neto.pe_'
    );

    if (!envio || !envio.ok) {
      // No se entregó → NO marcamos el ticket como respondido (queda visible como pendiente).
      if (envio && envio.code === META_ERR_FUERA_VENTANA) {
        return { ok: false, msg: '⏳ No se entregó: el usuario no escribe hace más de 24h (ventana de Meta cerrada). Pídele que te escriba algo y reintenta.' };
      }
      return {
        ok: false,
        msg: '❌ Meta rechazó el envío' + (envio && envio.code ? ' (code ' + envio.code + ')' : '') + '. No marqué el ticket como respondido.',
      };
    }

    // Entregado. Si no vino ticketId (comandos), tomamos el pendiente más reciente del número.
    if (!targetTicketId) {
      const { data: tickets } = await supabase
        .from('tickets_soporte').select('id')
        .eq('whatsapp', numero).in('estado', ['pendiente', 'esperando_mensaje'])
        .order('created_at', { ascending: false }).limit(1);
      targetTicketId = tickets && tickets.length > 0 ? tickets[0].id : null;
    }

    if (targetTicketId) {
      await supabase.from('tickets_soporte').update({
        mensaje_admin: texto.substring(0, 1000),
        estado: 'respondido',
        updated_at: new Date().toISOString(),
      }).eq('id', targetTicketId);
    }

    return { ok: true, msg: '✅ Respuesta enviada a ' + numero + '.' };
  } catch (e) {
    log.error({ tag: 'RESPONDER', err: e.message }, 'Error enviando respuesta admin');
    return { ok: false, msg: '❌ Error enviando la respuesta: ' + e.message };
  }
}

/**
 * Lista los tickets de soporte pendientes (para el comando /tickets del admin).
 * @returns {Promise<string>} texto listo para enviar al admin.
 */
async function listarTicketsPendientes() {
  const { data: ticketsList } = await supabase
    .from('tickets_soporte').select('*')
    .in('estado', ['pendiente', 'esperando_mensaje'])
    .order('created_at', { ascending: false }).limit(10);

  if (!ticketsList || ticketsList.length === 0) {
    return '📭 No hay tickets pendientes. ¡Todo tranquilo!';
  }

  let msg = '🎫 *Tickets pendientes (' + ticketsList.length + '):*\n\n';
  ticketsList.forEach((t, i) => {
    msg += (i + 1) + '. ' + (t.nombre_usuario || 'Sin nombre') + ' (' + t.whatsapp + ')\n';
    msg += '   📋 ' + t.estado + ' | ' + new Date(t.created_at).toLocaleDateString('es-PE') + '\n';
    if (t.mensaje_usuario) msg += '   💬 ' + t.mensaje_usuario.substring(0, 80) + '\n';
    msg += '\n';
  });
  msg += '_Responde con:_\n/responder <número> <mensaje>';
  return msg;
}

module.exports = { responderTicket, listarTicketsPendientes };
