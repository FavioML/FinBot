const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { PRO_PRECIOS, precioProEfectivo } = require('../lib/config');
const { registrarSolicitudPro } = require('../lib/pro-payment');
const { esProPagado } = require('../lib/trial');
const { generarUrlAutorizacion, BANCOS_CATALOGO, emailGmailVinculado } = require('../gmail');

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

// Modos de conexión que la webapp puede pedir. **No existe 'agregar'**: un usuario tiene una
// sola cuenta de Gmail, porque cada cuenta de Google distinta consume otro de los 100 cupos de
// por vida y no vamos a cobrar por cuenta conectada. El modo solo elige el copy del mensaje
// posterior; la exclusividad la impone `guardarTokens` sin mirarlo.
const MODOS_CONEXION = ['inicial', 'reemplazar'];

// GET /pro/gmail-auth-url?usuario_id=&modo= — URL de OAuth Gmail para el usuario logueado.
// El callback redirige de vuelta a la webapp (origen 'web'); ver routes/public.js.
router.get('/gmail-auth-url', async (req, res) => {
  if (!verificarInterno(req, res)) return;
  const usuarioId = req.query.usuario_id;
  if (!usuarioId) return res.status(400).json({ ok: false, msg: 'Falta usuario_id' });
  // Trae `plan` y `trial_estado` porque las dos alimentan la decisión de abajo: una fila
  // parcial acá decidiría con `trial_estado: undefined` y abriría el gate.
  const { data: usuario, error: errUsuario } = await supabase.from('usuarios').select('whatsapp, plan, trial_estado').eq('id', usuarioId).maybeSingle();
  if (errUsuario) {
    log.error({ tag: 'GMAIL_AUTH_URL', err: errUsuario.message, usuarioId }, 'No se pudo leer al usuario que pide conectar Gmail');
    return res.status(500).json({ ok: false, msg: 'No pude leer tu cuenta. Reintenta.' });
  }
  if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });
  // Conectar Gmail consume un cupo de Google (100 hasta la certificación CASA), así que se
  // reserva para quien PAGA. Durante el trial `plan` ya vale 'premium' — por eso el predicado
  // es esProPagado y no un chequeo de plan. La webapp traduce este 403 a la tarjeta bloqueada.
  if (!esProPagado(usuario)) {
    return res.status(403).json({ ok: false, motivo: 'pro_pagado_requerido', msg: 'Conectar Gmail requiere Pro pagado' });
  }
  // La webapp es el ÚNICO camino para conectar Gmail, así que también tiene que cubrir la
  // reconexión tras un `invalid_grant` — antes eso solo existía por WhatsApp (cambiar_gmail).
  // Se pasa el usuario_id → el callback resuelve por identidad, no por número (un
  // Pro web-only tiene whatsapp null y sin uid quedaría sin poder conectar Gmail).
  const modo = MODOS_CONEXION.includes(req.query.modo) ? req.query.modo : 'inicial';
  // Si ya vinculó un correo, Google lo preselecciona. Es la única defensa REAL del cupo: se
  // gasta al aprobar en la pantalla de Google, antes de que nuestro callback pueda opinar.
  // Solo el correo en claro sirve de `login_hint`: el hash no se le puede mostrar a Google.
  // Tras un borrado de cuenta la fila conserva el hash pero no el correo, así que acá queda
  // `null` — se pierde la preselección, que es comodidad, y NO el gate del canje, que mira el
  // hash. Es la dirección correcta de pérdida.
  const emailActual = (await emailGmailVinculado(usuarioId))?.email || null;
  try {
    const url = generarUrlAutorizacion(usuario.whatsapp, modo, 'web', usuarioId, emailActual);
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

    // Del otro lado de este 404 hay alguien que YA pago y esta subiendo su comprobante. Decirle
    // "Usuario no encontrado" porque la base no contesto lo manda a pensar que su cuenta no
    // existe en vez de a reintentar.
    const { data: usuario, error: errUsuario } = await supabase.from('usuarios').select('*').eq('id', usuarioId).maybeSingle();
    if (errUsuario) {
      log.error({ tag: 'SOLICITUD_PRO', err: errUsuario.message, usuarioId }, 'No se pudo leer al usuario que sube comprobante');
      return res.status(500).json({ ok: false, msg: 'No pude leer tu cuenta. Reintenta en un momento.' });
    }
    if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

    // Nota: un usuario premium SÍ puede enviar solicitud (renovación); solo bloqueamos
    // tener dos solicitudes pendientes a la vez (anti-abuso).
    // Falla CERRADO: esta lectura ES el anti-abuso. Con el error descartado, una caida daba
    // `pendiente = null` y el gate se abria — una segunda fila en `pagos` y un segundo
    // comprobante en Storage para el mismo usuario, que el admin ve como dos solicitudes.
    const { data: pendiente, error: errPendiente } = await supabase.from('pagos')
      .select('id').eq('usuario_id', usuarioId).eq('estado', 'pendiente').limit(1).maybeSingle();
    if (errPendiente) {
      log.error({ tag: 'SOLICITUD_PRO', err: errPendiente.message, usuarioId }, 'No se pudo verificar si ya hay una solicitud pendiente');
      return res.status(500).json({ ok: false, msg: 'No pude verificar tu solicitud. Reintenta en un momento.' });
    }
    if (pendiente) return res.status(409).json({ ok: false, msg: 'Ya tienes una solicitud en revisión' });

    // Precio efectivo: aplica el 50% off de referido si está vigente (mensual → S/5). La fila
    // `pagos` queda con el monto real esperado, que el admin ve al aprobar.
    const monto = precioProEfectivo(usuario, tipoPlan) || PRO_PRECIOS[tipoPlan] || null;
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
