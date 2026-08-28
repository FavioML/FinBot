const { supabase } = require('./db');
const { enviarWhatsapp, META_ERR_FUERA_VENTANA } = require('./whatsapp');
const log = require('./logger');

// Estados en los que una conversación de soporte se considera ABIERTA (sesión viva).
// Solo 'cerrado' termina la sesión. Mientras esté en uno de estos, TODO mensaje del
// usuario se enruta al admin en vez de al bot (ver message-processor.procesarMensajeLibre).
const SESSION_ACTIVE_STATES = ['esperando_mensaje', 'pendiente', 'respondido'];

// Autocierre por inactividad: si nadie escribe en 48h, la sesión se cierra sola y el
// usuario vuelve al asistente. Evita que alguien quede atascado en modo soporte para
// siempre por olvido (de él o del admin). Se aplica lazy al leer, sin cron.
const SESSION_IDLE_MS = 48 * 60 * 60 * 1000;

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

/**
 * Devuelve la sesión de soporte ABIERTA de un usuario (ticket en un estado activo),
 * o null si no hay. Aplica autocierre lazy: si la sesión lleva más de 48h sin
 * actividad, la cierra y devuelve null (el usuario vuelve al bot).
 *
 * @param {string} usuarioId
 * @returns {Promise<object|null>} el ticket abierto, o null.
 */
async function obtenerSesionAbierta(usuarioId) {
  if (!usuarioId) return null;
  const { data } = await supabase.from('tickets_soporte').select('*')
    .eq('usuario_id', usuarioId).in('estado', SESSION_ACTIVE_STATES)
    .order('created_at', { ascending: false }).limit(1);
  if (!data || data.length === 0) return null;
  const t = data[0];
  const ref = t.updated_at || t.created_at;
  if (ref && (Date.now() - new Date(ref).getTime()) > SESSION_IDLE_MS) {
    await supabase.from('tickets_soporte')
      .update({ estado: 'cerrado', updated_at: new Date().toISOString() })
      .eq('usuario_id', usuarioId).in('estado', SESSION_ACTIVE_STATES);
    log.info({ tag: 'SOPORTE', usuarioId }, 'Sesión de soporte autocerrada por inactividad');
    return null;
  }
  return t;
}

/**
 * Abre una sesión de soporte para un usuario. Idempotente: si ya hay una abierta,
 * no crea otra. El ticket nace en 'esperando_mensaje' (a la espera del primer
 * mensaje, que lo pasa a 'pendiente' y notifica al admin).
 *
 * @param {{ usuarioId: string, whatsapp: string, nombre?: string|null }} args
 * @returns {Promise<{ yaAbierta: boolean, ticket: object|null }>}
 */
async function abrirSesion({ usuarioId, whatsapp, nombre = null }) {
  const existente = await obtenerSesionAbierta(usuarioId);
  if (existente) return { yaAbierta: true, ticket: existente };
  const { data } = await supabase.from('tickets_soporte').insert({
    usuario_id: usuarioId,
    whatsapp,
    nombre_usuario: nombre,
    estado: 'esperando_mensaje',
  }).select('id').maybeSingle();
  return { yaAbierta: false, ticket: data || null };
}

/**
 * Cierra la(s) sesión(es) de soporte abiertas de un usuario, por id o por número.
 * Opcionalmente avisa al usuario por WhatsApp (para el /cerrar del admin).
 *
 * @param {{ usuarioId?: string, whatsapp?: string, avisarUsuario?: boolean }} args
 * @returns {Promise<{ closed: number, msg: string|null }>}
 */
async function cerrarSesion({ usuarioId = null, whatsapp = null, avisarUsuario = false }) {
  const numero = whatsapp ? String(whatsapp).replace(/\+/g, '').trim() : null;
  let q = supabase.from('tickets_soporte').select('id, whatsapp').in('estado', SESSION_ACTIVE_STATES);
  if (usuarioId) q = q.eq('usuario_id', usuarioId);
  else if (numero) q = q.eq('whatsapp', numero);
  else return { closed: 0, msg: 'Falta usuarioId o whatsapp.' };

  const { data: abiertos } = await q;
  if (!abiertos || abiertos.length === 0) {
    return { closed: 0, msg: numero ? ('No hay conversación de soporte abierta para ' + numero + '.') : null };
  }
  const ids = abiertos.map((t) => t.id);
  await supabase.from('tickets_soporte')
    .update({ estado: 'cerrado', updated_at: new Date().toISOString() })
    .in('id', ids);

  const numAviso = numero || abiertos[0].whatsapp;
  if (avisarUsuario && numAviso) {
    try {
      await enviarWhatsapp(numAviso, '✅ El equipo de Neto cerró tu conversación de soporte.\n\nSi necesitas algo más, escribe */soporte* cuando quieras. 💚');
    } catch (e) { /* best-effort */ }
  }
  return { closed: ids.length, msg: '✅ Conversación de soporte cerrada' + (numAviso ? ' (' + String(numAviso).replace(/\+/g, '') + ')' : '') + '.' };
}

/**
 * Contacta a un usuario que NO abrió un ticket: la respuesta del admin a un feedback o a una
 * queja desde el panel (tab "NLP Errors").
 *
 * Existe porque esas dos cosas no viven en `tickets_soporte` sino en `nlp_errors`, así que no
 * hay ticket que responder — y hasta hoy la única forma de contestarle a alguien que dejó una
 * sugerencia era escribirle desde un celular.
 *
 * **El envío va PRIMERO y la sesión sólo se abre si el mensaje se entregó.** Al revés, un fallo
 * de la ventana de 24h dejaría a la persona en modo soporte sin haber recibido nada: sus
 * mensajes siguientes irían al admin en vez del bot (message-processor:104) y su registro de
 * gastos quedaría roto hasta el autocierre, por una conversación que nunca existió.
 *
 * `abrirConversacion` es del ADMIN y por defecto es false. Contestar "gracias, ya lo anotamos"
 * no debería secuestrarle el bot a nadie; abrir el ida y vuelta es una decisión aparte, que se
 * toma cuando de verdad hace falta.
 *
 * @param {{ usuarioId?: string|null, whatsapp: string, nombre?: string|null, mensaje: string,
 *           abrirConversacion?: boolean }} args
 * @returns {Promise<{ ok: boolean, msg: string, conversacionAbierta?: boolean }>}
 */
async function contactarUsuario({ usuarioId = null, whatsapp, nombre = null, mensaje, abrirConversacion = false }) {
  const numero = String(whatsapp || '').replace(/\+/g, '').trim();
  if (!numero) return { ok: false, msg: 'No encontré el número de esa persona.' };

  // Mismo envío, mismo encabezado y mismo manejo del 131047 que la respuesta a un ticket: si
  // esto se duplicara, la ventana de 24h se trataría distinto según por qué pantalla se entró.
  const envio = await responderTicket({ numDestino: numero, mensaje });
  if (!envio.ok) return envio;

  if (!abrirConversacion) return { ok: true, msg: envio.msg, conversacionAbierta: false };

  if (!usuarioId) {
    return { ok: true, msg: envio.msg + ' (no pude abrir la conversación: la fila no tiene usuario).', conversacionAbierta: false };
  }
  const { ticket } = await abrirSesion({ usuarioId, whatsapp: numero, nombre });
  if (ticket && ticket.id) {
    await supabase.from('tickets_soporte').update({
      mensaje_admin: String(mensaje).substring(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq('id', ticket.id);
  }
  return { ok: true, msg: envio.msg + ' Conversación abierta: lo que responda te llega a vos.', conversacionAbierta: true };
}

module.exports = {
  responderTicket,
  contactarUsuario,
  listarTicketsPendientes,
  obtenerSesionAbierta,
  abrirSesion,
  cerrarSesion,
  SESSION_ACTIVE_STATES,
};
