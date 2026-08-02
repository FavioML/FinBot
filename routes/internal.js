const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { notificarUsuario, CANALES } = require('../lib/notify-user');
const analytics = require('../lib/analytics');

const router = express.Router();

/**
 * Auth service-to-service, idéntico al de routes/pro.js: la webapp ya autenticó al
 * usuario y nos vouchea su `usuario_id` con un secreto compartido por header.
 * Clave distinta a ADMIN_KEY a propósito: la webapp no debe poder actuar como admin.
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

/**
 * POST /internal/activacion-completada
 * Body: { usuario_id, resultado: 'adoptada'|'fusionada' }
 *
 * La webapp acaba de vincular una cuenta que nació en WhatsApp (link firmado de
 * lib/activacion.js). Este endpoint cierra el círculo con las dos cosas que la
 * webapp no puede hacer:
 *   1. Confirmar por WhatsApp — solo el backend tiene el token de Meta.
 *   2. Emitir el evento del embudo con distinctId = usuarios.id. La webapp usa
 *      posthog-js con OTRO distinct_id, así que emitir desde allá partiría el
 *      embudo en dos mitades que no se pueden unir.
 */
router.post('/activacion-completada', async (req, res) => {
  if (!verificarInterno(req, res)) return;
  try {
    const usuarioId = req.body && req.body.usuario_id;
    const resultado = (req.body && req.body.resultado) || 'adoptada';
    if (!usuarioId) return res.status(400).json({ ok: false, msg: 'Falta usuario_id' });

    const { data: usuario } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre').eq('id', usuarioId).maybeSingle();
    if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

    // Paso 200 = activación de la cuenta web. Vive en los MISMOS eventos que el
    // resto del alta (wa_onboarding_step_*) para que el embudo de PostHog siga
    // siendo uno solo, de "llegó un mensaje" a "activó su cuenta".
    analytics.capture(usuario.id, 'wa_onboarding_step_ok', { paso: 200, siguiente: 0, via: resultado });

    // Los dos canales, y el `if (usuario.whatsapp)` se cae: este endpoint se llama JUSTO
    // cuando la webapp terminó de vincular la cuenta, así que el buzón in-app existe por
    // construcción y es el primero que el usuario va a mirar.
    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
    await notificarUsuario({
      canales: CANALES.AMBOS,
      usuarioId: usuario.id,
      whatsapp: usuario.whatsapp || null,
      tipo: 'activacion_ok',
      mensaje: '✅ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u cuenta quedó activada.\n\n' +
        'Todo lo que anotes por acá lo ves en tu dashboard: gráficos, presupuestos y tu historial completo.\n\n' +
        'https://app.neto.pe/dashboard',
      titulo: 'Tu cuenta quedó activada',
      cuerpo: 'Todo lo que anotes por WhatsApp lo ves acá: gráficos, presupuestos y tu historial completo.',
      link: '/dashboard',
    });

    res.json({ ok: true });
  } catch (e) {
    log.error({ tag: 'ACTIVACION_INTERNA', err: e.message }, 'Error confirmando activación');
    res.status(500).json({ ok: false, msg: 'Error confirmando la activación' });
  }
});

/**
 * POST /internal/activacion-fallida
 * Body: { usuario_id?, motivo }
 * Solo telemetría: los motivos por los que un link no llegó a vincular
 * (token_invalido, token_expirado, ya_activada, merge_conflict). Sin usuario_id
 * no hay a quién atribuirlo, así que se descarta en vez de inventar un distinctId.
 */
router.post('/activacion-fallida', async (req, res) => {
  if (!verificarInterno(req, res)) return;
  const usuarioId = req.body && req.body.usuario_id;
  const motivo = (req.body && req.body.motivo) || 'desconocido';
  if (usuarioId) analytics.capture(usuarioId, 'wa_onboarding_step_failed', { paso: 200, motivo });
  res.json({ ok: true });
});

/**
 * POST /internal/trial-iniciar
 * Body: { usuario_id }
 *
 * La webapp acaba de registrar una transacción. El trial arranca con el PRIMER
 * gasto venga de donde venga, y el usuario web-first (que nace en app.neto.pe y
 * anota desde el dashboard) no pasa por services/transactions.js, así que sin
 * este endpoint sería el único que nunca recibe su prueba.
 *
 * Va por acá y no replicando el CAS en TypeScript por lo mismo de siempre: el
 * arranque del trial vive en UN solo lugar (lib/trial.js), y el evento de PostHog
 * necesita distinctId = usuarios.id — posthog-js usa otro y partiría el embudo.
 *
 * Idempotente por construcción (el CAS de iniciarTrialSiCorresponde), así que la
 * webapp puede llamarlo en cada insert sin condicionar nada.
 */
router.post('/trial-iniciar', async (req, res) => {
  if (!verificarInterno(req, res)) return;
  try {
    const usuarioId = req.body && req.body.usuario_id;
    if (!usuarioId) return res.status(400).json({ ok: false, msg: 'Falta usuario_id' });
    const { iniciarTrialSiCorresponde } = require('../lib/trial');
    const r = await iniciarTrialSiCorresponde(usuarioId, { via: 'primer_gasto_web' });
    res.json({ ok: true, iniciado: r.iniciado, trialVence: r.trialVence });
  } catch (e) {
    log.error({ tag: 'TRIAL', err: e.message }, 'Error arrancando trial desde la webapp');
    res.status(500).json({ ok: false, msg: 'Error arrancando el trial' });
  }
});

/**
 * POST /internal/trial-evento
 * Body: { usuario_id, evento }
 *
 * Telemetría de trial nacida en la webapp (hoy: `paywall_visto`). Mismo motivo que
 * el resto de los `/internal`: emitir desde posthog-js partiría el embudo por
 * distinct_id. Paso 401 = "vio el muro", dentro del mismo embudo del alta.
 */
router.post('/trial-evento', async (req, res) => {
  if (!verificarInterno(req, res)) return;
  const usuarioId = req.body && req.body.usuario_id;
  const evento = (req.body && req.body.evento) || 'desconocido';
  if (usuarioId) analytics.capture(usuarioId, 'wa_onboarding_step_ok', { paso: 401, via: evento });
  res.json({ ok: true });
});

module.exports = router;
