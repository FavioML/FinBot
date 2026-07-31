const log = require('./logger');
const { supabase } = require('./db');

// Cache: phone (normalized) → { isTest: boolean, expiresAt: epoch_ms }
// 5 min TTL keeps Meta send latency stable while still picking up flag flips.
const TEST_USER_TTL_MS = 5 * 60 * 1000;
const testUserCache = new Map();

// Error de Meta cuando el mensaje free-form sale fuera de la ventana de servicio de 24h
// (el usuario no escribió en las últimas 24h). El mensaje NO se entrega.
const META_ERR_FUERA_VENTANA = 131047;

async function isTestUser(numero) {
  const dest = numero.replace(/^whatsapp:/i, '').replace(/^\+/, '');
  const cached = testUserCache.get(dest);
  if (cached && cached.expiresAt > Date.now()) return cached.isTest;
  try {
    const { data } = await supabase
      .from('usuarios')
      .select('is_test_user')
      .eq('whatsapp', dest)
      .maybeSingle();
    const isTest = data?.is_test_user === true;
    testUserCache.set(dest, { isTest, expiresAt: Date.now() + TEST_USER_TTL_MS });
    return isTest;
  } catch (e) {
    // Column may not exist yet (pre-migration) — fail open: never silence real users.
    return false;
  }
}

/**
 * Registra el resultado REAL de un envío en notification_deliveries.
 * Best-effort: nunca lanza (no debe romper el flujo de envío).
 * Solo registra envíos etiquetados con `tipo` (proactivos: crons, survey-triggers).
 * Las respuestas interactivas del webhook no pasan `tipo` y no se registran (siempre
 * están dentro de la ventana de 24h de todos modos).
 */
async function registrarEntrega({ usuarioId, tipo, canal, estado, code, error, wamid }) {
  if (!tipo) return;
  try {
    await supabase.from('notification_deliveries').insert({
      usuario_id: usuarioId || null,
      tipo,
      canal: canal || 'whatsapp',
      estado,
      code: code != null ? code : null,
      error: error ? String(error).substring(0, 300) : null,
      // El wamid es lo que permite cruzar este intento con el callback de status de
      // Meta. Sin él, `estado='sent'` solo dice "Meta aceptó el POST", no que le
      // haya llegado a nadie.
      wamid: wamid || null,
    });
  } catch (e) {
    log.error({ tag: 'NOTIF_DELIV', err: e.message }, 'No se pudo registrar entrega');
  }
}

/**
 * Procesa los callbacks de status de Meta (`value.statuses` del webhook) y marca la
 * entrega real sobre la fila que dejó registrarEntrega, cruzando por wamid.
 *
 * Los mensajes conversacionales del bot no tienen fila acá (registrarEntrega hace
 * `if (!tipo) return`), así que sus statuses no matchean nada. Es un no-op esperado.
 *
 * @param {Array} statuses  value.statuses del payload de Meta
 */
async function procesarStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) return;
  for (const st of statuses) {
    const wamid = st && st.id;
    if (!wamid) continue;
    const ahora = new Date().toISOString();
    let patch = null;
    if (st.status === 'delivered') patch = { delivered_at: ahora };
    else if (st.status === 'read') patch = { read_at: ahora };
    else if (st.status === 'failed') {
      const err = st.errors && st.errors[0];
      patch = {
        failed_at: ahora,
        fail_code: err && err.code != null ? err.code : null,
        error: err ? String(err.title || err.message || 'failed').substring(0, 300) : 'failed',
      };
    }
    if (!patch) continue; // 'sent' ya lo registró el envío; cualquier otro estado se ignora
    try {
      const { data } = await supabase
        .from('notification_deliveries')
        .update(patch)
        .eq('wamid', wamid)
        .select('id');
      if (!data || data.length === 0) {
        log.debug({ tag: 'NOTIF_STATUS', wamid, status: st.status }, 'Status sin fila de notificación (mensaje conversacional)');
      } else {
        log.info({ tag: 'NOTIF_STATUS', wamid, status: st.status }, 'Entrega actualizada');
      }
    } catch (e) {
      log.error({ tag: 'NOTIF_STATUS', err: e.message, wamid }, 'No se pudo actualizar entrega');
    }
  }
}

/**
 * Envía un mensaje de WhatsApp por Meta Cloud API y REPORTA el resultado real.
 *
 * @param {string} numero  destino
 * @param {string} mensaje texto (ignorado si opts.template está presente)
 * @param {object} [opts]
 * @param {string} [opts.tipo]      etiqueta para observabilidad (ver notification_deliveries).
 *                                  Si se pasa, el resultado se registra en notification_deliveries.
 * @param {string} [opts.usuarioId] id del usuario destino (para el registro de entrega)
 * @param {object} [opts.template]  payload de template de Meta: { name, language, components? }.
 *                                  Si se pasa, se envía type:'template' (entrega FUERA de la
 *                                  ventana de 24h). Ver docs/whatsapp-templates.md.
 * @returns {Promise<{ok:boolean, code?:number, error?:string, msgId?:string, skipped?:string}>}
 */
async function enviarWhatsapp(numero, mensaje, opts = {}) {
  const { tipo = null, usuarioId = null, template = null } = opts;
  const esTemplate = !!template;
  const canal = esTemplate ? 'whatsapp_template' : 'whatsapp';
  // Red de seguridad web-first: un usuario nacido en la web tiene whatsapp NULL y no
  // puede recibir mensajes. Cualquier ruta que intente enviarle (cron olvidado, alerta
  // disparada por una transacción hecha en la webapp) hace no-op acá en vez de reventar
  // en `numero.replace(...)`. Las guardas explícitas en la selección de destinatarios
  // (cron/checks.js, notifications.js) evitan además el trabajo inútil.
  if (!numero) {
    await registrarEntrega({ usuarioId, tipo, canal, estado: 'skipped_no_whatsapp' });
    return { ok: false, skipped: 'no_whatsapp' };
  }
  try {
    if (await isTestUser(numero)) {
      log.info({ tag: 'META', dest: numero, len: mensaje ? mensaje.length : 0 }, 'Skip Meta send (is_test_user)');
      await registrarEntrega({ usuarioId, tipo, canal, estado: 'skipped_test' });
      return { ok: true, skipped: 'test_user' };
    }
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_ACCESS_TOKEN;
    const dest = numero.replace(/^whatsapp:/i, '').replace(/^\+/, '');

    const body = esTemplate
      ? { messaging_product: 'whatsapp', to: dest, type: 'template', template }
      : { messaging_product: 'whatsapp', to: dest, type: 'text', text: { body: mensaje } };

    const response = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();

    if (data.messages && data.messages[0]) {
      log.info({ tag: 'META', dest, msgId: data.messages[0].id }, 'Enviado');
      await registrarEntrega({ usuarioId, tipo, canal, estado: 'sent', wamid: data.messages[0].id });
      return { ok: true, msgId: data.messages[0].id };
    }

    // Error reportado por Meta
    const code = data.error && data.error.code != null ? data.error.code : null;
    const errMsg = (data.error && data.error.message) || 'Meta send failed';
    const bloqueadoVentana = code === META_ERR_FUERA_VENTANA;
    if (bloqueadoVentana) {
      // Fuera de la ventana de 24h: el mensaje NO llegó. No es ruido de error, es esperable
      // para el usuario inactivo → log a nivel warn, no error.
      log.warn({ tag: 'META', dest, code, tipo }, 'Bloqueado por ventana 24h (131047)');
    } else {
      log.error({ tag: 'META', dest, code, err: errMsg }, 'Error enviando');
    }
    await registrarEntrega({
      usuarioId, tipo, canal,
      estado: bloqueadoVentana ? 'blocked_24h' : 'error',
      code, error: errMsg,
    });
    return { ok: false, code, error: errMsg };
  } catch (e) {
    log.error({ tag: 'META', err: e.message }, 'Error enviando WhatsApp');
    await registrarEntrega({ usuarioId, tipo, canal, estado: 'error', error: e.message });
    return { ok: false, code: null, error: e.message };
  }
}

module.exports = { enviarWhatsapp, procesarStatuses, META_ERR_FUERA_VENTANA };
