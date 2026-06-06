const { supabase } = require('./db');
const { notificarAdmin } = require('./admin-notify');
const log = require('./logger');

// Tracking de errores recientes en memoria (para detectar patrones)
const _errorCounts = {}; // { tag:mensaje -> { count, firstSeen, lastNotified } }
const PATTERN_THRESHOLD = 5; // 5+ errores iguales
const PATTERN_WINDOW_MS = 60 * 60 * 1000; // en 1 hora
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min entre alertas críticas

/**
 * Registra un error en Supabase y detecta patrones.
 * @param {string} tag - Componente (WEBHOOK, NLP, AUTO, etc.)
 * @param {string} mensaje - Mensaje de error
 * @param {object} opts - { detalle, usuarioId, whatsapp, stack }
 */
async function registrarError(tag, mensaje, opts = {}) {
  try {
    // 1. Guardar en Supabase
    await supabase.from('errores').insert({
      tag,
      mensaje: mensaje.substring(0, 500),
      detalle: opts.detalle ? String(opts.detalle).substring(0, 1000) : null,
      usuario_id: opts.usuarioId || null,
      whatsapp: opts.whatsapp || null,
      stack: opts.stack ? String(opts.stack).substring(0, 2000) : null,
    });

    // 2. Detectar patrones (errores repetitivos)
    const key = tag + ':' + mensaje.substring(0, 100);
    const ahora = Date.now();
    if (!_errorCounts[key]) {
      _errorCounts[key] = { count: 0, firstSeen: ahora, lastNotified: 0 };
    }
    const entry = _errorCounts[key];
    // Reset si la ventana expiró
    if (ahora - entry.firstSeen > PATTERN_WINDOW_MS) {
      entry.count = 0;
      entry.firstSeen = ahora;
    }
    entry.count++;

    // 3. Alerta crítica si supera el threshold
    if (entry.count >= PATTERN_THRESHOLD && (ahora - entry.lastNotified > ALERT_COOLDOWN_MS)) {
      entry.lastNotified = ahora;
      const alertMsg = '🔴 *ALERTA CRITICA*\n\n' +
        '⚠️ Error repetitivo detectado:\n' +
        '📍 ' + tag + '\n' +
        '❌ ' + mensaje.substring(0, 150) + '\n' +
        '🔄 *' + entry.count + ' veces* en la última hora\n\n' +
        'Esto puede indicar un problema sistémico.\n' +
        '_' + new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }) + '_';
      await notificarAdmin(alertMsg);
      log.warn({ tag: 'MONITOR', errorTag: tag, count: entry.count }, 'Alerta crítica enviada — error repetitivo');
    }
  } catch (e) {
    // El monitor nunca debe crashear la app
    log.error({ tag: 'MONITOR', err: e.message }, 'Error en el monitor de errores');
  }
}

/**
 * Limpia contadores de errores viejos (housekeeping).
 * Llamar periódicamente.
 */
function limpiarContadores() {
  const ahora = Date.now();
  for (const key of Object.keys(_errorCounts)) {
    if (ahora - _errorCounts[key].firstSeen > PATTERN_WINDOW_MS * 2) {
      delete _errorCounts[key];
    }
  }
}

module.exports = { registrarError, limpiarContadores };
