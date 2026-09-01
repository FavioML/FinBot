const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { guardarMensaje } = require('../helpers/db-helpers');
const { activarPro, reclamarPagoPendiente } = require('../lib/pro-payment');
const { resumenReferidoParaAdmin, registrarReferido } = require('../services/referrals');
const { responderTicket, contactarUsuario } = require('../lib/support-tickets');
const { esProPagado } = require('../lib/trial');
const { parsearCorreoBancario } = require('../services/parsers');

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
  // `maybeSingle` + `if (error)` separado del `if (!data)`, molde de `resolverSolicitudPro`.
  // Con `.single()` y cero filas el error es PGRST116, asi que un `if (error)` a secas
  // convertiria "no existe" en "no pude leer", que es la mentira simetrica de la que habia:
  // la lectura muda contestaba **404 "Usuario no encontrado"** al admin que acaba de pedir un
  // comp, mandandolo a buscar un alta que si existe.
  const { data: usuarioActivar, error: errActivar } = await supabase.from('usuarios').select('*').eq('whatsapp', numero).maybeSingle();
  if (errActivar) {
    log.error({ tag: 'ADMIN_ACTIVAR', err: errActivar.message, numero }, 'No se pudo leer el usuario a activar');
    return res.status(500).json({ ok: false, msg: 'No pude leer el usuario. Reintenta.' });
  }
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
  // Sin leer el error, una caida devolvia `pendientes: []` con `ok: true`: el panel decia
  // "no hay nadie esperando" justo cuando alguien pago y mando su comprobante.
  const { data, error } = await supabase.from('usuarios').select('whatsapp, nombre, plan, pago_pendiente, pago_referencia, created_at').eq('pago_pendiente', true);
  if (error) {
    log.error({ tag: 'ADMIN_PENDIENTES', err: error.message }, 'No se pudieron leer los pagos pendientes');
    return res.status(500).json({ ok: false, msg: 'No pude leer los pagos pendientes. Reintenta.' });
  }
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
    // **`maybeSingle` y no `single`, y eso es la mitad del arreglo.** Leer el `error` sobre un
    // `.single()` convertiría el 404 legítimo en un 500: postgrest devuelve `PGRST116` en
    // `error` cuando la lectura no encuentra fila. Con `maybeSingle` las dos causas quedan
    // separadas —`error` es la caída, `!usuario` es que no está— y el admin deja de leer
    // "Usuario no encontrado" sobre una lectura que nunca respondió. Es el hermano de lo que
    // ya se arregló en `admin-commands.js`, en el OTRO canal admin.
    const { data: usuario, error: errUsuario } = await query.maybeSingle();
    if (errUsuario) {
      log.error({ tag: 'APROBAR_PAGO', err: errUsuario.message }, 'No se pudo leer el usuario a aprobar');
      return res.status(500).json({ ok: false, msg: 'No pude leer el usuario. Reintenta.' });
    }
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
    // Una lista vacia por caida se lee igual que "este usuario nunca pago", y esto es la
    // constancia de suscripcion. El 500 obliga a reintentar en vez de dar por buena una
    // historia de pagos vacia.
    const { data: pagos, error: errPagos } = await query;
    if (errPagos) {
      log.error({ tag: 'ADMIN_PAGOS', err: errPagos.message, usuarioId }, 'No se pudo leer el historial de pagos');
      return res.status(500).json({ ok: false, msg: 'No pude leer los pagos. Reintenta.' });
    }
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
      try {
        referido = await resumenReferidoParaAdmin(usuarioId);
      } catch (e) {
        log.warn({ tag: 'ADMIN_PAGOS', err: e.message, usuarioId }, 'No se pudo leer el contexto de referido');
        // **Se responde con `parcial: true`, no con `null`.** Un `null` acá viaja hasta el
        // panel y se lee igual que "este usuario no tiene referido", que es el colapso que
        // la bandera existe para romper — un nivel más arriba de donde se rompió. Hoy es
        // inalcanzable porque `resumenReferidoParaAdmin` se traga todo en su propio
        // try/catch y nunca lanza, pero eso es una propiedad de esa función y no un
        // contrato: el día que alguien le agregue un `throw`, la pantalla donde se aprueba
        // un pago vuelve a callar. Cuesta una línea.
        referido = { descuentoPct: 0, referrerId: null, referrerNombre: null, yaPremiado: false, parcial: true };
      }
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
    // Con la lectura caida esto devolvia `usuarios: []` y `total: 0` con `ok: true`: el panel
    // afirmaba que no hay ni un registrado habiendo mas de cien.
    const { data, error } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, email, plan, onboarding_completado, gmail_access_token, created_at, premium_vence, supabase_auth_id')
      .order('created_at', { ascending: false });
    if (error) {
      log.error({ tag: 'ADMIN_USUARIOS', err: error.message }, 'No se pudo leer la lista de usuarios');
      return res.status(500).json({ ok: false, msg: 'No pude leer los usuarios. Reintenta.' });
    }
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

    // **Las seis lecturas de este tablero fallan JUNTAS o no fallan.** Una metrica que sale
    // en cero porque la base no contesto es indistinguible de un cero real, y este endpoint
    // es de donde salen los numeros que se miran para decidir. Un tablero a medias con
    // `ok: true` es peor que ninguno: el 500 dice "no se". Ver `feedback_datos_y_metricas`.
    const fallo = (etiqueta, error) => {
      log.error({ tag: 'ADMIN_STATS', err: error.message, consulta: etiqueta }, 'No se pudo leer una metrica del tablero');
      return res.status(500).json({ ok: false, msg: 'No pude leer las metricas (' + etiqueta + '). Reintenta.' });
    };

    // `trial_estado` la exige `esProPagado`: sin ella la respuesta sería false para todos.
    const { data: allUsers, error: errUsers } = await supabase.from('usuarios').select('id, plan, trial_estado, onboarding_completado, gmail_access_token, created_at');
    if (errUsers) return fallo('usuarios', errUsers);
    const totalUsuarios = (allUsers || []).length;
    const conGmail = (allUsers || []).filter(u => !!u.gmail_access_token).length;
    const modoManual = (allUsers || []).filter(u => u.onboarding_completado && !u.gmail_access_token).length;
    // M16: durante el trial `plan` vale 'premium', así que esto contaba pruebas como pagos.
    const premium = (allUsers || []).filter(esProPagado).length;
    const nuevos7d = (allUsers || []).filter(u => u.created_at >= hace7).length;

    const { count: txsHoy, error: errHoy } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).eq('fecha', hoy);
    if (errHoy) return fallo('transacciones-hoy', errHoy);
    const { count: txs7d, error: err7d } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).gte('fecha', hace7);
    if (err7d) return fallo('transacciones-7d', err7d);
    const { count: txs30d, error: err30d } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).gte('fecha', hace30);
    if (err30d) return fallo('transacciones-30d', err30d);

    const { data: txsCat, error: errCat } = await supabase.from('transacciones').select('categoria, monto_pen').eq('tipo', 'gasto').gte('fecha', hace30);
    if (errCat) return fallo('top-categorias', errCat);
    const porCat = {};
    (txsCat || []).forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || 0); });
    const topCategorias = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([cat, total]) => ({ categoria: cat, total: parseFloat(total.toFixed(2)) }));

    const { data: txsBanco, error: errBanco } = await supabase.from('transacciones').select('banco').gte('fecha', hace30).not('banco', 'is', null);
    if (errBanco) return fallo('top-bancos', errBanco);
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
      const { data: u, error: errU } = await supabase.from('usuarios').select('whatsapp, nombre').eq('id', userId).maybeSingle();
      if (errU) {
        log.error({ tag: 'ADMIN_NOTIFY', err: errU.message, userId }, 'No se pudo leer el usuario a notificar');
        return res.status(500).json({ ok: false, msg: 'No pude leer el usuario. Reintenta.' });
      }
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
      // **Esta falla ABIERTO, y es la unica de este archivo que lo hace.** El numero ya esta
      // validado y el mensaje se manda igual: lo unico que se pierde sin este id es la fila en
      // `conversaciones`, y la respuesta ya lo dice con `saved_in_history`. Cortar el envio
      // por una lectura que solo sirve para archivar seria apagar un efecto correcto —
      // exactamente lo que el item 20 pago con el aviso del autocierre.
      const { data: u, error: errU } = await supabase.from('usuarios').select('id, nombre').eq('whatsapp', numero).maybeSingle();
      if (errU) log.error({ tag: 'ADMIN_NOTIFY', err: errU.message, numero }, 'No se pudo resolver el usuario por numero: el mensaje sale igual, sin fila en conversaciones');
      if (u) { userId = u.id; nombre = u.nombre; }
    }
    await enviarWhatsapp(numero, mensaje);
    let saved = false;
    if (userId) {
      // `saved` sale del RETORNO, no de que no haya excepción: `guardarMensaje` no lanza nunca
      // (su catch se traga todo), así que el `try` de acá informaba `true` sobre un INSERT
      // rechazado. El try se queda igual por si algún día lanza de verdad.
      try { saved = await guardarMensaje(userId, 'neto', mensaje) === true; }
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
    // "No hay errores" es justo lo que esta ruta contestaba cuando la tabla de errores no
    // respondia. Es la tabla de donde salen los stacks de produccion: un cero falso ahi manda
    // a buscar el problema a otro lado.
    const { data, error } = await query;
    if (error) {
      log.error({ tag: 'ADMIN_ERRORES', err: error.message }, 'No se pudo leer la tabla de errores');
      return res.status(500).json({ ok: false, msg: 'No pude leer los errores. Reintenta.' });
    }
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

/**
 * POST /admin/contactar-usuario — le escribe como NETO a alguien que NO abrió un ticket.
 *
 * El caso que lo pide: el feedback y la queja viven en `nlp_errors`, no en
 * `tickets_soporte`, asi que el boton Responder del panel no tenia a que apuntar y
 * contestarle a quien dejo una sugerencia obligaba a escribirle desde un celular.
 *
 * Ya NO recibe `abrir_conversacion`. El ticket se crea siempre: es el REGISTRO de que la
 * conversacion existio, y sin el la respuesta del admin no se guardaba en ningun lado.
 * Que ademas el proximo mensaje de la persona vuelva al panel es consecuencia de que la
 * ventana de escucha este fresca (SESSION_IDLE_MS), no una decision aparte.
 *
 * Body: { whatsapp, mensaje, usuario_id?, nombre? }.
 */
router.post('/contactar-usuario', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { whatsapp, mensaje, usuario_id, nombre } = req.body || {};
  if (!mensaje || !whatsapp) {
    return res.status(400).json({ ok: false, msg: 'Falta whatsapp o mensaje' });
  }
  const r = await contactarUsuario({
    usuarioId: usuario_id || null,
    whatsapp,
    nombre: nombre || null,
    mensaje,
  });
  if (!r.ok) return res.status(502).json({ ok: false, msg: r.msg });
  res.json({ ok: true, msg: r.msg, conversacionAbierta: r.conversacionAbierta === true });
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
    const { data: referrer, error: errReferrer } = await supabase.from('usuarios')
      .select('id').eq('ref_code', code).neq('id', referido_id).maybeSingle();
    // Sin leer el error, una caida devolvia `ok: true, linked: false` — o sea "ese codigo no
    // existe" — y el vinculo se perdia para siempre: nadie reintenta un no-op exitoso, y de
    // ese vinculo cuelgan el mes gratis del referrer y el 50% off del referido.
    if (errReferrer) {
      log.error({ tag: 'REFERIDO_WEB', err: errReferrer.message, code }, 'No se pudo resolver el ref_code');
      return res.status(500).json({ ok: false, msg: 'No pude validar el codigo. Reintenta.' });
    }
    if (!referrer) return res.json({ ok: true, linked: false }); // code inexistente o self: no-op silencioso
    await registrarReferido(referrer.id, referido_id);
    res.json({ ok: true, linked: true });
  } catch (e) {
    log.error({ tag: 'REFERIDO_WEB', err: e.message }, 'Error vinculando referido web');
    res.status(500).json({ ok: false, msg: 'Error vinculando el referido' });
  }
});

// POST /admin/test-parser — herramienta de admin para probar el parser de correos.
//
// Vivía en `routes/public.js` y leía la ADMIN_KEY del **body** (hallazgo S′9). Dos problemas,
// y el segundo es el que importa: el body queda en logs igual que el query string —que es
// justo lo que `verificarAdmin` prohíbe por escrito— y colgaba de `publicLimiter` (60/min por
// IP) en vez de `adminLimiter` (10/min). Acá hereda las dos cosas: llave por header y el
// limiter de admin, sin una línea de auth propia.
router.post('/test-parser', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { correo } = req.body || {};
  if (!correo) return res.status(400).json({ ok: false, error: 'Falta correo' });
  try { res.json({ ok: true, resultado: await parsearCorreoBancario(correo) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
