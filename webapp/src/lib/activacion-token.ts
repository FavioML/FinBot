import crypto from 'node:crypto';

// Espejo TS de lib/activacion.js (backend). El backend firma el token y lo manda
// por WhatsApp; la webapp lo verifica acá, sin hop de red, con el mismo secreto
// compartido (ACTIVATION_TOKEN_SECRET en Railway y en Vercel).
//
// Si tocas el formato del token, tocá los DOS lados: un desajuste no rompe nada
// visible, solo hace que todos los links de activación dejen de funcionar en
// silencio (y el usuario cae al login normal, que es el peor final posible acá).

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenSecret(): string {
  return process.env.ACTIVATION_TOKEN_SECRET || '';
}

function firmar(payloadB64: string): string {
  return crypto.createHmac('sha256', tokenSecret()).update(payloadB64).digest('base64url');
}

export type TokenActivacion = { uid: string; ts: number };

/**
 * Verifica firma y vigencia. Devuelve null ante cualquier duda — nunca adivina
 * el usuario. Es la única puerta entre "alguien abrió un link" y "vinculamos una
 * cuenta", así que falla cerrada.
 */
export function verificarTokenActivacion(token: string | null | undefined): TokenActivacion | null {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  if (!tokenSecret()) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(firmar(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const { uid, ts } = obj as Partial<TokenActivacion>;
  if (!uid || typeof uid !== 'string') return null;
  if (!ts || typeof ts !== 'number' || Date.now() - ts > TOKEN_TTL_MS) return null;
  return { uid, ts };
}
