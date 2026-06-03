const { supabase } = require('./db');
const { enviarWhatsapp } = require('./whatsapp');
const { ADMIN_NUMBER, esPagoNeto, detectarTipoPlan, PRO_PRECIOS } = require('./config');
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
 * Procesa una captura como comprobante de pago Pro:
 *  - sube la imagen al bucket privado `comprobantes`
 *  - registra una fila en `pagos` (estado pendiente)
 *  - marca pago_pendiente y limpia el flag de espera
 *  - notifica al admin con el monto detectado
 *  - responde al usuario que está en verificación
 * NO activa Pro: eso lo hace el admin al aprobar (manual o desde el panel).
 */
async function procesarComprobantePro({ usuario, parsed, imgBuffer, mimeType, from }) {
  const montoDet = parsed && parsed.monto != null ? parseFloat(parsed.monto) : null;
  const tipoPlan = usuario.tipo_plan || detectarTipoPlan(montoDet);

  // 1. Subir comprobante a Storage (privado)
  let comprobanteUrl = null;
  try {
    if (imgBuffer) {
      const ext = (mimeType && mimeType.includes('png')) ? 'png' : 'jpg';
      const path = usuario.id + '/' + Date.now() + '.' + ext;
      const { error: upErr } = await supabase.storage.from('comprobantes')
        .upload(path, Buffer.from(imgBuffer), { contentType: mimeType || 'image/jpeg', upsert: false });
      if (upErr) log.error({ tag: 'PRO_PAGO', err: upErr.message }, 'Error subiendo comprobante a Storage');
      else comprobanteUrl = path;
    }
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Excepción subiendo comprobante');
  }

  // 2. Registrar pago pendiente
  try {
    await supabase.from('pagos').insert({
      usuario_id: usuario.id,
      monto: montoDet,
      moneda: 'PEN',
      tipo_plan: tipoPlan,
      metodo_pago: (parsed && parsed.metodo_pago) || 'Yape',
      comprobante_url: comprobanteUrl,
      monto_detectado: montoDet,
      estado: 'pendiente',
    });
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error insertando pago pendiente');
  }

  // 3. Marcar pendiente y limpiar flag de espera
  try {
    await supabase.from('usuarios')
      .update({ pago_pendiente: true, estado_pago: 'pendiente', esperando_comprobante: false })
      .eq('id', usuario.id);
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error marcando pago_pendiente');
  }

  // 4. Notificar al admin
  const montoStr = montoDet != null && !isNaN(montoDet) ? 'S/ ' + montoDet.toFixed(2) : '(no detectado)';
  try {
    await enviarWhatsapp(ADMIN_NUMBER,
      '💸 *Comprobante de pago Pro recibido*\n' +
      'Usuario: ' + (usuario.nombre || from) + '\n' +
      'WhatsApp: ' + from + '\n' +
      'Monto detectado: ' + montoStr + '\n' +
      'Plan: ' + tipoPlan + '\n' +
      (comprobanteUrl ? '📎 Comprobante guardado\n' : '⚠️ Sin comprobante guardado\n') +
      '\nApruébalo en el admin (app.neto.pe/admin/operacion) o confirma aquí:\n/pago ' + from + ' ' + tipoPlan
    );
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error notificando al admin');
  }

  // 5. Responder al usuario
  await enviarWhatsapp(from, '📸 *Comprobante recibido.*\n\nEstamos verificando tu pago. Te confirmamos en breve. ⏳');
}

/**
 * Registra/actualiza una fila en `pagos` cuando se APRUEBA un pago (activación Pro).
 * Si hay un pago pendiente del usuario, lo marca aprobado (conserva el comprobante);
 * si no, inserta una fila aprobada nueva (activación manual sin comprobante).
 */
async function registrarPagoAprobado(usuarioId, { tipoPlan, monto, premiumDesde, premiumVence, aprobadoPor }) {
  const montoFinal = monto != null ? monto : (PRO_PRECIOS[tipoPlan] || null);
  try {
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

module.exports = {
  solicitarComprobante,
  esperaComprobante,
  procesarComprobantePro,
  registrarPagoAprobado,
  esPagoNeto,
  detectarTipoPlan,
  PRO_PRECIOS,
};
