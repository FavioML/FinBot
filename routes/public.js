const express = require('express');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { oauth2Client, obtenerPerfilGoogle, guardarTokens, verificarState, emailGmailVinculado, esElMismoGmail } = require('../gmail');
const { esProPagado } = require('../lib/trial');
const { escanearGmailYRegistrar, escanearHistoricoInicial } = require('../services/gmail-scanner');
const analytics = require('../lib/analytics');

const router = express.Router();

const LANDING_URL = process.env.LANDING_URL || 'https://neto.pe';
const PANEL_PRO_URL = 'https://app.neto.pe/dashboard/pro';

// Estas páginas las ve un navegador después de un OAuth fallido, y conectar Gmail ahora
// empieza y termina en la webapp: mandarlo "de vuelta a WhatsApp" lo devolvía a un canal
// que ya no tiene botón de conectar.
const REINTENTAR = (titulo) =>
  '<h2>' + titulo + '</h2><p>Vuelve a <a href="' + PANEL_PRO_URL + '">app.neto.pe</a> e intenta conectar Gmail de nuevo.</p>';

// El email viene del perfil de Google, no de la query, pero igual es dato ajeno que termina
// dentro del HTML. Mismo criterio que el 400 de arriba, que a propósito no refleja req.query.
function escaparHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// GET /r/:code — legacy. Antes deep-linkeaba directo a WhatsApp; ahora funnelea por la
// mini-landing de bienvenida (neto.pe/r/:code), que muestra quién invita + la oferta y de
// ahí deep-linkea. Los links nuevos ya apuntan a neto.pe/r/:code; esto mantiene vivos los viejos.
router.get('/r/:code', async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return res.redirect(LANDING_URL);
  res.redirect(302, LANDING_URL + '/r/' + code);
});

// GET /api/referidor/:code — resuelve ref_code → primer nombre del referrer para la
// mini-landing (static export, la consume client-side). Público a propósito: SOLO devuelve
// el primer nombre, nada sensible (ni id, ni whatsapp, ni email). CORS ya permite neto.pe.
router.get('/api/referidor/:code', async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  res.set('Cache-Control', 'public, max-age=300');
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return res.status(404).json({ ok: false });
  const { data: referrer } = await supabase.from('usuarios').select('nombre').eq('ref_code', code).maybeSingle();
  if (!referrer) return res.status(404).json({ ok: false });
  const primerNombre = referrer.nombre ? String(referrer.nombre).split(' ')[0] : null;
  res.json({ ok: true, nombre: primerNombre });
});

// GET /auth/callback — OAuth2 callback de Gmail
router.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  // No reflejar req.query.error crudo en el HTML (XSS reflejado). Lo logueamos y mostramos texto fijo.
  if (error) { log.warn({ tag: 'OAUTH', code: String(error).slice(0, 60) }, 'Google devolvió error en el callback OAuth'); return res.status(400).send(REINTENTAR('No se pudo conectar Gmail.')); }
  if (!code) return res.status(400).send(REINTENTAR('No se recibió el código.'));
  // Verifica el state firmado (HMAC, ver gmail.js) ANTES de canjear el code: no gastamos
  // un token exchange en un callback forjado y NUNCA adivinamos el usuario. Sin esta guarda,
  // un state ausente/forjado permitía asignar los tokens de Gmail de la víctima a la cuenta
  // del atacante (robo de datos bancarios).
  const stateObj = verificarState(req.query.state);
  if (!stateObj) {
    log.warn({ tag: 'OAUTH' }, 'State OAuth ausente, inválido o vencido — callback abortado');
    return res.status(400).send(REINTENTAR('El enlace de conexión expiró o no es válido.'));
  }
  const whatsappNum = stateObj.num;
  const modoConexion = stateObj.modo || 'inicial';
  // `stateObj.origen` ya no se lee: el callback termina SIEMPRE en el dashboard (ver S′8
  // más abajo). Se sigue emitiendo en el state porque es lo que distinguía las dos ramas
  // y borrarlo del emisor invalidaría los enlaces en vuelo sin ganar nada.
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // Resolución por identidad primero (uid), con fallback al número. Un Pro web-only
    // no tiene whatsapp: sin uid, el callback no sabría a quién asignar el token y
    // devolvía 404 tras completar el OAuth. Los flujos WhatsApp no mandan uid y
    // siguen resolviéndose por num, sin cambios.
    const uid = stateObj.uid;
    let usuario = null;
    if (uid) { const { data } = await supabase.from('usuarios').select('*').eq('id', uid).single(); usuario = data; }
    if (!usuario && whatsappNum) { const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', whatsappNum).single(); usuario = data; }
    if (!usuario) return res.status(404).send(REINTENTAR('No se encontró tu cuenta.'));

    // ── El gate que de verdad protege el cupo ──────────────────────────────────
    // Gatear la EMISIÓN del link no alcanza: el state vive 7 días (STATE_TTL_MS en gmail.js,
    // generoso a propósito porque el link post-pago se abre horas o días después en el chat).
    // Un link emitido cuando el usuario todavía pagaba se canjea igual una semana más tarde.
    // El cupo de Google no se gasta al generar el enlace, se gasta acá. Por eso se revalida
    // contra la fila fresca — que además es lo que hace seguro NO gatear activarPro: cuando
    // llega acá, el UPDATE que lo dejó 'premium'/'convertido' ya está escrito.
    if (!esProPagado(usuario)) {
      log.warn({ tag: 'OAUTH', usuarioId: usuario.id, plan: usuario.plan, trialEstado: usuario.trial_estado },
        'Canje de OAuth rechazado: el usuario no es Pro pagado (link emitido antes del vencimiento)');
      return res.status(403).send('<h2>Este enlace ya no está activo.</h2><p>Conectar tu Gmail requiere Neto Pro activo. Actívalo en <a href="https://app.neto.pe/dashboard/pro">app.neto.pe</a> y te damos un enlace nuevo.</p>');
    }

    const perfil = await obtenerPerfilGoogle(oauth2Client);
    const emailConectado = perfil.email;

    // ── Una cuenta de Gmail por usuario, para siempre ──────────────────────────
    // Cada cuenta de Google DISTINTA consume otro de los 100 cupos de por vida, así que un
    // usuario no puede tener dos: sería gastar dos cupos permanentes por un pago de S/10.
    //
    // Se compara contra el historial (`emailGmailVinculado` mira también las filas inactivas):
    // una cuenta revocada ya gastó su cupo, y revocar no lo devuelve. Reconectar el MISMO
    // correo pasa siempre — es el caso de `invalid_grant` y no cuesta cupo.
    //
    // Honestidad sobre el alcance: cuando llegamos acá el usuario YA aprobó en Google, o sea
    // que el cupo de esta cuenta nueva ya se gastó y este rechazo no lo recupera. Lo que
    // garantiza es que nadie termine con dos cuentas leyendo, y suelta el permiso en el acto
    // en vez de quedarnos con acceso a un buzón que no vamos a usar. La defensa que sí evita
    // el gasto es el `login_hint` de la emisión.
    // Desde la migración 073 la comparación es por HASH, no por el correo en claro. El motivo
    // es el borrado de cuenta: la lápida conserva la fila de `gmail_cuentas` con `email` en
    // null y `email_hash` puesto, justamente para que este gate siga funcionando sin que
    // retengamos la dirección. Comparar el correo acá vería null, concluiría "nunca vinculó
    // nada" y dejaría quemar otro cupo permanente a quien se dio de baja y volvió.
    //
    // `esElMismoGmail` devuelve tres valores y los tres se usan: true (mismo correo, pasa),
    // false (otro correo) y **null = no sé** — que solo ocurre con una fila previa sin hash
    // NI correo, o sea alguien que ya gastó un cupo y no podemos identificar. Se trata como
    // rechazo (`!== true`) a propósito: acá el fallo seguro es no dejar pasar. Que NO haya
    // fila previa es otra cosa y se filtra antes, con `previo &&`: esa es la primera conexión.
    const previo = await emailGmailVinculado(usuario.id);
    if (previo && emailConectado && esElMismoGmail(previo, emailConectado) !== true) {
      log.warn({ tag: 'OAUTH', usuarioId: usuario.id, teniaCorreo: !!previo.email, teniaHash: !!previo.emailHash, emailConectado },
        'Canje rechazado: el usuario ya tiene un Gmail vinculado y autorizó con otro (cupo gastado, se revoca)');
      try { await oauth2Client.revokeToken(tokens.refresh_token || tokens.access_token); }
      catch (e) { log.warn({ tag: 'OAUTH', err: e.message }, 'No se pudo revocar el grant sobrante'); }
      // Solo se nombra la cuenta previa si todavía la tenemos. Después de una baja no la
      // tenemos —y ese es el punto— así que ahí el texto manda a soporte, que es el único
      // camino que puede resolverlo.
      //
      // Son DOS `send` y no un ternario adentro de uno: el guard S8
      // (`tests/gmail-oauth-gates.test.js`) marca como interpolación cruda cualquier
      // identificador que sobreviva a quitar los literales y los `escaparHtml`, y la
      // CONDICIÓN de un ternario sobrevive. Es un falso positivo, pero la respuesta correcta
      // a un guard estricto es escribir el código de forma que no necesite excepción, no
      // ablandar el guard — sobre todo uno que vigila HTML con datos ajenos.
      if (previo.email) {
        return res.status(409).send(
          '<h2>Neto lee de una sola cuenta.</h2>' +
          '<p>Tu cuenta vinculada es <b>' + escaparHtml(previo.email) + '</b>, y autorizaste con otra. ' +
          'Vuelve a <a href="' + PANEL_PRO_URL + '">app.neto.pe</a> y entra con esa misma cuenta.</p>' +
          '<p>Si necesitas cambiarla, escríbenos y lo hacemos nosotros.</p>');
      }
      return res.status(409).send(
        '<h2>Neto lee de una sola cuenta.</h2>' +
        '<p>Ya habías vinculado una cuenta de Google antes, y esta no es la misma.</p>' +
        '<p>Escríbenos y lo resolvemos contigo.</p>');
    }

    // El modo NO se pasa: la exclusividad la impone guardarTokens sin mirarlo, para que no
    // dependa de un parámetro que viaja en un state de 7 días.
    await guardarTokens(usuario.id, tokens, emailConectado);
    if (perfil.nombre || emailConectado) {
      const updateUser = { nombre: usuario.nombre || perfil.nombre };
      if (!usuario.email && emailConectado) updateUser.email = emailConectado;
      await supabase.from('usuarios').update(updateUser).eq('id', usuario.id);
      usuario.nombre = usuario.nombre || perfil.nombre;
    }

    // Siempre al dashboard. El escaneo asíncrono de abajo corre igual.
    //
    // ── S′8: acá había una rama que armaba HTML concatenando `usuario.nombre` ──────
    // Era self-XSS (hay que ponerse uno mismo un nombre con markup), pero `nombre` no es
    // un campo que el producto controle: viene del perfil de Google o del onboarding por
    // WhatsApp. Se podía escapar. Lo correcto era **borrarla**, y eso se decidió midiendo,
    // no por gusto:
    //
    //   · `routes/pro.js` es el ÚNICO emisor de producción (guard:
    //     `tests/gmail-oauth-gates.test.js`, cero `generarUrlAutorizacion` en `handlers/`)
    //     y siempre pasa `origen: 'web'`.
    //   · Los enlaces viejos de las cinco puertas de WhatsApp murieron solos:
    //     web-only entró el 03-ago-2026 (`538bd64`) y `STATE_TTL_MS` son 7 días, así que
    //     el último state sin `origen` venció el 10-ago. `verificarState` los rechaza
    //     antes de llegar hasta acá.
    //   · Y no había nadie mirando igual: la última fila de `gmail_cuentas` es del
    //     12-jul-2026 (5 filas en toda la historia).
    //
    // O sea que la rama era código muerto que solo podía revivir si alguien vuelve a
    // emitir OAuth desde WhatsApp — y eso ya lo rompe el guard de las puertas.
    // Un usuario web-only no tiene WhatsApp al que "volver", que era lo que decía el HTML.
    res.redirect('https://app.neto.pe/dashboard?gmail=conectado');
    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : 'por ahi';

    setTimeout(async () => {
      try {
        // Ya no hay rama 'agregar': un usuario tiene UNA cuenta, así que conectar otra es
        // siempre un reemplazo. Los enlaces viejos que todavía lleven ese modo en su state
        // caen acá y se tratan como conexión normal — el reemplazo real ya lo hizo
        // guardarTokens, que no mira el modo.
        if (modoConexion === 'reemplazar') {
          await enviarWhatsapp(usuario.whatsapp, '🔄 *Cuenta Gmail actualizada, ' + primerNombre + '!*\n📧 ' + emailConectado + '\n\nEscaneando tus correos... 🔍');
        } else {
          await enviarWhatsapp(usuario.whatsapp, '✅ *Gmail conectado, ' + primerNombre + '!*\n📧 ' + emailConectado + '\n\nEscaneando tus correos bancarios... 🔍');
        }
        // Primera conexión de Gmail → barrido único de 30 días para poblar el dashboard.
        // El flag historico_importado evita repetirlo en cada reconexión.
        const debeHistorico = !usuario.historico_importado;
        const resultado = debeHistorico
          ? await escanearHistoricoInicial(usuario)
          : await escanearGmailYRegistrar(usuario);
        if (resultado && typeof resultado === 'string') {
          await enviarWhatsapp(usuario.whatsapp, resultado);
        }
        if (modoConexion === 'inicial') {
          await supabase.from('usuarios').update({ onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
          analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'gmail' });
          await new Promise(r => setTimeout(r, 1500));
          await enviarWhatsapp(usuario.whatsapp,
            '🎉 *¡Listo, ' + primerNombre + '!* Tu cuenta está activa.\n\n' +
            '📊 *Tu dashboard:* https://app.neto.pe\n' +
            'Ahí puedes ver gráficos, metas, reportes PDF y más.\n\n' +
            'Por WhatsApp escríbeme como quieras:\n' +
            '_"cuánto gasté esta semana"_\n' +
            '_"dame mi reporte"_\n\n' +
            'Te aviso cada vez que detecte un gasto nuevo. 🔔'
          );
        }
      } catch(e) { log.error({ tag: 'CALLBACK', err: e.message }, 'Error OAuth callback'); }
    }, 2000);
  } catch (err) { log.error({ tag: 'CALLBACK', err: err.message }, 'Error en OAuth callback'); res.status(500).send(REINTENTAR('Ocurrió un error al conectar Gmail.')); }
});

// `/test-parser` se MUDÓ a `routes/admin.js` (hallazgo S′9). Vivía acá y tenía las dos
// cosas que este archivo no puede dar: leía la ADMIN_KEY del **body** —que es justo lo que
// `verificarAdmin` prohíbe por escrito, porque el body queda en logs igual que el query
// string— y colgaba de `publicLimiter` (60/min por IP) en vez de `adminLimiter` (10/min).
// Un endpoint que acepta la llave del admin no pertenece al router público.

// GET / — root
// ═══════════════════════════════════════════════════════════════════════════════════════
// CANAL DE EMAIL — la salida y el veredicto de entrega
// ═══════════════════════════════════════════════════════════════════════════════════════

const PAGINA_BAJA = (titulo, cuerpo) =>
  '<!doctype html><html lang="es"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Neto</title></head>'
  + '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;'
  + 'background:#f4f4f0;margin:0;padding:48px 16px;color:#1a1a18">'
  + '<div style="max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">'
  + '<div style="color:#1D9E75;font-weight:700;margin-bottom:14px">Neto</div>'
  + '<h1 style="font-size:20px;margin:0 0 10px">' + titulo + '</h1>'
  + '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0">' + cuerpo + '</p>'
  + '</div></body></html>';

/**
 * Baja de recordatorios desde un correo. Sin sesión: la identidad viaja firmada en el token
 * (`lib/email.js`, molde de `lib/activacion.js`).
 *
 * **Apaga TODOS los canales, no solo el correo**, y el pie del email lo dice con esas palabras.
 * Es deliberado: `usuarios.recordatorios_activos` ya existe, ya lo respetan los crons y ya lo
 * expone la webapp. Un flag separado solo-email sería el mismo estado en dos lugares, que es
 * como se produce la divergencia — y dejaría a alguien que pidió no ser molestado recibiendo
 * WhatsApps. Lo que no se puede hacer es prometer una cosa y hacer otra; por eso el copy.
 *
 * ─── El GET NO muta, y no es purismo de HTTP ─────────────────────────────────────────────
 *
 * La primera versión daba de baja en el GET, y eso se dispara SOLO, sin que nadie clickee:
 * los escáneres de links corporativos (Outlook ATP Safe Links, Proofpoint, Mimecast) hacen un
 * GET a cada URL de un correo para verificarla, y los clientes que no honran
 * `List-Unsubscribe-Post` también hacen GET sobre la URL del header. Cualquiera de esos apaga
 * los recordatorios de una persona que nunca pidió nada — **y como esto apaga también
 * WhatsApp, la deja en silencio total**. El rastro que queda es indistinguible de una baja
 * real, así que ni siquiera se puede deshacer con confianza.
 *
 * Por eso: **GET muestra una confirmación, POST ejecuta.** Es lo que pide RFC 8058 para el
 * one-click, y de paso lo que hace que el botón nativo de Gmail y Outlook siga funcionando:
 * ese manda POST, que sigue siendo un solo paso para el usuario.
 */
function paginaConfirmarBaja(token) {
  return PAGINA_BAJA('¿Dejar de recibir recordatorios?',
    'Se apagan los recordatorios de Neto en todos los canales, también en WhatsApp. '
    + 'Puedes volver a prenderlos cuando quieras desde Configuración en app.neto.pe.'
    + '<form method="POST" action="/baja-recordatorios" style="margin-top:20px">'
    + '<input type="hidden" name="t" value="' + escaparHtml(token) + '">'
    + '<button type="submit" style="background:#1D9E75;color:#fff;border:0;padding:12px 22px;'
    + 'border-radius:8px;font-weight:600;font-size:15px;cursor:pointer">Sí, dejar de recibirlos'
    + '</button></form>');
}

async function bajaRecordatorios(req, res) {
  const { verificarTokenBaja } = require('../lib/email');
  const token = req.query.t || (req.body && req.body.t);
  const payload = verificarTokenBaja(token);
  if (!payload) {
    // No se distingue "token mal firmado" de "secreto ausente" en la respuesta: las dos son
    // 400 y el mismo texto. Decir cuál es le confirma a quien prueba firmas si el problema
    // era la firma o la configuración.
    log.warn({ tag: 'EMAIL_BAJA' }, 'Token de baja inválido');
    return res.status(400).send(PAGINA_BAJA('No pudimos procesar el enlace',
      'El enlace no es válido. Puedes apagar los recordatorios desde Configuración en app.neto.pe.'));
  }
  // El GET solo pregunta. Ver el docblock: un escáner de links haciendo GET no puede dejar a
  // nadie sin recordatorios.
  if (req.method === 'GET') return res.send(paginaConfirmarBaja(token));

  const { error } = await supabase.from('usuarios')
    .update({ recordatorios_activos: false }).eq('id', payload.uid);
  if (error) {
    // supabase-js NO lanza: sin leer el `{ error }` acá, un UPDATE rechazado (RLS, 5xx de
    // PostgREST) devolvería la misma página de "listo" que un éxito, y la persona seguiría
    // recibiendo correos después de haberse dado de baja. Ese es el peor fallo posible de
    // esta ruta, mucho peor que mostrar un error.
    log.error({ tag: 'EMAIL_BAJA', usuarioId: payload.uid, err: error.message },
      'No se pudo apagar los recordatorios: la baja NO quedó');
    return res.status(500).send(PAGINA_BAJA('No pudimos completar la baja',
      'Intenta de nuevo en unos minutos, o escríbenos a hola@neto.pe.'));
  }
  log.info({ tag: 'EMAIL_BAJA', usuarioId: payload.uid }, 'Recordatorios apagados desde correo');
  return res.send(PAGINA_BAJA('Listo, no te escribimos más',
    'Apagamos los recordatorios de Neto en todos los canales, también en WhatsApp. '
    + 'Puedes volver a prenderlos cuando quieras desde Configuración en app.neto.pe.'));
}
router.get('/baja-recordatorios', bajaRecordatorios);
router.post('/baja-recordatorios', bajaRecordatorios);

/**
 * Webhook de Resend: el ÚNICO que escribe `delivered_at` / `failed_at` del canal email.
 *
 * Existe por el hallazgo B23. Sin él, `estado='sent'` sería toda la instrumentación del canal
 * nuevo y volveríamos a reportar 100% de entrega sin saber nada — exactamente lo que pasó con
 * WhatsApp, donde 556 `sent` resultaron ser 67 entregados. Es el hermano de `procesarStatuses`
 * (`lib/whatsapp.js`) y cruza por la misma columna (`wamid`, que guarda el id del proveedor).
 *
 * Firma verificada a mano con Svix (`svix-id.svix-timestamp.body`, HMAC-SHA256, secreto
 * base64 tras el prefijo `whsec_`). Sin el paquete `svix`: es una comparación de HMAC de
 * quince líneas y el repo ya la hace igual para el HMAC de Meta en `handlers/webhook.js`.
 */
async function resendWebhookHandler(req, res) {
  const crypto = require('crypto');
  const secreto = process.env.RESEND_WEBHOOK_SECRET;
  if (!secreto) {
    // Fail CLOSED. Un webhook sin verificar es una ruta anónima que escribe en la tabla que
    // decide qué se considera entregado: cualquiera podría marcar entregado lo que no llegó,
    // y el ledger dejaría de servir para lo único que sirve.
    log.error({ tag: 'EMAIL_HOOK' }, 'RESEND_WEBHOOK_SECRET ausente: se rechaza el callback');
    return res.sendStatus(503);
  }
  // `rawBody` lo puebla el `verify` de express.json() en index.js, y NO corre si el
  // Content-Type no es JSON. Sin bytes crudos no hay firma que comprobar — mismo chequeo
  // explícito que hace el webhook de Meta, y por el mismo motivo.
  if (!req.rawBody || req.rawBody.length === 0) {
    log.warn({ tag: 'EMAIL_HOOK' }, 'Callback sin rawBody');
    return res.sendStatus(400);
  }
  const id = req.get('svix-id');
  const ts = req.get('svix-timestamp');
  const firmas = req.get('svix-signature');
  if (!id || !ts || !firmas) return res.sendStatus(400);

  // Ventana de 5 minutos: sin esto, un callback capturado se puede reproducir para siempre.
  const edad = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(edad) || edad > 300) {
    log.warn({ tag: 'EMAIL_HOOK', edad }, 'Callback fuera de la ventana de tiempo');
    return res.sendStatus(400);
  }

  const clave = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
  const esperada = crypto.createHmac('sha256', clave)
    .update(id + '.' + ts + '.' + req.rawBody.toString('utf8')).digest('base64');
  // Svix manda una LISTA separada por espacios (`v1,firma v1,otra`) durante una rotación de
  // secreto. Comparar contra el header entero rechazaría los callbacks legítimos justo
  // mientras se rota, que es cuando menos se quiere perder el veredicto de entrega.
  const valida = String(firmas).split(' ').some((f) => {
    const parte = f.split(',')[1] || '';
    const a = Buffer.from(parte);
    const b = Buffer.from(esperada);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!valida) {
    log.warn({ tag: 'EMAIL_HOOK' }, 'Firma inválida');
    return res.sendStatus(401);
  }

  // Se responde 200 antes de tocar la base: Resend reintenta ante un no-2xx, y un reintento
  // no arregla un fallo de escritura nuestro — solo multiplica el trabajo. El log es el
  // rastro, igual que en el webhook de Meta.
  res.sendStatus(200);

  try {
    const evento = req.body || {};
    const msgId = evento.data && evento.data.email_id;
    if (!msgId) return;
    const ahora = new Date().toISOString();
    let patch = null;
    // `email.sent` se ignora: ya lo registró el POST. Lo que importa acá es el desenlace.
    // `delivered` es el único que confirma entrega; `bounced` y `complained` son fallos, y
    // `complained` (marcó spam) es además la señal más cara que existe para la reputación
    // del dominio, así que queda escrita y no solo logueada.
    if (evento.type === 'email.delivered') patch = { delivered_at: ahora };
    else if (evento.type === 'email.bounced') patch = { failed_at: ahora, error: 'bounced' };
    else if (evento.type === 'email.complained') patch = { failed_at: ahora, error: 'complained' };
    if (!patch) return;

    const { data, error } = await supabase.from('notification_deliveries')
      .update(patch).eq('wamid', msgId).eq('canal', 'email').select('id, tipo, usuario_id');
    // El `{ error }` se lee por la lección de `procesarStatuses`: con error, `data` viene null
    // y sin distinguir los dos casos un UPDATE rechazado se leería como "este callback no era
    // de un aviso nuestro" — o sea que `delivered_at` no se escribiría nunca y el canal
    // volvería a reportar solo lo que el proveedor aceptó.
    if (error) {
      log.error({ tag: 'EMAIL_HOOK', msgId, tipo: evento.type, err: error.message },
        'No se pudo actualizar la entrega del correo');
    } else if (!data || data.length === 0) {
      log.debug({ tag: 'EMAIL_HOOK', msgId, tipo: evento.type }, 'Callback sin fila de notificación');
    } else {
      log.info({ tag: 'EMAIL_HOOK', msgId, tipo: evento.type, usuarioId: data[0].usuario_id },
        'Entrega de correo actualizada');
    }
  } catch (e) {
    log.error({ tag: 'EMAIL_HOOK', err: e.message }, 'Error procesando callback de Resend');
  }
}

router.get('/', (req, res) => res.send('NETO v5'));

module.exports = router;
/**
 * El webhook NO cuelga de este router, y por eso se exporta aparte.
 *
 * `routes/public.js` se monta detrás de `publicLimiter` (60/min por IP, compartido con
 * `/auth/callback` y `/api/referidor`), que es el límite correcto para superficie de navegador
 * y el equivocado para callbacks de un proveedor: Svix entrega desde un pool chico de IPs y
 * manda al menos dos eventos por correo. Un 429 acá no se reintenta con éxito garantizado y lo
 * que se pierde es `delivered_at` — o sea justo la medición por la que existe este canal.
 *
 * `index.js` lo monta con `webhookLimiter` (1200/min), que ya existe con ese número por el
 * mismo motivo del lado de Meta: sus callbacks de status llegan en ráfaga.
 */
module.exports.resendWebhookHandler = resendWebhookHandler;
