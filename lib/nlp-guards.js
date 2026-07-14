/**
 * Guards de seguridad para la clasificación NLP.
 *
 * Nota importante sobre acentos: `\b` en JS es ASCII, así que NO se usa antes de "último"
 * (la "ú" no es word-char y el boundary fallaría justo con la palabra que nos importa).
 * Los verbos de borrado van como stems con boundary solo al inicio, para cubrir todas las
 * conjugaciones (elimina/eliminar/eliminé, borra/borrar/borré, etc.).
 */

const RE_PIDE_ULTIMO =
  /[uú]ltim[oa]s?\b.{0,25}\b(movimiento|transacc|gasto|registro|compra|operaci)/i;
const RE_PIDE_ULTIMO_PREGUNTA =
  /\b(cu[aá]l|qu[eé]|mu[eé]stra|ens[eé][ñn]a|ver)\b.{0,30}[uú]ltim/i;
const RE_VERBO_BORRADO =
  /\b(borr|elimin|desha|quit|sac[ao]|cancel|reviert|revert|anul)/i;

// Verbo activo de registro/gasto (stems, boundary al inicio para cubrir conjugaciones).
const RE_VERBO_REGISTRO =
  /\b(gast[eé]|pagu[eé]|compr[eé]|regis?tr[aeoó]|an[oó]t[ao]|ap[uú]nt[ao]|invert[ií])/i;
// Presencia de un monto: dígito, número en palabras, o palabra de dinero.
const RE_MONTO_PRESENTE =
  /\d|\b(un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil)\b|\b(soles?|lucas?|mangos?|luquitas?|s\/)/i;

/**
 * ¿El mensaje pide VER el último movimiento/transacción sin ningún verbo de borrado?
 * Se usa para evitar que "el último movimiento" se ejecute como deshacer/eliminar
 * (caso Edgar, 23-jun-2026: pidió ver su último movimiento y Neto le borró el gasto).
 * @param {string} msg
 * @returns {boolean}
 */
function esVerUltimoMovimiento(msg) {
  const t = msg || '';
  const pide = RE_PIDE_ULTIMO.test(t) || RE_PIDE_ULTIMO_PREGUNTA.test(t);
  if (!pide) return false;
  return !RE_VERBO_BORRADO.test(t);
}

/**
 * ¿El mensaje es un REGISTRO DE GASTO NUEVO (verbo de gasto/registro + monto)?
 * Se usa en el webhook para NO dejar que el intercept de consultas pendientes
 * (intentarResolverConsulta) secuestre el mensaje: una nota de voz "registra un
 * gasto de diez soles en taxi" debe registrar el gasto, no categorizar un pendiente
 * al azar (bug 2026-07-14: se perdía el gasto y se corrompía un pendiente).
 * @param {string} msg
 * @returns {boolean}
 */
function esRegistroGastoNuevo(msg) {
  const t = msg || '';
  return RE_VERBO_REGISTRO.test(t) && RE_MONTO_PRESENTE.test(t);
}

module.exports = { esVerUltimoMovimiento, esRegistroGastoNuevo };
