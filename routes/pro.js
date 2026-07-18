const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { PRO_PRECIOS } = require('../lib/config');
const { subirComprobante, registrarSolicitudPro } = require('../lib/pro-payment');
const { generarUrlAutorizacion, BANCOS_CATALOGO } = require('../gmail');

const router = express.Router();

// Set de ids válidos del catálogo de bancos (para filtrar la selección de la webapp).
const BANCO_IDS = new Set(BANCOS_CATALOGO.map((b) => b.id));

/**
 * Auth service-to-service: la webapp (Vercel) ya autenticó al usuario logueado con
 * getNetoUserId() y nos vouchea su `usuario_id`. Verificamos un secreto compartido
 * (`INTERNAL_API_KEY`) por header, nunca por query/body (se filtra a logs). Es una clave
 * distinta a ADMIN_KEY: la webapp no debe poder actuar como admin.
 */
function verificarInterno(req, res) {
  const KEY = process.env.INTERNAL_API_KEY;
  const clave = req.get('x-internal-key') || '';
  if (!KEY || !clave || clave.length !== KEY.length || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(KEY))) {
    res.status(401).json({ ok: false, msg: 'No autorizado' });
    return false;
  }
  return true;
}

/** Parsea el header x-bancos: ausente → undefined (no tocar); 'todos' → null (todos); csv → array de ids válidos. */
function parsearBancos(header) {
  if (header == null || header === '') return undefined;
  if (String(header).toLowerCase() === 'todos') return null;
  const ids = String(header).split(',').map((s) => s.trim().toLowerCase()).filter((s) => BANCO_IDS.has(s));
  return ids.length ? ids : undefined;
}

// GET /pro/bancos — catálogo de bancos (id + label) para el multiselect de la webapp.
router.get('/bancos', (req, res) => {
  if (!verificarInterno(req, res)) return;
  res.json({ ok: true, bancos: BANCOS_CATALOGO.map((b) => ({ id: b.id, label: b.label })) });
});

// GET /pro/gmail-auth-url?usuario_id= — URL de OAuth Gmail para el usuario logueado.
// El callback redirige de vuelta a la webapp (origen 'web'); ver routes/public.js.
router.get('/gmail-auth-url', async (req, res) => {
  if (!verificarInterno(req, res)) return;
  const usuarioId = req.query.usuario_id;
  if (!usuarioId) return res.status(400).json({ ok: false, msg: 'Falta usuario_id' });
  const { data: usuario } = await supabase.from('usuarios').select('whatsapp').eq('id', usuarioId).single();
  if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });
  try {
    const url = generarUrlAutorizacion(usuario.whatsapp, 'inicial', 'web');
    res.json({ ok: true, url });
  } catch (e) {
    log.error({ tag: 'PRO_OAUTH', err: e.message }, 'No se pudo generar URL OAuth');
    res.status(500).json({ ok: false, msg: 'No se pudo generar el enlace' });
  }
});

// POST /pro/solicitud — crea una solicitud Pro pendiente desde la webapp.
// Headers: x-internal-key, x-usuario-id, x-tipo-plan (mensual|anual), x-bancos, x-mime-type.
// Body: bytes crudos de la imagen (application/octet-stream) — evita el límite de express.json.
router.post('/solicitud', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  if (!verificarInterno(req, res)) return;
  try {
    const usuarioId = req.get('x-usuario-id');
    const tipoPlan = req.get('x-tipo-plan') === 'anual' ? 'anual' : 'mensual';
    const mimeType = req.get('x-mime-type') || 'image/jpeg';
    const bancos = parsearBancos(req.get('x-bancos'));
    if (!usuarioId) return res.status(400).json({ ok: false, msg: 'Falta usuario_id' });

    const imgBuffer = req.body;
    if (!imgBuffer || !imgBuffer.length) return res.status(400).json({ ok: false, msg: 'Falta la imagen del comprobante' });

    const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', usuarioId).single();
    if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });
    if (usuario.plan === 'premium') return res.status(409).json({ ok: false, msg: 'Ya tienes Pro activo' });

    // Anti-abuso: una solicitud pendiente a la vez.
    const { data: pendiente } = await supabase.from('pagos')
      .select('id').eq('usuario_id', usuarioId).eq('estado', 'pendiente').limit(1).maybeSingle();
    if (pendiente) return res.status(409).json({ ok: false, msg: 'Ya tienes una solicitud en revisión' });

    const comprobantePath = await subirComprobante(usuarioId, imgBuffer, mimeType);
    if (!comprobantePath) return res.status(502).json({ ok: false, msg: 'No se pudo guardar el comprobante' });

    const monto = PRO_PRECIOS[tipoPlan] || null;
    const { pagoId } = await registrarSolicitudPro({
      usuario, monto, montoDetectado: null, tipoPlan,
      metodoPago: 'Yape', comprobantePath, origen: 'webapp', bancos,
    });

    res.json({ ok: true, pagoId, estado: 'pendiente' });
  } catch (e) {
    log.error({ tag: 'PRO_SOLICITUD', err: e.message }, 'Error creando solicitud Pro');
    res.status(500).json({ ok: false, msg: 'Error creando la solicitud' });
  }
});

module.exports = router;
