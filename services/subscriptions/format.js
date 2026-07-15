// ═══════════════════════════════════════════════════════════════
// FORMATEO — Genera el texto de suscripciones para WhatsApp (voz NETO)
// ═══════════════════════════════════════════════════════════════

/**
 * Genera el texto de análisis de suscripciones para WhatsApp (voz NETO)
 */
function generarTextoSuscripciones(dataSubs, nombreUsuario) {
  const nombre = nombreUsuario ? nombreUsuario.split(' ')[0] : '';
  const { suscripciones_detectadas: subs, total_mensual_pen, resumen } = dataSubs;

  if (subs.length === 0) {
    return nombre
      ? nombre + ', no detecté suscripciones activas en tus transacciones. Si tienes alguna, regístrala manual y la trackeo.'
      : 'No detecté suscripciones activas. Si tienes alguna, regístrala y la trackeo.';
  }

  let msg = '🔄 ' + (nombre ? nombre + ', t' : 'T') + 'ienes ' + subs.length + ' suscripci' + (subs.length === 1 ? 'ón' : 'ones') + ' detectada' + (subs.length === 1 ? '' : 's') + ' (≈ S/' + total_mensual_pen + '/mes):\n\n';

  for (const sub of subs.slice(0, 8)) {
    const precio = sub.moneda === 'USD'
      ? '$' + sub.monto_detectado + ' (≈ S/' + sub.monto_pen + ')'
      : 'S/' + sub.monto_detectado;
    msg += sub.icono + ' ' + sub.nombre + ': ' + precio + '\n';
  }
  if (subs.length > 8) {
    msg += '... y ' + (subs.length - 8) + ' más\n';
  }

  // Tip de ahorro si aplica
  if (resumen.ahorro_potencial_familiar > 10) {
    msg += '\n💡 Si compartes planes familiares podrías ahorrar ≈ S/' + resumen.ahorro_potencial_familiar + '/mes';
  }

  msg += '\n\n¿Quieres que revise si alguna te conviene cancelar o cambiar de plan?';

  return msg;
}

module.exports = {
  generarTextoSuscripciones,
};
