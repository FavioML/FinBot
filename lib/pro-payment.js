const { supabase } = require('./db');
const { enviarWhatsapp } = require('./whatsapp');
const { notificarAdmin } = require('./admin-notify');
const { enviarTelegramFotoConBotones } = require('./telegram');
const { notificarUsuario, CANALES } = require('./notify-user');
const { ADMIN_NUMBER, esPagoNeto, detectarTipoPlan, resolverTipoPlan, PRO_PRECIOS } = require('./config');
const { procesarConversionProReferido, resumenReferidoParaAdmin } = require('../services/referrals');
const { linkPanelPro } = require('./trial');
const { hoyPeru, sumarMeses } = require('./dates');
const { guardarMensaje } = require('../helpers/db-helpers');
const { validarMonto } = require('./validators');
const log = require('./logger');
const { msgErr } = require('./error-monitor');

/**
 * `pagos.monto` es NULLABLE a propósito y eso NO se toca: cuando Vision no lee un
 * monto en el comprobante la fila entra con `null`, que es el dato honesto, y el admin
 * lo resuelve al aprobar. Lo que faltaba era validar el número CUANDO viene.
 *
 * Importa porque esta columna alimenta el MRR (`webapp/src/lib/admin-revenue.ts`): un
 * monto corrupto acá no rompe una pantalla del usuario, corrompe la métrica de
 * ingresos. Y el 2026-08-04 esta misma función ya costó S/89 de sub-registro por otra
 * vía, así que es la peor superficie del repo para confiar en un número sin mirar.
 *
 * Devuelve `null` tanto para "no vino" como para "vino y no sirve": las dos cosas
 * significan lo mismo para la fila, y un monto basura preservado es peor que ausente.
 */
function montoDePago(valor, { permitirCero = false } = {}) {
  if (valor == null) return null;
  const v = validarMonto(valor, { permitirCero });
  if (v === null) {
    log.warn({ tag: 'PRO_PAGO', monto: String(valor) }, 'Monto de pago inválido: se guarda null');
  }
  return v;
}

// Ventana de validez del flag "esperando comprobante": si el usuario manda la captura
// dentro de este lapso desde que se le pidió, la tratamos como comprobante Pro.
const COMPROBANTE_VENTANA_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * Marca que el usuario debe enviar su comprobante de pago Pro.
 * Lo llaman premium.js (ver_premium), el cron de upsell/vencimiento y el onboarding.
 */
async function solicitarComprobante(usuarioId) {
  try {
    // Si este flag no queda seteado, la próxima captura del usuario se procesa como
    // GASTO en vez de comprobante Pro. supabase-js no lanza: hay que leer el error.
    const { error } = await supabase.from('usuarios')
      .update({ esperando_comprobante: true, comprobante_solicitado_at: new Date().toISOString() })
      .eq('id', usuarioId);
    if (error) log.error({ tag: 'PRO_PAGO', err: error.message, usuarioId }, 'No se pudo setear esperando_comprobante');
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'No se pudo setear esperando_comprobante');
  }
}

/**
 * ¿El usuario está esperando enviar su comprobante (y dentro de la ventana de tiempo)?
 * onboarding_paso === 2 es el flujo de registro inicial; esperando_comprobante cubre
 * a usuarios ya registrados que pidieron Pro por /premium o por el cron.
 */
function esperaComprobante(usuario) {
  if (!usuario) return false;
  if (usuario.onboarding_paso === 2) return true;
  if (!usuario.esperando_comprobante) return false;
  if (!usuario.comprobante_solicitado_at) return true;
  const t = new Date(usuario.comprobante_solicitado_at).getTime();
  if (isNaN(t)) return true;
  return (Date.now() - t) < COMPROBANTE_VENTANA_MS;
}

/**
 * Sube un comprobante (buffer de imagen) al bucket privado `comprobantes`.
 * @returns {Promise<string|null>} el path guardado, o null si no se pudo.
 */
async function subirComprobante(usuarioId, imgBuffer, mimeType) {
  if (!imgBuffer) return null;
  try {
    const ext = (mimeType && mimeType.includes('png')) ? 'png' : 'jpg';
    const path = usuarioId + '/' + Date.now() + '.' + ext;
    const { error: upErr } = await supabase.storage.from('comprobantes')
      .upload(path, Buffer.from(imgBuffer), { contentType: mimeType || 'image/jpeg', upsert: false });
    if (upErr) {
      log.error({ tag: 'PRO_PAGO', err: upErr.message }, 'Error subiendo comprobante a Storage');
      return null;
    }
    return path;
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Excepción subiendo comprobante');
    return null;
  }
}

/**
 * Notifica al admin una solicitud Pro pendiente. Prioriza Telegram con la FOTO del
 * comprobante + botones inline (aprobar mensual/anual, rechazar); si Telegram no está
 * configurado o falla, cae al aviso de texto (`notificarAdmin`, que a su vez intenta
 * Telegram texto y luego WhatsApp). Los botones inline son exclusivos de Telegram.
 */
async function notificarSolicitudAdminPro({ pagoId, usuario, from, montoDet, tipoPlan, comprobanteBuffer, mimeType, origen }) {
  const montoStr = montoDet != null && !isNaN(montoDet) ? 'S/ ' + montoDet.toFixed(2) : '(no detectado)';

  // Contexto de referido para que el admin decida con la info completa ANTES de aprobar:
  // si el usuario tiene 50% off se espera S/5 (no S/10), y quién ganará el mes gratis.
  const infoRef = await resumenReferidoParaAdmin(usuario.id);
  let refLines = '';
  if (infoRef.descuentoPct) {
    const esperado = Math.round(PRO_PRECIOS.mensual * (100 - infoRef.descuentoPct)) / 100;
    refLines += '🎟️ Referido con ' + infoRef.descuentoPct + '% off — se espera S/ ' + esperado.toFixed(2) + ' (no S/ ' + PRO_PRECIOS.mensual.toFixed(2) + ')\n';
  }
  if (infoRef.referrerNombre || infoRef.referrerId) {
    refLines += '👥 Referido de: ' + (infoRef.referrerNombre || infoRef.referrerId) + (infoRef.yaPremiado ? ' (ya premiado)' : ' — gana 1 mes gratis al aprobar') + '\n';
  }

  const caption =
    '💸 Solicitud Pro (' + (origen || 'whatsapp') + ')\n' +
    'Usuario: ' + (usuario.nombre || from) + '\n' +
    'WhatsApp: ' + from + '\n' +
    'Monto: ' + montoStr + '\n' +
    'Plan declarado: ' + tipoPlan + '\n' +
    refLines + '\n' +
    'Aprueba o rechaza abajo 👇';

  // Intento Telegram con la FOTO (bytes crudos, multipart) + botones inline.
  // Sin pagoId (el insert en `pagos` falló) los botones llevarían callback_data
  // 'pro:approve:mensual:null' y el claim reventaría al tocarlos: mejor caer al texto,
  // que trae el comando manual /pago.
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (adminChatId && comprobanteBuffer && pagoId) {
    try {
      const keyboard = [
        [{ text: '✅ Aprobar mensual', callback_data: 'pro:approve:mensual:' + pagoId }],
        [{ text: '✅ Aprobar anual', callback_data: 'pro:approve:anual:' + pagoId }],
        [{ text: '❌ Rechazar', callback_data: 'pro:reject:' + pagoId }],
      ];
      const res = await enviarTelegramFotoConBotones(adminChatId, comprobanteBuffer, mimeType, caption, keyboard);
      if (res && res.ok) return;
    } catch (e) {
      log.error({ tag: 'PRO_PAGO', err: e.message }, 'Fallo notificación Telegram con foto; uso fallback');
    }
  }

  // Fallback: texto (Telegram texto → WhatsApp). Sin botones: incluye el comando manual.
  await notificarAdmin(
    '💸 *Comprobante de pago Pro recibido* (' + (origen || 'whatsapp') + ')\n' +
    'Usuario: ' + (usuario.nombre || from) + '\n' +
    'WhatsApp: ' + from + '\n' +
    'Monto: ' + montoStr + '\n' +
    'Plan: ' + tipoPlan + '\n' +
    refLines +
    (comprobanteBuffer ? '📎 Comprobante recibido\n' : '⚠️ Sin comprobante\n') +
    '\nApruébalo en el admin (app.neto.pe/admin/operacion) o confirma aquí:\n/pago ' + from + ' ' + tipoPlan
  );
}

/**
 * Reclama ATÓMICAMENTE el derecho a abrir UNA solicitud Pro para este usuario.
 *
 * Hermano de `reclamarPagoPendiente`, que cierra la carrera del otro extremo (dos APROBACIONES
 * del mismo pago). Ésta cierra la de la ENTRADA: en el camino de la imagen, la fila del usuario
 * se lee al empezar, después vienen dos awaits caros —bajar el media de Meta y llamar a
 * Vision— y recién ahí se escribía `pago_pendiente`. Dos capturas seguidas leían las dos
 * `false` y abrían DOS solicitudes. La guarda que había cubría el REENVÍO (foto, respuesta,
 * foto), no las dos en vuelo.
 *
 * El `UPDATE ... WHERE id = ? AND pago_pendiente IS NOT TRUE` es atómico en Postgres: sólo una
 * ejecución matchea la fila, y las demás reciben `null`.
 *
 * **Cierra la carrera de WhatsApp contra WhatsApp, NO la cruzada con la webapp.** `routes/pro.js`
 * guarda contra otra columna —`select id from pagos where estado='pendiente'`— y no mira esta,
 * así que una captura por WhatsApp y una subida por la webapp en el mismo momento siguen
 * pudiendo abrir dos solicitudes. Esa ventana ya existía y este cambio no la ensancha (el
 * INSERT en `pagos` siempre estuvo detrás de la subida a Storage), pero tampoco la cierra:
 * unificar los dos guards es una decisión aparte, porque acopla el pago por web a un flag que
 * puede quedar viejo. Anotado en `docs/DEFECTOS.md`.
 *
 * **`pago_pendiente` es NULLABLE** (default `false`; 0 nulos al 2026-08-23, pero la columna lo
 * permite). En PostgREST —igual que en SQL— `pago_pendiente=eq.false` NO matchea NULL, así que
 * el `.or(...)` no es defensa de más: sin él, un solo NULL dejaría a ese usuario sin poder
 * pagar nunca, y encima contestándole que su comprobante está en verificación.
 *
 * **Un error de red NO es "otro ganó".** Se distinguen leyendo `error`, y se propaga: el
 * llamador tiene que poder decir "reenvíamela" en vez de "ya la tenemos".
 *
 * @param {string} usuarioId
 * @returns {Promise<boolean>} true si ESTA ejecución ganó el derecho a abrir la solicitud.
 * @throws si la consulta falla (indistinguible de perder la carrera si sólo se mira `data`).
 */
async function reclamarSolicitudPro(usuarioId) {
  const { data, error } = await supabase.from('usuarios')
    .update({ pago_pendiente: true, estado_pago: 'pendiente', esperando_comprobante: false })
    .eq('id', usuarioId)
    .or('pago_pendiente.is.false,pago_pendiente.is.null')
    .select('id')
    .maybeSingle();
  if (error) {
    log.error({ tag: 'PRO_PAGO', err: error.message, usuarioId }, 'No se pudo reclamar la solicitud Pro');
    throw new Error('No se pudo reclamar la solicitud Pro: ' + error.message);
  }
  return !!data;
}

/**
 * Suelta un claim que no terminó en solicitud. Es la contraparte obligatoria de
 * `reclamarSolicitudPro`, no un extra.
 *
 * El claim escribe `pago_pendiente` ANTES de que exista la fila en `pagos` —tiene que ser así,
 * si no no cierra ninguna carrera—, y eso abre un estado que antes era imposible: marcado sin
 * solicitud. Quién lo ve y qué puede hacer: WhatsApp le contesta "ya tenemos tu comprobante en
 * verificación" (falso), la webapp le esconde el formulario de pago, el panel prende el badge
 * "pendiente" sin nada que aprobar, y las dos rutas que limpian el flag —`activarPro` y
 * `rechazarSolicitudPro`— necesitan un `pagoId` o una fila pendiente que acá no existe. Para el
 * usuario del canal silencioso, que no tiene número, tampoco sirve el `/pago` manual del admin:
 * quedaría sin poder pagar por ningún canal, para siempre. Lo encontró la revisión adversarial.
 *
 * `esperando_comprobante` NO se restaura y `estado_pago` queda en `null`, no en su valor previo:
 * el claim los pisó y esos valores se perdieron. Cuesta el matiz del texto de la próxima
 * respuesta (la decisión la toma el CONTENIDO de la captura desde el 14-ago) y deja la solicitud
 * fallida sin rastro en la DB: el único registro es el aviso al admin.
 *
 * No lanza: es una compensación, y para cuando corre el admin ya recibió el aviso de que la
 * solicitud no quedó. Fallar acá sólo puede empeorar lo que se está tratando de arreglar.
 *
 * @returns {Promise<boolean>} true sólo si el claim quedó efectivamente suelto.
 */
async function liberarSolicitudPro(usuarioId) {
  try {
    // **Mira `pagos` ANTES de soltar, y por eso no es un UPDATE a secas.** Quien llama llegó
    // acá porque no recibió un `pagoId`, y eso NO prueba que no haya fila: el INSERT pudo
    // commitear y perderse la respuesta, y la webapp —que guarda contra `pagos` y no contra
    // esta columna— pudo abrir la suya en los segundos que tarda la subida a Storage más el
    // multipart a Telegram. Soltar en cualquiera de esos dos casos apaga el badge de una
    // solicitud REAL: desaparece del panel (que filtra por `pago_pendiente`) y la próxima
    // captura vuelve a ganar el claim, o sea la carrera que esto vino a cerrar. Lo midió la
    // segunda revisión adversarial.
    const { data: pendiente, error: errLeer } = await supabase.from('pagos')
      .select('id').eq('usuario_id', usuarioId).eq('estado', 'pendiente').limit(1).maybeSingle();
    // Una lectura caída NO es "no hay ninguna". Sin poder mirar, se deja el claim puesto: es el
    // estado previo a esta función, el admin ya tiene su aviso, y equivocarse hacia el otro lado
    // duplica una solicitud de plata.
    if (errLeer) {
      log.error({ tag: 'PRO_PAGO', err: errLeer.message, usuarioId }, 'No se pudo comprobar si hay solicitud: NO se suelta el claim');
      return false;
    }
    if (pendiente) {
      log.warn({ tag: 'PRO_PAGO', usuarioId, pagoId: pendiente.id }, 'Hay una solicitud pendiente: el claim se queda puesto');
      return false;
    }
    const { error } = await supabase.from('usuarios')
      .update({ pago_pendiente: false, estado_pago: null })
      .eq('id', usuarioId);
    if (error) {
      log.error({ tag: 'PRO_PAGO', err: error.message, usuarioId }, 'No se pudo soltar el claim de la solicitud Pro: el usuario queda marcado sin solicitud');
      return false;
    }
    return true;
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: msgErr(e), usuarioId }, 'Excepción soltando el claim de la solicitud Pro');
    return false;
  }
}

/**
 * Core canal-agnóstico: registra una solicitud Pro pendiente.
 *  - sube el comprobante al bucket privado
 *  - inserta una fila en `pagos` (estado pendiente, con `origen`)
 *  - marca pago_pendiente y limpia el flag de espera
 *  - notifica al admin (Telegram con la foto + botones, fallback texto)
 * NO activa Pro ni toca bancos: eso viene después de aprobar. Lo usan el canal WhatsApp
 * (procesarComprobantePro) y el canal webapp (routes/pro.js). Sirve tanto para alta como
 * para renovación (un usuario premium puede tener una solicitud pendiente sin perder su plan).
 *
 * @param {object} p
 * @param {object} p.usuario
 * @param {number|null} p.monto            monto a registrar (webapp: precio del plan)
 * @param {number|null} p.montoDetectado   monto_detectado (WhatsApp: leído por Vision)
 * @param {string} p.tipoPlan
 * @param {string} p.metodoPago
 * @param {Buffer|null} p.comprobanteBuffer bytes de la imagen del comprobante
 * @param {string} p.mimeType
 * @param {string} p.origen                'whatsapp' | 'webapp'
 * @param {boolean} [p.yaReclamado]        el llamador ya ganó `reclamarSolicitudPro`: las tres
 *                                         columnas de `usuarios` ya están escritas por ESE
 *                                         update y no se repiten (ver el bloque de abajo).
 * @returns {Promise<{pagoId:string|null, comprobantePath:string|null, usuarioMarcado:boolean}>}
 *
 * **Los tres pasos fallan por separado y ninguno lanza.** Storage, el INSERT en `pagos` y el
 * UPDATE de `usuarios` tienen cada uno su try/catch y solo loguean, así que esta función
 * devuelve normalmente aunque haya hecho la mitad. Por eso informa los tres resultados y no
 * solo el `pagoId`: quien llama desde un canal que NO puede pedirle al usuario que reintente
 * (el silencioso, ver services/registro-silencioso.js) necesita saber si quedó a medias.
 * Los canales que sí pueden responder solo miran `pagoId`, y para ellos nada cambió.
 */
async function registrarSolicitudPro({ usuario, monto, montoDetectado, tipoPlan, metodoPago, comprobanteBuffer, mimeType, origen, yaReclamado = false }) {
  const comprobantePath = await subirComprobante(usuario.id, comprobanteBuffer, mimeType);

  let pagoId = null;
  try {
    const { data, error } = await supabase.from('pagos').insert({
      usuario_id: usuario.id,
      monto: montoDePago(monto),
      moneda: 'PEN',
      tipo_plan: tipoPlan,
      metodo_pago: metodoPago || 'Yape',
      comprobante_url: comprobantePath,
      monto_detectado: montoDePago(montoDetectado),
      estado: 'pendiente',
      origen: origen || 'whatsapp',
    }).select('id').single();
    if (error) log.error({ tag: 'PRO_PAGO', err: error.message }, 'Error insertando solicitud pendiente');
    else pagoId = data && data.id;
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Excepción insertando solicitud pendiente');
  }

  // Marcar pendiente + limpiar flag de espera. NO tocamos plan ni bancos (renovación segura).
  //
  // `yaReclamado` NO es una optimización: cuando el llamador ganó el claim de
  // `reclamarSolicitudPro`, estas tres columnas YA quedaron escritas por ESE update, que es el
  // que decide quién abre la solicitud. Repetirlo no agrega estado, y su fallo produciría un
  // `usuarioMarcado:false` mentiroso — que en el canal silencioso dispara "solicitud
  // incompleta: no se marcó `pago_pendiente`" sobre una solicitud sana.
  let usuarioMarcado = yaReclamado;
  if (!yaReclamado) {
    try {
      const { error } = await supabase.from('usuarios')
        .update({ pago_pendiente: true, estado_pago: 'pendiente', esperando_comprobante: false })
        .eq('id', usuario.id);
      if (error) log.error({ tag: 'PRO_PAGO', err: error.message, usuarioId: usuario.id }, 'Error marcando pago_pendiente');
      else usuarioMarcado = true;
    } catch (e) {
      log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error marcando pago_pendiente');
    }
  }

  await notificarSolicitudAdminPro({
    pagoId,
    usuario,
    from: usuario.whatsapp,
    montoDet: montoDetectado != null ? montoDetectado : monto,
    tipoPlan,
    comprobanteBuffer,
    mimeType,
    origen,
  });

  return { pagoId, comprobantePath, usuarioMarcado };
}

/**
 * Canal WhatsApp: procesa una captura como comprobante de pago Pro.
 * Delega el registro/notificación al core `registrarSolicitudPro` (que sube la imagen y
 * notifica al admin con foto + botones) y responde al usuario que está en verificación.
 *
 * Si venía con el claim tomado y la solicitud NO quedó (`pagoId` null: el INSERT en `pagos`
 * falló y `registrarSolicitudPro` no lanza por eso), suelta el claim. Sin eso, el usuario queda
 * marcado como "tiene una solicitud" sobre una solicitud que no existe, y ninguna de las rutas
 * que limpian el flag puede alcanzarlo: no habría forma de que vuelva a pagar.
 *
 * @returns {Promise<{pagoId:string|null}>}
 */
async function procesarComprobantePro({ usuario, parsed, imgBuffer, mimeType, from, yaReclamado = false }) {
  // Se valida ACÁ, una vez, y lo validado va a los TRES consumidores.
  //
  // Antes se validaba solo al escribir la columna, y eso tapaba la mitad del problema:
  // el crudo seguía alimentando `resolverTipoPlan` —que decide el PERIODO que se
  // concede— y la tarjeta del admin, cuyo `!isNaN(montoDet)` es false para Infinity
  // (el mismo bug que este trabajo entero viene a cerrar). O sea que con un `1e999`
  // leído por Vision, la fila guardaba `null` pero el admin veía "Monto: S/ Infinity" y
  // decidía el periodo mirando eso.
  const montoDet = montoDePago(parsed && parsed.monto);
  // El monto del comprobante manda sobre el tipo_plan guardado (que puede venir viejo).
  const tipoPlan = resolverTipoPlan(montoDet, usuario.tipo_plan);

  const { pagoId } = await registrarSolicitudPro({
    usuario,
    monto: montoDet,
    montoDetectado: montoDet,
    tipoPlan,
    metodoPago: (parsed && parsed.metodo_pago) || 'Yape',
    comprobanteBuffer: imgBuffer,
    mimeType,
    origen: 'whatsapp',
    yaReclamado,
  }) || {};

  if (yaReclamado && !pagoId) await liberarSolicitudPro(usuario.id);

  await enviarWhatsapp(from, '📸 *Comprobante recibido.*\n\nEstamos verificando tu pago. Te confirmamos en breve. ⏳');
  return { pagoId: pagoId || null };
}

/**
 * Reclama ATÓMICAMENTE un pago pendiente (pendiente → aprobado) antes de activar Pro.
 * Cierra la ventana TOCTOU de doble aprobación: doble-tap en Telegram, reintento del
 * callback_query, o doble-click en el panel web. El UPDATE condicional
 * (WHERE id=? AND estado='pendiente') es atómico en Postgres, así que solo UNA ejecución
 * gana la fila; las demás reciben null y NO deben activar nada (evita apilar meses + fila duplicada).
 *
 * @param {object} p
 * @param {string} [p.pagoId]      reclama este pago puntual (canal Telegram, con pagoId)
 * @param {string} [p.usuarioId]   si no hay pagoId, reclama el pendiente más reciente del usuario (panel web)
 * @param {string} [p.aprobadoPor]
 * @returns {Promise<object|null>} la fila reclamada, o null si ya no estaba pendiente / no existe.
 */
async function reclamarPagoPendiente({ pagoId, usuarioId, aprobadoPor }) {
  let objetivoId = pagoId;
  if (!objetivoId && usuarioId) {
    const { data: pend, error } = await supabase.from('pagos').select('id')
      .eq('usuario_id', usuarioId).eq('estado', 'pendiente')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    // Una lectura fallida NO es "no hay pendiente". Devolver null aquí hacía que el panel
    // respondiera "El pago ya estaba procesado" (ok:true) sobre un pago que nadie aprobó:
    // el usuario pagaba y se quedaba en Free sin que ningún log lo delatara.
    if (error) {
      log.error({ tag: 'PRO_PAGO', err: error.message, usuarioId }, 'No se pudo leer el pago pendiente');
      throw new Error('No se pudo leer el pago pendiente: ' + error.message);
    }
    if (!pend) return null;
    objetivoId = pend.id;
  }
  if (!objetivoId) return null;
  const { data, error: errClaim } = await supabase.from('pagos')
    .update({ estado: 'aprobado', aprobado_at: new Date().toISOString(), aprobado_por: aprobadoPor || 'admin' })
    .eq('id', objetivoId)
    .eq('estado', 'pendiente')
    .select('*')
    .maybeSingle();
  // Un claim que falla por error de red es indistinguible de "otro tap ganó la fila" si
  // solo se mira data. Se distingue leyendo error, y se propaga para que el admin reintente.
  if (errClaim) {
    log.error({ tag: 'PRO_PAGO', err: errClaim.message, pagoId: objetivoId }, 'Falló el claim del pago');
    throw new Error('Falló el claim del pago: ' + errClaim.message);
  }
  return data || null;
}

/**
 * Aviso al admin, best-effort por definición: se usa en los caminos donde la plata ya se movió
 * y lo único que queda es que una persona lo arregle. Si el aviso también falla, queda el log
 * —que es lo que había antes— y nada empeora.
 */
async function avisarAdminPagos(texto) {
  // **El booleano de `notificarAdmin` NO se descarta, y ese es el punto.** Lo devuelve
  // exactamente para esto (D10, 15-ago): tragárselo hace indistinguible "salió" de "Telegram
  // estaba caído". Y acá la correlación es real — lo que produce estos avisos es una caída de
  // la DB, y el canal de respaldo del admin usa el mismo token de Telegram. Si los dos fallan,
  // al usuario ya le dijimos "ya avisamos al equipo, no hace falta que hagas nada": esta línea
  // es lo único que impide que esa frase sea falsa sin dejar rastro.
  try {
    if (!(await notificarAdmin(texto))) {
      log.error({ tag: 'PRO_PAGO', aviso: texto }, 'El aviso al admin NO salió por ningún canal');
    }
  } catch (e) { /* best-effort: el log de arriba ya salió */ }
}

/**
 * Registra/actualiza una fila en `pagos` cuando se APRUEBA un pago (activación Pro).
 * Si `pagoId` viene (fila ya reclamada atómicamente aguas arriba), solo completa el periodo.
 * Si no, comportamiento legacy: marca el pendiente aprobado, o inserta una fila nueva
 * (activación manual sin comprobante vía /pago o /activar).
 */
async function registrarPagoAprobado(usuarioId, { tipoPlan, monto, premiumDesde, premiumVence, aprobadoPor, pagoId }) {
  // `permitirCero`: la cortesía entra por acá con `monto: 0` (ver `activarPro`), y ese
  // 0 es el dato correcto. Lo que se descarta es NaN/Infinity/negativo/sobre el techo.
  const montoFinal = montoDePago(monto != null ? monto : (PRO_PRECIOS[tipoPlan] || null), { permitirCero: true });
  try {
    if (pagoId) {
      // Ya reclamado (estado/aprobado_at/aprobado_por seteados por reclamarPagoPendiente):
      // solo completa el plan/monto/periodo de esa fila puntual.
      //
      // El `monto` de la fila reclamada MANDA sobre el precio de lista, PERO solo si el
      // periodo que se está aprobando es el mismo que esa fila pidió.
      //
      // Por qué manda: `activarPro` llama acá con `monto: undefined` en toda conversión
      // pagada, así que el fallback pisaba lo que la fila ya decía. Una solicitud con el 50%
      // off de referido entraba a la cola en S/5 (`routes/pro.js` la escribe con
      // `precioProEfectivo`) y al aprobarla se guardaba S/10: `cajaDelMes` suma esta columna,
      // o sea que cada conversión con descuento inflaba la caja del mes en S/5 que nadie
      // transfirió. Es la otra mitad de B10.
      //
      // Por qué el `tipo_plan` tiene que coincidir, y esto costó una segunda revisión: el
      // periodo que se aprueba NO sale de la fila, sale del admin (`req.body.tipo_plan` en
      // /admin/aprobar-pago, `parts[2]` en el botón de Telegram). El admin ve el comprobante
      // y puede corregirlo — pidió mensual y yapeó S/99. Preservar el monto a ciegas
      // concedía 12 meses registrando S/10: sub-registro de S/89, o sea el mismo bug que
      // esto vino a arreglar pero al revés y más grande. Cuando divergen gana el precio de
      // lista del periodo APROBADO, que es lo que el admin acaba de decidir. (`resolverTipoPlan`
      // en lib/config.js existe por el mismo motivo: el tipo_plan guardado puede venir viejo.)
      //
      // Solo se preserva si la fila trae monto: un `null` (WhatsApp cuando la imagen no dio
      // monto) cae al de lista. Y un `monto` explícito del llamador gana siempre — es como el
      // comp escribe su S/0.
      let montoFila = montoFinal;
      if (monto == null) {
        const { data: filaPrevia, error: errLee } = await supabase.from('pagos')
          .select('monto, tipo_plan').eq('id', pagoId).maybeSingle();
        if (errLee) {
          log.error({ tag: 'PRO_PAGO', err: errLee.message, pagoId },
            'No se pudo leer el monto acordado: se registra el precio de lista');
        } else if (filaPrevia && filaPrevia.monto != null) {
          if (filaPrevia.tipo_plan === tipoPlan) {
            // La fila previa también se valida antes de re-escribirla: si estuviera
            // corrupta, preservarla es propagar la corrupción a la fila aprobada, que
            // es la que suma el MRR. `?? montoFinal` cae al precio de lista, que es lo
            // mismo que hace la rama de "no se pudo leer".
            montoFila = montoDePago(filaPrevia.monto, { permitirCero: true }) ?? montoFinal;
          } else {
            log.warn({ tag: 'PRO_PAGO', pagoId, pidio: filaPrevia.tipo_plan, aprobado: tipoPlan, montoFila: filaPrevia.monto },
              'El admin aprobó un periodo distinto al solicitado: se registra el precio de lista del aprobado');
          }
        }
      }
      const { error } = await supabase.from('pagos').update({
        tipo_plan: tipoPlan,
        monto: montoFila,
        premium_desde: premiumDesde,
        premium_vence: premiumVence,
      }).eq('id', pagoId);
      // **Loguear y seguir era el bug, no el manejo.** Esta función corre DESPUÉS de que
      // `activarPro` escribió el plan: Pro ya está activo y el usuario ya recibió "¡Pago
      // confirmado!", así que tirar acá sería mentir al revés. Pero callarse tampoco sirve:
      // `cajaDelMes` suma `monto` y el MRR se calcula por `premium_desde`/`tipo_plan`, o sea
      // que la fila incompleta subcuenta la caja en silencio y nadie vuelve a mirarla.
      // El único desenlace útil es que alguien la complete a mano, y para eso hay que avisar.
      //
      // Las tres escrituras de esta función comparten el arreglo —avisar, no cortar— porque
      // las tres dejan el mismo agujero contable con Pro ya activo. Lo que NO comparten es el
      // texto: cada una deja la fila en un estado distinto y el admin tiene que arreglar otra cosa.
      if (error) {
        log.error({ tag: 'PRO_PAGO', err: error.message, pagoId }, 'Pago aprobado quedó sin plan/monto/periodo');
        await avisarAdminPagos('⚠️ Pro activado, pero el pago `' + pagoId + '` quedó SIN tipo_plan/monto/periodo. El MRR lo subcuenta: complétalo a mano.');
      }
      return;
    }
    const { data: pendiente, error: errPend } = await supabase.from('pagos')
      .select('id')
      .eq('usuario_id', usuarioId)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Si no se pudo leer, NO insertar: `pagos` no tiene unique que frene el duplicado, y
    // una fila aprobada de más infla el revenue del mes y deja el pendiente huérfano.
    // Se avisa al admin para que lo registre a mano; el pendiente sigue ahí, aprobable.
    if (errPend) {
      log.error({ tag: 'PRO_PAGO', err: errPend.message, usuarioId }, 'No se pudo leer el pendiente: no se registra el pago');
      try {
        await notificarAdmin('⚠️ Pro activado para ' + usuarioId + ' pero NO se pudo registrar la fila en `pagos` (fallo de lectura). Regístralo a mano.');
      } catch (e) { /* aviso best-effort */ }
      return;
    }

    if (pendiente) {
      const { error } = await supabase.from('pagos').update({
        estado: 'aprobado',
        tipo_plan: tipoPlan,
        monto: montoFinal,
        premium_desde: premiumDesde,
        premium_vence: premiumVence,
        aprobado_at: new Date().toISOString(),
        aprobado_por: aprobadoPor || 'admin',
      }).eq('id', pendiente.id);
      // Distinto de 3.a y por eso otro texto: acá la fila NO fue reclamada atómicamente aguas
      // arriba, así que sigue en `pendiente`. No es sólo caja subcontada — el panel la muestra
      // aprobable y un segundo Aprobar le regala otro mes al usuario.
      if (error) {
        log.error({ tag: 'PRO_PAGO', err: error.message, pagoId: pendiente.id }, 'No se pudo marcar aprobado el pendiente');
        await avisarAdminPagos('⚠️ Pro activado, pero el pago `' + pendiente.id + '` sigue en PENDIENTE. Márcalo aprobado a mano antes de que alguien lo apruebe otra vez.');
      }
      return;
    }

    const { error: errIns } = await supabase.from('pagos').insert({
      usuario_id: usuarioId,
      monto: montoFinal,
      moneda: 'PEN',
      tipo_plan: tipoPlan,
      metodo_pago: 'Yape',
      estado: 'aprobado',
      premium_desde: premiumDesde,
      premium_vence: premiumVence,
      aprobado_at: new Date().toISOString(),
      aprobado_por: aprobadoPor || 'admin',
    });
    // Y acá no queda fila ninguna: sin constancia del cobro y sin nada que sumar.
    if (errIns) {
      log.error({ tag: 'PRO_PAGO', err: errIns.message, usuarioId }, 'No se pudo insertar el pago aprobado');
      await avisarAdminPagos('⚠️ Pro activado para ' + usuarioId + ' pero NO quedó fila en `pagos` (falló el insert). Regístralo a mano.');
    }
  } catch (e) {
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error registrando pago aprobado');
  }
}

/**
 * Activa Pro para un usuario (fuente única de verdad, compartida por los 3 canales de
 * aprobación: endpoint admin, comando /pago y callback de Telegram). Preserva SIEMPRE la
 * lógica de "no acortar una suscripción ya activa" (antes solo vivía en /admin/aprobar-pago)
 * y setea el set completo de columnas (antes /activar quedaba a medias).
 *
 * @param {object} p
 * @param {object} p.usuario
 * @param {string} p.tipoPlan            'mensual' | 'anual'
 * @param {string} p.aprobadoPor
 * @param {boolean} [p.enviarLinkGmail=true]  incluir el atajo al panel Pro (donde se conecta
 *   Gmail) en el mensaje. Se llamaba `enviarOAuth` cuando acá salía la URL de OAuth cruda;
 *   desde que conectar es web-only lo que viaja es el link al panel, no un grant de Google.
 * @param {boolean} [p.guardarHistorial=true]
 * @param {string|null} [p.pagoId=null]   fila de `pagos` ya reclamada atómicamente aguas arriba
 *                                        (aprobación de un pendiente); null = activación manual.
 * @param {boolean} [p.esConversionPagada=false]  true SOLO en aprobaciones de pago REAL
 *   (webapp /aprobar-pago, /pago, callback Telegram). Es el predicado de "esto fue plata" y
 *   decide dos cosas: dispara el premio de referidos al referrer, y registra la fila de `pagos`
 *   al precio de lista. Queda false en los comps (POST /admin/activar y el comando /activar de
 *   WhatsApp): un comp no puede premiar (anti-cadena) y se registra en S/0 para no inflar la
 *   caja del mes.
 * @returns {Promise<{venceStr:string, mensaje:string}>}
 */
async function activarPro({ usuario, tipoPlan, aprobadoPor, enviarLinkGmail = true, guardarHistorial = true, pagoId = null, esConversionPagada = false }) {
  const plan = tipoPlan === 'anual' ? 'anual' : 'mensual';
  const hoy = new Date();
  const mesesAdd = plan === 'anual' ? 12 : 1;
  // Toda la aritmética del periodo va sobre cadenas 'YYYY-MM-DD' en fecha Lima, no sobre
  // objetos Date. Dos motivos, y los dos costaban días de Pro:
  //
  //   · `new Date(y, m + 1, d)` hace ROLLOVER cuando el día no existe en el mes destino: un
  //     pago del 31-ene vencía el 3-mar (31 de febrero → +3 días), y un 31-mar vencía el
  //     1-may. Regalaba días en los meses cortos, y el anual repetía el patrón cada 29-feb.
  //     `sumarMeses` recorta al último día del mes destino, que es lo que espera cualquiera
  //     que pague el 31. Es la misma función que ya arregló este bug en el recordatorio de
  //     suscripciones (checkRecordatorioSuscripciones).
  //   · `new Date(...).toISOString()` mezclaba la zona del proceso con UTC: `new Date(y,m,d)`
  //     es medianoche LOCAL, así que en un servidor al este de UTC el `.split('T')[0]` caía
  //     un día antes. Hoy Railway corre en UTC y no se nota; es una trampa esperando una
  //     variable de entorno.
  const hoyStr = hoyPeru();
  const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  // Renovación: si la suscripción sigue vigente, apilamos el periodo SOBRE el vencimiento
  // actual (no desde hoy); si venció o no existe, contamos desde hoy. Nunca acorta.
  // Comparar cadenas 'YYYY-MM-DD' es comparar fechas: el orden lexicográfico es el cronológico.
  let base = hoyStr;
  if (usuario.premium_vence) {
    const actual = String(usuario.premium_vence).slice(0, 10);
    if (esFecha(actual) && actual > base) base = actual;
  }
  // Pagar durante el trial NO cuesta los días que faltaban. Sin esto, quien decide al
  // día 3 pierde 11 días de prueba por decidirse rápido — o sea que el sistema castiga
  // exactamente la conversión temprana que queremos. `premium_vence` está NULL durante
  // el trial (así los trials le son invisibles a checkPremiumExpiry), así que el periodo
  // se apila sobre trial_vence.
  if (usuario.trial_estado === 'activo' && usuario.trial_vence) {
    const finTrial = String(usuario.trial_vence).slice(0, 10);
    if (esFecha(finTrial) && finTrial > base) base = finTrial;
  }
  const venceStr = sumarMeses(base, mesesAdd);
  const desde = usuario.premium_desde || hoyStr;

  const update = {
    plan: 'premium', estado_pago: 'pagado', tipo_plan: plan,
    // `fecha_vencimiento` es la columna legacy (timestamptz); la viva es `premium_vence`.
    // Se ancla al mediodía de Lima para que las dos nombren SIEMPRE el mismo día, mire
    // quien la mire y desde la zona que sea.
    fecha_pago: hoy.toISOString(), fecha_vencimiento: new Date(venceStr + 'T12:00:00-05:00').toISOString(),
    premium_desde: desde, premium_vence: venceStr,
    pago_pendiente: false, esperando_comprobante: false,
    // Sella el trial: convirtió. Deja de contar como prueba en las métricas de MRR
    // (que filtran trial_estado <> 'activo') y no vuelve a tener otro nunca, ni siquiera
    // si más adelante churnea. Se escribe aunque nunca haya tenido trial: un pagador
    // tampoco debería ganarse una prueba retroactiva.
    trial_estado: 'convertido',
  };
  // El 50% off de referido es "tu PRIMER mes": una conversión pagada lo consume. Sin esto
  // quedaba vivo hasta 7 días más (la ventana se ancla al fin del trial), y ese residuo no
  // era cosmético: `POST /pro/solicitud` calcula el monto esperado con `precioProEfectivo`,
  // así que una RENOVACIÓN pedida dentro de esa ventana se registraba en S/5 en vez de S/10
  // y el admin aprobaba media mensualidad sin enterarse.
  //
  // Solo lo consume el pago REAL. Un comp (`esConversionPagada: false`) no gasta el primer
  // mes de nadie: sería quitarle el incentivo al referido por un regalo nuestro.
  //
  // Los dos lectores de la webapp (el banner del dashboard y /api/pro/status) ya lo ocultan
  // por `esProPagado`, así que esto no cambia nada de lo que el usuario ve — cierra el
  // camino que sí movía plata, y de paso deja de haber un descuento vigente en una fila que
  // ya pagó, que es lo que hacía falsa cualquier consulta futura sobre la tabla.
  if (esConversionPagada) {
    update.referido_dscto_pct = null;
    update.referido_dscto_vence = null;
  }
  // Desatasca el alta cuando el pago llega con el usuario parado en el paso 2 (la espera del
  // comprobante). Sin esto `esperaComprobante()` sigue devolviendo true para siempre (mira
  // onboarding_paso === 2), y el usuario ya premium recibe "elige tu plan / mándame la captura"
  // ante cualquier mensaje sin '/': pagó y no puede ni registrar un gasto. Pasó de verdad
  // (2026-07-21, aprobación por Telegram): antes esto solo lo hacía el comando /pago vía flag,
  // y las otras tres rutas de aprobación dejaban al usuario trabado.
  // `onboarding_completado` va en el mismo update a propósito: soltar el paso sin marcarlo deja
  // al usuario sin Gmail cayendo en el trigger de usuario nuevo (webhook → paso 100), o sea de
  // vuelta en "¿cómo te llamas?" pese a haber dado nombre y correo.
  if (usuario.onboarding_paso === 2) {
    update.onboarding_paso = 0;
    update.onboarding_completado = true;
  }
  // Esta escritura ES la activación. Si falla y seguimos, el usuario recibe
  // "¡Pago confirmado!", la fila de `pagos` queda aprobada y el plan sigue en Free:
  // pagó, el sistema dice que sí, y no tiene Pro. Se corta acá.
  const { error: errPlan } = await supabase.from('usuarios').update(update).eq('id', usuario.id);
  if (errPlan) {
    log.error({ tag: 'PRO_PAGO', err: errPlan.message, usuarioId: usuario.id }, 'No se pudo activar Pro');
    // El pago ya fue reclamado como aprobado aguas arriba. Sin devolverlo a pendiente, el
    // reintento del admin encontraría "ya procesado" y el usuario quedaría en Free para siempre.
    if (pagoId) {
      const { error: errRollback } = await supabase.from('pagos')
        .update({ estado: 'pendiente', aprobado_at: null, aprobado_por: null })
        .eq('id', pagoId);
      if (errRollback) {
        log.error({ tag: 'PRO_PAGO', err: errRollback.message, pagoId }, 'El pago quedó aprobado sin Pro activo: revisar a mano');
        try { await notificarAdmin('🚨 Pago ' + pagoId + ' quedó APROBADO pero Pro NO se activó y no se pudo revertir. Revisar a mano.'); } catch (e) { /* best-effort */ }
      }
    }
    throw new Error('No se pudo activar Pro: ' + errPlan.message);
  }

  // Un comp se registra en `pagos` (constancia de quién lo otorgó y por qué periodo) pero
  // vale S/0: `cajaDelMes` (webapp/src/lib/admin-revenue.ts) suma el `monto` de los pagos
  // aprobados del mes, así que dejarlo en el precio de lista haría figurar como cobrado un
  // mes que nadie transfirió. `esConversionPagada` ya es exactamente ese predicado: hoy es
  // true solo en los tres caminos de pago real. `undefined` deja el default (precio de lista).
  await registrarPagoAprobado(usuario.id, {
    tipoPlan: plan,
    monto: esConversionPagada ? undefined : 0,
    premiumDesde: desde, premiumVence: venceStr,
    aprobadoPor: aprobadoPor || 'admin', pagoId,
  });

  // Modelo de referidos dos-lados: si este usuario fue referido y ESTA es una conversión
  // PAGADA real (no comp), su referrer gana 1 mes. El grant al referrer se escribe directo
  // (plan:'premium') dentro de procesarConversionProReferido, NUNCA re-entra a activarPro:
  // así un comp o el propio premio no encadenan. Best-effort: jamás romper el pago.
  if (esConversionPagada) {
    try { await procesarConversionProReferido(usuario.id); }
    catch (e) { log.error({ tag: 'PRO_PAGO', err: e.message, usuarioId: usuario.id }, 'No se pudo procesar el premio de referido'); }
  }

  // Antes acá salía la URL de OAuth cruda, y era el único emisor exento del gate de Pro
  // pagado (la fila en memoria todavía es la de antes del UPDATE de arriba). Ahora conectar
  // Gmail es web-only, así que lo que se manda es el atajo al panel — y de paso desaparece
  // la excepción: este archivo ya no emite OAuth.
  //
  // El destino depende de la identidad: quien tiene cuenta web entra directo; quien es
  // WhatsApp-only necesita el link firmado, porque /dashboard/pro lo dejaría en /login sin
  // forma de vincularse a su número. `linkPanelPro` es dueño de esa decisión.
  let linkPanel = '';
  if (enviarLinkGmail) {
    // `usuario` es la fila previa al UPDATE, pero las dos columnas que mira linkPanelPro
    // (id y supabase_auth_id) no las toca este flujo: siguen siendo verdad.
    linkPanel = linkPanelPro(usuario) || '';
    if (!linkPanel) log.warn({ tag: 'PRO_PAGO', usuarioId: usuario.id }, 'No se pudo armar el link al panel Pro');
  }
  const cierre = linkPanel
    ? 'Conecta tu Gmail desde tu app y Neto empieza a leer tus correos bancarios solo:\n\n🔗 ' + linkPanel + '\n\n_Solo notificaciones bancarias. Sin contraseñas._'
    : '_Gracias por confiar en NETO._ 💚';
  // El comp no recibe el mensaje de pago. No es cosmética: al regalado se le estaba diciendo
  // "Pago confirmado — Plan Mensual S/10/mes", o sea confirmándole un cobro que no existió, y
  // el comp casi siempre ES la jugada de marketing (un influencer, alguien a quien quieres de
  // tu lado). Ramifica por `esConversionPagada`, el mismo predicado que ya decide el premio de
  // referidos y el monto registrado: un predicado, tres consecuencias, un solo sitio. No es un
  // parámetro de copy nuevo a propósito, para no reabrir la divergencia de mensajes que la
  // unificación de /admin/activar vino a cerrar.
  const mensaje = esConversionPagada
    ? '✅ *¡Pago confirmado!*\n\n' +
      'Plan: *' + (plan === 'anual' ? 'Anual (S/' + PRO_PRECIOS.anual + '/año)' : 'Mensual (S/' + PRO_PRECIOS.mensual + '/mes)') + '*\n' +
      'Vence: ' + venceStr + '\n\n' + cierre
    : '⭐ *¡Bienvenido a Neto Pro!*\n\n' +
      'Te activamos Pro hasta el ' + venceStr + ', sin costo.\n\n' +
      '✅ Dashboard e historial completos\n✅ Reportes y resumen semanal\n✅ Categorías personalizadas\n\n' + cierre;
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id,
    whatsapp: usuario.whatsapp || null,
    tipo: esConversionPagada ? 'pro_activado' : 'pro_activado_comp',
    mensaje,
    titulo: '¡Tu Pro fue activado! ⭐',
    cuerpo: 'Ya tienes acceso completo a Neto Pro. Vence el ' + venceStr + '.',
    tipoInApp: 'pro',
    link: '/dashboard/pro',
  });
  if (guardarHistorial) {
    try { await guardarMensaje(usuario.id, 'neto', mensaje); } catch (e) { /* historial best-effort */ }
  }

  return { venceStr, mensaje };
}

/**
 * Rechaza una solicitud Pro pendiente: marca el pago rechazado, limpia pago_pendiente
 * y avisa al usuario (in-app + WhatsApp). No toca el plan (sigue Free).
 *
 * **Por qué el limpiado de `pago_pendiente` no puede loguear y seguir.** Es la misma clase que
 * 9A —el error descartado— una llamada más abajo, pero acá el síntoma no es un mensaje falso:
 * es un estado sin salida. `reclamarSolicitudPro` pide
 * `.or('pago_pendiente.is.false,pago_pendiente.is.null')`, así que con el flag trabado en true
 * ese claim NO vuelve a ganarse nunca. El usuario reenvía la captura y WhatsApp le contesta
 * "ya tenemos tu comprobante en verificación" para siempre. Es exactamente el estado que
 * `liberarSolicitudPro` documenta como imposible de limpiar solo: `activarPro` y esta función
 * necesitan un `pagoId` o una fila pendiente, y tras el rechazo ya no hay ninguna.
 *
 * **Qué queda bloqueado, con precisión, porque acá decía "por ningún canal" y era de más.**
 * WhatsApp sí queda cerrado (es el claim de arriba). La webapp también, pero por OTRA columna:
 * `webapp/src/lib/plan.ts` pinta la pantalla 'pendiente' mirando `pago_pendiente`, así que el
 * formulario desaparece. Lo que NO bloquea es la API cruda — `routes/pro.js` guarda contra
 * `pagos.estado='pendiente'` y tras el rechazo el pago está en `rechazado`, o sea que un POST
 * directo pasaría. Para la persona el estado es sin salida igual; la distinción importa porque
 * `reclamarSolicitudPro` ya documenta 600 líneas más arriba que la webapp guarda contra otra
 * columna, y afirmar lo contrario acá dejaba dos docblocks del mismo archivo peleados.
 *
 * De ahí las tres consecuencias: se avisa al admin (única forma de destrabarlo), el mensaje al
 * usuario NO le promete un camino cerrado, y se devuelve el estado para que el canal admin diga
 * la verdad en vez de "Rechazado".
 *
 * @returns {Promise<{claimLimpio: boolean}>} `claimLimpio:false` = el usuario quedó trabado.
 */
async function rechazarSolicitudPro({ pagoId, usuario, motivo }) {
  let claimLimpio = true;
  try {
    if (pagoId) {
      const { error } = await supabase.from('pagos')
        .update({ estado: 'rechazado', notas: motivo || 'Rechazado por admin' })
        .eq('id', pagoId);
      // Si no se marca, la fila sigue pendiente y puede aprobarse después de haberle
      // dicho al usuario que su pago no era válido.
      if (error) log.error({ tag: 'PRO_PAGO', err: error.message, pagoId }, 'No se pudo marcar el pago como rechazado');
    }
    // estado_pago tiene un CHECK (pendiente|pagado|vencido); en rechazo lo limpiamos a NULL.
    const { data: filasLimpias, error: errUsr } = await supabase.from('usuarios')
      .update({ pago_pendiente: false, estado_pago: null, esperando_comprobante: false })
      .eq('id', usuario.id)
      .select('id');
    if (errUsr) {
      claimLimpio = false;
      log.error({ tag: 'PRO_PAGO', err: errUsr.message, usuarioId: usuario.id }, 'No se pudo limpiar pago_pendiente tras rechazo: el usuario queda sin poder volver a pagar');
      await avisarAdminPagos('🚨 Rechacé el pago de ' + usuario.id + ' pero NO pude limpiar `pago_pendiente`. No va a poder reenviar comprobante por ningún canal hasta que lo pongas en false a mano.');
    } else if (!filasLimpias || filasLimpias.length === 0) {
      // "0 filas" acá NO es el estado trabado y por eso no avisa al admin: el WHERE es sólo por
      // `id`, así que cero filas significa que la fila del usuario no está. Sin fila no hay flag
      // que trabe nada, y avisar mandaría a buscar un `pago_pendiente` que no existe. La
      // distinción sólo se ve con `.select('id')`: sin él los dos casos llegan con `error: null`.
      log.warn({ tag: 'PRO_PAGO', usuarioId: usuario.id }, 'El limpiado de pago_pendiente no afectó ninguna fila: el usuario ya no está');
    }
  } catch (e) {
    // El throw entra acá con el flag en un estado desconocido. Se trata como trabado: el aviso
    // de más es barato, el usuario mudo para siempre no.
    claimLimpio = false;
    log.error({ tag: 'PRO_PAGO', err: e.message }, 'Error rechazando solicitud');
    await avisarAdminPagos('🚨 Falló el rechazo del pago de ' + usuario.id + '. Revisa `pago_pendiente`: puede haber quedado trabado.');
  }
  // El copy cambia según el estado, y no es cosmética: "reenvíanos la captura correcta" describe
  // un camino que con el claim trabado NO existe —WhatsApp le contestaría "ya tenemos tu
  // comprobante en verificación"—, así que mandarlo ahí es la confirmación falsa de siempre con
  // otra ropa.
  const mensaje = claimLimpio
    ? '⚠️ *No pudimos validar tu pago Pro*\n\n' +
      (motivo ? motivo + '\n\n' : '') +
      'Si ya yapeaste S/' + PRO_PRECIOS.mensual + ' (mensual) o S/' + PRO_PRECIOS.anual + ' (anual) a *Favio Mendoza* (970398192), reenvíanos la captura correcta desde app.neto.pe/dashboard/pro o por aquí. 📸'
    : '⚠️ *No pudimos validar tu pago Pro*\n\n' +
      (motivo ? motivo + '\n\n' : '') +
      'Tuvimos un problema al liberar tu solicitud, así que por ahora no vas a poder reenviar el comprobante. Ya avisamos al equipo y lo destrabamos nosotros — no hace falta que hagas nada. 🙏';
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id,
    whatsapp: usuario.whatsapp || null,
    tipo: 'pro_rechazado',
    mensaje,
    titulo: 'No pudimos validar tu pago',
    cuerpo: motivo || 'Revisa tu comprobante y vuelve a enviarlo desde Pasar a Pro.',
    tipoInApp: 'pro',
    link: '/dashboard/pro',
  });
  return { claimLimpio };
}

module.exports = {
  solicitarComprobante,
  esperaComprobante,
  subirComprobante,
  reclamarSolicitudPro,
  liberarSolicitudPro,
  registrarSolicitudPro,
  procesarComprobantePro,
  activarPro,
  rechazarSolicitudPro,
  reclamarPagoPendiente,
  registrarPagoAprobado,
  esPagoNeto,
  detectarTipoPlan,
  PRO_PRECIOS,
};
