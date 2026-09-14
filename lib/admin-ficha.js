const { supabase } = require('./db');
const log = require('./logger');

/**
 * Cómo se nombra a un cliente en los avisos al admin (Telegram), y cuántas veces pagó.
 *
 * Existe porque el admin no reconoce un UUID. El aviso de "OTRA captura" decía solo
 * `174d2efd-…` debajo de una foto con nombre, y no había forma de saber si era la misma
 * persona. Y aprobar reescribía el caption con el nombre a secas: el teléfono que la foto
 * traía desaparecía justo en el mensaje que queda en el chat.
 */

/** '51970398192' → '+51 970 398 192'. Otro largo sale con '+' y los dígitos tal cual. */
function telefonoLegible(whatsapp) {
  // Un BSUID ('PE.1049…') no es un teléfono: sin esto salía como '+1049…'.
  if (/[a-z]/i.test(String(whatsapp || ''))) return null;
  const d = String(whatsapp || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d.startsWith('51')) {
    return '+51 ' + d.slice(2, 5) + ' ' + d.slice(5, 8) + ' ' + d.slice(8);
  }
  return '+' + d;
}

/**
 * Líneas "Cliente / WhatsApp" para un aviso al admin. Quien escribe sin número visible
 * (llega por BSUID) no tiene teléfono que mostrar, y se dice eso en vez de pegar el BSUID,
 * que el admin tampoco reconoce. Sin número, el correo es lo único que lo identifica.
 */
function lineasIdentidad(usuario, { conId = false } = {}) {
  const u = usuario || {};
  const lineas = ['Cliente: ' + (u.nombre || '(sin nombre)')];
  const tel = telefonoLegible(u.whatsapp);
  if (tel) lineas.push('WhatsApp: ' + tel);
  else if (u.bsuid) lineas.push('WhatsApp: sin número visible (escribe con usuario de WhatsApp)');
  else lineas.push('WhatsApp: no vinculado');
  if (!tel && u.email) lineas.push('Correo: ' + u.email);
  if (conId && u.id) lineas.push('ID: ' + u.id);
  return lineas;
}

/**
 * Pagos APROBADOS con plata (`monto > 0`) del usuario, sin contar `excluirPagoId`.
 *
 * `monto > 0` es la misma frontera que separa al Pro de cortesía del pagado en el MRR
 * (`webapp/src/lib/admin-revenue.ts`): `/activar` registra el regalo en S/0, y contarlo
 * haría pasar por recurrente a alguien que nunca pagó.
 *
 * Devuelve `null` si no se pudo leer. Nunca lanza: es contexto del aviso, y un aviso de
 * pago que no sale porque falló una cuenta es peor que un aviso sin la cuenta.
 */
async function contarPagosConPlata(usuarioId, { excluirPagoId = null } = {}) {
  try {
    let q = supabase.from('pagos').select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId).eq('estado', 'aprobado').gt('monto', 0);
    if (excluirPagoId) q = q.neq('id', excluirPagoId);
    const { count, error } = await q;
    if (error) {
      log.warn({ tag: 'ADMIN_FICHA', err: error.message, usuarioId }, 'No se pudo contar los pagos del usuario');
      return null;
    }
    return typeof count === 'number' ? count : null;
  } catch (e) {
    log.warn({ tag: 'ADMIN_FICHA', err: e && e.message, usuarioId }, 'Excepción contando los pagos del usuario');
    return null;
  }
}

// `null` no se redondea a "cliente nuevo": decirlo sin haberlo leído es justo el error que
// este contexto existe para evitar.
const SIN_HISTORIAL = '⚠️ No pude leer cuántas veces pagó antes';

/** Antes de aprobar: cuántas veces pagó ya. */
function lineaHistorialAntes(previos) {
  if (previos == null) return SIN_HISTORIAL;
  if (previos === 0) return '🆕 Cliente nuevo: sería su primer pago';
  return '🔁 Recurrente: ya pagó ' + previos + (previos === 1 ? ' vez' : ' veces') +
    ', este sería el pago N° ' + (previos + 1);
}

/** Después de aprobar: qué número de pago fue este. */
function lineaHistorialAprobado(previos) {
  if (previos == null) return SIN_HISTORIAL;
  return previos === 0 ? '🆕 Pago N° 1 (cliente nuevo)' : '🔁 Pago N° ' + (previos + 1) + ' (recurrente)';
}

module.exports = {
  telefonoLegible,
  lineasIdentidad,
  contarPagosConPlata,
  lineaHistorialAntes,
  lineaHistorialAprobado,
};
