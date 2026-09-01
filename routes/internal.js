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

    // La webapp acaba de vincular esta cuenta, o sea que el usuario existe por construccion:
    // un 404 aca solo puede ser una lectura caida, y se llevaba puestos el WhatsApp de
    // confirmacion y el evento del embudo (paso 200) sin dejar rastro.
    const { data: usuario, error: errUsuario } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre').eq('id', usuarioId).maybeSingle();
    if (errUsuario) {
      log.error({ tag: 'ACTIVACION', err: errUsuario.message, usuarioId }, 'No se pudo leer al usuario recien activado');
      return res.status(500).json({ ok: false, msg: 'No pude leer el usuario. Reintenta.' });
    }
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

/**
 * POST /internal/cuenta/borrar
 * Body: { usuario_id }
 *
 * La segunda puerta del borrado de cuenta. Hasta la migración 073 la única salida era el
 * intent `desconectar_cuenta` por WhatsApp, al que además solo se llega por NLP (no hay
 * comando): 7 usuarios sin `whatsapp` no tenían NINGUNA puerta para irse.
 *
 * La webapp no reimplementa el borrado, lo delega acá. Es deliberado y es la lección de las
 * TRES copias del wipe que se unificaron el 17-ago: el flujo toca Google, Storage, el Admin
 * API de Auth y una transacción de Postgres, y escribirlo dos veces en dos lenguajes es
 * garantizar que un arreglo llegue a una sola mitad. Lo único que cada canal decide es su
 * texto.
 *
 * El usuario ya viene autenticado por la webapp (`requireNetoUser`), que nos vouchea su
 * `usuario_id` con `INTERNAL_API_KEY`. Acá NO se acepta ningún id que no venga por ese
 * canal: no hay superficie de IDOR porque no hay sesión de usuario que suplantar.
 */
router.post('/cuenta/borrar', async (req, res) => {
  if (!verificarInterno(req, res)) return;
  const usuarioId = req.body && req.body.usuario_id;
  if (!usuarioId) return res.status(400).json({ ok: false, msg: 'Falta usuario_id' });

  // Se relee la fila fresca en vez de confiar en lo que mande la webapp: el servicio necesita
  // `supabase_auth_id` para borrar la identidad y el plan para el aviso al admin, y esos son
  // datos que no queremos que viajen por el cuerpo de un POST.
  const { data: usuario, error } = await supabase.from('usuarios')
    .select('id, nombre, whatsapp, plan, tipo_plan, trial_estado, premium_vence, supabase_auth_id, gmail_refresh_token')
    .eq('id', usuarioId).maybeSingle();
  // `maybeSingle` a propósito: separa "no existe" (404) de "no se pudo leer" (500). Colapsarlos
  // haría que un timeout le dijera a alguien que su cuenta no existe.
  if (error) {
    log.error({ tag: 'WIPE', usuarioId, err: error.message }, 'No se pudo leer el usuario a borrar');
    return res.status(500).json({ ok: false, msg: 'Error temporal, intenta de nuevo' });
  }
  if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });

  const { borrarCuenta } = require('../services/account-deletion');
  const r = await borrarCuenta(usuario, { origen: 'webapp' });
  // Un borrado fallido es 500 y no 200-con-flag: la webapp tiene que poder distinguirlo sin
  // leer el cuerpo, y sobre todo NO puede cerrar la sesión ni decir "listo" cuando no pasó nada.
  if (!r.ok) return res.status(500).json({ ok: false, msg: 'No se pudo eliminar la cuenta' });
  // `sucio` NO se le devuelve a la webapp: son detalles operativos (qué quedó vivo en Google,
  // en Storage o en Auth) que ya fueron al admin y que a la persona no le sirven de nada.
  res.json({ ok: true });
});

module.exports = router;
