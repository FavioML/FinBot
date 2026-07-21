const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { guardarMensaje } = require('../helpers/db-helpers');
const { activarPro, reclamarPagoPendiente } = require('../lib/pro-payment');
const { generarUrlAutorizacion } = require('../gmail');

const router = express.Router();

function verificarAdmin(req, res) {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  // Solo por header: nunca por query string ni body. La clave en query se filtra
  // a los access logs de Railway / Referer / historial de proxy; el body también
  // puede quedar en logs. Aceptamos `x-admin-key` o `Authorization: Bearer <key>`.
  const authHeader = req.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const clave = req.get('x-admin-key') || bearer || '';
  if (!ADMIN_KEY || !clave || clave.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(ADMIN_KEY))) {
    res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
    return false;
  }
  return true;
}

// POST /admin/activar — activar premium via web
router.post('/activar', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { whatsapp } = req.body;
  if (!whatsapp) return res.status(400).json({ ok: false, msg: 'Falta whatsapp' });
  const numero = whatsapp.replace(/\+/g, '').replace(/^0/, '');
  const { data: usuarioActivar } = await supabase.from('usuarios').select('*').eq('whatsapp', numero).single();
  if (!usuarioActivar) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });
  const hoy = new Date();
  const vence = new Date(hoy.getFullYear(), hoy.getMonth() + 1, hoy.getDate()).toISOString().split('T')[0];
  await supabase.from('usuarios').update({
    plan: 'premium', pago_pendiente: false,
    premium_desde: hoy.toISOString().split('T')[0], premium_vence: vence
  }).eq('id', usuarioActivar.id);
  await enviarWhatsapp(usuarioActivar.whatsapp,
    '\u2B50 *\u00a1Bienvenido a NETO Pro!*\n\n' +
    'Tu pago fue confirmado. Ya tienes acceso completo.\n\n' +
    '\u2705 Reportes PDF ilimitados\n\u2705 Resumen semanal automatico\n\u2705 Categorias personalizadas\n\n' +
    '_Gracias por confiar en NETO._ \uD83D\uDC9A'
  );
  res.json({ ok: true, msg: 'Premium activado para ' + (usuarioActivar.nombre || numero), vence });
});

// GET /admin/pendientes — ver pagos pendientes
router.get('/pendientes', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { data } = await supabase.from('usuarios').select('whatsapp, nombre, plan, pago_pendiente, pago_referencia, created_at').eq('pago_pendiente', true);
  res.json({ ok: true, pendientes: data || [] });
});

// POST /admin/aprobar-pago — aprueba un pago, activa Pro, registra en historial y notifica al usuario
// Body: { clave, usuario_id | whatsapp, tipo_plan }
router.post('/aprobar-pago', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  try {
    const { usuario_id, whatsapp, tipo_plan } = req.body;
    const tipoPlan = tipo_plan === 'anual' ? 'anual' : 'mensual';
    let query = supabase.from('usuarios').select('*');
    if (usuario_id) query = query.eq('id', usuario_id);
    else if (whatsapp) query = query.eq('whatsapp', String(whatsapp).replace(/\+/g, '').replace(/^0/, ''));
    else return res.status(400).json({ ok: false, msg: 'Falta usuario_id o whatsapp' });
    const { data: usuario } = await query.single();
    if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

    // Claim atómico del pago pendiente: cierra el doble-click en el panel. Si no hay
    // pendiente que reclamar (ya procesado / otro click ganó), respondemos idempotente
    // sin re-activar — así no se apila un mes extra. Las altas manuales sin pago van por /admin/activar.
    const claimed = await reclamarPagoPendiente({ usuarioId: usuario.id, aprobadoPor: 'admin:webapp' });
    if (!claimed) {
      return res.json({ ok: true, already: true, msg: 'El pago ya estaba procesado', premium_vence: usuario.premium_vence || null });
    }

    // Fuente única de verdad: activarPro (incluye "no acortar suscripción activa",
    // set completo de columnas, link OAuth, WhatsApp + notificación in-app).
    const { venceStr } = await activarPro({ usuario, tipoPlan, aprobadoPor: 'admin:webapp', pagoId: claimed.id });

    res.json({ ok: true, msg: 'Pago aprobado y Pro activado para ' + (usuario.nombre || usuario.whatsapp), premium_vence: venceStr });
  } catch (e) {
    log.error({ tag: 'APROBAR_PAGO', err: e.message }, 'Error aprobando pago');
    res.status(500).json({ ok: false, msg: 'Error aprobando pago' });
  }
});

// GET /admin/pagos?usuario_id= — historial de pagos de un usuario (constancia de suscripción)
router.get('/pagos', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  try {
    const usuarioId = req.query.usuario_id;
    let query = supabase.from('pagos').select('*').order('created_at', { ascending: false });
    if (usuarioId) query = query.eq('usuario_id', usuarioId);
    else query = query.limit(100);
    const { data: pagos } = await query;
    // Firmar URLs de comprobantes (bucket privado, 1h)
    for (const p of pagos || []) {
      if (p.comprobante_url) {
        const { data: signed } = await supabase.storage.from('comprobantes').createSignedUrl(p.comprobante_url, 3600);
        p.comprobante_signed_url = signed ? signed.signedUrl : null;
      }
    }
    res.json({ ok: true, pagos: pagos || [] });
  } catch (e) {
    log.error({ tag: 'ADMIN_PAGOS', err: e.message }, 'Error listando pagos');
    res.status(500).json({ ok: false, msg: 'Error listando pagos' });
  }
});

// GET /admin/usuarios — lista de usuarios registrados
router.get('/usuarios', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  try {
    const { data } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, email, plan, onboarding_completado, gmail_access_token, created_at, premium_vence, supabase_auth_id')
      .order('created_at', { ascending: false });
    const usuarios = (data || []).map(u => ({
      id: u.id,
      whatsapp: u.whatsapp,
      nombre: u.nombre,
      email: u.email,
      plan: u.plan || 'free',
      onboarding_completado: u.onboarding_completado,
      tiene_gmail: !!u.gmail_access_token,
      tiene_webapp: !!u.supabase_auth_id,
      premium_vence: u.premium_vence,
      created_at: u.created_at,
    }));
    res.json({ ok: true, total: usuarios.length, usuarios });
  } catch(e) {
    log.error({ tag: 'ADMIN_USUARIOS', err: e.message }, 'Error listando usuarios');
    res.status(500).json({ ok: false, msg: 'Error listando usuarios' });
  }
});

// GET /admin/stats — métricas de uso
router.get('/stats', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  try {
    const hoy = hoyPeru();
    const hace7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const hace30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const { data: allUsers } = await supabase.from('usuarios').select('id, plan, onboarding_completado, gmail_access_token, created_at');
    const totalUsuarios = (allUsers || []).length;
    const conGmail = (allUsers || []).filter(u => !!u.gmail_access_token).length;
    const modoManual = (allUsers || []).filter(u => u.onboarding_completado && !u.gmail_access_token).length;
    const premium = (allUsers || []).filter(u => u.plan === 'premium').length;
    const nuevos7d = (allUsers || []).filter(u => u.created_at >= hace7).length;

    const { count: txsHoy } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).eq('fecha', hoy);
    const { count: txs7d } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).gte('fecha', hace7);
    const { count: txs30d } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).gte('fecha', hace30);

    const { data: txsCat } = await supabase.from('transacciones').select('categoria, monto_pen').eq('tipo', 'gasto').gte('fecha', hace30);
    const porCat = {};
    (txsCat || []).forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || 0); });
    const topCategorias = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([cat, total]) => ({ categoria: cat, total: parseFloat(total.toFixed(2)) }));

    const { data: txsBanco } = await supabase.from('transacciones').select('banco').gte('fecha', hace30).not('banco', 'is', null);
    const porBanco = {};
    (txsBanco || []).forEach(t => { porBanco[t.banco] = (porBanco[t.banco] || 0) + 1; });
    const topBancos = Object.entries(porBanco).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([banco, count]) => ({ banco, transacciones: count }));

    res.json({
      ok: true,
      generado: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }),
      usuarios: { total: totalUsuarios, conGmail, modoManual, premium, nuevos7d },
      transacciones: { hoy: txsHoy || 0, ultimos7d: txs7d || 0, ultimos30d: txs30d || 0 },
      topCategorias,
      topBancos,
    });
  } catch(e) {
    log.error({ tag: 'ADMIN_STATS', err: e.message }, 'Error generando stats');
    res.status(500).json({ ok: false, msg: 'Error generando estadísticas' });
  }
});

// POST /admin/notify — enviar mensaje WhatsApp manual a un usuario
// Body: { clave, whatsapp, mensaje } | { clave, usuario_id, mensaje }
router.post('/notify', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  try {
    const { whatsapp, usuario_id, mensaje } = req.body;
    if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) {
      return res.status(400).json({ ok: false, msg: 'Falta mensaje' });
    }
    if (mensaje.length > 4000) {
      return res.status(400).json({ ok: false, msg: 'Mensaje supera 4000 caracteres' });
    }
    let numero = whatsapp;
    let nombre = null;
    let userId = usuario_id || null;
    if (userId && !numero) {
      const { data: u } = await supabase.from('usuarios').select('whatsapp, nombre').eq('id', userId).single();
      if (!u) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });
      numero = u.whatsapp;
      nombre = u.nombre;
    }
    if (!numero) return res.status(400).json({ ok: false, msg: 'Falta whatsapp o usuario_id' });
    numero = String(numero).replace(/\+/g, '').replace(/^0/, '');
    if (!/^\d{8,15}$/.test(numero)) {
      return res.status(400).json({ ok: false, msg: 'Numero whatsapp invalido' });
    }
    if (!userId) {
      const { data: u } = await supabase.from('usuarios').select('id, nombre').eq('whatsapp', numero).single();
      if (u) { userId = u.id; nombre = u.nombre; }
    }
    await enviarWhatsapp(numero, mensaje);
    let saved = false;
    if (userId) {
      try { await guardarMensaje(userId, 'neto', mensaje); saved = true; }
      catch(e) { log.error({ tag: 'ADMIN_NOTIFY', err: e.message }, 'No se pudo guardar mensaje en conversaciones'); }
    }
    log.info({ tag: 'ADMIN_NOTIFY', numero, len: mensaje.length, saved }, 'Mensaje admin enviado');
    res.json({ ok: true, msg: 'Mensaje enviado a ' + (nombre || numero), saved_in_history: saved });
  } catch(e) {
    log.error({ tag: 'ADMIN_NOTIFY', err: e.message }, 'Error enviando mensaje admin');
    res.status(500).json({ ok: false, msg: 'Error enviando mensaje' });
  }
});

// GET /admin/errores — errores recientes
router.get('/errores', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  try {
    const limite = parseInt(req.query.limite) || 20;
    const soloNoResueltos = req.query.resueltos !== 'true';
    let query = supabase.from('errores').select('*').order('created_at', { ascending: false }).limit(limite);
    if (soloNoResueltos) query = query.eq('resuelto', false);
    const { data } = await query;
    res.json({ ok: true, errores: data || [], total: (data || []).length });
  } catch(e) {
    res.status(500).json({ ok: false, msg: 'Error consultando errores' });
  }
});

/**
 * POST /admin/espacio-nuevo-miembro — avisa a los miembros de un espacio que
 * entro alguien y como quedo su parte.
 *
 * Existe porque la webapp NO puede mandar WhatsApp (no tiene token ni sender de
 * Meta) y el link de invitacion apunta justamente a la webapp, o sea que es la
 * puerta de entrada principal. Sin este hop, unirse desde la web no avisaria a
 * nadie y el reparto de los que ya estaban se moveria en silencio: exactamente
 * lo que este cambio cierra.
 *
 * Server-to-server con ADMIN_KEY (la webapp ya la tiene para el panel de pagos).
 * No recibe montos ni escribe nada: solo dispara el aviso.
 */
router.post('/espacio-nuevo-miembro', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { space_id, user_id } = req.body || {};
  if (!space_id || !user_id) return res.status(400).json({ ok: false, msg: 'Faltan space_id y user_id' });
  try {
    const { notificarNuevoMiembro } = require('../services/shared-spaces');
    await notificarNuevoMiembro(space_id, user_id);
    res.json({ ok: true });
  } catch (e) {
    log.error({ tag: 'ESPACIO_JOIN_AVISO', err: e.message }, 'Error avisando del nuevo miembro');
    res.status(500).json({ ok: false, msg: 'Error enviando el aviso' });
  }
});

/**
 * POST /admin/espacio-reparto-cambiado — avisa que alguien edito el split por
 * defecto del espacio.
 *
 * Mismo hop que el aviso de nuevo miembro y por la misma razon: la webapp no
 * puede mandar WhatsApp. `antes` son los pesos que habia justo antes de escribir;
 * solo alimenta el texto del "de X% a Y%", la plata no depende de el.
 */
router.post('/espacio-reparto-cambiado', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { space_id, actor_id, antes } = req.body || {};
  if (!space_id || !actor_id) return res.status(400).json({ ok: false, msg: 'Faltan space_id y actor_id' });
  try {
    const { notificarRepartoEditado } = require('../services/shared-spaces');
    await notificarRepartoEditado(space_id, actor_id, antes);
    res.json({ ok: true });
  } catch (e) {
    log.error({ tag: 'ESPACIO_SPLIT_AVISO', err: e.message }, 'Error avisando del cambio de reparto');
    res.status(500).json({ ok: false, msg: 'Error enviando el aviso' });
  }
});

/**
 * POST /admin/espacio-reglas-cambiadas — avisa que alguien edito las reglas de
 * reparto por categoria (Pro) del espacio.
 *
 * Mismo hop y misma razon que los dos de arriba. `antes` son las reglas que habia
 * justo antes de escribir; el "despues" lo lee el service de la DB.
 */
router.post('/espacio-reglas-cambiadas', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { space_id, actor_id, antes } = req.body || {};
  if (!space_id || !actor_id) return res.status(400).json({ ok: false, msg: 'Faltan space_id y actor_id' });
  try {
    const { notificarReglasEditadas } = require('../services/shared-spaces');
    await notificarReglasEditadas(space_id, actor_id, antes);
    res.json({ ok: true });
  } catch (e) {
    log.error({ tag: 'ESPACIO_REGLAS_AVISO', err: e.message }, 'Error avisando del cambio de reglas');
    res.status(500).json({ ok: false, msg: 'Error enviando el aviso' });
  }
});

module.exports = router;
