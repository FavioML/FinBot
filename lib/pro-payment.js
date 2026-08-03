const { supabase } = require('./db');
const { enviarWhatsapp } = require('./whatsapp');
const { notificarAdmin } = require('./admin-notify');
const { enviarTelegramFotoConBotones } = require('./telegram');
const { notificarUsuario, CANALES } = require('./notify-user');
const { ADMIN_NUMBER, esPagoNeto, detectarTipoPlan, resolverTipoPlan, PRO_PRECIOS } = require('./config');
const { procesarConversionProReferido, resumenReferidoParaAdmin } = require('../services/referrals');
const { linkPanelPro } = require('./trial');
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
    // Si este flag no queda seteado, la próxima captura del usuario se procesa como
    // GASTO en vez de comprobante Pro. supabase-js no lanza: hay que leer el error.
    const { error } = await supabase.from('usuarios')
      .update({ esperando_comprobante: true, comprobante_solicitado_at: new Date().toISOString() })
      .eq('id', usuarioId);
    if (error) log.error({ tag: 'PRO_PAGO', err: error.message, usuarioId }, 'No se pudo setear esperando_comprobante');
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

  // Contexto de referido para que el admin decida con la info completa ANTES de aprobar:
  // si el usuario tiene 50% off se espera S/5 (no S/10), y quién ganará el mes gratis.
  const infoRef = await resumenReferidoParaAdmin(usuario.id);
  let refLines = '';
  if (infoRef.descuentoPct) {
    const esperado = Math.round(PRO_PRECIOS.mensual * (100 - infoRef.descuentoPct)) / 100;
    refLines += '🎟️ Referido con ' + infoRef.descuentoPct + '% off — se espera S/ ' + esperado.toFixed(2) + ' (no S/ ' + PRO_PRECIOS.mensual.toFixed(2) + ')\n';
  }
  if (infoRef.referrerNombre || infoRef.referrerId) {
    refLines += '👥 Referido de: ' + (infoRef.referrerNombre || infoRef.referrerId) + (infoRef.yaPremiado ? ' (ya premiado)' : ' — gana 1 mes gratis al aprobar') + '\n';
  }

  const caption =
    '💸 Solicitud Pro (' + (origen || 'whatsapp') + ')\n' +
    'Usuario: ' + (usuario.nombre || from) + '\n' +
    'WhatsApp: ' + from + '\n' +
    'Monto: ' + montoStr + '\n' +
    'Plan declarado: ' + tipoPlan + '\n' +
    refLines + '\n' +
    'Aprueba o rechaza abajo 👇';

  // Intento Telegram con la FOTO (bytes crudos, multipart) + botones inline.
  // Sin pagoId (el insert en `pagos` falló) los botones llevarían callback_data
  // 'pro:approve:mensual:null' y el claim reventaría al tocarlos: mejor caer al texto,
  // que trae el comando manual /pago.
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (adminChatId && comprobanteBuffer && pagoId) {
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
    refLines +
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
    const { error } = await supabase.from('usuarios')
      .update({ pago_pendiente: true, estado_pago: 'pendiente', esperando_comprobante: false })
      .eq('id', usuario.id);
    if (error) log.error({ tag: 'PRO_PAGO', err: error.message, usuarioId: usuario.id }, 'Error marcando pago_pendiente');
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
    const { data: pend, error } = await supabase.from('pagos').select('id')
      .eq('usuario_id', usuarioId).eq('estado', 'pendiente')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    // Una lectura fallida NO es "no hay pendiente". Devolver null aquí hacía que el panel
    // respondiera "El pago ya estaba procesado" (ok:true) sobre un pago que nadie aprobó:
    // el usuario pagaba y se quedaba en Free sin que ningún log lo delatara.
    if (error) {
      log.error({ tag: 'PRO_PAGO', err: error.message, usuarioId }, 'No se pudo leer el pago pendiente');
      throw new Error('No se pudo leer el pago pendiente: ' + error.message);
    }
    if (!pend) return null;
    objetivoId = pend.id;
  }
  if (!objetivoId) return null;
  const { data, error: errClaim } = await supabase.from('pagos')
    .update({ estado: 'aprobado', aprobado_at: new Date().toISOString(), aprobado_por: aprobadoPor || 'admin' })
    .eq('id', objetivoId)
    .eq('estado', 'pendiente')
    .select('*')
    .maybeSingle();
  // Un claim que falla por error de red es indistinguible de "otro tap ganó la fila" si
  // solo se mira data. Se distingue leyendo error, y se propaga para que el admin reintente.
  if (errClaim) {
    log.error({ tag: 'PRO_PAGO', err: errClaim.message, pagoId: objetivoId }, 'Falló el claim del pago');
    throw new Error('Falló el claim del pago: ' + errClaim.message);
  }
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
      const { error } = await supabase.from('pagos').update({
        tipo_plan: tipoPlan,
        monto: montoFinal,
        premium_desde: premiumDesde,
        premium_vence: premiumVence,
      }).eq('id', pagoId);
      if (error) log.error({ tag: 'PRO_PAGO', err: error.message, pagoId }, 'Pago aprobado quedó sin plan/monto/periodo');
      return;
    }
    const { data: pendiente, error: errPend } = await supabase.from('pagos')
      .select('id')
      .eq('usuario_id', usuarioId)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Si no se pudo leer, NO insertar: `pagos` no tiene unique que frene el duplicado, y
    // una fila aprobada de más infla el revenue del mes y deja el pendiente huérfano.
    // Se avisa al admin para que lo registre a mano; el pendiente sigue ahí, aprobable.
    if (errPend) {
      log.error({ tag: 'PRO_PAGO', err: errPend.message, usuarioId }, 'No se pudo leer el pendiente: no se registra el pago');
      try {
        await notificarAdmin('⚠️ Pro activado para ' + usuarioId + ' pero NO se pudo registrar la fila en `pagos` (fallo de lectura). Regístralo a mano.');
      } catch (e) { /* aviso best-effort */ }
      return;
    }

    if (pendiente) {
      const { error } = await supabase.from('pagos').update({
        estado: 'aprobado',
        tipo_plan: tipoPlan,
        monto: montoFinal,
        premium_desde: premiumDesde,
        premium_vence: premiumVence,
        aprobado_at: new Date().toISOString(),
        aprobado_por: aprobadoPor || 'admin',
      }).eq('id', pendiente.id);
      if (error) log.error({ tag: 'PRO_PAGO', err: error.message, pagoId: pendiente.id }, 'No se pudo marcar aprobado el pendiente');
      return;
    }

    const { error: errIns } = await supabase.from('pagos').insert({
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
    if (errIns) log.error({ tag: 'PRO_PAGO', err: errIns.message, usuarioId }, 'No se pudo insertar el pago aprobado');
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
 * @param {boolean} [p.enviarLinkGmail=true]  incluir el atajo al panel Pro (donde se conecta
 *   Gmail) en el mensaje. Se llamaba `enviarOAuth` cuando acá salía la URL de OAuth cruda;
 *   desde que conectar es web-only lo que viaja es el link al panel, no un grant de Google.
 * @param {boolean} [p.guardarHistorial=true]
 * @param {string|null} [p.pagoId=null]   fila de `pagos` ya reclamada atómicamente aguas arriba
 *                                        (aprobación de un pendiente); null = activación manual.
 * @param {boolean} [p.esConversionPagada=false]  true SOLO en aprobaciones de pago REAL
 *   (webapp /aprobar-pago, /pago, callback Telegram). Es el predicado de "esto fue plata" y
 *   decide dos cosas: dispara el premio de referidos al referrer, y registra la fila de `pagos`
 *   al precio de lista. Queda false en los comps (POST /admin/activar y el comando /activar de
 *   WhatsApp): un comp no puede premiar (anti-cadena) y se registra en S/0 para no inflar la
 *   caja del mes.
 * @returns {Promise<{venceStr:string, mensaje:string}>}
 */
async function activarPro({ usuario, tipoPlan, aprobadoPor, enviarLinkGmail = true, guardarHistorial = true, pagoId = null, esConversionPagada = false }) {
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
  // Pagar durante el trial NO cuesta los días que faltaban. Sin esto, quien decide al
  // día 3 pierde 11 días de prueba por decidirse rápido — o sea que el sistema castiga
  // exactamente la conversión temprana que queremos. `premium_vence` está NULL durante
  // el trial (así los trials le son invisibles a checkPremiumExpiry), así que el periodo
  // se apila sobre trial_vence.
  if (usuario.trial_estado === 'activo' && usuario.trial_vence) {
    const finTrial = new Date(String(usuario.trial_vence).slice(0, 10) + 'T12:00:00');
    if (!isNaN(finTrial.getTime()) && finTrial > base) base = finTrial;
  }
  const vence = new Date(base.getFullYear(), base.getMonth() + mesesAdd, base.getDate());
  const desde = usuario.premium_desde || hoy.toISOString().split('T')[0];
  const venceStr = vence.toISOString().split('T')[0];

  const update = {
    plan: 'premium', estado_pago: 'pagado', tipo_plan: plan,
    fecha_pago: hoy.toISOString(), fecha_vencimiento: vence.toISOString(),
    premium_desde: desde, premium_vence: venceStr,
    pago_pendiente: false, esperando_comprobante: false,
    // Sella el trial: convirtió. Deja de contar como prueba en las métricas de MRR
    // (que filtran trial_estado <> 'activo') y no vuelve a tener otro nunca, ni siquiera
    // si más adelante churnea. Se escribe aunque nunca haya tenido trial: un pagador
    // tampoco debería ganarse una prueba retroactiva.
    trial_estado: 'convertido',
  };
  // Desatasca el alta cuando el pago llega con el usuario parado en el paso 2 (la espera del
  // comprobante). Sin esto `esperaComprobante()` sigue devolviendo true para siempre (mira
  // onboarding_paso === 2), y el usuario ya premium recibe "elige tu plan / mándame la captura"
  // ante cualquier mensaje sin '/': pagó y no puede ni registrar un gasto. Pasó de verdad
  // (2026-07-21, aprobación por Telegram): antes esto solo lo hacía el comando /pago vía flag,
  // y las otras tres rutas de aprobación dejaban al usuario trabado.
  // `onboarding_completado` va en el mismo update a propósito: soltar el paso sin marcarlo deja
  // al usuario sin Gmail cayendo en el trigger de usuario nuevo (webhook → paso 100), o sea de
  // vuelta en "¿cómo te llamas?" pese a haber dado nombre y correo.
  if (usuario.onboarding_paso === 2) {
    update.onboarding_paso = 0;
    update.onboarding_completado = true;
  }
  // Esta escritura ES la activación. Si falla y seguimos, el usuario recibe
  // "¡Pago confirmado!", la fila de `pagos` queda aprobada y el plan sigue en Free:
  // pagó, el sistema dice que sí, y no tiene Pro. Se corta acá.
  const { error: errPlan } = await supabase.from('usuarios').update(update).eq('id', usuario.id);
  if (errPlan) {
    log.error({ tag: 'PRO_PAGO', err: errPlan.message, usuarioId: usuario.id }, 'No se pudo activar Pro');
    // El pago ya fue reclamado como aprobado aguas arriba. Sin devolverlo a pendiente, el
    // reintento del admin encontraría "ya procesado" y el usuario quedaría en Free para siempre.
    if (pagoId) {
      const { error: errRollback } = await supabase.from('pagos')
        .update({ estado: 'pendiente', aprobado_at: null, aprobado_por: null })
        .eq('id', pagoId);
      if (errRollback) {
        log.error({ tag: 'PRO_PAGO', err: errRollback.message, pagoId }, 'El pago quedó aprobado sin Pro activo: revisar a mano');
        try { await notificarAdmin('🚨 Pago ' + pagoId + ' quedó APROBADO pero Pro NO se activó y no se pudo revertir. Revisar a mano.'); } catch (e) { /* best-effort */ }
      }
    }
    throw new Error('No se pudo activar Pro: ' + errPlan.message);
  }

  // Un comp se registra en `pagos` (constancia de quién lo otorgó y por qué periodo) pero
  // vale S/0: `cajaDelMes` (webapp/src/lib/admin-revenue.ts) suma el `monto` de los pagos
  // aprobados del mes, así que dejarlo en el precio de lista haría figurar como cobrado un
  // mes que nadie transfirió. `esConversionPagada` ya es exactamente ese predicado: hoy es
  // true solo en los tres caminos de pago real. `undefined` deja el default (precio de lista).
  await registrarPagoAprobado(usuario.id, {
    tipoPlan: plan,
    monto: esConversionPagada ? undefined : 0,
    premiumDesde: desde, premiumVence: venceStr,
    aprobadoPor: aprobadoPor || 'admin', pagoId,
  });

  // Modelo de referidos dos-lados: si este usuario fue referido y ESTA es una conversión
  // PAGADA real (no comp), su referrer gana 1 mes. El grant al referrer se escribe directo
  // (plan:'premium') dentro de procesarConversionProReferido, NUNCA re-entra a activarPro:
  // así un comp o el propio premio no encadenan. Best-effort: jamás romper el pago.
  if (esConversionPagada) {
    try { await procesarConversionProReferido(usuario.id); }
    catch (e) { log.error({ tag: 'PRO_PAGO', err: e.message, usuarioId: usuario.id }, 'No se pudo procesar el premio de referido'); }
  }

  // Antes acá salía la URL de OAuth cruda, y era el único emisor exento del gate de Pro
  // pagado (la fila en memoria todavía es la de antes del UPDATE de arriba). Ahora conectar
  // Gmail es web-only, así que lo que se manda es el atajo al panel — y de paso desaparece
  // la excepción: este archivo ya no emite OAuth.
  //
  // El destino depende de la identidad: quien tiene cuenta web entra directo; quien es
  // WhatsApp-only necesita el link firmado, porque /dashboard/pro lo dejaría en /login sin
  // forma de vincularse a su número. `linkPanelPro` es dueño de esa decisión.
  let linkPanel = '';
  if (enviarLinkGmail) {
    // `usuario` es la fila previa al UPDATE, pero las dos columnas que mira linkPanelPro
    // (id y supabase_auth_id) no las toca este flujo: siguen siendo verdad.
    linkPanel = linkPanelPro(usuario) || '';
    if (!linkPanel) log.warn({ tag: 'PRO_PAGO', usuarioId: usuario.id }, 'No se pudo armar el link al panel Pro');
  }
  const cierre = linkPanel
    ? 'Conecta tu Gmail desde tu app y Neto empieza a leer tus correos bancarios solo:\n\n🔗 ' + linkPanel + '\n\n_Solo notificaciones bancarias. Sin contraseñas._'
    : '_Gracias por confiar en NETO._ 💚';
  // El comp no recibe el mensaje de pago. No es cosmética: al regalado se le estaba diciendo
  // "Pago confirmado — Plan Mensual S/10/mes", o sea confirmándole un cobro que no existió, y
  // el comp casi siempre ES la jugada de marketing (un influencer, alguien a quien quieres de
  // tu lado). Ramifica por `esConversionPagada`, el mismo predicado que ya decide el premio de
  // referidos y el monto registrado: un predicado, tres consecuencias, un solo sitio. No es un
  // parámetro de copy nuevo a propósito, para no reabrir la divergencia de mensajes que la
  // unificación de /admin/activar vino a cerrar.
  const mensaje = esConversionPagada
    ? '✅ *¡Pago confirmado!*\n\n' +
      'Plan: *' + (plan === 'anual' ? 'Anual (S/' + PRO_PRECIOS.anual + '/año)' : 'Mensual (S/' + PRO_PRECIOS.mensual + '/mes)') + '*\n' +
      'Vence: ' + venceStr + '\n\n' + cierre
    : '⭐ *¡Bienvenido a Neto Pro!*\n\n' +
      'Te activamos Pro hasta el ' + venceStr + ', sin costo.\n\n' +
      '✅ Dashboard e historial completos\n✅ Reportes y resumen semanal\n✅ Categorías personalizadas\n\n' + cierre;
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id,
    whatsapp: usuario.whatsapp || null,
    tipo: esConversionPagada ? 'pro_activado' : 'pro_activado_comp',
    mensaje,
    titulo: '¡Tu Pro fue activado! ⭐',
    cuerpo: 'Ya tienes acceso completo a Neto Pro. Vence el ' + venceStr + '.',
    tipoInApp: 'pro',
    link: '/dashboard/pro',
  });
  if (guardarHistorial) {
    try { await guardarMensaje(usuario.id, 'neto', mensaje); } catch (e) { /* historial best-effort */ }
  }

  return { venceStr, mensaje };
}

/**
 * Rechaza una solicitud Pro pendiente: marca el pago rechazado, limpia pago_pendiente
 * y avisa al usuario (in-app + WhatsApp). No toca el plan (sigue Free).
 */
async function rechazarSolicitudPro({ pagoId, usuario, motivo }) {
  try {
    if (pagoId) {
      const { error } = await supabase.from('pagos')
        .update({ estado: 'rechazado', notas: motivo || 'Rechazado por admin' })
        .eq('id', pagoId);
      // Si no se marca, la fila sigue pendiente y puede aprobarse después de haberle
      // dicho al usuario que su pago no era válido.
      if (error) log.error({ tag: 'PRO_PAGO', err: error.message, pagoId }, 'No se pudo marcar el pago como rechazado');
    }
    // estado_pago tiene un CHECK (pendiente|pagado|vencido); en rechazo lo limpiamos a NULL.
    const { error: errUsr } = await supabase.from('usuarios')
      .update({ pago_pendiente: false, estado_pago: null, esperando_comprobante: false })
      .eq('id', usuario.id);
    if (errUsr) log.error({ tag: 'PRO_PAGO', err: errUsr.message, usuarioId: usuario.id }, 'No se pudo limpiar pago_pendiente tras rechazo');
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error rechazando solicitud');
  }
  const mensaje = '⚠️ *No pudimos validar tu pago Pro*\n\n' +
    (motivo ? motivo + '\n\n' : '') +
    'Si ya yapeaste S/10 (mensual) o S/99 (anual) a *Favio Mendoza* (970398192), reenvíanos la captura correcta desde app.neto.pe/dashboard/pro o por aquí. 📸';
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id,
    whatsapp: usuario.whatsapp || null,
    tipo: 'pro_rechazado',
    mensaje,
    titulo: 'No pudimos validar tu pago',
    cuerpo: motivo || 'Revisa tu comprobante y vuelve a enviarlo desde Pasar a Pro.',
    tipoInApp: 'pro',
    link: '/dashboard/pro',
  });
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
