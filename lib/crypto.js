const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY env var is required');
  // Key must be 32 bytes for AES-256
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt a plaintext string.
 * Returns base64-encoded string: iv:ciphertext:tag
 */
function encrypt(text) {
  if (!text) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + encrypted + ':' + tag.toString('base64');
}

/**
 * Decrypt a string encrypted by encrypt().
 * Input: base64-encoded string iv:ciphertext:tag
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  // Handle plaintext tokens (pre-encryption migration)
  if (!encryptedText.includes(':')) return encryptedText;
  const [ivB64, ciphertext, tagB64] = encryptedText.split(':');
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
