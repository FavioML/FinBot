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

module.exports = { esVerUltimoMovimiento };
