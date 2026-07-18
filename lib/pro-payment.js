const { supabase } = require('./db');
const { enviarWhatsapp } = require('./whatsapp');
const { notificarAdmin } = require('./admin-notify');
const { enviarTelegramFotoConBotones } = require('./telegram');
const { crearNotificacion } = require('./notifications-db');
const { ADMIN_NUMBER, esPagoNeto, detectarTipoPlan, resolverTipoPlan, PRO_PRECIOS } = require('./config');
const { generarUrlAutorizacion } = require('../gmail');
const { guardarMensaje } = require('../helpers/db-helpers');
const log = require('./logger');

// Ventana de validez del flag "esperando comprobante": si el usuario manda la captura
// dentro de este lapso desde que se le pidió, la tratamos como comprobante Pro.
const COMPROBANTE_VENTANA_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * Marca que el usuario debe enviar su comprobante de pago Pro.
 * Lo llaman premium.js (ver_premium), el cron de upsell/vencimiento y el onboarding.
 */
async function solicitarComprobante(usuarioId) {
  try {
    await supabase.from('usuarios')
      .update({ esperando_comprobante: true, comprobante_solicitado_at: new Date().toISOString() })
      .eq('id', usuarioId);
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'No se pudo setear esperando_comprobante');
  }
}

/**
 * ¿El usuario está esperando enviar su comprobante (y dentro de la ventana de tiempo)?
 * onboarding_paso === 2 es el flujo de registro inicial; esperando_comprobante cubre
 * a usuarios ya registrados que pidieron Pro por /premium o por el cron.
 */
function esperaComprobante(usuario) {
  if (!usuario) return false;
  if (usuario.onboarding_paso === 2) return true;
  if (!usuario.esperando_comprobante) return false;
  if (!usuario.comprobante_solicitado_at) return true;
  const t = new Date(usuario.comprobante_solicitado_at).getTime();
  if (isNaN(t)) return true;
  return (Date.now() - t) < COMPROBANTE_VENTANA_MS;
}

/**
 * Sube un comprobante (buffer de imagen) al bucket privado `comprobantes`.
 * @returns {Promise<string|null>} el path guardado, o null si no se pudo.
 */
async function subirComprobante(usuarioId, imgBuffer, mimeType) {
  if (!imgBuffer) return null;
  try {
    const ext = (mimeType && mimeType.includes('png')) ? 'png' : 'jpg';
    const path = usuarioId + '/' + Date.now() + '.' + ext;
    const { error: upErr } = await supabase.storage.from('comprobantes')
      .upload(path, Buffer.from(imgBuffer), { contentType: mimeType || 'image/jpeg', upsert: false });
    if (upErr) {
      log.error({ tag: 'PRO_PAGO', err: upErr.message }, 'Error subiendo comprobante a Storage');
      return null;
    }
    return path;
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Excepción subiendo comprobante');
    return null;
  }
}

/**
 * Notifica al admin una solicitud Pro pendiente. Prioriza Telegram con la FOTO del
 * comprobante + botones inline (aprobar mensual/anual, rechazar); si Telegram no está
 * configurado o falla, cae al aviso de texto (`notificarAdmin`, que a su vez intenta
 * Telegram texto y luego WhatsApp). Los botones inline son exclusivos de Telegram.
 */
async function notificarSolicitudAdminPro({ pagoId, usuario, from, montoDet, tipoPlan, comprobanteBuffer, mimeType, origen }) {
  const montoStr = montoDet != null && !isNaN(montoDet) ? 'S/ ' + montoDet.toFixed(2) : '(no detectado)';
  const caption =
    '💸 Solicitud Pro (' + (origen || 'whatsapp') + ')\n' +
    'Usuario: ' + (usuario.nombre || from) + '\n' +
    'WhatsApp: ' + from + '\n' +
    'Monto: ' + montoStr + '\n' +
    'Plan declarado: ' + tipoPlan + '\n\n' +
    'Aprueba o rechaza abajo 👇';

  // Intento Telegram con la FOTO (bytes crudos, multipart) + botones inline.
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (adminChatId && comprobanteBuffer) {
    try {
      const keyboard = [
        [{ text: '✅ Aprobar mensual', callback_data: 'pro:approve:mensual:' + pagoId }],
        [{ text: '✅ Aprobar anual', callback_data: 'pro:approve:anual:' + pagoId }],
        [{ text: '❌ Rechazar', callback_data: 'pro:reject:' + pagoId }],
      ];
      const res = await enviarTelegramFotoConBotones(adminChatId, comprobanteBuffer, mimeType, caption, keyboard);
      if (res && res.ok) return;
    } catch (e) {
      log.error({ tag: 'PRO_PAGO', err: e.message }, 'Fallo notificación Telegram con foto; uso fallback');
    }
  }

  // Fallback: texto (Telegram texto → WhatsApp). Sin botones: incluye el comando manual.
  await notificarAdmin(
    '💸 *Comprobante de pago Pro recibido* (' + (origen || 'whatsapp') + ')\n' +
    'Usuario: ' + (usuario.nombre || from) + '\n' +
    'WhatsApp: ' + from + '\n' +
    'Monto: ' + montoStr + '\n' +
    'Plan: ' + tipoPlan + '\n' +
    (comprobanteBuffer ? '📎 Comprobante recibido\n' : '⚠️ Sin comprobante\n') +
    '\nApruébalo en el admin (app.neto.pe/admin/operacion) o confirma aquí:\n/pago ' + from + ' ' + tipoPlan
  );
}

/**
 * Core canal-agnóstico: registra una solicitud Pro pendiente.
 *  - sube el comprobante al bucket privado
 *  - inserta una fila en `pagos` (estado pendiente, con `origen`)
 *  - marca pago_pendiente y limpia el flag de espera
 *  - notifica al admin (Telegram con la foto + botones, fallback texto)
 * NO activa Pro ni toca bancos: eso viene después de aprobar. Lo usan el canal WhatsApp
 * (procesarComprobantePro) y el canal webapp (routes/pro.js). Sirve tanto para alta como
 * para renovación (un usuario premium puede tener una solicitud pendiente sin perder su plan).
 *
 * @param {object} p
 * @param {object} p.usuario
 * @param {number|null} p.monto            monto a registrar (webapp: precio del plan)
 * @param {number|null} p.montoDetectado   monto_detectado (WhatsApp: leído por Vision)
 * @param {string} p.tipoPlan
 * @param {string} p.metodoPago
 * @param {Buffer|null} p.comprobanteBuffer bytes de la imagen del comprobante
 * @param {string} p.mimeType
 * @param {string} p.origen                'whatsapp' | 'webapp'
 * @returns {Promise<{pagoId:string|null}>}
 */
async function registrarSolicitudPro({ usuario, monto, montoDetectado, tipoPlan, metodoPago, comprobanteBuffer, mimeType, origen }) {
  const comprobantePath = await subirComprobante(usuario.id, comprobanteBuffer, mimeType);

  let pagoId = null;
  try {
    const { data, error } = await supabase.from('pagos').insert({
      usuario_id: usuario.id,
      monto: monto != null ? monto : null,
      moneda: 'PEN',
      tipo_plan: tipoPlan,
      metodo_pago: metodoPago || 'Yape',
      comprobante_url: comprobantePath,
      monto_detectado: montoDetectado != null ? montoDetectado : null,
      estado: 'pendiente',
      origen: origen || 'whatsapp',
    }).select('id').single();
    if (error) log.error({ tag: 'PRO_PAGO', err: error.message }, 'Error insertando solicitud pendiente');
    else pagoId = data && data.id;
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Excepción insertando solicitud pendiente');
  }

  // Marcar pendiente + limpiar flag de espera. NO tocamos plan ni bancos (renovación segura).
  try {
    await supabase.from('usuarios')
      .update({ pago_pendiente: true, estado_pago: 'pendiente', esperando_comprobante: false })
      .eq('id', usuario.id);
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error marcando pago_pendiente');
  }

  await notificarSolicitudAdminPro({
    pagoId,
    usuario,
    from: usuario.whatsapp,
    montoDet: montoDetectado != null ? montoDetectado : monto,
    tipoPlan,
    comprobanteBuffer,
    mimeType,
    origen,
  });

  return { pagoId };
}

/**
 * Canal WhatsApp: procesa una captura como comprobante de pago Pro.
 * Delega el registro/notificación al core `registrarSolicitudPro` (que sube la imagen y
 * notifica al admin con foto + botones) y responde al usuario que está en verificación.
 */
async function procesarComprobantePro({ usuario, parsed, imgBuffer, mimeType, from }) {
  const montoDet = parsed && parsed.monto != null ? parseFloat(parsed.monto) : null;
  // El monto del comprobante manda sobre el tipo_plan guardado (que puede venir viejo).
  const tipoPlan = resolverTipoPlan(montoDet, usuario.tipo_plan);

  await registrarSolicitudPro({
    usuario,
    monto: montoDet,
    montoDetectado: montoDet,
    tipoPlan,
    metodoPago: (parsed && parsed.metodo_pago) || 'Yape',
    comprobanteBuffer: imgBuffer,
    mimeType,
    origen: 'whatsapp',
  });

  await enviarWhatsapp(from, '📸 *Comprobante recibido.*\n\nEstamos verificando tu pago. Te confirmamos en breve. ⏳');
}

/**
 * Reclama ATÓMICAMENTE un pago pendiente (pendiente → aprobado) antes de activar Pro.
 * Cierra la ventana TOCTOU de doble aprobación: doble-tap en Telegram, reintento del
 * callback_query, o doble-click en el panel web. El UPDATE condicional
 * (WHERE id=? AND estado='pendiente') es atómico en Postgres, así que solo UNA ejecución
 * gana la fila; las demás reciben null y NO deben activar nada (evita apilar meses + fila duplicada).
 *
 * @param {object} p
 * @param {string} [p.pagoId]      reclama este pago puntual (canal Telegram, con pagoId)
 * @param {string} [p.usuarioId]   si no hay pagoId, reclama el pendiente más reciente del usuario (panel web)
 * @param {string} [p.aprobadoPor]
 * @returns {Promise<object|null>} la fila reclamada, o null si ya no estaba pendiente / no existe.
 */
async function reclamarPagoPendiente({ pagoId, usuarioId, aprobadoPor }) {
  let objetivoId = pagoId;
  if (!objetivoId && usuarioId) {
    const { data: pend } = await supabase.from('pagos').select('id')
      .eq('usuario_id', usuarioId).eq('estado', 'pendiente')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!pend) return null;
    objetivoId = pend.id;
  }
  if (!objetivoId) return null;
  const { data } = await supabase.from('pagos')
    .update({ estado: 'aprobado', aprobado_at: new Date().toISOString(), aprobado_por: aprobadoPor || 'admin' })
    .eq('id', objetivoId)
    .eq('estado', 'pendiente')
    .select('*')
    .maybeSingle();
  return data || null;
}

/**
 * Registra/actualiza una fila en `pagos` cuando se APRUEBA un pago (activación Pro).
 * Si `pagoId` viene (fila ya reclamada atómicamente aguas arriba), solo completa el periodo.
 * Si no, comportamiento legacy: marca el pendiente aprobado, o inserta una fila nueva
 * (activación manual sin comprobante vía /pago o /activar).
 */
async function registrarPagoAprobado(usuarioId, { tipoPlan, monto, premiumDesde, premiumVence, aprobadoPor, pagoId }) {
  const montoFinal = monto != null ? monto : (PRO_PRECIOS[tipoPlan] || null);
  try {
    if (pagoId) {
      // Ya reclamado (estado/aprobado_at/aprobado_por seteados por reclamarPagoPendiente):
      // solo completa el plan/monto/periodo de esa fila puntual.
      await supabase.from('pagos').update({
        tipo_plan: tipoPlan,
        monto: montoFinal,
        premium_desde: premiumDesde,
        premium_vence: premiumVence,
      }).eq('id', pagoId);
      return;
    }
    const { data: pendiente } = await supabase.from('pagos')
      .select('id')
      .eq('usuario_id', usuarioId)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendiente) {
      await supabase.from('pagos').update({
        estado: 'aprobado',
        tipo_plan: tipoPlan,
        monto: montoFinal,
        premium_desde: premiumDesde,
        premium_vence: premiumVence,
        aprobado_at: new Date().toISOString(),
        aprobado_por: aprobadoPor || 'admin',
      }).eq('id', pendiente.id);
      return;
    }

    await supabase.from('pagos').insert({
      usuario_id: usuarioId,
      monto: montoFinal,
      moneda: 'PEN',
      tipo_plan: tipoPlan,
      metodo_pago: 'Yape',
      estado: 'aprobado',
      premium_desde: premiumDesde,
      premium_vence: premiumVence,
      aprobado_at: new Date().toISOString(),
      aprobado_por: aprobadoPor || 'admin',
    });
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error registrando pago aprobado');
  }
}

/**
 * Activa Pro para un usuario (fuente única de verdad, compartida por los 3 canales de
 * aprobación: endpoint admin, comando /pago y callback de Telegram). Preserva SIEMPRE la
 * lógica de "no acortar una suscripción ya activa" (antes solo vivía en /admin/aprobar-pago)
 * y setea el set completo de columnas (antes /activar quedaba a medias).
 *
 * @param {object} p
 * @param {object} p.usuario
 * @param {string} p.tipoPlan            'mensual' | 'anual'
 * @param {string} p.aprobadoPor
 * @param {boolean} [p.enviarOAuth=true]  incluir el link de conexión Gmail en el mensaje
 * @param {boolean} [p.guardarHistorial=true]
 * @param {boolean} [p.resetOnboarding=false]  poner onboarding_paso=0 (lo hacía /pago)
 * @param {string|null} [p.pagoId=null]   fila de `pagos` ya reclamada atómicamente aguas arriba
 *                                        (aprobación de un pendiente); null = activación manual.
 * @returns {Promise<{venceStr:string, mensaje:string}>}
 */
async function activarPro({ usuario, tipoPlan, aprobadoPor, enviarOAuth = true, guardarHistorial = true, resetOnboarding = false, pagoId = null }) {
  const plan = tipoPlan === 'anual' ? 'anual' : 'mensual';
  const hoy = new Date();
  const mesesAdd = plan === 'anual' ? 12 : 1;
  // Renovación: si la suscripción sigue vigente, apilamos el periodo SOBRE el vencimiento
  // actual (no desde hoy); si venció o no existe, contamos desde hoy. Nunca acorta.
  let base = hoy;
  if (usuario.premium_vence) {
    const actual = new Date(usuario.premium_vence + 'T12:00:00');
    if (!isNaN(actual.getTime()) && actual > hoy) base = actual;
  }
  const vence = new Date(base.getFullYear(), base.getMonth() + mesesAdd, base.getDate());
  const desde = usuario.premium_desde || hoy.toISOString().split('T')[0];
  const venceStr = vence.toISOString().split('T')[0];

  const update = {
    plan: 'premium', estado_pago: 'pagado', tipo_plan: plan,
    fecha_pago: hoy.toISOString(), fecha_vencimiento: vence.toISOString(),
    premium_desde: desde, premium_vence: venceStr,
    pago_pendiente: false, esperando_comprobante: false,
  };
  if (resetOnboarding) update.onboarding_paso = 0;
  await supabase.from('usuarios').update(update).eq('id', usuario.id);

  await registrarPagoAprobado(usuario.id, { tipoPlan: plan, premiumDesde: desde, premiumVence: venceStr, aprobadoPor: aprobadoPor || 'admin', pagoId });

  let urlOAuth = '';
  if (enviarOAuth) {
    try { urlOAuth = generarUrlAutorizacion(usuario.whatsapp); }
    catch (e) { log.warn({ tag: 'PRO_PAGO', err: e.message }, 'No se pudo generar URL OAuth'); }
  }
  const mensaje = '✅ *¡Pago confirmado!*\n\n' +
    'Plan: *' + (plan === 'anual' ? 'Anual (S/99/año)' : 'Mensual (S/10/mes)') + '*\n' +
    'Vence: ' + venceStr + '\n\n' +
    (urlOAuth
      ? 'Conecta tu Gmail para que Neto lea tus correos bancarios automáticamente:\n\n🔗 ' + urlOAuth + '\n\n_Solo leemos notificaciones bancarias. Sin contraseñas bancarias._'
      : '_Gracias por confiar en NETO._ 💚');
  await enviarWhatsapp(usuario.whatsapp, mensaje);
  if (guardarHistorial) {
    try { await guardarMensaje(usuario.id, 'neto', mensaje); } catch (e) { /* historial best-effort */ }
  }
  try {
    await crearNotificacion(usuario.id, 'pro', '¡Tu Pro fue activado! ⭐',
      'Ya tienes acceso completo a Neto Pro. Vence el ' + venceStr + '.', { link: '/dashboard/pro' });
  } catch (e) { /* notificación best-effort */ }

  return { venceStr, mensaje };
}

/**
 * Rechaza una solicitud Pro pendiente: marca el pago rechazado, limpia pago_pendiente
 * y avisa al usuario (in-app + WhatsApp). No toca el plan (sigue Free).
 */
async function rechazarSolicitudPro({ pagoId, usuario, motivo }) {
  try {
    if (pagoId) {
      await supabase.from('pagos')
        .update({ estado: 'rechazado', notas: motivo || 'Rechazado por admin' })
        .eq('id', pagoId);
    }
    // estado_pago tiene un CHECK (pendiente|pagado|vencido); en rechazo lo limpiamos a NULL.
    await supabase.from('usuarios')
      .update({ pago_pendiente: false, estado_pago: null, esperando_comprobante: false })
      .eq('id', usuario.id);
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error rechazando solicitud');
  }
  const mensaje = '⚠️ *No pudimos validar tu pago Pro*\n\n' +
    (motivo ? motivo + '\n\n' : '') +
    'Si ya yapeaste S/10 (mensual) o S/99 (anual) a *Favio Mendoza* (970398192), reenvíanos la captura correcta desde app.neto.pe/dashboard/pro o por aquí. 📸';
  try { await enviarWhatsapp(usuario.whatsapp, mensaje); } catch (e) { /* best-effort */ }
  try {
    await crearNotificacion(usuario.id, 'pro', 'No pudimos validar tu pago',
      motivo || 'Revisa tu comprobante y vuelve a enviarlo desde Pasar a Pro.', { link: '/dashboard/pro' });
  } catch (e) { /* best-effort */ }
}

module.exports = {
  solicitarComprobante,
  esperaComprobante,
  subirComprobante,
  registrarSolicitudPro,
  procesarComprobantePro,
  activarPro,
  rechazarSolicitudPro,
  reclamarPagoPendiente,
  registrarPagoAprobado,
  esPagoNeto,
  detectarTipoPlan,
  PRO_PRECIOS,
};
