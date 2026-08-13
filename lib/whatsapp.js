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
// Mapeo PASIVO del BSUID. Medido el 08-ago-2026 contra un callback real: los status traen las
// dos identidades juntas — `recipient_id` (el número) y `recipient_user_id` (el BSUID) — y ya
// vienen en `sent`, que ocurre al enviar, sin que la persona lea ni reciba nada.
//
// Por qué importa más que aprenderlo del mensaje entrante: eso exige que el usuario ESCRIBA, y
// a quien active un username antes de volver a escribir lo perdemos. Esto convierte cada
// recordatorio y cada resumen que ya le mandamos en un mapeo gratis.
//
// El Set evita una query por callback: cada mensaje enviado genera `sent`+`delivered`+`read`, y
// con los crons diarios son cientos por día. Una sola consulta por número y por instancia (el
// backend asume instancia única, ver CLAUDE.md).
//
// **Solo entran los números con respuesta DEFINITIVA (hallazgo B19).** Antes se marcaba el
// número ANTES de consultar, así que un hipo de red lo dejaba marcado como "ya visto" y su BSUID
// no se volvía a intentar nunca — hasta el próximo deploy, que es lo único que limpia este Set.
// Definitivo significa: se guardó, ya lo tenía, ese número no es de nadie (reintentarlo tampoco
// lo haría aparecer), o el BSUID pertenece a otra fila (23505, permanente). Un fallo transitorio
// NO entra, y por eso hace falta `persistirBsuidConEstado`: `persistirBsuid` se traga el error
// del UPDATE, así que "no lanzó" nunca significó "se guardó".
const bsuidVistos = new Set();
const ESTADOS_DEFINITIVOS = new Set(['guardado', 'sin_cambio', 'colision', 'sin_usuario']);

// Consultas en vuelo. Los tres callbacks de un mismo envío llegan casi juntos pero en POSTs
// SEPARADOS, o sea concurrentes de verdad: con el `add` movido al final, los tres pasarían el
// `has` y dispararían tres SELECT y tres UPDATE del mismo número. Compartir la promesa mantiene
// la propiedad de una query por número que el Set venía a dar, y de paso evita esos UPDATE
// concurrentes (son idempotentes, pero no hay razón para provocarlos).
const bsuidEnCurso = new Map();

async function aprenderBsuidDeStatus(st) {
  const numero = st && st.recipient_id;
  const bsuid = st && st.recipient_user_id;
  if (!numero || !bsuid || bsuidVistos.has(numero)) return;
  const enCurso = bsuidEnCurso.get(numero);
  if (enCurso) return enCurso;
  const consulta = resolverBsuidDeNumero(numero, bsuid)
    .then((estado) => { if (ESTADOS_DEFINITIVOS.has(estado)) bsuidVistos.add(numero); })
    .catch((e) => {
      log.error({ tag: 'BSUID', err: e.message }, 'No se pudo aprender el BSUID desde un callback — se reintentará en el próximo');
    })
    .finally(() => { bsuidEnCurso.delete(numero); });
  bsuidEnCurso.set(numero, consulta);
  return consulta;
}

async function resolverBsuidDeNumero(numero, bsuid) {
  // Require PEREZOSO a propósito. `whatsapp.js` es infraestructura de envío y `db-helpers`
  // está una capa más arriba; importarlo al tope invierte las capas e invita a un ciclo el
  // día que db-helpers necesite mandar un mensaje. Hoy no hay ciclo (verificado), y así
  // tampoco lo habrá. El costo es cero: `require` cachea.
  const { persistirBsuidConEstado } = require('../helpers/db-helpers');
  // `usuarios.whatsapp` es único (`usuarios_whatsapp_key`), así que acá no hay "varias filas":
  // un error de este SELECT es de infraestructura y por eso se propaga en vez de leerse como
  // "ese número no es de nadie", que es lo que hacía antes y lo que cacheaba el fallo.
  const { data, error } = await supabase.from('usuarios').select('id, bsuid').eq('whatsapp', numero).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return 'sin_usuario';
  const { estado } = await persistirBsuidConEstado(data, bsuid);   // no borra, no rompe: ver helpers/db-helpers.js
  return estado;
}

async function procesarStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) return;
  for (const st of statuses) {
    const wamid = st && st.id;
    if (!wamid) continue;
    await aprenderBsuidDeStatus(st);
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

    // `AbortSignal.timeout` porque el default de fetch es NO tener timeout: un socket que
    // Meta deja colgado bloquea el turno del usuario para siempre, y este await está en el
    // camino de cada respuesta y de cada cron. 15s es holgado contra la latencia real de
    // Graph (cientos de ms) y corto contra un cuelgue (hallazgo B22).
    const response = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
      signal: AbortSignal.timeout(15000),
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
