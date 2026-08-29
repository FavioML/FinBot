// Canal de EMAIL transaccional. Hermano de `lib/whatsapp.js`: misma forma de resultado, mismo
// contrato best-effort (nunca lanza), misma fila en `notification_deliveries`.
//
// ─── Por qué existe, medido y no supuesto ────────────────────────────────────────────────
//
// El canal de WhatsApp no entrega. Sobre 30 días al 27-ago-2026, en toda la tabla:
// **556 `sent`, 67 entregados, 459 fallidos por callback**, y **452 de esos 459 son el
// código 131047** — la ventana de servicio de 24h de Meta. O sea que el aviso proactivo le
// llega a quien escribió hoy y a nadie más.
//
// Y sobre la población que de verdad importa, el email cubre MÁS que WhatsApp. Los 12
// usuarios que recibieron un aviso de plata (`deuda` + `alerta_presupuesto`) en 30 días:
// **12 de 12 tienen email, 11 de 12 tienen número, 0 son solo-WhatsApp**. En el padrón vivo
// (126 al 27-ago): 104 con email, 112 con número, 14 solo email, 22 solo WhatsApp.
//
// ─── Por qué NO son plantillas de Meta ───────────────────────────────────────────────────
//
// Porque la plantilla sirve exactamente para el caso que se cobra. Meta no cobra la utility
// entregada DENTRO de una ventana abierta, pero dentro de la ventana no hace falta plantilla:
// el texto libre ya funciona. Fuera de la ventana es donde la plantilla sirve, y ahí se paga.
// La medición del experimento de trial (1 entregado de 29, ver docs/whatsapp-templates.md)
// cerró la discusión: se pagaría por alcanzar a quien no está usando el producto.
//
// ─── Por qué Resend y no Brevo ───────────────────────────────────────────────────────────
//
// Brevo en este workspace es la herramienta de outbound FRÍO de Vortik. Mandar "tu deuda vence
// mañana" por la misma reputación de dominio que las campañas en frío es cambiar entregabilidad
// transaccional por nada. Además el argumento de "Brevo ya está configurado en neto.pe" es
// falso, y se verificó contra el DNS real: el SPF de neto.pe es
// `v=spf1 include:_spf.mx.cloudflare.net ~all` (solo entrada), `mail._domainkey.neto.pe` NO
// existe, y de Brevo solo hay un `brevo-code` de verificación y el `rua=` del DMARC. O sea que
// Brevo hoy tampoco puede firmar un correo de neto.pe: los dos proveedores piden el mismo
// trabajo de DNS. La implementación de referencia es `products/App de Baile/lib/email.ts`.
//
// ─── Lo que este archivo NO copia de esa referencia ──────────────────────────────────────
//
// Danzio loguea a consola y se acabó. Acá eso sería repetir el hallazgo B23 con otro
// proveedor: "Resend aceptó el POST" NO es entrega, igual que "Meta aceptó" no lo era. Por eso
// cada envío deja su fila en `notification_deliveries` con `canal='email'`, y `delivered_at` /
// `failed_at` los escribe el WEBHOOK de Resend (ver `routes/public.js`), nunca el POST.
//
// ─── Sin SDK a propósito ─────────────────────────────────────────────────────────────────
//
// Un POST con `fetch` es toda la superficie que se usa de Resend, y `enviarWhatsapp` ya habla
// con Graph exactamente así. Agregar `resend` como dependencia sería traer un cliente entero
// para una llamada, con su cadena de transitivas, en el backend que corre los crons.

const crypto = require('crypto');
const log = require('./logger');
const { supabase } = require('./db');
const { registrarEntrega } = require('./notification-deliveries');
const { WEBAPP_URL } = require('./constants');
const { hoyPeru } = require('./dates');

const CANAL = 'email';
const API_URL = 'https://api.resend.com/emails';

/**
 * Tope de correos REALES por persona y por día.
 *
 * El envío es por evento, no por persona: el cron de deudas recorre deuda por deuda, así que
 * alguien con varias venciendo el mismo día recibe varios correos separados esa mañana. Hoy el
 * techo medido es 7 (un usuario con 7 deudas abiertas, sobre 11 que tienen alguna), y ya hay
 * DOS emisores de correo — el cron de deudas y el respaldo de soporte.
 *
 * **El arreglo de fondo no es este tope, es agrupar por persona**, y este número no lo
 * reemplaza: lo acota mientras tanto. 5 se eligió para que ninguna de las carteras reales de
 * hoy lo toque salvo la extrema, en vez de por gusto.
 *
 * Lo que hace tolerable suprimir un aviso: el tope es SOLO del correo. La campana in-app y el
 * WhatsApp del mismo aviso salen igual, así que a nadie se le oculta una deuda — se le evita
 * una bandeja con cinco correos del mismo producto la misma mañana.
 *
 * Cuentan sólo los `sent`: un `skipped_*` no llegó a ninguna bandeja y no debe gastar cupo.
 */
const TOPE_DIARIO_POR_USUARIO = 5;

/**
 * ¿Este usuario ya llegó al tope de hoy?
 *
 * **Falla ABIERTO a propósito**, y es la diferencia con el fail-closed del link de baja. Acá el
 * peor caso de equivocarse hacia el envío es un correo de más; el de equivocarse hacia el
 * silencio es que un hipo de PostgREST apague el canal entero sin que nadie se entere. El
 * mismo razonamiento por el que el chokepoint NO lleva esta consulta (ver `notificarUsuario`).
 *
 * El día es el de Lima, no UTC: a las 19:00 de Lima ya es el día siguiente en UTC, y el tope se
 * reiniciaría a mitad de la tarde.
 */
async function llegoAlTopeDiario(usuarioId) {
  if (!usuarioId) return false;
  const inicioDiaLima = new Date(hoyPeru() + 'T00:00:00-05:00').toISOString();
  const { count, error } = await supabase.from('notification_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', usuarioId).eq('canal', CANAL).eq('estado', 'sent')
    .gte('created_at', inicioDiaLima);
  // supabase-js no lanza: sin leer el `{ error }`, un 5xx deja `count` en null, `null >= 5` es
  // false, y el fallo se leería como "no llegó al tope". Da el mismo resultado que el
  // fail-open deliberado, pero por accidente y sin dejar rastro de que la lectura falló.
  if (error) {
    log.warn({ tag: 'EMAIL', usuarioId, err: error.message },
      'No se pudo contar el tope diario: se manda igual (fail open)');
    return false;
  }
  return (count || 0) >= TOPE_DIARIO_POR_USUARIO;
}

/** El backend, que es quien sirve la ruta de baja. La webapp vive en otro host. */
const API_URL_PUBLICA = process.env.API_PUBLIC_URL || 'https://api.neto.pe';

/**
 * Remitente. `hola@neto.pe` es la dirección que Favio ya usa con los clientes y la que
 * Cloudflare Email Routing entrega. Configurable por env para poder cambiarla sin deploy.
 */
function remitente() {
  return process.env.RESEND_FROM || 'Neto <hola@neto.pe>';
}

// ── Baja de recordatorios ────────────────────────────────────────────────────────────────
//
// Molde exacto de `lib/activacion.js` (payload base64url + HMAC-SHA256 + timingSafeEqual), y
// por la misma razón: el link viaja fuera de toda sesión y tiene que ser infalsificable sin
// una tabla nueva.
//
// SIN TTL, a diferencia del de activación. Un token de baja vencido es un correo del que no se
// puede salir, y eso es exactamente lo que convierte un transaccional legítimo en algo
// indefendible. Un correo de hace ocho meses tiene que seguir teniendo salida.
//
// Secreto propio y sin fallback: si falta, no se emite link — y `enviarEmail` NO manda el
// correo. Fail closed. Un correo sin salida es peor que un correo que no salió.
function secretoBaja() {
  return process.env.EMAIL_OPTOUT_SECRET || '';
}

function firmarBaja(payloadB64) {
  return crypto.createHmac('sha256', secretoBaja()).update(payloadB64).digest('base64url');
}

/**
 * Token de baja de recordatorios para un usuario.
 * @returns {string|null} null si no hay secreto configurado
 */
function construirTokenBaja(usuarioId) {
  if (!usuarioId || !secretoBaja()) return null;
  const payload = Buffer.from(JSON.stringify({ uid: usuarioId })).toString('base64url');
  return payload + '.' + firmarBaja(payload);
}

/** URL absoluta de baja. La sirve `routes/public.js`, por GET y por POST (one-click). */
function construirLinkBaja(usuarioId) {
  const token = construirTokenBaja(usuarioId);
  return token ? API_URL_PUBLICA + '/baja-recordatorios?t=' + token : null;
}

/**
 * Verifica firma. Espejo de `verificarTokenActivacion`: nunca adivina el usuario, devuelve
 * null ante cualquier duda. Sin chequeo de vigencia, ver arriba.
 * @returns {{uid: string}|null}
 */
function verificarTokenBaja(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  if (!secretoBaja()) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(firmarBaja(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!obj || typeof obj !== 'object' || !obj.uid) return null;
  return obj;
}

// ── Usuario de prueba ────────────────────────────────────────────────────────────────────
//
// Mismo gesto que `isTestUser` en whatsapp.js y por el mismo motivo: los harness de QA corren
// contra usuarios reales de la tabla, y sin esto una corrida de `qa-e2e` manda correo de
// verdad. Cachea 5 min como el hermano, keyeado por id en vez de por número.
const TEST_USER_TTL_MS = 5 * 60 * 1000;
const testUserCache = new Map();

async function esUsuarioDePrueba(usuarioId) {
  if (!usuarioId) return false;
  const cached = testUserCache.get(usuarioId);
  if (cached && cached.expiresAt > Date.now()) return cached.isTest;
  try {
    const { data, error } = await supabase.from('usuarios')
      .select('is_test_user').eq('id', usuarioId).maybeSingle();
    // supabase-js NO lanza: sin leer el `{ error }`, un 5xx de PostgREST deja `data` en null,
    // `isTest` en false — y lo CACHEA cinco minutos. Ahí está la diferencia que importa: el
    // fail-open es una decisión por llamada, no una que se toma una vez y se sostiene un rato
    // largo. Con la fila cacheada, un hipo de lectura le manda correo real a la cuenta de QA
    // durante toda la ventana, sin volver a preguntar.
    //
    // Ojo con el catch de abajo: cubre la EXCEPCIÓN (red caída, cliente roto), que es otra
    // rama. Un test que solo mockea `throw` no ejercita ésta, que es el modo de falla real.
    if (error) {
      log.warn({ tag: 'EMAIL', usuarioId, err: error.message },
        'No se pudo leer is_test_user: se asume real y NO se cachea');
      return false;
    }
    const isTest = data?.is_test_user === true;
    testUserCache.set(usuarioId, { isTest, expiresAt: Date.now() + TEST_USER_TTL_MS });
    return isTest;
  } catch (e) {
    // Fail open, igual que el hermano: nunca silenciar a un usuario real por un hipo de la
    // lectura. El costo de equivocarse acá es un correo de más a una cuenta de prueba. Tampoco
    // se cachea, por el mismo motivo que arriba.
    log.warn({ tag: 'EMAIL', usuarioId, err: e.message }, 'is_test_user lanzó: se asume real');
    return false;
  }
}

// ── Plantilla ────────────────────────────────────────────────────────────────────────────

function escapar(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function urlAbsoluta(link) {
  if (!link) return null;
  return /^https?:/i.test(link) ? link : WEBAPP_URL + link;
}

/**
 * El HTML del correo. Deliberadamente pobre: tablas, estilos inline, sin imágenes remotas y
 * sin fuentes externas. Un correo bonito que cae en spam vale menos que uno sobrio que llega,
 * y un cliente de correo no comparte nada con un navegador.
 *
 * `link` es el mismo path relativo de la webapp que consume la campana in-app, así que acá se
 * absolutiza: un href relativo dentro de un correo no lleva a ningún lado.
 */
function construirHtml({ titulo, cuerpo, link, linkBaja }) {
  const href = urlAbsoluta(link);
  const boton = href
    ? '<tr><td style="padding:8px 0 4px">'
      + '<a href="' + escapar(href) + '" style="display:inline-block;background:#1D9E75;color:#ffffff;'
      + 'text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:15px">'
      + 'Ver en Neto</a></td></tr>'
    : '';
  const pie = linkBaja
    ? '<p style="margin:0;color:#8a8a80;font-size:12px;line-height:1.5">'
      + 'Te llega porque tienes los recordatorios de Neto activados. '
      + '<a href="' + escapar(linkBaja) + '" style="color:#8a8a80">Dejar de recibirlos</a>'
      + ' (se apagan en todos los canales, también en WhatsApp).</p>'
    : '';
  return '<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#f4f4f0">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f0">'
    + '<tr><td align="center" style="padding:28px 12px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
    + 'style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px;'
    + 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">'
    + '<tr><td style="padding-bottom:14px;color:#1D9E75;font-weight:700;font-size:17px">Neto</td></tr>'
    + '<tr><td style="font-size:19px;font-weight:600;color:#1a1a18;padding-bottom:10px">'
    + escapar(titulo) + '</td></tr>'
    + '<tr><td style="font-size:15px;line-height:1.6;color:#3a3a36;padding-bottom:14px">'
    + escapar(cuerpo).replace(/\n/g, '<br>') + '</td></tr>'
    + boton
    + '<tr><td style="padding-top:22px;border-top:1px solid #e8e8e2">' + pie + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

/** El plano. No es opcional: un correo solo-HTML puntúa peor en cualquier filtro de spam. */
function construirTexto({ titulo, cuerpo, link, linkBaja }) {
  const href = urlAbsoluta(link);
  return titulo + '\n\n' + cuerpo
    + (href ? '\n\nVer en Neto: ' + href : '')
    + (linkBaja ? '\n\n---\nTe llega porque tienes los recordatorios de Neto activados.\n'
        + 'Dejar de recibirlos (todos los canales, también WhatsApp): ' + linkBaja : '');
}

// ── Envío ────────────────────────────────────────────────────────────────────────────────

/**
 * Manda un correo transaccional. Best-effort absoluto: NUNCA lanza.
 *
 * Toda salida deja fila en `notification_deliveries` cuando hay `tipo`, incluidos los no-ops.
 * Eso es a propósito: un `skipped_sin_proveedor` es la diferencia entre "el canal está
 * apagado" y "el canal no se llamó", y desde afuera esos dos se ven igual.
 *
 * @param {string} to             destino. `null` es válido y esperado (usuario sin email).
 * @param {object} o
 * @param {string} o.asunto       subject.
 * @param {string} o.titulo       encabezado dentro del correo.
 * @param {string} o.cuerpo       texto del correo (plano; se escapa y se convierte a HTML).
 * @param {string} [o.link]       path de la webapp o URL absoluta.
 * @param {string} [o.usuarioId]  para el ledger y para el link de baja.
 * @param {string} [o.tipo]       slug de observabilidad. Sin él no se registra entrega.
 * @returns {Promise<{ok:boolean, code?:number, error?:string, msgId?:string, skipped?:string}>}
 */
async function enviarEmail(to, { asunto, titulo, cuerpo, link = null, usuarioId = null, tipo = null } = {}) {
  if (!to) {
    await registrarEntrega({ usuarioId, tipo, canal: CANAL, estado: 'skipped_no_email' });
    return { ok: false, skipped: 'no_email' };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Pre-verificación de dominio: el canal está cableado pero apagado. No es un error y no
    // se loguea como tal — pero SÍ deja rastro, que es lo que permite verificar post-deploy
    // que el camino se recorre antes de que exista la key.
    log.info({ tag: 'EMAIL', tipo, usuarioId }, 'RESEND_API_KEY ausente: canal email apagado');
    await registrarEntrega({ usuarioId, tipo, canal: CANAL, estado: 'skipped_sin_proveedor' });
    return { ok: false, skipped: 'sin_proveedor' };
  }
  try {
    if (await esUsuarioDePrueba(usuarioId)) {
      log.info({ tag: 'EMAIL', tipo, usuarioId }, 'Skip envío (is_test_user)');
      await registrarEntrega({ usuarioId, tipo, canal: CANAL, estado: 'skipped_test' });
      return { ok: true, skipped: 'test_user' };
    }

    // Después del test user (para que QA no gaste cupo) y antes de armar el correo: si no se
    // va a mandar, no tiene sentido pagar el HTML ni el link firmado.
    if (await llegoAlTopeDiario(usuarioId)) {
      log.warn({ tag: 'EMAIL', tipo, usuarioId, tope: TOPE_DIARIO_POR_USUARIO },
        'Tope diario de correo alcanzado: no se manda (in-app y WhatsApp salen igual)');
      await registrarEntrega({ usuarioId, tipo, canal: CANAL, estado: 'skipped_tope_diario' });
      return { ok: false, skipped: 'tope_diario' };
    }

    const linkBaja = construirLinkBaja(usuarioId);
    if (usuarioId && !linkBaja) {
      // Fail closed. Un recordatorio sin salida es lo que convierte esto en algo que no se
      // puede defender, así que la falta del secreto apaga el canal en vez de degradarlo.
      log.error({ tag: 'EMAIL', tipo, usuarioId },
        'EMAIL_OPTOUT_SECRET ausente: no se manda un recordatorio sin link de baja');
      await registrarEntrega({ usuarioId, tipo, canal: CANAL, estado: 'skipped_sin_baja' });
      return { ok: false, skipped: 'sin_link_baja' };
    }

    const payload = {
      from: remitente(),
      to: [to],
      subject: asunto,
      html: construirHtml({ titulo, cuerpo, link, linkBaja }),
      text: construirTexto({ titulo, cuerpo, link, linkBaja }),
    };
    if (linkBaja) {
      // Los dos headers van juntos o el one-click no aplica. Gmail y Outlook muestran su
      // propio botón de baja cuando están, y que alguien lo use cuenta MUCHO mejor para la
      // reputación del dominio que el mismo alguien marcando "spam".
      payload.headers = {
        'List-Unsubscribe': '<' + linkBaja + '>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }

    // `AbortSignal.timeout` por el mismo motivo que en `enviarWhatsapp` (hallazgo B22): el
    // default de fetch es no tener timeout, y este await está dentro del bucle de un cron.
    const res = await fetch(API_URL, {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data && data.id) {
      // `sent` es "Resend aceptó", NO "llegó". El veredicto lo escribe el webhook sobre esta
      // misma fila, cruzando por este id. Ver el hallazgo B23.
      log.info({ tag: 'EMAIL', tipo, usuarioId, msgId: data.id }, 'Enviado');
      await registrarEntrega({ usuarioId, tipo, canal: CANAL, estado: 'sent', wamid: data.id });
      return { ok: true, msgId: data.id };
    }

    const errMsg = (data && (data.message || data.name)) || ('HTTP ' + res.status);
    log.error({ tag: 'EMAIL', tipo, usuarioId, status: res.status, err: errMsg }, 'Error enviando');
    await registrarEntrega({
      usuarioId, tipo, canal: CANAL, estado: 'error', code: res.status, error: errMsg,
    });
    return { ok: false, code: res.status, error: errMsg };
  } catch (e) {
    log.error({ tag: 'EMAIL', tipo, usuarioId, err: e.message }, 'Error enviando email');
    await registrarEntrega({ usuarioId, tipo, canal: CANAL, estado: 'error', error: e.message });
    return { ok: false, code: null, error: e.message };
  }
}

module.exports = {
  enviarEmail, CANAL_EMAIL: CANAL,
  construirLinkBaja, verificarTokenBaja, construirTokenBaja,
  construirHtml, construirTexto,
};
