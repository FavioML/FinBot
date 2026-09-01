const { supabase } = require('./db');
const { notificarAdmin } = require('./admin-notify');
const log = require('./logger');

// Tracking de errores recientes en memoria (para detectar patrones)
const _errorCounts = {}; // { tag:mensaje -> { count, firstSeen, lastNotified } }
const PATTERN_THRESHOLD = 5; // 5+ errores iguales
const PATTERN_WINDOW_MS = 60 * 60 * 1000; // en 1 hora
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min entre alertas críticas

/**
 * ¿Este error es "OpenAI se quedó sin saldo"?
 *
 * OpenAI devuelve **429 para dos cosas que no se parecen en nada**: la saturación temporal
 * (`rate_limit_exceeded`, se pasa sola en segundos) y la cuenta sin crédito
 * (`insufficient_quota`, no se pasa NUNCA hasta que alguien pague). Todo el código que
 * mira sólo el `429` las trata igual, y de ahí salieron los dos defectos del 28-ago-2026:
 * al usuario se le prometía "reenvía en unos segundos" cuando reenviar no podía funcionar,
 * y al admin le llegaba una alerta rotulada con el componente que la reportó (`CORREO`)
 * cuando el que estaba caído era todo lo que usa IA.
 *
 * Se decide por el TEXTO y no por el código porque el código no distingue. No se busca
 * "billing" a secas: esa palabra viene dentro de la URL que OpenAI mete en los dos mensajes.
 */
const esOpenAISinCreditos = (mensaje) =>
  /no credits remaining|insufficient[_ ]quota|exceeded your current quota/i.test(String(mensaje || ''));

/**
 * Registra un error en Supabase y detecta patrones.
 * @param {string} tag - Componente (WEBHOOK, NLP, AUTO, etc.)
 * @param {string} mensaje - Mensaje de error
 * @param {object} opts - { detalle, usuarioId, whatsapp, stack }
 */
async function registrarError(tag, mensaje, opts = {}) {
  try {
    // 1. Guardar en Supabase
    //
    // **Se lee el error, y NO es una exención como se esperaba.** El argumento para eximirlo
    // sería la recursión —el registrador de errores registrando su propio fallo— y no aplica:
    // el log es pino a stdout, no vuelve a `registrarError`. El insert ya se `await`ea, así
    // que tampoco cuesta una espera nueva. Y lo que se pierde al descartarlo es caro de otra
    // forma: `errores` es la tabla donde se cruzan los stacks completos por timestamp cuando
    // algo se rompe en producción, o sea que un insert rechazado en silencio no deja "un
    // error sin registrar" — deja una tabla que dice que no pasó nada.
    const { error: errInsert } = await supabase.from('errores').insert({
      tag,
      mensaje: mensaje.substring(0, 500),
      detalle: opts.detalle ? String(opts.detalle).substring(0, 1000) : null,
      usuario_id: opts.usuarioId || null,
      whatsapp: opts.whatsapp || null,
      stack: opts.stack ? String(opts.stack).substring(0, 2000) : null,
    });
    if (errInsert) {
      log.error({ tag: 'MONITOR', errorTag: tag, err: errInsert.message }, 'No entró el error a la tabla errores');
    }

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
      const fecha = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
      // El alerta genérica rotula con el `tag`, que es el componente que REPORTÓ el error, no
      // el que está roto. Para el saldo de OpenAI esa distinción es la que decide si Favio lo
      // lee como "algo del correo" o como "está caído todo lo que usa IA", que es lo que es.
      const alertMsg = esOpenAISinCreditos(mensaje)
        ? '🔴 *OPENAI SIN CRÉDITOS*\n\n' +
          'La cuenta de OpenAI se quedó sin saldo.\n\n' +
          '⚠️ Esto NO es del componente que lo reportó (' + tag + '). Afecta *todo lo que usa ' +
          'IA*: registro por WhatsApp, audios, fotos de recibos, Excel y el escaneo de Gmail.\n\n' +
          '✅ Los gastos por WhatsApp que el parser sin IA logra leer se siguen guardando, ' +
          'pero caen en "Otros" sin categoría real.\n\n' +
          '👉 Recargar en https://platform.openai.com/settings/organization/billing/\n\n' +
          '🔄 *' + entry.count + ' fallos* en la última hora\n' +
          '_' + fecha + '_'
        : '🔴 *ALERTA CRITICA*\n\n' +
          '⚠️ Error repetitivo detectado:\n' +
          '📍 ' + tag + '\n' +
          '❌ ' + mensaje.substring(0, 150) + '\n' +
          '🔄 *' + entry.count + ' veces* en la última hora\n\n' +
          'Esto puede indicar un problema sistémico.\n' +
          '_' + fecha + '_';
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

/**
 * El mensaje de algo que se rechazó, sea o no un `Error`.
 *
 * `e.message` a secas es una bomba dentro de un `catch`: si el rechazo no es un Error
 * (`throw null`, un `Promise.reject()` sin argumento, un `throw 'texto'`), el propio catch tira
 * `TypeError` y se lleva puesto TODO lo que venía después dentro de ese catch — el rescate del
 * gasto, el aviso al admin, el resto del loop. El peor caso, causado por el manejo del peor caso.
 *
 * El repo ya lo pagó tres veces con el mismo diagnóstico (`services/account-deletion.js`, que se
 * llevaba puesto el borrado entero; `handlers/message-processor.js`; y los catches de los crons).
 * Vive acá porque es parte de registrar un error, y para que el próximo no lo reescriba a mano.
 */
const msgErr = (e) => (e && e.message) || String(e);

module.exports = { registrarError, limpiarContadores, msgErr, esOpenAISinCreditos };
