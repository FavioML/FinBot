const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { oauth2Client, obtenerPerfilGoogle, guardarTokens, verificarState } = require('../gmail');
const { esProPagado } = require('../lib/trial');
const { parsearCorreoBancario } = require('../services/parsers');
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
  const origenConexion = stateObj.origen || null;
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
    // El modo NO se pasa: la exclusividad de una cuenta por usuario la impone guardarTokens
    // sin mirarlo, para que no dependa de un parámetro que viaja en un state de 7 días.
    await guardarTokens(usuario.id, tokens, emailConectado);
    if (perfil.nombre || emailConectado) {
      const updateUser = { nombre: usuario.nombre || perfil.nombre };
      if (!usuario.email && emailConectado) updateUser.email = emailConectado;
      await supabase.from('usuarios').update(updateUser).eq('id', usuario.id);
      usuario.nombre = usuario.nombre || perfil.nombre;
    }

    const nombre = usuario.nombre ? ', ' + usuario.nombre : '';
    const emailMsg = emailConectado ? ' (' + emailConectado + ')' : '';
    // Origen 'web' (conexión iniciada desde la webapp): redirigir de vuelta al dashboard.
    // El escaneo asíncrono de abajo corre igual.
    if (origenConexion === 'web') {
      res.redirect('https://app.neto.pe/dashboard?gmail=conectado');
    } else {
      res.send('<html><body style="font-family:Arial;text-align:center;padding:50px;background:#0d1b2a;color:white"><h1 style="color:#4CAF50">Gmail conectado' + nombre + '!</h1><p style="font-size:18px">' + emailMsg + '</p><p>Vuelve a WhatsApp, el bot te escribira en un momento.</p></body></html>');
    }
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

// POST /test-parser — admin tool to test email parser
router.post('/test-parser', async (req, res) => {
  const { correo, clave } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (!ADMIN_KEY || !clave || clave.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(ADMIN_KEY))) return res.status(401).json({ error: 'No autorizado' });
  if (!correo) return res.status(400).json({ error: 'Falta correo' });
  try { const r = await parsearCorreoBancario(correo); res.json({ ok: true, resultado: r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET / — root
router.get('/', (req, res) => res.send('NETO v5'));

module.exports = router;
