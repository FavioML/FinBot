const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');

const router = express.Router();

function verificarAdmin(req, res) {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  const clave = req.body.clave || req.query.clave || '';
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

module.exports = router;
