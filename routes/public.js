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
router.get('/', (req, res) => res.send('NETO v5'));

module.exports = router;
