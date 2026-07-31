// Activación de cuenta: el puente WhatsApp → webapp con el número YA identificado.
//
// El puente que existía era el inverso (web → WhatsApp, código NETO-XXXXXX de
// migrations/020): servía a quien ya estaba logueado en app.neto.pe. Para quien
// nace en WhatsApp ese camino obliga a dictar un email y a copiar un código, y
// ahí se cae la gente (baseline 2026-07-31: 7 usuarios trabados en el paso del
// email, 0 de 18 sin webapp llegan al día 31).
//
// Acá el número viaja firmado dentro del link, así que el usuario solo toca
// "Continuar con Google": ni email dictado ni OTP. El link NO abre sesión por sí
// solo — eso convertiría cualquier reenvío del chat en un takeover — sino que
// lleva la identidad para que auth/callback vincule sin preguntar nada.
//
// Molde del token: el state OAuth de gmail.js (payload base64url + HMAC-SHA256 +
// TTL + timingSafeEqual). Sin tabla nueva: el "un solo uso" lo da el propio
// modelo de datos, porque el token solo hace algo si la fila todavía no tiene
// supabase_auth_id. Activada la cuenta, el token queda inerte.

const crypto = require('crypto');
const log = require('./logger');
const { WEBAPP_URL } = require('./constants');

// TTL generoso porque el link vive en un chat de WhatsApp y se abre cuando el
// usuario tiene ganas, no cuando lo mandamos. Además se re-emite en cada gasto,
// así que un token vencido siempre tiene un reemplazo a un mensaje de distancia.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Secreto DEDICADO y compartido con la webapp (Vercel lo verifica sin hop de red).
// Sin fallback a propósito: un fallback silencioso firmaría con un secreto que la
// webapp no conoce (links muertos) o, peor, reutilizaría un secreto de otro
// propósito. Si falta, no se emite link — fail closed, nunca un link forjable.
function tokenSecret() {
  return process.env.ACTIVATION_TOKEN_SECRET || '';
}

function firmar(payloadB64) {
  return crypto.createHmac('sha256', tokenSecret()).update(payloadB64).digest('base64url');
}

/**
 * Token de activación para un usuario. Payload mínimo: solo el id y el timestamp
 * (nada de número ni email — el link puede terminar en un screenshot).
 * @param {string} usuarioId
 * @returns {string|null} token, o null si no hay secreto configurado
 */
function construirTokenActivacion(usuarioId) {
  if (!usuarioId || !tokenSecret()) return null;
  const payload = Buffer.from(JSON.stringify({ uid: usuarioId, ts: Date.now() })).toString('base64url');
  return payload + '.' + firmar(payload);
}

/**
 * URL de activación lista para mandar por WhatsApp.
 * @returns {string|null} null si no se pudo firmar (el llamador simplemente no muestra link)
 */
function construirLinkActivacion(usuarioId) {
  const token = construirTokenActivacion(usuarioId);
  if (!token) {
    log.warn({ tag: 'ACTIVACION' }, 'ACTIVATION_TOKEN_SECRET no configurada — no se emite link de activación');
    return null;
  }
  return WEBAPP_URL + '/activar?t=' + token;
}

/**
 * Verifica firma y vigencia. Espejo exacto de verificarState (gmail.js): nunca
 * adivina el usuario, devuelve null ante cualquier duda.
 * @param {string} token
 * @returns {{uid: string, ts: number}|null}
 */
function verificarTokenActivacion(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  if (!tokenSecret()) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!payload || !sig) return null;
  const esperada = firmar(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!obj || typeof obj !== 'object' || !obj.uid) return null;
  if (!obj.ts || (Date.now() - obj.ts) > TOKEN_TTL_MS) return null;
  return obj;
}

// El corte: al tercer gasto el empujón deja de ser una línea al pie y pasa a ser
// un bloque con el porqué. NO hay gate — Neto sigue registrando igual. Lo que
// mata al usuario es que le cortemos el servicio, no que le insistamos.
const CORTE_TX = 3;

/**
 * Texto de empujón a la activación para pegar al final de una confirmación de
 * gasto. Función pura: decide solo con la fila del usuario y el conteo.
 * @param {object} usuario   fila de usuarios (necesita supabase_auth_id, id)
 * @param {number} conteoTx  cuántas transacciones tiene YA (incluyendo la recién guardada)
 * @returns {string|null} bloque a concatenar, o null si no corresponde empujar
 */
function nudgeActivacion(usuario, conteoTx) {
  if (!usuario || !usuario.id) return null;
  if (usuario.supabase_auth_id) return null;   // ya activó: nunca más
  if (!conteoTx || conteoTx < 1) return null;

  const link = construirLinkActivacion(usuario.id);
  if (!link) return null;

  if (conteoTx === 1) {
    // Primer gasto: puede que se haya saltado el nombre y no tenga ni saludo.
    return '\n\n─────\n👋 Ese es tu primer gasto en Neto.\n\nActiva tu cuenta y míralo en gráficos, con tu historial completo:\n' + link +
      '\n\n_Un toque, sin contraseñas._';
  }
  if (conteoTx < CORTE_TX) {
    return '\n\n👉 Activa tu cuenta para ver todo esto en tu dashboard:\n' + link;
  }
  return '\n\n─────\n📊 Ya llevas *' + conteoTx + ' gastos* registrados.\n\n' +
    'Activa tu cuenta y desbloquéalos: gráficos, presupuestos, historial y reportes. Además tu data queda respaldada si cambias de teléfono.\n\n' +
    link + '\n\n_Un toque con tu Google, sin contraseñas._';
}

/** Empujón proactivo del día 2 (cron). Mensaje completo, no un apéndice. */
function mensajeActivacionDia2(usuario, conteoTx) {
  const link = construirLinkActivacion(usuario.id);
  if (!link) return null;
  const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
  const cuantos = conteoTx === 1 ? 'tu primer gasto' : 'tus ' + conteoTx + ' gastos';
  return (primerNombre ? '👋 ' + primerNombre + ', y' : '👋 Y') + 'a tienes ' + cuantos + ' en Neto.\n\n' +
    'Actívalos en tu dashboard y míralos en gráficos, con presupuestos y tu historial completo:\n\n' + link +
    '\n\n_Un toque con tu Google. Toma 10 segundos._';
}

module.exports = {
  construirTokenActivacion,
  construirLinkActivacion,
  verificarTokenActivacion,
  nudgeActivacion,
  mensajeActivacionDia2,
  CORTE_TX,
  TOKEN_TTL_MS,
};
