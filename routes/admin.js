const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { guardarMensaje } = require('../helpers/db-helpers');
const { activarPro, reclamarPagoPendiente } = require('../lib/pro-payment');
const { resumenReferidoParaAdmin, registrarReferido } = require('../services/referrals');
const { responderTicket } = require('../lib/support-tickets');

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

// POST /admin/activar — comp: activar premium a mano, sin pago de por medio.
//
// Delega en `activarPro` (fuente única, lib/pro-payment.js), igual que el comando `/activar`
// de WhatsApp. El UPDATE a mano que vivía acá escribía 4 de las ~10 columnas que la activación
// necesita, y cada omisión costaba algo:
//   · sin `trial_estado: 'convertido'`, un comp durante el trial dejaba la fila en 'activo' y
//     `checkTrialExpiry` (cron/checks.js) la bajaba a `plan: 'free'` al vencer el trial: el
//     comp se evaporaba solo. Además el usuario seguía contando como "en prueba" en las
//     métricas (esProPagado filtra trial_estado <> 'activo').
//   · sin la matemática de renovación, el periodo contaba siempre desde hoy, así que un comp
//     sobre alguien con Pro vigente le ACORTABA el vencimiento.
//   · sin el desatasco de `onboarding_paso === 2`, el usuario ya premium seguía recibiendo
//     "elige tu plan / mándame la captura" ante cada mensaje.
//
// Los tres flags, decididos y no heredados:
//   · `esConversionPagada: false` — un comp no premia al referrer (anti-cadena) y su fila de
//     `pagos` se registra en S/0, para no inflar la caja del mes con plata que nadie transfirió.
//     Si el usuario SÍ pagó y mandó comprobante, el endpoint es /admin/aprobar-pago.
//   · `enviarLinkGmail: false` — conserva lo que esta ruta ya hacía (nunca mandó link de Gmail) y
//     empata con el comp por WhatsApp. El link lo manda /pago, que sí confirma un pago.
//   · `guardarHistorial: true` (default, explícito) — ahora sí sale un WhatsApp; sin la fila en
//     `mensajes`, el hilo del usuario tendría un hueco justo donde Neto le escribió.
router.post('/activar', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { whatsapp } = req.body;
  if (!whatsapp) return res.status(400).json({ ok: false, msg: 'Falta whatsapp' });
  const numero = whatsapp.replace(/\+/g, '').replace(/^0/, '');
  const { data: usuarioActivar } = await supabase.from('usuarios').select('*').eq('whatsapp', numero).single();
  if (!usuarioActivar) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });
  try {
    // El aviso al usuario (WhatsApp + in-app, por el chokepoint `notificarUsuario`) sale
    // dentro de activarPro. No lo dupliques aca.
    const { venceStr } = await activarPro({
      usuario: usuarioActivar,
      tipoPlan: 'mensual',
      aprobadoPor: 'admin:comp',
      enviarLinkGmail: false,
      guardarHistorial: true,
      esConversionPagada: false,
    });
    res.json({ ok: true, msg: 'Premium activado para ' + (usuarioActivar.nombre || numero), vence: venceStr });
  } catch (e) {
    // activarPro lanza cuando el UPDATE que ES la activacion falla. Antes esta ruta ni leia
    // el error y respondia ok: el admin veia exito sobre un usuario que seguia en Free.
    log.error({ tag: 'ADMIN_ACTIVAR', err: e.message, usuarioId: usuarioActivar.id }, 'No se pudo activar Pro (comp)');
    res.status(500).json({ ok: false, msg: 'No se pudo activar Pro' });
  }
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
    const { venceStr } = await activarPro({ usuario, tipoPlan, aprobadoPor: 'admin:webapp', pagoId: claimed.id, esConversionPagada: true });

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
    // Contexto de referido del usuario (si se pidió por usuario_id): descuento vigente +
    // quién lo refirió, para que el admin apruebe sabiendo que se espera S/5 y quién gana el mes.
    let referido = null;
    if (usuarioId) {
      try { referido = await resumenReferidoParaAdmin(usuarioId); } catch (e) { log.warn({ tag: 'ADMIN_PAGOS', err: e.message }, 'No se pudo leer el contexto de referido'); }
    }
    res.json({ ok: true, pagos: pagos || [], referido });
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
/**
 * POST /admin/responder-ticket — responde un ticket de soporte desde el panel web.
 *
 * Existe por la misma razon que los avisos de espacios: la webapp NO puede mandar
 * WhatsApp (no tiene token ni sender de Meta). El panel manda el `ticket_id` (ya
 * tiene la fila) y aca se resuelve el numero, se envia el WhatsApp y se marca el
 * ticket como respondido. Toda la logica vive en lib/support-tickets, compartida
 * con el comando /responder de WhatsApp y Telegram.
 *
 * Body: { ticket_id?, whatsapp?, mensaje }. Server-to-server con ADMIN_KEY.
 */
router.post('/responder-ticket', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { ticket_id, whatsapp, mensaje } = req.body || {};
  if (!mensaje || (!ticket_id && !whatsapp)) {
    return res.status(400).json({ ok: false, msg: 'Falta mensaje y (ticket_id o whatsapp)' });
  }
  const r = await responderTicket({ numDestino: whatsapp || null, mensaje, ticketId: ticket_id || null });
  if (!r.ok) return res.status(502).json({ ok: false, msg: r.msg });
  res.json({ ok: true, msg: r.msg });
});

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

/**
 * POST /admin/referido-web — vincula un referido nacido por la webapp con su referrer.
 *
 * Gemelo web del deep-link "Hola NETO ref:CODE" de WhatsApp (handlers/webhook.js). La
 * webapp NO puede replicar la lógica de referidos sin duplicar la siembra del descuento
 * (ventana 7d, 50%, "no si ya es Pro"), así que la delega aquí: toda la mecánica vive en
 * services/referrals. El callback de auth (app.neto.pe) llama esto tras crear la cuenta
 * web-first, con el `ref` que capturó del ?ref=CODE de la mini-landing.
 *
 * Solo VINCULA + siembra el 50% off al referido; NO premia al referrer (eso salta recién
 * cuando el referido PAGA Pro, en lib/pro-payment:activarPro). Idempotente por registrarReferido.
 *
 * Body: { ref_code, referido_id }. Server-to-server con ADMIN_KEY.
 */
router.post('/referido-web', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { ref_code, referido_id } = req.body || {};
  if (!ref_code || !referido_id) return res.status(400).json({ ok: false, msg: 'Faltan ref_code y referido_id' });
  const code = String(ref_code).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return res.status(400).json({ ok: false, msg: 'ref_code inválido' });
  try {
    // Resolver referrer excluyendo al propio referido (anti auto-referirse), igual que el webhook.
    const { data: referrer } = await supabase.from('usuarios')
      .select('id').eq('ref_code', code).neq('id', referido_id).maybeSingle();
    if (!referrer) return res.json({ ok: true, linked: false }); // code inexistente o self: no-op silencioso
    await registrarReferido(referrer.id, referido_id);
    res.json({ ok: true, linked: true });
  } catch (e) {
    log.error({ tag: 'REFERIDO_WEB', err: e.message }, 'Error vinculando referido web');
    res.status(500).json({ ok: false, msg: 'Error vinculando el referido' });
  }
});

module.exports = router;
