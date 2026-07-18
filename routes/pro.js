const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { PRO_PRECIOS } = require('../lib/config');
const { registrarSolicitudPro } = require('../lib/pro-payment');
const { generarUrlAutorizacion, BANCOS_CATALOGO } = require('../gmail');

const router = express.Router();

/**
 * Auth service-to-service: la webapp (Vercel) ya autenticó al usuario logueado con
 * getNetoUserId() y nos vouchea su `usuario_id`. Verificamos un secreto compartido
 * (`INTERNAL_API_KEY`) por header, nunca por query/body. Es una clave distinta a ADMIN_KEY:
 * la webapp no debe poder actuar como admin.
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
  // modo: 'inicial' (primera conexión) | 'agregar' (cuenta Gmail adicional, no reemplaza la actual)
  const modo = req.query.modo === 'agregar' ? 'agregar' : 'inicial';
  try {
    const url = generarUrlAutorizacion(usuario.whatsapp, modo, 'web');
    res.json({ ok: true, url });
  } catch (e) {
    log.error({ tag: 'PRO_OAUTH', err: e.message }, 'No se pudo generar URL OAuth');
    res.status(500).json({ ok: false, msg: 'No se pudo generar el enlace' });
  }
});

// POST /pro/solicitud — crea una solicitud Pro pendiente desde la webapp (alta o renovación).
// Headers: x-internal-key, x-usuario-id, x-tipo-plan (mensual|anual), x-mime-type.
// Body: bytes crudos de la imagen (application/octet-stream) — evita el límite de express.json.
// La selección de bancos NO va aquí: se elige después de aprobar (no debe frenar el pago).
router.post('/solicitud', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  if (!verificarInterno(req, res)) return;
  try {
    const usuarioId = req.get('x-usuario-id');
    const tipoPlan = req.get('x-tipo-plan') === 'anual' ? 'anual' : 'mensual';
    const mimeType = req.get('x-mime-type') || 'image/jpeg';
    if (!usuarioId) return res.status(400).json({ ok: false, msg: 'Falta usuario_id' });

    const imgBuffer = req.body;
    if (!imgBuffer || !imgBuffer.length) return res.status(400).json({ ok: false, msg: 'Falta la imagen del comprobante' });

    const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', usuarioId).single();
    if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

    // Nota: un usuario premium SÍ puede enviar solicitud (renovación); solo bloqueamos
    // tener dos solicitudes pendientes a la vez (anti-abuso).
    const { data: pendiente } = await supabase.from('pagos')
      .select('id').eq('usuario_id', usuarioId).eq('estado', 'pendiente').limit(1).maybeSingle();
    if (pendiente) return res.status(409).json({ ok: false, msg: 'Ya tienes una solicitud en revisión' });

    const monto = PRO_PRECIOS[tipoPlan] || null;
    const { pagoId } = await registrarSolicitudPro({
      usuario, monto, montoDetectado: null, tipoPlan,
      metodoPago: 'Yape', comprobanteBuffer: imgBuffer, mimeType, origen: 'webapp',
    });

    res.json({ ok: true, pagoId, estado: 'pendiente' });
  } catch (e) {
    log.error({ tag: 'PRO_SOLICITUD', err: e.message }, 'Error creando solicitud Pro');
    res.status(500).json({ ok: false, msg: 'Error creando la solicitud' });
  }
});

module.exports = router;
