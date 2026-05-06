const log = require('./logger');
const { supabase } = require('./db');

// Cache: phone (normalized) → { isTest: boolean, expiresAt: epoch_ms }
// 5 min TTL keeps Meta send latency stable while still picking up flag flips.
const TEST_USER_TTL_MS = 5 * 60 * 1000;
const testUserCache = new Map();

async function isTestUser(numero) {
  const dest = numero.replace(/^whatsapp:/i, '').replace(/^\+/, '');
  const cached = testUserCache.get(dest);
  if (cached && cached.expiresAt > Date.now()) return cached.isTest;
  try {
    const { data } = await supabase
      .from('usuarios')
      .select('is_test_user')
      .eq('whatsapp', dest)
      .maybeSingle();
    const isTest = data?.is_test_user === true;
    testUserCache.set(dest, { isTest, expiresAt: Date.now() + TEST_USER_TTL_MS });
    return isTest;
  } catch (e) {
    // Column may not exist yet (pre-migration) — fail open: never silence real users.
    return false;
  }
}

async function enviarWhatsapp(numero, mensaje) {
  try {
    if (await isTestUser(numero)) {
      log.info({ tag: 'META', dest: numero, len: mensaje.length }, 'Skip Meta send (is_test_user)');
      return;
    }
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_ACCESS_TOKEN;
    const dest = numero.replace(/^whatsapp:/i, '').replace(/^\+/, '');
    const response = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: dest, type: 'text', text: { body: mensaje } })
    });
    const data = await response.json();
    if (data.messages && data.messages[0]) { log.info({ tag: 'META', dest, msgId: data.messages[0].id }, 'Enviado'); }
    else { log.error({ tag: 'META', data }, 'Error enviando'); }
  } catch (e) { log.error({ tag: 'META', err: e.message }, 'Error enviando WhatsApp'); }
}

module.exports = { enviarWhatsapp };
