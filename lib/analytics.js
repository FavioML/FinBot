// PostHog server-side analytics (singleton).
//
// Captura eventos de activación del flujo WhatsApp para que el funnel de
// PostHog stitchee landing -> WhatsApp -> webapp por usuario.id.
//
// Reglas:
// - No-op si falta POSTHOG_KEY (no rompe prod ni tests sin la env var).
// - Nunca lanza: analytics jamas debe romper el flujo del bot.
// - Lazy init: posthog-node solo se carga la primera vez que se captura.
const log = require('./logger');

let client = null;
let initTried = false;

function getClient() {
  if (initTried) return client;
  initTried = true;
  const key = process.env.POSTHOG_KEY;
  if (!key) {
    log.warn({ tag: 'ANALYTICS' }, 'POSTHOG_KEY no configurado — analytics server-side deshabilitado');
    return null;
  }
  try {
    const { PostHog } = require('posthog-node');
    client = new PostHog(key, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      // Volumen bajo (webhook bot): enviar de inmediato para no perder
      // eventos de activación si Railway reinicia el proceso.
      flushAt: 1,
      flushInterval: 10000,
    });
  } catch (e) {
    log.error({ tag: 'ANALYTICS', err: e.message }, 'No se pudo iniciar PostHog server-side');
    client = null;
  }
  return client;
}

// capture(distinctId, event, properties)
// properties puede incluir { $set: {...} } para setear propiedades de persona.
function capture(distinctId, event, properties) {
  try {
    const c = getClient();
    if (!c || !distinctId) return;
    c.capture({ distinctId: String(distinctId), event, properties: properties || {} });
  } catch (e) {
    log.warn({ tag: 'ANALYTICS', err: e.message, event }, 'capture falló');
  }
}

async function shutdown() {
  try {
    if (client) await client.shutdown();
  } catch (e) {}
}

module.exports = { capture, shutdown };
