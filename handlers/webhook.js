const crypto = require('crypto');
const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { CATEGORIAS_SUGERIDAS, MESES } = require('../lib/constants');
const { getEmojiCategoria, formatearResumen, formatearCategoriasMsg, generarRefCode, formatFecha } = require('../lib/formatters');
const { enviarWhatsapp, procesarStatuses } = require('../lib/whatsapp');
const { ADMIN_NUMBER, PRO_PRECIOS, lineaPrecioPro } = require('../lib/config');
const { guardarTransaccion, obtenerGastosMes, recategorizarTransaccion } = require('../services/transactions');
const { guardarPresupuesto, formatearEstadoPresupuesto } = require('../services/budget');
const { parsearCorreoBancario } = require('../services/parsers');
const { notificarErrorAdmin, notificarAdmin } = require('../lib/admin-notify');
const { registrarError, msgErr } = require('../lib/error-monitor');
const { registrarReferido, obtenerEstadisticasReferidos, mensajeMisReferidos } = require('../services/referrals');
const { obtenerCategoriasUsuario } = require('../services/categories');
const { subcategoriaUtil } = require('../lib/subcategoria');
const { escanearGmailYRegistrar } = require('../services/gmail-scanner');
const { tieneGmailConectado } = require('../gmail');
const { registrarGastoSilencioso, registrarAudioSilencioso, registrarImagenSilenciosa, avisarPrimeraVezSilencioso } = require('../services/registro-silencioso');
const { verificarCuentaWebPorBsuid } = require('../services/otp-sin-numero');
const { descargarMedia, transcribirAudio, extraerPagoDeImagen } = require('../services/media-intake');
const { generarResumenSemanal } = require('../services/summaries');
const { guardarMensaje, obtenerOCrearUsuario, getUserPlanConfig, buscarUsuarioPorBsuid } = require('../helpers/db-helpers');
const { checkProWall } = require('../helpers/pro-wall');
const { parseCSV, parseExcel } = require('../services/import-parser');
const { esperaComprobante, esPagoNeto, procesarComprobantePro, reclamarSolicitudPro } = require('../lib/pro-payment');
const { procesarComandoAdmin } = require('./admin-commands');
const premiumIntents = require('./intents/premium');
const { abrirSesion, cerrarSesion } = require('../lib/support-tickets');
const { manejarOnboarding } = require('./onboarding');
const { colaConfirmacionGasto, estaEnMuro, mensajeMuro, mensajeCargaMasivaPro, esProPagado, mensajeGmailProPagado, mensajeConectarEnLaApp, mensajeGmailDesconectado } = require('../lib/trial');
const { comandoRequiereLectura } = require('./intents-acceso');
const { verificarEscritura, entro } = require('../helpers/escritura-verificada');
const analytics = require('../lib/analytics');

// Idempotencia por wamid: Meta retransmite el webhook cada 30s si OpenAI demora >timeout.
// Map preserva orden de inserción → LRU. TTL 5 min, max 1000 entries.
// Cero delay, cero serialización: solo evita reprocesar el mismo message.id.
const WAMID_CACHE_TTL_MS = 5 * 60 * 1000;
const WAMID_CACHE_MAX = 1000;
const wamidCache = new Map();
function isDuplicateWamid(wamid) {
  if (!wamid) return false;
  const now = Date.now();
  const insertedAt = wamidCache.get(wamid);
  if (insertedAt !== undefined && now - insertedAt < WAMID_CACHE_TTL_MS) return true;
  if (insertedAt !== undefined) wamidCache.delete(wamid);
  if (wamidCache.size >= WAMID_CACHE_MAX) wamidCache.delete(wamidCache.keys().next().value);
  wamidCache.set(wamid, now);
  return false;
}

// Rate limit anti fuerza-bruta del OTP inverso: el código es global-by-code (el número no se
// conoce hasta que se envía, ese es el modelo de posesión), así que la defensa contra adivinar
// el código de otra persona es el throttle. Máx 5 intentos por número cada 15 min. In-memory
// (asume single-instance, ver supuesto documentado del backend).
const OTP_MAX_INTENTOS = 5;
const OTP_VENTANA_MS = 15 * 60 * 1000;

// Throttle del aviso de vinculación por BSUID. Los desenlaces accionables dejan el código vivo a
// propósito, así que la persona reenvía y sin esto cada reenvío es otro Telegram idéntico. Mismo
// papel que `ALERT_COOLDOWN_MS` en `lib/error-monitor.js`. In-memory, como el resto de los
// throttles del backend (ver el supuesto de instancia única en el CLAUDE.md).
const AVISO_VINCULACION_COOLDOWN_MS = 10 * 60 * 1000;
const avisosVinculacion = new Map();
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const otpIntentos = new Map(); // from → { count, ts }
function otpRateLimited(from) {
  const now = Date.now();
  const e = otpIntentos.get(from);
  if (!e || now - e.ts > OTP_VENTANA_MS) { otpIntentos.set(from, { count: 1, ts: now }); return false; }
  e.count += 1;
  return e.count > OTP_MAX_INTENTOS;
}
/**
 * Aviso al admin de una vinculación por BSUID. Es el desenlace de alguien a quien NO se le puede
 * contestar, así que este Telegram es el único acuse que existe de que el trámite salió.
 *
 * **No avisa de todo, y la selección es la que evita que el aviso se vuelva ruido:** los éxitos
 * repetidos (`ya_vinculada`, que es lo que devuelve el reenvío del mismo código) y los códigos
 * mal tipeados (`invalido`) no dicen nada nuevo. Lo que sí se avisa es la primera vinculación
 * —porque desde ese momento hay un usuario vivo y mudo, y conviene saber quién es— y el
 * `conflicto`, que es el único desenlace que necesita una mano humana.
 */
async function avisarVinculacionPorBsuid(bsuid, r) {
  const EXITO = ['vinculada', 'fusionada', 'adoptada'];
  const ACCIONABLES = ['conflicto', 'vinculada_sin_destrabar'];
  if (!EXITO.includes(r.estado) && !ACCIONABLES.includes(r.estado)) return;
  // **Los fixtures no avisan.** Este camino se verifica con un harness que le pega al webhook de
  // PRODUCCIÓN, así que sin este corte cada corrida le manda un Telegram real a Favio. Es el
  // falso positivo del 13-ago-2026, que además llegaba con un comando listo para ejecutar. Se usa
  // `is_test_user` y no una marca nueva porque es la que ya consulta `enviarWhatsapp` para no
  // llamar a Meta, y un usuario real nunca la lleva.
  if (r.esTest) {
    log.info({ tag: 'OTP_BSUID', bsuid, estado: r.estado }, 'Vinculación de un fixture: no se avisa');
    return;
  }
  // **Throttle por (bsuid, estado), y no es precaución teórica.** Los dos desenlaces accionables
  // dejan el código VIVO a propósito, o sea que el diseño cuenta con que la persona reenvíe — y
  // Julio reenvió 9 veces en 9 minutos. Sin esto, una base con hipo produce 9 Telegrams idénticos
  // en un minuto, cada uno con su comando de arreglo. `error-monitor` tiene `ALERT_COOLDOWN_MS`
  // exactamente para esto. Lo encontró la revisión adversarial, ejecutando el caso.
  const clave = bsuid + ':' + r.estado;
  const ahora = Date.now();
  const ultimo = avisosVinculacion.get(clave);
  if (ultimo && ahora - ultimo < AVISO_VINCULACION_COOLDOWN_MS) {
    log.info({ tag: 'OTP_BSUID', bsuid, estado: r.estado }, 'Aviso de vinculación throttleado');
    return;
  }
  avisosVinculacion.set(clave, ahora);
  const quien = [r.nombre, r.email].filter(Boolean).join(' · ') || 'sin datos';
  // El vínculo se escribió pero la señal que destraba la webapp no. La persona sigue mirando el
  // spinner y NO tiene canal por el que enterarse, así que este aviso es el único camino hacia
  // el arreglo: marcar la fila a mano.
  if (r.estado === 'vinculada_sin_destrabar') {
    try {
      await notificarAdmin(
        '⚠️ VINCULACIÓN A MEDIAS POR BSUID\n\n' +
        'Se escribió el vínculo pero NO se pudo marcar el código como verificado, así que la ' +
        'persona sigue viendo "Esperando tu confirmación..." y no hay forma de avisarle.\n\n' +
        '👤 ' + quien + '\n🆔 ' + bsuid + '\n\n' +
        // **El comando lleva el `usuarioId`, no el BSUID concatenado.** La versión anterior armaba
        // un `where bsuid = '<valor del webhook>'` pegando texto que llega de Meta: una sentencia
        // lista para copiar en una consola con service-role, construida por concatenación desde un
        // campo externo. No era explotable (pasa por el HMAC), pero el id es un UUID que ya viene
        // resuelto en `r.usuarioId` y además ahorra el subquery.
        // En SQL las comillas DOBLES delimitan identificadores, no cadenas, así que el literal va
        // entre simples — y sólo se emite si el id tiene forma de UUID. Si no la tiene, el aviso
        // sale sin comando: mejor que entregar uno que no se puede pegar.
        (ES_UUID.test(String(r.usuarioId || ''))
          ? '👉 Arreglo: update webapp_otp set verified_at = now() where supabase_auth_id = '
            + "(select supabase_auth_id from usuarios where id = '" + r.usuarioId + "');"
          : '👉 Buscá su fila por el BSUID de arriba y marcá `verified_at` a mano.')
      );
    } catch (e) {
      log.error({ tag: 'OTP_BSUID', bsuid, err: e && e.message }, 'No se pudo avisar la vinculación a medias');
    }
    return;
  }
  // Texto plano, igual que el resto: `lib/telegram.js` manda sin `parse_mode` y ADEMÁS le saca
  // los asteriscos, así que ni Markdown ni HTML sirven acá — el HTML saldría con las etiquetas
  // a la vista. Es la decisión que evita que un envío falle por formato desbalanceado.
  const msg = r.estado === 'conflicto'
    ? '⚠️ VINCULACIÓN POR BSUID EN CONFLICTO\n\n' +
      'Alguien sin número visible mandó un código válido y no se pudo vincular solo.\n\n' +
      '👤 ' + quien + '\n🆔 ' + bsuid + '\n\n' +
      'Necesita revisión manual: hay dos filas que no se pueden fusionar automáticamente.'
    : '🔗 CUENTA VINCULADA POR BSUID\n\n' +
      'Un usuario con el número oculto (WhatsApp Usernames) completó la verificación de su ' +
      'cuenta web. Su onboarding se destrabó.\n\n' +
      '👤 ' + quien + '\n🆔 ' + bsuid + '\n\n' +
      '⚠️ No se le puede responder por WhatsApp. Sus gastos se van a registrar en silencio y ' +
      'los ve sólo en app.neto.pe. No espera un "listo, anotado".';
  try { await notificarAdmin(msg); } catch (e) {
    // El aviso no puede tumbar la vinculación, que es lo que le importa a la persona.
    log.error({ tag: 'OTP_BSUID', bsuid, err: e && e.message }, 'No se pudo avisar la vinculación');
  }
}

/**
 * Devuelve la ficha que `otpRateLimited` acaba de cobrar. **Sólo se llama cuando el intento
 * fracasó por NUESTRO lado** (una lectura que no se pudo hacer), nunca por un código malo.
 *
 * Hace falta porque el contador se incrementa ANTES de leer nada: sin esto, cinco hipos de
 * Supabase seguidos dejan a la persona con *"Demasiados intentos de verificación, espera unos
 * minutos"* durante 15 minutos, castigada por un fallo del servidor mientras el mensaje que
 * acaba de recibir la invita a reintentar en un minuto. Lo encontró la revisión adversarial.
 *
 * No debilita la defensa contra la fuerza bruta: adivinar un código no pasa por acá. Las cinco
 * ramas que la devuelven son de dos clases y ninguna la puede provocar el remitente: dos exigen
 * que falle una lectura nuestra, y las otras TRES son posteriores a haber encontrado el código
 * —o sea que quien llega ya presentó uno válido y vigente— y fallan por el link, por el
 * `merge_and_link` o por una excepción.
 *
 * **La regla es el par, no la rama:** si un camino le dice a la persona que reintente y el
 * motivo es NUESTRO, tiene que devolver la ficha. La primera versión de este arreglo cubría
 * sólo las dos lecturas y dejaba las otras tres invitando a reintentar con la ficha cobrada
 * — o sea el mismo bug, en las ramas nuevas del propio commit. Lo encontró la revisión
 * adversarial del arreglo.
 */
function otpDevolverIntento(from) {
  const e = otpIntentos.get(from);
  if (e && e.count > 0) e.count -= 1;
}

// Límite POR REMITENTE, y vive acá y no en el limiter de `index.js` por una razón que no es
// de estilo: el de index.js corre ANTES del HMAC, así que la identidad que ve es la que el
// atacante escribió. Acá la firma ya se verificó, o sea que `from` (o el BSUID) lo puso Meta.
// Es la mitad de S′5 que el keyGenerator no podía dar: el otro limiter protege contra un
// flood anónimo, este contra un remitente autenticado que quema presupuesto de OpenAI.
//
// 60 por minuto es un orden de magnitud sobre el uso real (el usuario más activo manda ~10
// mensajes en una ráfaga de multi-gasto). Un remitente por encima de eso no está usando el
// producto.
//
// In-memory, como `wamidCache` y `otpIntentos`: asume single-instance, que es el supuesto
// documentado del backend. Con N réplicas el límite efectivo sería 60×N — degrada holgando,
// no cerrando, que es la dirección correcta para algo que puede descartar un gasto real.
//
// Los callbacks de STATUS no pasan por acá a propósito: no los origina un usuario sino
// nuestros propios envíos, así que un cron grande los dispararía en ráfaga y throttlearlos
// perdería el aprendizaje de BSUID justo en el pico.
const REMITENTE_MAX = 60;
const REMITENTE_VENTANA_MS = 60 * 1000;
const REMITENTE_CACHE_MAX = 5000;   // cota de memoria: el Map no puede crecer sin techo
const remitenteHits = new Map();    // clave → { count, ts }
function limiteRemitenteSuperado(clave) {
  if (!clave) return false;         // sin identidad verificable no hay a quién contarle
  const now = Date.now();
  const e = remitenteHits.get(clave);
  if (!e || now - e.ts > REMITENTE_VENTANA_MS) {
    if (remitenteHits.size >= REMITENTE_CACHE_MAX) remitenteHits.delete(remitenteHits.keys().next().value);
    remitenteHits.set(clave, { count: 1, ts: now });
    return false;
  }
  e.count += 1;
  return e.count > REMITENTE_MAX;
}

function createWebhookHandler(procesarMensajeLibre) {
  return async function webhookHandler(req, res) {
  const META_APP_SECRET = process.env.META_APP_SECRET;
  if (!META_APP_SECRET) {
    log.error({ tag: 'WEBHOOK' }, 'META_APP_SECRET no configurado — rechazando request');
    return res.sendStatus(500);
  }
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    log.warn({ tag: 'WEBHOOK' }, 'Request sin X-Hub-Signature-256');
    return res.sendStatus(403);
  }
  // `rawBody` solo lo puebla el `verify` de express.json(), que NO corre si el Content-Type
  // no es JSON. Sin esta guarda, un POST con `Content-Type: text/plain` y CUALQUIER valor en
  // el header de firma hacía que `createHmac().update(undefined)` lanzara un TypeError — y
  // como esta línea vive fuera del try, terminaba en el error handler de Express, que escribe
  // una fila con stack en la tabla `errores`. Esa escritura no tiene throttle (el cooldown de
  // 5 min es de `notificarErrorAdmin`, no del INSERT), así que era un camino sin autenticar
  // para llenar Supabase, que acá es capa única: tumbarla apaga WhatsApp, webapp y crons.
  //
  // Va antes del HMAC y no dentro del try a propósito: un request sin rawBody no puede tener
  // firma válida, así que la respuesta correcta es la misma que para una firma inválida.
  // El `length === 0` no es decorativo, pero tampoco tapa un agujero: un rawBody vacío ya
  // caía en 403 por la comparación de firma (nadie puede forjar el HMAC del buffer vacío sin
  // el secreto). Se cubre acá para que el 403 salga por la razón correcta y no dependa de que
  // el HMAC de la nada resulte no matchear.
  if (!req.rawBody || req.rawBody.length === 0) {
    log.warn({ tag: 'WEBHOOK' }, 'Request sin rawBody (Content-Type no JSON)');
    return res.sendStatus(403);
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  // Guarda de longitud: timingSafeEqual lanza RangeError si los buffers difieren en
  // largo. Sin esto, una firma malformada responde 500 (en vez de 403) y dispara la
  // notificación de error al admin. Mismo patrón que telegram-webhook.js.
  if (sigBuf.length !== expBuf.length) {
    log.warn({ tag: 'WEBHOOK' }, 'Firma HMAC con largo invalido');
    return res.sendStatus(403);
  }
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
    log.warn({ tag: 'WEBHOOK' }, 'Firma HMAC invalida');
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  // `from` se declara fuera del try para que el catch pueda referenciarlo al
  // registrar el error. Antes vivía dentro del try (const block-scoped) y el
  // catch crasheaba con "from is not defined", tragándose el stack del error
  // original y generando un unhandled rejection fantasma.
  let from;
  try {
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const messages = value && value.messages;
    // Callbacks de status (delivered/read/failed). Vienen en el mismo campo del
    // webhook que los mensajes, pero sin `value.messages`, así que antes caían en el
    // return de abajo y se descartaban en silencio: por eso `estado='sent'` era todo
    // lo que sabíamos de una notificación proactiva.
    if (value && value.statuses && value.statuses.length > 0) {
      await procesarStatuses(value.statuses);
      return;
    }
    if (!messages || messages.length === 0) return;
    const message = messages[0];
    from = message.from;
    // El BSUID del remitente, cuando Meta lo manda. Medido con tráfico real el 08-ago-2026:
    // hoy llega en TODOS los mensajes, junto al número (`contacts[0]` trae `wa_id` Y
    // `user_id`). Esa coincidencia es la ventana entera: mientras el usuario siga mandando
    // número se le aprende el BSUID (migración 065), y cuando active un username —y `from`
    // deje de venir— es lo único que lo reconecta con su cuenta.
    const bsuid = message.from_user_id || null;
    // El dedup va ANTES del descarte por falta de `from`, no después. Meta retransmite el
    // webhook cada 30s si tardamos, y desde que el camino sin `from` corre Vision y Whisper,
    // cada retransmisión de una foto costaba otra llamada a GPT-4o. (El dedup de
    // `guardarTransaccion` evita la transacción repetida, pero no el gasto de la llamada.)
    if (isDuplicateWamid(message.id)) {
      log.info({ tag: 'WEBHOOK', wamid: message.id, from: from || null, bsuid }, 'Wamid duplicado — skip');
      return;
    }
    // Throttle por remitente VERIFICADO (S′5). Va después del dedup para que una
    // retransmisión de Meta —que es culpa nuestra, por tardar— no le gaste cupo al usuario.
    // Se descarta el mensaje pero la respuesta HTTP ya salió 200: devolverle 429 a Meta
    // dispararía retransmisiones, o sea más carga por la misma ráfaga.
    if (limiteRemitenteSuperado(from || bsuid)) {
      log.warn({ tag: 'WEBHOOK_THROTTLE', from: from || null, bsuid, max: REMITENTE_MAX },
        'Remitente por encima del límite del minuto — mensaje descartado');
      return;
    }
    // Meta mandó un mensaje SIN remitente. Pasó 4 veces el 01-ago-2026 (05:32 UTC) y
    // reventaba adentro de obtenerOCrearUsuario con un TypeError opaco ("Cannot read
    // properties of undefined (reading 'replace')"), del que no se podía sacar nada: la fila
    // de `errores` quedaba con `detalle` vacío, así que no había forma de saber QUÉ había
    // llegado. Sin remitente no hay nada que responder ni a quién, así que se descarta — pero
    // se registra la FORMA del payload, que es exactamente el dato que faltaba para
    // diagnosticarlo la próxima vez. No se loguea el contenido, solo las claves.
    if (!from) {
      // Ya sabemos QUÉ es: Meta arrancó el rollout de WhatsApp Usernames + BSUID. El usuario
      // que activa username oculta su número, así que `from` y `wa_id` dejan de venir y en su
      // lugar llega `from_user_id` — el Business Scoped User ID, formato `PE.1049206861029395`,
      // opaco y distinto por cada negocio. Confirmado el 08-ago-2026 con 6 mensajes del MISMO
      // BSUID en 13 minutos: una persona escribiendo y sin recibir nada.
      //
      // Se sigue descartando porque hoy no hay a dónde responder (`enviarWhatsapp` manda
      // `to: <número>`), pero se registra lo único que podría permitirlo: el BSUID y la forma
      // de `contacts`, que es donde Meta pone la identidad y todavía no sabemos qué trae. Del
      // contacto van las CLAVES y los identificadores, nunca el nombre del perfil.
      const contacto = ((value && value.contacts) || [])[0] || null;
      const forma = {
        tipo: message.type || null,
        wamid: message.id || null,
        clavesMensaje: Object.keys(message || {}),
        clavesValue: Object.keys(value || {}),
        fromUserId: message.from_user_id || null,
        clavesContacto: Object.keys(contacto || {}),
        clavesPerfil: Object.keys((contacto && contacto.profile) || {}),
        contactoWaId: (contacto && contacto.wa_id) || null,
        contactoUserId: (contacto && contacto.user_id) || null,
      };
      // ¿Lo conocemos igual? Si le aprendimos el BSUID mientras todavía mandaba su número,
      // este mensaje SÍ tiene dueño aunque Meta ya no diga quién es. Responderle sigue siendo
      // imposible (no hay número y el envío por BSUID no está habilitado en nuestra WABA),
      // pero anotarle el gasto no depende de eso — y perder el gasto de alguien IDENTIFICADO
      // es peor que no confirmárselo. Lo ve en el dashboard, que es el canal que sí le llega.
      //
      // Vale para texto, foto y nota de voz. Durante un tiempo solo cubrió texto, con el
      // argumento de que "procesar una imagen exige responder": es falso — correr Vision y
      // guardar el gasto no necesita respuesta, lo que pasaba es que ese código vivía inline
      // entre los `enviarWhatsapp` del webhook. Importa por volumen: 12 de los 34 usuarios que
      // registraron algo en los últimos 60 días lo hacen por captura.
      // El OTP inverso es el ÚNICO trámite que se puede cerrar sin número, y por eso se atiende
      // ANTES de preguntar si el BSUID nos suena. El orden importa en las dos direcciones:
      //   · si el BSUID es DESCONOCIDO, este es el único camino que existe — abajo se descarta;
      //   · si es CONOCIDO, sin esto su código caería en `registrarGastoSilencioso`, que lo
      //     trataría como el texto de un gasto. Vincular su cuenta web es lo que pidió.
      //
      // Hasta el 02-sep-2026 esto no existía y el efecto no era "no se pudo verificar": era una
      // pantalla de onboarding colgada para siempre, porque `/api/onboarding` poletea señales que
      // sólo escribe el handler del OTP, 360 líneas más abajo de este `return`.
      const cuerpoOtp = (message.type === 'text' && message.text && message.text.body) || '';
      // **`bsuid` es obligatorio para entrar acá, y no es defensivo por gusto.** Meta puede mandar
      // un mensaje sin `from` Y sin `from_user_id` — así llegaron los 4 del 01-ago-2026. Sin esta
      // condición, uno de esos que trajera un código caía igual en este bloque, salía `error` y
      // hacía `return` **sin escribir la fila en `errores`**: se perdía el único rastro
      // diagnóstico que este bloque existe para producir, justo en el caso donde no hay ninguna
      // otra pista. Además `otpRateLimited(null)` es un bucket compartido por todos los remitentes
      // sin BSUID. Lo encontró la revisión adversarial.
      const otpSinNumero = bsuid ? cuerpoOtp.match(/NETO-(\d{6})/i) : null;
      if (otpSinNumero) {
        // El throttle va por BSUID: es el identificador estable que Meta pone acá, el mismo papel
        // que cumple `from` en el flujo con número. Sin esto el camino nuevo quedaría sin la única
        // defensa que tiene el código contra la fuerza bruta.
        if (otpRateLimited(bsuid)) {
          log.warn({ tag: 'OTP_BSUID', bsuid }, 'OTP rate limit alcanzado (posible fuerza bruta)');
          return;
        }
        const r = await verificarCuentaWebPorBsuid(bsuid, 'NETO-' + otpSinNumero[1]);
        // Se devuelve la ficha cuando el intento fracasó por NUESTRO lado, nunca por un código
        // malo. Misma regla que el OTP con número: **la regla es el par, no la rama** — si un
        // camino invita a reintentar y el motivo es nuestro, tiene que devolver la ficha.
        //
        // `vinculada_sin_destrabar` está en la lista porque el destrabe previsto ES reenviar (el
        // código quedó vivo justamente para eso, y cae en `ya_vinculada` que reintenta el burn).
        // Sin reembolso ese camino se come 5 fichas y deja a la persona bloqueada 15 minutos con
        // la pantalla girando, castigada por un fallo nuestro. Lo encontró la revisión adversarial.
        if (r.estado === 'lectura_fallida' || r.estado === 'error' || r.estado === 'vinculada_sin_destrabar') {
          otpDevolverIntento(bsuid);
        }
        await avisarVinculacionPorBsuid(bsuid, r);
        log.info({ tag: 'OTP_BSUID', bsuid, estado: r.estado, usuarioId: r.usuarioId || null },
          'OTP sin número resuelto');
        // Un código inválido o expirado NO se registra como "mensaje sin from": no es el caso que
        // esa fila vigila, y ensuciarlo dispararía la alerta de volumen por gente tipeando mal.
        return;
      }

      const conocido = await buscarUsuarioPorBsuid(bsuid);
      if (conocido) {
        let r = null;
        if (message.type === 'text') r = await registrarGastoSilencioso(message.text && message.text.body, conocido);
        else if (message.type === 'audio') r = await registrarAudioSilencioso(message, conocido);
        else if (message.type === 'image') r = await registrarImagenSilenciosa(message, conocido);

        // Que alguien CONOCIDO llegue sin número no había pasado nunca hasta el 10-ago-2026 (los
        // 7 casos reales eran BSUIDs desconocidos). Cuando pase, hay que enterarse: es la única
        // oportunidad de medir si al número guardado todavía le llega algo, y esa persona deja
        // de recibir respuestas desde ese momento. Va DESPUÉS de procesar para que el aviso no
        // se interponga entre el usuario y su gasto.
        await avisarPrimeraVezSilencioso(conocido, message.type, r);

        if (r) {
          // Si acá falla la infraestructura (Meta, Vision, Whisper), el gasto SE PIERDE y no
          // hay reintento: el usuario no recibe el "no pude procesarlo" que en el camino
          // normal lo hace reenviar, y Meta tampoco va a retransmitir —este webhook responde
          // 200 antes de procesar (línea 99), así que para Meta la entrega ya fue exitosa—.
          // Lo único que queda es la fila en `errores` que escribe el service. Se intentó
          // devolver el wamid a la cola para aprovechar una retransmisión, y era un mecanismo
          // apoyado en un evento que este código impide que ocurra.
          log.warn({ tag: 'WEBHOOK', usuarioId: conocido.id, tipo: message.type, registrado: r.registrado, motivo: r.motivo },
            'Mensaje sin `from` de un usuario CONOCIDO por BSUID — procesado sin respuesta');
          return;
        }
        // Un documento, una ubicación, un sticker. Nada que anotar, y nada que contestar.
        log.warn({ tag: 'WEBHOOK', usuarioId: conocido.id, tipo: message.type },
          'Mensaje sin `from` de un usuario conocido, de un tipo que no se puede procesar a ciegas');
        return;
      }
      // Desconocido de verdad: o nunca escribió desde la migración 065, o es alguien nuevo que
      // llegó ya con username. Ese segundo caso no tiene arreglo de nuestro lado: sin número no
      // hay a quién responder ni historial al que asociarlo.
      // **El texto va en la fila, y es un cambio deliberado de criterio.** Hasta el 02-sep-2026
      // acá se guardaba sólo la FORMA del payload ("no se loguea el contenido, solo las claves"),
      // y esa decisión tuvo un costo medible: cuando un usuario real quedó trabado mandando
      // códigos de verificación, sus 9 filas eran indistinguibles de las de cualquier otro, y sólo
      // se supo qué había mandado porque fue a reclamar por Instagram. Los otros 6 BSUID de esos
      // días siguen sin poder revisarse: no hay forma de saber si estaban en el mismo problema.
      //
      // Se acota a 200 caracteres y sólo al tipo `text`.
      //
      // **HUECO ABIERTO, y el argumento que lo justificaba se cae con este mismo commit.**
      // `borrar_cuenta_total` barre `errores` por `usuario_id` y por `whatsapp`
      // (`migrations/073d:159`), y estas filas no llevan ninguno de los dos, así que **este texto
      // sobrevive a un pedido de baja**.
      //
      // La primera versión de esta nota decía que eso era aceptable "porque son de gente que
      // todavía no identificamos". Es falso: la fila lleva `fromUserId` en el `detalle`, y una
      // vinculación exitosa escribe ESE MISMO VALOR en `usuarios.bsuid`, o sea que
      // `errores.detalle->>'fromUserId' = usuarios.bsuid` es un join trivial. **La feature
      // fabrica retroactivamente la atribución que el argumento negaba.** Lo demostró la
      // revisión adversarial.
      //
      // Lo que hay puesto como mitigación es el tope de 200 chars y el corte por tipo `text`. Lo
      // que falta es una condición más en ese DELETE (por el bsuid de la fila, que ya se puede
      // leer del mismo SELECT INTO), y eso es una migración sobre la función más sensible del
      // sistema —con su canary de md5— así que se decide aparte, no de rebote en un fix de
      // webhook. Hasta entonces esto es un hueco conocido, no uno aceptado.
      const forma2 = { ...forma, texto: cuerpoOtp ? cuerpoOtp.slice(0, 200) : null };
      log.error({ tag: 'WEBHOOK', ...forma2 }, 'Mensaje entrante sin `from` — se descarta');
      // `actor` no entra a la fila: lo usa el detector de patrones para contar PERSONAS distintas
      // en vez de mensajes, que es la diferencia entre "uno insistiendo" y "esto se generalizó".
      registrarError('WEBHOOK', 'Mensaje entrante sin from', { detalle: JSON.stringify(forma2), actor: bsuid });
      return;
    }
    // --- Manejo de imágenes ---
    if (message.type === 'image') {
      const usuario = await obtenerOCrearUsuario(from, bsuid);

      const mediaId = message.image && message.image.id;
      log.info({ tag: 'IMAGEN', mediaId }, 'Procesando imagen');
      if (!mediaId) { await enviarWhatsapp(from, 'No pude recibir la imagen. Intenta de nuevo.'); return; }
      try {
        // Bajar la captura y pasarla por Vision. Las dos cosas viven en
        // `services/media-intake.js` porque el camino silencioso (el usuario que llega solo
        // con BSUID y al que no se le puede responder) corre exactamente el mismo pipeline.
        const { buffer: imgBuffer, mimeType } = await descargarMedia(mediaId, {
          tag: 'IMAGEN', mimeFallback: message.image.mime_type || 'image/jpeg',
        });
        const hoy = hoyPeru();
        const parsed = await extraerPagoDeImagen(imgBuffer, mimeType, hoy);

        // ─── Qué es esta captura lo decide el CONTENIDO, no el flag ──────────────────────
        //
        // Hasta el 14-ago-2026 lo decidía `esperando_comprobante`, y como interruptor de modo
        // perdía algo en CADA posición:
        //
        //   · flag PUESTO + captura que no es el pago a Neto → se rechazaba y **el gasto se
        //     perdía**. Es la trampa de B12/B23: el flag lo pone un cron, así que la ventana
        //     de 48h se le abría a gente que ni se enteró del aviso.
        //   · flag SIN PONER + captura que SÍ es el pago a Neto → se anotaba como un gasto más
        //     a "Favio Mendoza" y **el pago se perdía**, en silencio y sin fila en `pagos`.
        //     Le pasa al WhatsApp-only que quiere RENOVAR: `plan` sigue en `premium`, así que
        //     `pideComprobante` (intents/premium.js) es false y no tiene forma de abrir la
        //     ventana. Lo encontró la revisión adversarial del fix de B23.
        //
        // Con el contenido decidiendo, ninguna de las dos pierde nada, y de paso `llegoElAviso`
        // deja de ser una decisión cara.
        //
        // **El falso positivo de `esPagoNeto` NO es gratis, y acá decía que sí.** Cuesta una
        // solicitud pendiente que el admin tiene que rechazar, `estado_pago` pisado a
        // 'pendiente', un Telegram con la foto de un pago privado a un tercero, y —por la
        // guarda de abajo— el comprobante siguiente entrando por la rama degradada. Por eso el
        // predicado se apretó al ampliarle el alcance (`\bfavio\b`: sin el borde de palabra
        // matcheaba "Faviola"). Lo que sí es cierto es que el gasto se registra en todas las
        // ramas, así que ningún falso positivo pierde plata.
        const esperaba = esperaComprobante(usuario);
        if (esPagoNeto(parsed)) {
          // Sin esto, reenviar la captura abría una SEGUNDA solicitud. Antes lo evitaba el flag
          // —`registrarSolicitudPro` lo apaga al registrar— y al sacar el flag de la decisión
          // hay que reponer la guarda explícita. `pago_pendiente` significa exactamente "hay una
          // solicitud sin resolver": tanto aprobar como rechazar la limpian.
          //
          // La guarda era `if (usuario.pago_pendiente)`, o sea una LECTURA de la fila que se
          // trajo al entrar al handler, y eso cubría el reenvío (foto → respuesta → foto) pero
          // no dos capturas EN VUELO: entre esa lectura y la escritura están la bajada del
          // media y la llamada a Vision, así que dos fotos seguidas leían las dos `false`.
          // Ahora la decisión la toma un UPDATE condicional —`reclamarSolicitudPro`, hermano
          // del `reclamarPagoPendiente` que cierra la doble APROBACIÓN—: sólo una ejecución
          // matchea la fila. Cubierto por `tests/handlers/webhook-comprobante-carrera.test.js`.
          let reclamado;
          try {
            reclamado = await reclamarSolicitudPro(usuario.id);
          } catch (eClaim) {
            // El claim que falla por red es indistinguible de perder la carrera si sólo se mira
            // el resultado, y tratarlo como "otro ganó" sería la peor respuesta del archivo:
            // le confirma al usuario que su comprobante está en verificación cuando NO existe
            // ninguna solicitud. Se le pide reenviarla, que es lo único que recupera el pago.
            // El gasto se anota igual, por el mismo motivo que en la rama de abajo.
            // `msgErr` y no `eClaim.message`: si el rechazo no es un `Error`, leer `.message`
            // tira `TypeError` ACÁ ADENTRO y se lleva puesto todo lo que sigue — el rescate del
            // gasto, el aviso al admin, la respuesta al usuario—, dejando sólo el "no pude
            // procesar la imagen" del catch de afuera. Sobre una captura de PAGO es el peor
            // desenlace del archivo. Lo encontró la segunda revisión adversarial, en el código
            // que la primera acababa de introducir.
            const detalleClaim = msgErr(eClaim);
            log.error({ tag: 'PRO_PAGO', err: detalleClaim, usuarioId: usuario.id }, 'No se pudo reclamar la solicitud Pro');
            registrarError('PRO_PAGO', 'No se pudo reclamar la solicitud Pro: ' + detalleClaim,
              { stack: eClaim && eClaim.stack, whatsapp: from, usuarioId: usuario.id });
            try { await guardarTransaccion(usuario.id, { ...parsed, fecha: parsed.fecha || hoy }); }
            catch (eDup) { log.error({ tag: 'PRO_PAGO', err: msgErr(eDup) }, 'Error registrando tx de captura con claim fallido'); }
            await notificarAdmin('⚠️ No se pudo abrir la solicitud Pro de `' + usuario.id + '`: ' + detalleClaim +
              '\n\nVision leyó: *' + (parsed.comercio || '(sin comercio)') + '* — ' + parsed.monto +
              '\n\nEl gasto quedó anotado y se le pidió reenviar la captura. Si no vuelve, el pago no figura en ningún lado.' +
              '\n\n⚠️ El UPDATE pudo haber commiteado antes de perderse la respuesta: revisá ' +
              '`usuarios.pago_pendiente` de ese id y, si quedó en true sin fila en `pagos`, bajalo a mano.');
            await enviarWhatsapp(from, 'No pude registrar tu comprobante en este momento. Lo anoté como gasto para no perderlo — *reenvíamela en un ratito* para activar tu Pro. 🙏');
            return;
          }
          if (!reclamado) {
            // El gasto se anota IGUAL. La primera versión de esta guarda retornaba acá y con
            // eso abría una TERCERA posición donde se pierde algo — justo lo que este cambio
            // dice cerrar. Y es la peor de las tres: si la solicitud pendiente vino de un falso
            // positivo, esta captura es el pago REAL, y descartarla le confirma al usuario que
            // todo está en orden mientras su plata desaparece. `guardarTransaccion` dedupea por
            // hash, así que reenviar la MISMA foto no duplica la fila.
            try { await guardarTransaccion(usuario.id, { ...parsed, fecha: parsed.fecha || hoy }); }
            catch (eDup) { log.error({ tag: 'PRO_PAGO', err: msgErr(eDup) }, 'Error registrando tx de captura con solicitud pendiente'); }
            await notificarAdmin('⏳ El usuario `' + usuario.id + '` mandó OTRA captura que parece un pago a Neto ' +
              'y ya tiene una solicitud sin resolver.\n\nVision leyó: *' + (parsed.comercio || '(sin comercio)') + '* — ' + parsed.monto + '\n\n' +
              'Si la solicitud pendiente era un falso positivo, ESTA puede ser el pago de verdad. El gasto quedó anotado igual.');
            await enviarWhatsapp(from, '⏳ Ya tenemos un comprobante tuyo en verificación, así que este lo anoté como gasto. Te confirmamos en breve.');
            return;
          }
          parsed.fecha = parsed.fecha || hoy;
          await procesarComprobantePro({ usuario, parsed, imgBuffer, mimeType, from, yaReclamado: true });
          // Registrar también el gasto de suscripción del usuario (se auto-categoriza a Suscripciones > Software)
          try { await guardarTransaccion(usuario.id, parsed); }
          catch(eTx) { log.error({ tag: 'PRO_PAGO', err: msgErr(eTx) }, 'Error registrando tx de comprobante'); }
          return;
        }

        if (parsed.tipo === 'no_pago') {
          // Acá no hay gasto que perder —no era una transacción—, así que lo único que cambia
          // según el flag es a qué se le apunta al usuario.
          await enviarWhatsapp(from, esperaba
            ? 'No reconocí un pago en esa imagen. Envíame la captura del Yape (S/' + PRO_PRECIOS.mensual + ' mensual o S/' + PRO_PRECIOS.anual + ' anual a *Favio Mendoza*) para activar tu Pro. 📸'
            : 'No reconocí ninguna transacción en esa imagen. Envíame la captura de Yape, Plin o tu banco (la pantalla que muestra el monto y destinatario).');
          return;
        }
        if (!parsed.monto || isNaN(parseFloat(parsed.monto))) {
          // Al que esperaba mandar su comprobante hay que contestarle eso, no el error genérico.
          // Antes esta rama era inalcanzable para él (el bloque del flag la atajaba arriba); al
          // dejar que el contenido decida, su Yape con el monto ilegible caía al `throw`, o sea
          // al catch de abajo: "No pude procesar la imagen" y una fila con stack en `errores`,
          // que es la tabla de diagnóstico del backend. Vision no leyendo un monto es esperable,
          // no es una falla de infraestructura.
          if (esperaba) {
            await enviarWhatsapp(from, 'No pude leer el monto de esa captura. Envíame la del Yape (S/' + PRO_PRECIOS.mensual + ' mensual o S/' + PRO_PRECIOS.anual + ' anual a *Favio Mendoza*) para activar tu Pro. 📸');
            return;
          }
          throw new Error('No se detectó monto en la imagen');
        }
        parsed.fecha = parsed.fecha || hoy;
        const txImg = await guardarTransaccion(usuario.id, parsed);
        const montoStr = parsed.moneda === 'USD' ? '$' + parseFloat(parsed.monto).toFixed(2) : 'S/ ' + parseFloat(parsed.monto).toFixed(2);
        const esIngreso = parsed.tipo === 'ingreso';
        // Categoría/subcategoría YA persistidas (normalizadas por guardarTransaccion), no la salida cruda del parser.
        const catImg = (txImg && txImg.categoria) || parsed.categoria;
        const subImg = (txImg && txImg.subcategoria) || parsed.subcategoria;
        const emoji = esIngreso ? '💵' : (getEmojiCategoria(catImg) || '📋');
        const tipoLabel = esIngreso ? 'Ingreso registrado' : 'Gasto registrado';
        // La fecha va por formatFecha ('03-ago-26'), igual que la confirmación de un gasto
        // escrito (handlers/intents/transacciones.js). Acá se escapaba el ISO crudo, así que
        // el MISMO evento se veía distinto según lo hubieras escrito o fotografiado, y
        // "2026-08-03" en un chat se lee como un log, no como algo que le habla a alguien.
        let respImg = '📸 *' + tipoLabel + '*\n\n' + emoji + ' *' + (parsed.comercio || (esIngreso ? 'Ingreso' : 'Pago')) + '* — ' + montoStr + '\n' + catImg + (subcategoriaUtil(subImg) ? ' > ' + subcategoriaUtil(subImg) : '') + ' · ' + formatFecha(parsed.fecha);
        // El gasto YA quedó anotado (eso es lo que antes se perdía). Lo único que agrega el
        // flag es la aclaración: si el usuario creía estar mandando su comprobante, tiene que
        // saber por qué esto le contestó "Gasto registrado".
        if (esperaba) {
          respImg += '\n\n_Lo anoté como gasto. Si esa era tu captura del pago a Neto (S/' +
            PRO_PRECIOS.mensual + ' mensual o S/' + PRO_PRECIOS.anual + ' anual a *Favio Mendoza*), ' +
            'revisa el monto y el destinatario y reenvíamela._';
        }
        const nudgeImg = await colaConfirmacionGasto(usuario, txImg, txImg && txImg.conteoTx);
        if (nudgeImg) respImg += nudgeImg;
        await enviarWhatsapp(from, respImg);
      } catch(e) {
        log.error({ tag: 'IMAGEN', err: e.message }, 'Error procesando imagen'); registrarError('IMAGEN', e.message, { stack: e.stack, whatsapp: from });
        await enviarWhatsapp(from, 'No pude procesar la imagen. Asegúrate de enviar la captura de la notificación de pago (la pantalla que muestra el monto y destinatario).');
      }
      return;
    }

    // --- Manejo de documentos (Excel para carga de gastos históricos) ---
    if (message.type === 'document') {
      const usuario = await obtenerOCrearUsuario(from, bsuid);

      const doc = message.document;
      const fileName = (doc && doc.filename) || '';
      const docMime = (doc && doc.mime_type) || '';

      // Carga masiva Excel/CSV es Pro (flag excelUpload en PLAN_CONFIG). Sin gate,
      // cualquier Free importaba gratis una feature prometida como Pro (fuga de valor).
      //
      // Va ANTES del chequeo de formato a propósito: el "acepto .xlsx o .csv" reparte el
      // link de la plantilla, así que ponerlo primero reproducía M9 en la rama hermana —
      // al del muro que manda un PDF se le decía "descarga la plantilla", la llenaba, y
      // recién al enviarla se le cobraba. A quien no puede importar no se le explica el
      // formato: se le dice que no puede importar.
      if (checkProWall(usuario, 'excelUpload').blocked) {
        // Espejo del evento que emite el intent `cargar_excel` (moderacion.js). `via:'archivo'`
        // es la mitad de abajo del embudo: este ya armó el archivo y lo mandó.
        analytics.capture(usuario.id, 'wa_muro_excel', { via: 'archivo' });
        await enviarWhatsapp(from, mensajeCargaMasivaPro(usuario));
        return;
      }

      const esCSV = fileName.endsWith('.csv') || docMime.includes('csv') || docMime.includes('text/plain');
      const esExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || docMime.includes('spreadsheet') || docMime.includes('excel') || docMime.includes('officedocument');
      if (!esCSV && !esExcel) {
        await enviarWhatsapp(from, '📄 Acepto archivos Excel (.xlsx) o CSV (.csv).\n\nDescarga la plantilla en: neto.pe/plantilla_gastos.xlsx\nO envía tu estado de cuenta bancario en CSV.');
        return;
      }

      const mediaId = doc && doc.id;
      if (!mediaId) { await enviarWhatsapp(from, 'No pude recibir el archivo. Intenta de nuevo.'); return; }

      try {
        await enviarWhatsapp(from, '📊 Procesando tu archivo de gastos... ⏳');

        // 1. Descargar desde Meta API (mismo patrón que imágenes)
        const metaToken = process.env.META_ACCESS_TOKEN;
        const phoneId = process.env.META_PHONE_NUMBER_ID;
        const metaUrl = 'https://graph.facebook.com/v19.0/' + mediaId + '?phone_number_id=' + phoneId;
        const metaRes = await fetch(metaUrl, { headers: { Authorization: 'Bearer ' + metaToken } });
        const metaJson = await metaRes.json();
        if (!metaJson.url) throw new Error('Meta no devolvió URL del documento');

        const fileRes = await fetch(metaJson.url, { headers: { Authorization: 'Bearer ' + metaToken } });
        if (!fileRes.ok) throw new Error('Error descargando archivo: ' + fileRes.status);
        const fileBuffer = Buffer.from(await fileRes.arrayBuffer());
        log.info({ tag: 'EXCEL', size: fileBuffer.byteLength }, 'Archivo descargado');

        // 2. Parsear archivo (CSV o Excel) — parser extraído a services/import-parser.js
        const rows = esCSV
          ? parseCSV(fileBuffer.toString('utf-8'))
          : await parseExcel(fileBuffer);

        if (rows.length === 0) throw new Error('No encontré datos válidos en el archivo. Asegúrate de usar la plantilla correcta o enviar tu estado de cuenta CSV.');
        if (rows.length > 500) throw new Error('Máximo 500 transacciones por archivo. Tu archivo tiene ' + rows.length + '.');

        // 4. Auto-categorizar filas sin categoría o sin subcategoría usando GPT-4o-mini
        const sinCategoria = rows.filter(r => !r.categoria || !r.subcategoria);
        if (sinCategoria.length > 0) {
          const batchSize = 50;
          for (let i = 0; i < sinCategoria.length; i += batchSize) {
            const batch = sinCategoria.slice(i, i + batchSize);
            const prompt = 'Categoriza cada movimiento. Categorías válidas: Alimentación, Transporte, Vivienda, Salud, Entretenimiento, Compras, Educación, Finanzas, Trabajo_Negocio, Otros.\nSubcategorías por categoría: Alimentación(delivery,restaurante,supermercado,mercado,cafeteria,snacks), Transporte(uber_cabify,taxi,bus_micro,metro_bus,gasolina,peaje,estacionamiento), Vivienda(alquiler,mantenimiento,electricidad,agua,gas,internet,cable), Salud(farmacia,medico,clinica,laboratorio,seguro_salud,optica), Entretenimiento(streaming,cine,juegos,bares_clubs,eventos,hobbies), Compras(ropa,calzado,electronico,hogar,belleza,mascotas), Educación(universidad,instituto,curso_online,utiles,idiomas,colegios), Finanzas(prestamo,tarjeta_credito,seguro,ahorro,inversion,comision_banco), Trabajo_Negocio(herramientas,publicidad,oficina,logistica,contador), Otros(regalo,donacion,multa,viaje,sin_categoria).\nDevuelve SOLO un JSON array: [{"index":0,"categoria":"...","subcategoria":"..."},...].\nMovimientos:\n' +
              batch.map((r, idx) => idx + '. ' + r.comercio + ' S/' + r.monto + (r.categoria ? ' [cat:' + r.categoria + ']' : '')).join('\n');

            try {
              const catRes = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0
              });
              const raw = catRes.choices[0].message.content.trim();
              const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
              if (start >= 0 && end >= 0) {
                const cats = JSON.parse(raw.slice(start, end + 1));
                cats.forEach(c => {
                  if (batch[c.index]) {
                    if (!batch[c.index].categoria) batch[c.index].categoria = c.categoria;
                    if (!batch[c.index].subcategoria) batch[c.index].subcategoria = c.subcategoria;
                  }
                });
              }
            } catch(catErr) {
              log.error({ tag: 'EXCEL', err: catErr.message }, 'Error categorizando batch');
            }
          }
        }

        // 5. Insertar transacciones — SERIAL, y se queda así. Medido el 2026-08-14 (hallazgo
        // P′5 de la auditoría del 10-ago, que proponía batchearlo o "ceder el turno").
        //
        // Uso real de esta rama en toda la historia: CERO. Las únicas 251 filas con prefijo
        // `Excel:` de la tabla son de Favio, del 2026-03-21, y NO salieron de este loop —
        // están agrupadas en 6 timestamps de ~50 filas (un `now()` por transacción), o sea
        // inserts en lote de un script local. Un loop serial deja 251 timestamps distintos.
        // La ruta hermana de la webapp (`Import webapp:`) tiene 0 filas. Recontarlo:
        //   select count(*), count(distinct created_at) from transacciones
        //   where descripcion_original like 'Excel:%';
        //
        // Y el costo que el hallazgo describía —"el bot se pone lento para todos"— no existe:
        // el webhook ya respondió 200 arriba (línea ~144) antes de procesar, y cada `await`
        // de este loop libera el event loop, así que los mensajes de otros usuarios se
        // atienden entremedio. Serial además garantiza UNA sola request de Supabase en vuelo:
        // es lo más gentil que puede ser con el pool de PostgREST, no lo menos.
        //
        // Lo que sí cuesta es tiempo de pared para QUIEN importa. Si algún día eso duele, el
        // insert en lote NO es un cambio mecánico: cada fila calcula su `dedup_hash`, resuelve
        // su regla por comercio y dispara el arranque del trial dentro de `guardarTransaccion`
        // (ver el chokepoint del primer gasto). Un lote tiene que decidir qué hace con el
        // conflicto de UNA fila y qué pasa con esos tres efectos. Ver `qa-excel-muro`.
        let insertados = 0, errores = 0;
        for (const row of rows) {
          try {
            await guardarTransaccion(usuario.id, {
              tipo: row.tipo || 'gasto',
              monto: row.monto,
              moneda: 'PEN',
              comercio: row.comercio,
              categoria: row.categoria || 'Otros',
              subcategoria: row.subcategoria || 'sin_categoria',
              metodo_pago: row.metodo_pago,
              banco: row.banco,
              fecha: row.fecha,
              descripcion_original: 'Excel: ' + row.comercio
            });
            insertados++;
          } catch(insErr) {
            errores++;
            log.error({ tag: 'EXCEL', err: insErr.message }, 'Error insertando fila');
          }
        }

        // 6. Resumen
        const gastos = rows.filter(r => r.tipo === 'gasto');
        const ingresos = rows.filter(r => r.tipo === 'ingreso');
        const totalGastos = gastos.reduce((s, r) => s + r.monto, 0);
        const totalIngresos = ingresos.reduce((s, r) => s + r.monto, 0);
        let resumenMsg = '✅ *Carga completada*\n\n' +
          '📊 ' + insertados + ' movimientos registrados\n';
        if (gastos.length > 0) resumenMsg += '💸 Gastos: ' + gastos.length + ' — S/ ' + totalGastos.toFixed(2) + '\n';
        if (ingresos.length > 0) resumenMsg += '💰 Ingresos: ' + ingresos.length + ' — S/ ' + totalIngresos.toFixed(2) + '\n';
        if (errores > 0) resumenMsg += '⚠️ ' + errores + ' filas con error\n';
        resumenMsg += '\n_Escribe "mis gastos" para ver tu resumen actualizado._';
        await enviarWhatsapp(from, resumenMsg);
        log.info({ tag: 'EXCEL', insertados, errores }, 'Carga Excel completada');
      } catch(e) {
        log.error({ tag: 'EXCEL', err: e.message }, 'Error procesando Excel'); registrarError('EXCEL', e.message, { stack: e.stack, whatsapp: from });
        await enviarWhatsapp(from, '❌ Error procesando el archivo: ' + e.message + '\n\nDescarga la plantilla correcta en: neto.pe/plantilla_gastos.xlsx');
      }
      return;
    }

    // --- Manejo de notas de voz (audio) ---
    // Transcribimos con Whisper (OpenAI) y reinyectamos el texto en el pipeline de
    // texto: reasignamos message.type/text y dejamos caer el flujo hasta el bloque
    // de texto de abajo. Así una nota de voz "gasté 20 soles en el almuerzo" registra
    // el gasto igual que si se hubiera escrito, sin duplicar la lógica de NLP.
    if (message.type === 'audio') {
      const mediaId = message.audio && message.audio.id;
      log.info({ tag: 'AUDIO', mediaId }, 'Procesando nota de voz');
      if (!mediaId) { await enviarWhatsapp(from, 'No pude recibir tu nota de voz. Intenta de nuevo. 🎤'); return; }
      try {
        const { buffer: audioBuffer, mimeType } = await descargarMedia(mediaId, {
          tag: 'AUDIO', mimeFallback: (message.audio && message.audio.mime_type) || 'audio/ogg',
        });
        const texto = await transcribirAudio(audioBuffer, mimeType);
        log.info({ tag: 'AUDIO', texto: texto.slice(0, 100) }, 'Nota de voz transcrita');

        if (!texto) {
          await enviarWhatsapp(from, 'No logré entender tu nota de voz. 🎤 Intenta de nuevo hablando claro, o escríbeme el gasto (ej: "gasté 20 soles en el almuerzo").');
          return;
        }

        // 4. Reinyectar en el pipeline de texto: el resto del handler procesa `message`
        // como si el usuario hubiera escrito la transcripción.
        message.type = 'text';
        message.text = { body: texto };
      } catch (e) {
        log.error({ tag: 'AUDIO', err: e.message }, 'Error procesando nota de voz'); registrarError('AUDIO', e.message, { stack: e.stack, whatsapp: from });
        await enviarWhatsapp(from, 'No pude procesar tu nota de voz. 🎤 Intenta de nuevo, o escríbeme el gasto (ej: "gasté 20 soles en el almuerzo").');
        return;
      }
    }

    if (message.type !== 'text') return;
    const msg = (message.text.body || '').trim();
    log.info({ tag: 'MSG', from, msg: msg.substring(0, 100) }, 'Mensaje recibido');

    let respuesta = '';
    const usuario = await obtenerOCrearUsuario(from, bsuid);
    const cmd = msg.toLowerCase().trim();

    // Verificación de cuenta web (OTP inverso). El usuario se logueó con Google en
    // app.neto.pe y, para probar posesión de su número, envía este código pre-escrito
    // (wa.me deep link). Aquí `from` es el número REAL que envió → posesión probada.
    // Recién aquí se vincula la cuenta Google (cierra el hueco de account-linking del
    // onboarding webapp). Ver migrations/020_webapp_otp.sql.
    const otpMatch = msg.match(/NETO-(\d{6})/i);
    if (otpMatch) {
      if (otpRateLimited(from)) {
        log.warn({ tag: 'WEBAPP_OTP', from }, 'OTP rate limit alcanzado (posible fuerza bruta)');
        await enviarWhatsapp(from, '⚠️ Demasiados intentos de verificación. Espera unos minutos y vuelve a intentar desde app.neto.pe.');
        return;
      }
      const code = 'NETO-' + otpMatch[1];
      try {
        // **`!otp` tiene DOS causas y una sola respuesta era mentira.** Sin leer el error, una
        // lectura caída se vuelve indistinguible de "ese código no existe", y lo que se le dice
        // a la persona es que su código es inválido — cuando puede ser perfectamente válido. No
        // es un mensaje feo y ya: la manda a app.neto.pe a generar OTRO código, o sea a repetir
        // el trámite entero, y cada intento le come una de las 5 fichas del rate limit de 15
        // minutos (el throttle es lo único que defiende el código de la fuerza bruta, así que
        // gastarlo en fallos nuestros baja la defensa además de mentir).
        const { data: otp, error: errOtp } = await supabase.from('webapp_otp')
          .select('id, supabase_auth_id, email, nombre, expires_at, verified_at')
          .eq('code', code).is('verified_at', null).maybeSingle();
        // **`PGRST116` acá NO es transitorio y por eso se separa.** `webapp_otp.code` no tiene
        // índice único (`migrations/020`: el único unique es por `supabase_auth_id`), así que
        // dos cuentas Google distintas pueden llegar a tener el mismo código de 6 dígitos
        // pendiente. `maybeSingle()` sobre dos filas devuelve `PGRST116`, y ahí *"volvé a
        // enviármelo, sigue siendo válido"* es un callejón sin salida: por más que reintente,
        // van a seguir siendo dos. Además vincular una de las dos a ciegas sería atar el
        // WhatsApp a la cuenta Google equivocada. Cae al mensaje de abajo, que manda a generar
        // uno nuevo — y regenerar sí lo resuelve, porque reemplaza la fila de esa cuenta.
        // Lo encontró la revisión adversarial.
        if (errOtp && errOtp.code !== 'PGRST116') {
          log.error({ tag: 'WEBAPP_OTP', from, err: errOtp.message }, 'No se pudo leer el código: no se declara inválido');
          otpDevolverIntento(from);
          await enviarWhatsapp(from, '⚠️ No pude verificar tu código en este momento. Vuelve a enviármelo en un minuto — sigue siendo válido.');
          return;
        }

        if (!otp || new Date(otp.expires_at).getTime() <= Date.now()) {
          await enviarWhatsapp(from, '⚠️ Ese código de verificación no es válido o ya expiró.\n\nVuelve a app.neto.pe y genera uno nuevo.');
          return;
        }

        // `usuario` (waRow) es la fila del número que ENVIÓ el código (posesión probada).
        // Con onboarding web, la cuenta Google ya tiene su propia fila web-first (webRow):
        // hay que FUSIONAR ambas en una, no vincular a ciegas (eso reventaría por el unique
        // de supabase_auth_id). El survivor es la fila web, que conserva el auth_id de la
        // sesión viva; la fila del número se pliega dentro y se borra.
        // **Ésta es la peor de las tres lecturas, porque `!webRow` no informa: RAMIFICA.** Con
        // el error descartado, una lectura caída se lee como "la cuenta web no llegó a crear su
        // fila" y manda al camino de link DIRECTO, que escribe `supabase_auth_id` sobre la fila
        // del número. Pero la fila web SÍ existe, así que ese update choca contra el unique de
        // `supabase_auth_id` y vuelve con 23505 — que el bloque de abajo atribuye al índice del
        // EMAIL y contesta *"ese correo ya está vinculado a otra cuenta de WhatsApp"*. O sea:
        // un hipo de la base termina en una escritura por el camino equivocado y en un
        // diagnóstico que apunta a un conflicto que no existe. Falla cerrado, sí, pero por
        // casualidad y con la explicación cambiada.
        const { data: webRow, error: errWebRow } = await supabase.from('usuarios')
          .select('id, nombre')
          .eq('supabase_auth_id', otp.supabase_auth_id)
          .maybeSingle();
        if (errWebRow) {
          log.error({ tag: 'WEBAPP_OTP', from, err: errWebRow.message }, 'No se pudo leer la cuenta web: no se elige rama a ciegas');
          otpDevolverIntento(from);
          await enviarWhatsapp(from, '⚠️ No pude verificar tu código en este momento. Vuelve a enviármelo en un minuto — sigue siendo válido.');
          return;
        }

        // **ACCESORIA, y va dicho porque el enunciado del ítem la describía al revés.** No es
        // "el vínculo se declara hecho sin quedar escrito": el vínculo lo escribe el update (o
        // el `merge_and_link`) de más abajo, y la señal que la webapp poletea es
        // `usuarios.whatsapp` de la fila del auth —no `verified_at`, que es sólo su fallback
        // (`webapp/src/app/api/onboarding/route.ts`)—. O sea que con esta escritura caída la
        // persona igual queda vinculada y la pantalla web igual avanza: el copy de los tres
        // call-sites es verdad sin importar cómo salga, y por eso NO se toca.
        //
        // Lo que sí se pierde son dos cosas que la persona no puede ver ni arreglar:
        //   · **el código no se quema.** `.is('verified_at', null)` lo vuelve a encontrar hasta
        //     que expire, o sea que una credencial que ya se usó sigue viva su ventana entera.
        //   · **`whatsapp_verified` es una de las dos columnas por las que el borrado de cuenta
        //     barre esta tabla** (`migrations/073`, `... OR whatsapp_verified = v_whatsapp`).
        //     Sin ella, la fila con el número sobrevive a un pedido de baja de datos.
        // Ninguna de las dos la resuelve la persona reintentando, así que la decisión es la del
        // opt-out de `survey_events`: sólo log, con `sitio` propio para que se pueda contar.
        // **`userId` es un parámetro y no `usuario.id` fijo por la rama del MERGE**, donde
        // `merge_and_link` acaba de BORRAR la fila del loser — que es `usuario.id`. El único
        // sitio cuya justificación entera es "sólo log, para que se pueda contar" emitía ahí el
        // id de una fila que ya no existe, o sea un diagnóstico que no se puede cruzar con
        // nada. El survivor es `webRow.id`. Lo encontró la revisión adversarial.
        const marcarVerificado = async (userId = usuario.id) => verificarEscritura(
          supabase.from('webapp_otp').update({
            verified_at: new Date().toISOString(),
            whatsapp_verified: from.replace(/^\+/, ''),
          }).eq('id', otp.id).select('id'),
          { sitio: 'webhook_otp_verificado', userId, campos: ['verified_at', 'whatsapp_verified'] });
        const primerNombre = (n) => (n || '').split(' ')[0];

        if (!webRow) {
          // La cuenta web no llegó a crear su fila (fallo de creación → fallback): vincula
          // el auth directamente sobre la fila del número. Ese número pasa a ser su cuenta.
          // **El `.select('id')` no es cosmético: sin RETURNING, cero filas llega con la MISMA
          // forma que el éxito** (`{data:null, error:null}`), y abajo se confirma el vínculo y
          // se QUEMA el código. Ese desenlace es alcanzable con el mismo mecanismo que los
          // otros cinco sitios de este commit: la fila del número desaparece entre
          // `obtenerOCrearUsuario` y el update (un merge concurrente, una baja de cuenta).
          //
          // No usa `verificarEscritura` a propósito, y es la única excepción del commit: el
          // helper colapsa el `{error}` en un veredicto de tres valores y acá hace falta el
          // CÓDIGO del error, porque `23505` decide un copy propio. La verificación es la
          // misma, escrita a mano. Lo encontró la revisión adversarial.
          const { data: linkFilas, error: linkErr } = await supabase.from('usuarios').update({
            supabase_auth_id: otp.supabase_auth_id,
            email: otp.email || usuario.email,
            nombre: usuario.nombre || otp.nombre,
            onboarding_completado: true,
          }).eq('id', usuario.id).select('id');
          if (linkErr) {
            // 23505: el correo de la cuenta web ya pertenece a otro WhatsApp
            // (índice usuarios_email_lower_unique). No marcamos verificado.
            if (linkErr.code === '23505') {
              await enviarWhatsapp(from, '⚠️ Ese correo ya está vinculado a otra cuenta de WhatsApp en Neto.\n\nSi es tuyo, escríbenos a soporte y lo resolvemos.');
              return;
            }
            throw linkErr;
          }
          if (!linkFilas || linkFilas.length === 0) {
            // El código NO se quema: si se quemara, reenviarlo daría "no es válido, genera uno
            // nuevo" y el nuevo caería en el mismo agujero. Dejándolo vivo, el reintento
            // funciona solo en cuanto la fila vuelva a estar.
            log.warn({ tag: 'WEBAPP_OTP', from, usuarioId: usuario.id },
              'El link directo no tocó NINGUNA fila: no se confirma el vínculo ni se quema el código');
            otpDevolverIntento(from);
            await enviarWhatsapp(from, '⚠️ No pude terminar de vincular tu cuenta. Vuelve a enviarme el código en un minuto — sigue siendo válido.');
            return;
          }
          await marcarVerificado();
          const pn = primerNombre(otp.nombre || usuario.nombre);
          await enviarWhatsapp(from, '✅ ' + (pn ? pn + ', t' : 'T') + 'u cuenta web quedó verificada y vinculada a este WhatsApp.\n\nYa puedes volver a app.neto.pe. 🎉');
          log.info({ tag: 'WEBAPP_OTP', usuarioId: usuario.id }, 'Cuenta web verificada (link directo)');
          return;
        }

        if (webRow.id === usuario.id) {
          // El número YA es de esta cuenta web (reenvío del código): nada que fusionar.
          await marcarVerificado();
          const pn = primerNombre(webRow.nombre || usuario.nombre);
          await enviarWhatsapp(from, '✅ ' + (pn ? pn + ', t' : 'T') + 'u cuenta ya está verificada y vinculada a este WhatsApp. 🎉');
          return;
        }

        // Dos filas distintas → fusión atómica. merge_and_link rechaza los bordes inseguros
        // (número ligado a otra cuenta Google, o espacio/meta compartida entre ambas filas).
        const { data: mergeResult, error: mergeErr } = await supabase.rpc('merge_and_link', {
          p_survivor: webRow.id,
          p_loser: usuario.id,
        });
        if (mergeErr) {
          log.error({ tag: 'WEBAPP_OTP', err: mergeErr.message }, 'Error en merge_and_link');
          otpDevolverIntento(from);
          await enviarWhatsapp(from, '⚠️ Tuvimos un problema al vincular tu cuenta. Intenta de nuevo en un momento o escríbenos a soporte.');
          return;
        }
        if (mergeResult === 'conflict') {
          await enviarWhatsapp(from, '⚠️ No pudimos vincular automáticamente: este número o tu cuenta ya tienen datos que necesitan revisión manual.\n\nEscríbenos a soporte y lo resolvemos rápido.');
          log.warn({ tag: 'WEBAPP_OTP', survivor: webRow.id, loser: usuario.id }, 'Merge en conflicto → soporte');
          return;
        }
        if (mergeResult !== 'linked') {
          log.error({ tag: 'WEBAPP_OTP', result: mergeResult }, 'merge_and_link resultado inesperado');
          otpDevolverIntento(from);
          await enviarWhatsapp(from, '⚠️ Tuvimos un problema al vincular tu cuenta. Intenta de nuevo en un momento o escríbenos a soporte.');
          return;
        }
        await marcarVerificado(webRow.id);
        const pn = primerNombre(webRow.nombre || usuario.nombre || otp.nombre);
        await enviarWhatsapp(from, '✅ ' + (pn ? pn + ', t' : 'T') + 'u cuenta web quedó verificada y vinculada a este WhatsApp.\n\nTus datos quedaron unificados. Ya puedes volver a app.neto.pe. 🎉');
        log.info({ tag: 'WEBAPP_OTP', survivor: webRow.id, loser: usuario.id }, 'Cuenta web verificada (merge)');
        return;
      } catch (e) {
        log.error({ tag: 'WEBAPP_OTP', err: e.message }, 'Error verificando cuenta web');
        // La ficha también se devuelve acá: llegar a este catch es siempre culpa nuestra (un
        // `throw` del link, una excepción de programación), nunca de un código malo.
        //
        // Lo que NO se toca es el "cae al flujo normal": con la verificación reventada, el
        // `NETO-123456` sigue de largo y termina contestado por el NLP, que responde cualquier
        // cosa a un código. Es preexistente y es OTRO problema — arreglarlo acá sería meter un
        // hallazgo nuevo en la tercera vuelta de un arreglo, que es exactamente cómo se produjo
        // el incidente del 04-ago.
        otpDevolverIntento(from);
        // cae al flujo normal
      }
    }

    // Detectar referido: nuevo usuario llegó vía link /r/:code
    const refMatch = msg.match(/^hola\s+neto\s+ref:([A-Z0-9]{4,12})/i);
    if (refMatch) {
      const refCode = refMatch[1].toUpperCase();
      // **`.single()` colapsa dos desenlaces en el mismo `data: null`**, y acá eso es plata:
      // "ese código no existe" (`PGRST116`, que es lo normal si alguien tipea cualquier cosa) y
      // "no se pudo preguntar". En el segundo caso el referido pierde su 50% off y el referrer
      // el mes gratis que le iba a pagar esa conversión, en silencio absoluto y para siempre —
      // nadie vuelve a mandar `hola neto ref:XXXX`, es el primer mensaje de una vida.
      //
      // No se le dice nada a la persona a propósito: está entrando por un link de invitación y
      // el mensaje siguiente es el del alta, así que meterle un error acá es ruido sobre alguien
      // que todavía no sabe qué es Neto. Lo que cambia es que deje de ser INDIAGNOSTICABLE: va
      // al log y a la tabla `errores`, que es donde se cruza por timestamp cuando alguien
      // reclama que su referido no contó.
      const { data: referrer, error: errReferrer } = await supabase.from('usuarios').select('id').eq('ref_code', refCode).neq('id', usuario.id).single();
      if (errReferrer && errReferrer.code !== 'PGRST116') {
        log.error({ tag: 'REFERIDO', from, refCode, err: errReferrer.message }, 'No se pudo resolver el código de referido: el descuento no se sembró');
        registrarError('REFERIDO', errReferrer.message, { whatsapp: from, refCode });
      }
      if (referrer) {
        // Solo vincular + sembrar el 50% off del referido. El premio al referrer NO se
        // dispara aquí (unirse ≠ convertir): salta recién cuando el referido PAGA Pro,
        // dentro de lib/pro-payment:activarPro.
        await registrarReferido(referrer.id, usuario.id);
      }
    }

    // Máquina de estados del onboarding (alta de usuarios). Todo el flujo vive
    // en handlers/onboarding.js; aquí webhook solo delega. Devuelve el texto a
    // enviar si el mensaje pertenece al alta, o null si no (sigue a la cascada).
    const respOnb = await manejarOnboarding({ usuario, msg, cmd, from });
    if (respOnb !== null) {
      await enviarWhatsapp(from, respOnb);
      // El alta hace short-circuit antes de message-processor, que es el único otro
      // punto que guarda el turno del usuario. Sin esto, de quien se traba EN el
      // onboarding no queda ni una línea de lo que escribió (era el agujero que
      // impedía diagnosticar la fuga del paso 100/101). Best-effort como el de abajo:
      // el historial nunca debe romper el bot.
      // …MENOS cuando el mensaje que se acaba de procesar fue el borrado de la cuenta.
      // `ejecutarBorradoTotal` vacía `conversaciones` dentro de su transacción, y estas dos
      // líneas corren DESPUÉS: reinsertaban el último mensaje de la persona y, encima, el
      // texto que le dice "borré todo lo que nos escribimos". O sea que el propio aviso de
      // borrado quedaba guardado como la única conversación de una cuenta borrada, en el
      // 100% de las bajas por WhatsApp.
      //
      // La marca la deja el servicio en la fila EN MEMORIA (`usuario.cuenta_borrada_at`), no
      // se relee: agregar un SELECT acá costaría una query por cada mensaje del alta para
      // cubrir un caso que ocurre una vez en la vida de una cuenta.
      if (!usuario.cuenta_borrada_at) {
        try { await guardarMensaje(usuario.id, 'usuario', msg); } catch (e) {}
        try { await guardarMensaje(usuario.id, 'neto', respOnb); } catch (e) {}
      }
      return;
    }

    // Muro de lectura para los comandos `/`. Va como PRIMERA rama de la cascada porque
    // esta cascada corre antes del NLP y nunca pasa por el dispatch de intents, así que
    // el chokepoint de message-processor no la cubre: sin esto, /reporte y /mes seguirían
    // entregando gratis exactamente lo que el muro cobra.
    // El saludo NO está en la lista: da el total del mes y el conteo, que es justo el
    // número que se decidió dejar del lado gratis.
    // **La cascada entera va envuelta, y no es defensa generica: es el unico lugar donde un
    // throw de estos comandos se puede convertir en una respuesta.** El catch de mas abajo
    // loguea, avisa al admin y deja fila en `errores`, pero NO le contesta nada al usuario:
    // desde el lado de la persona, `/mes` con la base caida era silencio.
    //
    // Y desde este commit hay mas caminos que pueden lanzar: `obtenerGastosMes` y
    // `obtenerCategoriasUsuario` dejaron de devolver "no tienes nada" cuando lo que pasa es
    // que no se pudo preguntar. Cambiar una mentira por silencio no es el trato; el trato es
    // cambiarla por esta linea.
    //
    // No envía nada por su cuenta: en todo el tramo que envuelve no hay un solo `enviarWhatsapp`
    // ni un `return` — las ramas sólo ASIGNAN `respuesta`, que se manda una vez al salir.
    //
    // **Lo que sí puede pasar, y por eso no dice "no puede duplicar":** dos comandos de ADMIN
    // envían de forma transitiva (`/responder` → `lib/support-tickets`, `/activar` →
    // `lib/pro-payment`), así que un throw posterior a ese envío le contesta al admin "tuve un
    // problema" e invita a repetir. Es sólo para el admin y `activarPro` está protegido por el
    // claim atómico de `pagos.estado`. Lo precisó la revisión adversarial.
    try {
    if (comandoRequiereLectura(cmd) && estaEnMuro(usuario)) {
      // Vive fuera del perímetro del guard —que se deriva de `cron/checks.js` a través de
      // `services/`— así que nadie la iba a marcar nunca, y es la vecina inmediata del tramo
      // que este commit envuelve. Accesoria: el cartel del muro sale igual, lo que se degrada
      // es el número que lleva adentro. Sólo log.
      const { count: conteoMuroCmd, error: errConteoMuro } = await supabase.from('transacciones')
        .select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id);
      if (errConteoMuro) log.warn({ tag: 'MURO', usuarioId: usuario.id, err: errConteoMuro.message }, 'No se pudo contar las transacciones: el muro sale sin conteo');
      respuesta = mensajeMuro(usuario, errConteoMuro ? undefined : conteoMuroCmd);
      analytics.capture(usuario.id, 'wa_muro_lectura', { comando: cmd.split(/\s+/)[0] });
    } else if (cmd === 'hola' || cmd === 'hi' || cmd === 'inicio') {
      var primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
      // La unión de las DOS fuentes, no la columna legacy sola: con `gmail_access_token` a
      // secas, a los usuarios que tienen Gmail conectado en `gmail_cuentas` se les daba el
      // saludo de "modo manual", que explica cómo registrar gastos a mano. Ver
      // `tieneGmailConectado`. El round-trip cae solo en el comando `/hola` y detrás de
      // `onboarding_completado`, que descarta sin tocar la red.
      var conGmail = usuario.onboarding_completado ? await tieneGmailConectado(usuario) : false;
      if (!conGmail && usuario.onboarding_completado) {
        // Usuario en modo manual — saludo normal
        var gastosMesHola = await obtenerGastosMes(usuario.id);
        var totalMesHola = gastosMesHola.reduce(function(s,t){return s+parseFloat(t.monto_pen||t.monto);},0);
        respuesta = '👋 Hola' + (primerNombre ? ', ' + primerNombre : '') + '.\n\n' +
          (gastosMesHola.length > 0 ? 'Este mes llevas *S/ ' + totalMesHola.toFixed(2) + '* en ' + gastosMesHola.length + ' movimientos.' : 'Sin movimientos este mes aun.') +
          // Acá había un "_Escribe /conectar para lectura automática de correos._". Se quitó:
          // invitaba a conectar el banco a cualquiera que saludara, incluido quien no puede
          // (no paga) y quien ni siquiera anotó su primer gasto. Y el sitio para conectar es
          // la webapp, donde se eligen los bancos antes; por WhatsApp es un menú numerado.
          '\n\n📝 Registra gastos así:\n_"gasté 50 en taxi"_\n_"almuerzo 25 soles"_\nO envía una foto de tu Yape/Plin.\n\n📊 *Tu dashboard:* https://app.neto.pe';
      } else {
        var gastosMesHola = await obtenerGastosMes(usuario.id);
        var totalMesHola = gastosMesHola.reduce(function(s,t){return s+parseFloat(t.monto_pen||t.monto);},0);
        // Aca vivian `catsHola`, `tipCats` y `saludo`: codigo muerto medido, no sospechado.
        // Ninguna de las tres variables se leia en la `respuesta` de abajo ni en ningun otro
        // lado del archivo, o sea que `obtenerCategoriasUsuario` era una query por cada "hola"
        // de un usuario con Gmail conectado cuyo unico consumidor era una cadena que se tiraba.
        // Aparecio clasificando los call-sites de esa lectura para este commit.
        respuesta = '\uD83D\uDC4B Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy NETO.\n\n' +
          (gastosMesHola.length > 0 ? 'Este mes llevas *S/ ' + totalMesHola.toFixed(2) + '* en ' + gastosMesHola.length + ' movimientos.' : 'Sin movimientos este mes aun.') +
          '\n\n📊 Revisa tu dashboard en *https://app.neto.pe*\n\n\u00bfQue revisamos?';
      }
    } else if (cmd === '/silenciar') {
      // **Los gemelos EXACTOS de `moderacion.js:22/63`**, que 9B-bis arregló dejando vivo el
      // original — y éste es además el que el docblock del guard de lecturas cita como ejemplo
      // canónico de la clase. Misma decisión y mismo copy que allá: el fallo lo nota la persona
      // sola, mañana a las 8pm, recibiendo el resumen que acaba de pedir que no le llegue.
      // Confirmarlo sin haberlo escrito no es un mensaje feo: es entrenarla a no creerle al
      // "listo". Los dos comandos escriben la MISMA columna, así que los separa el `sitio`.
      const vSilenciar = await verificarEscritura(
        supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id).select('id'),
        { sitio: 'webhook_silenciar', userId: usuario.id, campos: ['recordatorios_activos'] });
      respuesta = entro(vSilenciar)
        ? '🔇 Recordatorios desactivados. Escribe */recordar* para reactivarlos.'
        : 'No pude desactivar los recordatorios. Intenta de nuevo.';
    } else if (cmd === '/recordar') {
      const vRecordar = await verificarEscritura(
        supabase.from('usuarios').update({ recordatorios_activos: true }).eq('id', usuario.id).select('id'),
        { sitio: 'webhook_recordar', userId: usuario.id, campos: ['recordatorios_activos'] });
      respuesta = entro(vRecordar)
        ? '🔔 Recordatorios activados. Te avisaré a las 8pm si no registras gastos.'
        : 'No pude activar los recordatorios. Intenta de nuevo.';
    } else if (cmd === '/manoslibres') {
      if (!getUserPlanConfig(usuario).resumenDiario) {
        respuesta = '⭐ *El Modo Manos Libres es una función Pro.*\n\nCada noche a las 9pm te mando un resumen de lo que gastaste en el día, sin que hagas nada.\n\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.';
      } else {
        const nuevoEstado = !usuario.manos_libres;
        // Confirmación incondicional de un TOGGLE, que es el caso donde más engaña: el mensaje
        // afirma el estado nuevo, y quien lo lea va a asumir que el próximo `/manoslibres` lo
        // vuelve a invertir. Si el update no entró, el estado real sigue siendo el viejo y el
        // segundo toggle hace lo contrario de lo que la persona espera — sobre un resumen
        // nocturno que es justamente lo que no se está mirando.
        const vManos = await verificarEscritura(
          supabase.from('usuarios').update({ manos_libres: nuevoEstado }).eq('id', usuario.id).select('id'),
          { sitio: 'webhook_manoslibres', userId: usuario.id, campos: ['manos_libres'] });
        respuesta = !entro(vManos)
          ? 'No pude cambiar el Modo Manos Libres. Intenta de nuevo en un momento.'
          : nuevoEstado
          ? '🌙 *Modo Manos Libres activado.*\n\nCada noche a las 9pm te mando un resumen de lo que gastaste en el día. Escribe */manoslibres* de nuevo para desactivarlo.'
          : '✅ Modo Manos Libres desactivado. Ya no te mandaré el resumen diario.';
      }
    } else if (cmd === '/alertas') {
      // Opt-out de la tarjeta "Nuevo gasto" que se manda al detectar un movimiento en Gmail.
      // Legacy/undefined cuenta como activada (default true en DB).
      const alertasActivas = usuario.alertas_transaccion !== false;
      const nuevoEstadoAlertas = !alertasActivas;
      const { error: errAlertas } = await supabase.from('usuarios').update({ alertas_transaccion: nuevoEstadoAlertas }).eq('id', usuario.id);
      if (errAlertas) {
        // Nunca confirmar un cambio que no se persistio (ej: columna ausente).
        log.error({ tag: 'ALERTAS', err: errAlertas.message }, 'No se pudo guardar preferencia de alertas');
        respuesta = 'No pude guardar ese cambio ahora. Intenta de nuevo en un momento.';
      } else {
        respuesta = nuevoEstadoAlertas
          ? '🔔 *Alertas activadas.*\n\nTe aviso por aquí cada vez que detecte un movimiento en tu correo. Escribe */alertas* de nuevo para apagarlas.'
          : '🔕 *Alertas desactivadas.*\n\nYa no te aviso por WhatsApp cuando detecte un movimiento. Neto los sigue registrando y los ves en https://app.neto.pe\n\nEscribe */alertas* para reactivarlas.';
      }
    } else if (cmd === '/pendientes') {
      respuesta = '✅ Ya no necesitas categorizar por aquí. Neto categoriza tus gastos automáticamente.\n\n📊 Revisa o ajusta las categorías en https://app.neto.pe/dashboard/transacciones';
    } else if (cmd === '/conectar' || cmd === '/bancos') {
      // Conectar Gmail y elegir bancos son web-only. Estos comandos siguen vivos porque están
      // en chats viejos y en /ayuda: borrarlos mandaba al usuario al NLP. Ya no setean ningún
      // paso de onboarding ni emiten OAuth — responden con el atajo a la app.
      //
      // El gate cambió de rol: ya no protege el cupo (acá no hay nada que emitir), ELIGE EL
      // COPY. A quien no paga se le debe el pitch de Pro, no un link a una pantalla bloqueada.
      // La puerta real es routes/pro.js y el canje routes/public.js.
      if (!esProPagado(usuario)) {
        respuesta = mensajeGmailProPagado(usuario, cmd === '/bancos' ? 'bancos' : 'conectar');
      } else {
        respuesta = mensajeConectarEnLaApp(usuario, cmd === '/bancos' ? 'bancos' : 'conectar');
      }
    } else if (cmd === '/escanear') {
      // Leer SÍ se queda en WhatsApp: no consume cupo (opera sobre una conexión que ya existe)
      // y no tiene superficie web. Su gate sí es un gate de verdad — es la mitad silenciosa de
      // la capability, la que no tiene pantalla de por medio.
      if (!esProPagado(usuario)) {
        respuesta = mensajeGmailProPagado(usuario);
      } else {
        const resultado = await escanearGmailYRegistrar(usuario);
        // Ojo: devuelve un OBJETO si el token murió ({authError:true}) o si no hay ninguna
        // cuenta conectada ({sinCuenta:true}), no un string. Sin estas ramas el objeto viajaba
        // tal cual a enviarWhatsapp.
        //
        // **`sinCuenta` reemplaza a `!usuario.gmail_access_token`, que era el bug.** Esa
        // columna es el almacén legacy y está vacía para casi todos: a quien tiene Gmail
        // conectado en `gmail_cuentas` y escaneaba sin correos nuevos se le respondía
        // "conéctalo en la app", o sea que se le pedía hacer algo que ya había hecho. El
        // scanner ya sabe cuál de los dos casos es, mirando las DOS fuentes.
        if (resultado && resultado.authError) {
          respuesta = mensajeGmailDesconectado(usuario);
        } else if (resultado && resultado.sinCuenta) {
          respuesta = mensajeConectarEnLaApp(usuario);
        } else {
          respuesta = resultado || 'No encontre correos bancarios nuevos.';
        }
      }
    } else if (cmd === '/semana' || cmd === '/resumen') {
      const resumenSem = await generarResumenSemanal(usuario);
      respuesta = resumenSem || 'No hay gastos registrados esta semana.';
    } else if (cmd === '/mes') {
      respuesta = formatearResumen(await obtenerGastosMes(usuario.id), 'este mes');
    } else if (cmd === '/presupuesto') {
      respuesta = await formatearEstadoPresupuesto(usuario.id);
    } else if (cmd.startsWith('/presupuesto ')) {
      const partes = msg.trim().split(' ');
      if (partes.length >= 3) {
        const categoria = partes[1]; const monto = parseFloat(partes[2]);
        if (isNaN(monto) || monto <= 0) { respuesta = 'Monto invalido. Ej: /presupuesto Comida 500'; }
        else { await guardarPresupuesto(usuario.id, categoria, monto); respuesta = '*Presupuesto guardado*\n' + categoria + ': S/ ' + monto.toFixed(2) + '/mes'; }
      } else { respuesta = 'Formato: /presupuesto [categoria] [monto]'; }
    } else if (cmd.startsWith('/cambiar ')) {
      const partes = msg.trim().split(' ');
      if (partes.length >= 3) {
        const comercioInput = partes[1], categoriaInput = partes.slice(2).join(' ');
        // Acepta categoría conocida o libre (capitalizada). B30: la cuarta puerta que escribe
        // `transacciones.categoria` a mano. `catKnown` compara EXACTO salvo mayúsculas, así que
        // `/cambiar netflix alimentacion` no matcheaba —la tilde— y escribía 'Alimentacion':
        // la misma categoría partida en dos grafías. `resolverCategoriaPersistida` cubre el
        // camino difuso y deja intacto el nombre libre que no resuelve el mapa.
        const { resolverCategoriaPersistida } = require('../services/categories');
        const catKnown = CATEGORIAS_SUGERIDAS.map(c=>c.nombre).find(c => c.toLowerCase() === categoriaInput.toLowerCase());
        const catInputT = categoriaInput.trim(); // mismo motivo que el `.trim()` de corregir_categoria
        const catFinal = resolverCategoriaPersistida(catKnown || (catInputT.charAt(0).toUpperCase() + catInputT.slice(1)));
        const resultado = await recategorizarTransaccion(usuario.id, comercioInput, catFinal);
        respuesta = resultado.msg;
      } else { respuesta = 'Formato: /cambiar [comercio] [categoria]\nEj: /cambiar Netflix Streaming'; }
    } else if (cmd === '/reporte' || cmd.startsWith('/reporte ')) {
      const [anioHoyR, mesHoyR] = hoyPeru().split('-').map(Number), partesR = cmd.split(' ');
      const mesR = partesR[1] ? parseInt(partesR[1]) : mesHoyR;
      const anioR = partesR[2] ? parseInt(partesR[2]) : anioHoyR;
      if (mesR < 1 || mesR > 12 || isNaN(mesR)) { respuesta = 'Formato: /reporte [mes] [anio]\nEj: /reporte 3 2026'; }
      else {
        respuesta = '📊 *Tu reporte de ' + MESES[mesR] + ' ' + anioR + '*\n\n' +
          'Descarga tu PDF y ve tus gráficos en tu dashboard:\n\n' +
          '🔗 https://app.neto.pe/dashboard/reportes\n\n' +
          '_Inicia sesión con Google para ver tus datos._';
      }
    } else if (cmd === '/premium') {
      // Delegado al intent ver_premium: mismo copy con las TRES ramas (trial/pagado/muro).
      // La version inline que vivia aca le decia "Tu plan NETO Pro" a cualquiera --
      // incluido el del muro, que es justo quien tipea /premium para pagar -- porque quedo
      // fuera del fix b65d993/ca4bc8f (auditoria 2026-08-03, hallazgo M2).
      // Solo el TEXTO, no el efecto lateral: el comando informa el plan y lo tipea
      // cualquiera (incluida la curiosidad "cuánto cuesta"). Armar la espera del
      // comprobante acá le tragaba 48h de fotos de gastos a quien está en el muro.
      respuesta = premiumIntents.mensajeVerPremium(usuario);
    } else if (cmd === '/referir' || cmd === '/referidos' || cmd === '/invitar' ||
      /\b(quiero referir|referir a|mis referidos|mi link de referido|link de referido|invitar amigos|invitar a un amigo|compartir neto|recomendar neto|c[oó]digo de referido|programa de referidos|como refiero|cómo refiero|ganar pro gratis|referir amigos|quiero invitar)\b/i.test(cmd)) {
      let refCode = usuario.ref_code;
      if (!refCode) {
        refCode = generarRefCode();
        // **Esta es la rama que de verdad corre**, y por eso el arreglo va aca y no solo en
        // `premium.js`. Matchea TEXTO LIBRE por regex (`mis referidos`, `link de referido`,
        // `quiero invitar`...), y `procesarMensajeLibre` --lo unico que llega al intent
        // `ver_referidos`-- es el `else` del final de esta misma cascada: nunca lo ve. O sea que
        // 9B-bis arreglo la cola y las frases comunes se quedaron aca, mudas.
        //
        // Misma decision que alla, porque es la misma verdad: **el codigo ES la credencial**.
        // Si el update no entra y el mensaje se arma igual, la persona reparte un codigo que
        // `routes/public.js` no va a resolver nunca, y cada referido que traiga no le paga el
        // mes gratis a nadie. Es plata, y el fallo es permanentemente silencioso.
        const vRefCode = await verificarEscritura(
          supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id).select('id'),
          { sitio: 'webhook_ref_code', userId: usuario.id, campos: ['ref_code'] });
        if (!entro(vRefCode)) {
          // La fila EN MEMORIA no se toca: dejar `usuario.ref_code` seteado sobre una escritura
          // que no entro propaga el codigo inventado a todo lo que lea el objeto mas abajo.
          respuesta = '⚠️ Se me trabó creando tu código de referido, así que todavía no te lo puedo dar: ' +
            'si lo repartiera, no funcionaría. Pídemelo de nuevo en un momento.';
          refCode = null;
        } else {
          usuario.ref_code = refCode;
        }
      }
      if (refCode) {
        const statsRef = await obtenerEstadisticasReferidos(usuario.id);
        respuesta = mensajeMisReferidos(refCode, statsRef);
      }
    } else if (cmd === '/dashboard' || cmd === '/app') {
      respuesta = '📊 *Tu dashboard está en:*\n\n🔗 https://app.neto.pe\n\nAhí puedes ver gráficos, metas, reportes PDF, suscripciones y más.\n\n_Inicia sesión con tu cuenta de Google._';
    } else if (cmd === '/soporte' || cmd === '/humano') {
      // Usuario abre modo soporte: a partir de aquí sus mensajes van al equipo, no al bot.
      const r = await abrirSesion({ usuarioId: usuario.id, whatsapp: from, nombre: usuario.nombre });
      // **Sin ticket NO hay modo soporte, y anunciarlo igual es la mitad de la mentira.** El
      // insert de `abrirSesion` puede ser rechazado sin que nadie lance (supabase-js devuelve
      // `{ data: null, error }`), y entonces lo que la persona escriba después no encuentra
      // sesión y se lo lleva el bot: cree estar contándole su problema a alguien del equipo y
      // Neto le contesta sobre sus gastos.
      respuesta = !(r.yaAbierta || (r.ticket && r.ticket.id))
        ? '👤 Se me trabó abriendo la conversación con el equipo. Reintenta con */soporte* en un momento, o escríbenos a:\n📧 hola@neto.pe'
        : r.yaAbierta
        ? '👤 Ya estás en modo soporte. Escríbeme tu consulta y se la paso al equipo.\n\n_Escribe */salir* cuando quieras terminar._'
        : '👤 *Modo soporte activado*\n\nEscribe tu consulta o problema en un mensaje y se lo hago llegar al equipo de Neto. Te responderemos por este mismo chat.\n\n_Escribe */salir* cuando termines para volver al asistente._';
    } else if (cmd === '/salir') {
      // Usuario sale del modo soporte y vuelve al asistente.
      const r = await cerrarSesion({ usuarioId: usuario.id });
      // `closed === 0` ya no significa una sola cosa: puede ser "no estabas" o "no pude".
      // Decirle "no estabas en modo soporte" a alguien que SÍ está —y que va a seguir
      // hablándole al admin sin saberlo— es la mentira simétrica.
      respuesta = r.ok === false
        ? '😕 No pude cerrar el modo soporte ahora. Reintenta con */salir* en un momento.'
        : r.closed > 0
        ? '✅ Saliste del modo soporte. Vuelvo a ser tu asistente financiero 💚\n\n_Escríbeme un gasto o "hola" cuando quieras._'
        : 'No estabas en modo soporte. Sigo aquí para ayudarte con tus finanzas 💚';
    } else if (cmd.startsWith('/activar ') || cmd.startsWith('/pago ') || cmd === '/usuarios' || cmd === '/admin' || cmd === '/panel' || cmd.startsWith('/responder ') || cmd.startsWith('/tickets') || cmd.startsWith('/cerrar ')) {
      // Comandos admin (solo Favio). La logica vive en handlers/admin-commands.js,
      // compartida con el webhook de Telegram para que ambos canales se comporten igual.
      // Se pasa `msg` (texto crudo) ademas de `cmd`: /responder necesita el mensaje sin lowercasear.
      if (from !== ADMIN_NUMBER) {
        respuesta = 'No tienes permiso para usar este comando.';
      } else {
        respuesta = await procesarComandoAdmin(cmd, msg);
      }
    } else if (cmd === '/categorias' || cmd === '/categorias agregar') {
      var catsCmd = await obtenerCategoriasUsuario(usuario.id);
      if (cmd === '/categorias agregar' || !catsCmd) {
        // **El caso de `desconectar_cuenta` con el orden INVERTIDO**: alla el menu se imprimia
        // antes de saber si el paso habia entrado; aca el mensaje ya estaba compuesto una linea
        // ANTES del update. `onboarding_paso = 10` es lo unico que hace que el proximo mensaje
        // se lea como la respuesta a este menu (`handlers/onboarding.js`, paso 10): sin ese
        // estado escrito, el "1 3 5" cae al NLP, nadie personaliza nada y nadie se lo dice.
        //
        // Y no es solo un tramite que se pierde: por esta puerta ya salieron raices duplicadas
        // (`project_categorias_dedup_singlebug`), o sea que el estado a medias de aca ya
        // alimento un bug de datos. El write va PRIMERO y el menu se imprime solo si entro:
        // enumerar las opciones es la mitad de la mentira.
        const vMenuCats = await verificarEscritura(
          supabase.from('usuarios').update({ onboarding_paso: 10 }).eq('id', usuario.id).select('id'),
          { sitio: 'webhook_categorias_menu', userId: usuario.id, campos: ['onboarding_paso'] });
        if (!entro(vMenuCats)) {
          respuesta = 'No pude abrir la personalización de categorías ahora. Intenta de nuevo en un momento.';
        } else {
          var menuCatsStr = CATEGORIAS_SUGERIDAS.map(function(c,i){ return (i+1)+'. '+c.emoji+' '+c.nombre; }).join('\n');
          respuesta = '*Personaliza tus categorias*\n\nResponde con los numeros:\n\n' + menuCatsStr + '\n\n_Ej: 1 3 5 o "todas"_';
        }
      } else { respuesta = formatearCategoriasMsg(catsCmd); }
    } else if (cmd === '/ayuda') {
      const mesActual = new Date().getMonth() + 1;
      respuesta = '*Comandos NETO:*\n*/semana* -- gastos 7 dias\n*/mes* -- gastos del mes\n*/presupuesto* -- ver/configurar presupuesto\n*/categorias* -- categorias\n*/escanear* -- leer correos ahora\n*/cambiar [comercio] [cat]* -- corregir categoria\n*/reporte* -- PDF del mes\n*/reporte ' + mesActual + '* -- PDF mes especifico\n*/alertas* -- activar/desactivar avisos de Gmail\n*/dashboard* -- ir a tu app (https://app.neto.pe)\n*/referir* -- invitar amigos y ganar Pro\n*/premium* -- plan premium\n*hola* -- estado general\n\n_Tambien puedes escribirme en lenguaje natural!_';
    } else {
      respuesta = await procesarMensajeLibre(msg, usuario, from);
    }
    } catch (eCmd) {
      log.error({ tag: 'WEBHOOK_CMD', cmd, err: eCmd.message }, 'Un comando fallo: se responde en vez de callar');
      // **`notificarErrorAdmin` va acá porque este catch INTERCEPTA al general**, y el general
      // es el que lo hacía. Sin esta línea, atrapar el error para poder contestarle al usuario
      // le sacaba a Favio el push de todo fallo de comando — justo cuando este mismo commit
      // multiplica los caminos que lanzan ahí (`obtenerGastosMes`, `obtenerCategoriasUsuario`,
      // `formatearEstadoPresupuesto`). Quedaría sólo la fila en `errores`, que nadie mira en
      // vivo. Lo encontró la revisión adversarial.
      notificarErrorAdmin('WEBHOOK_CMD', cmd + ': ' + eCmd.message);
      registrarError('WEBHOOK_CMD', eCmd.message, { stack: eCmd.stack, whatsapp: from, cmd });
      respuesta = 'Tuve un problema consultando tus datos. Intenta de nuevo en un momento.';
    }
    if (respuesta) {
      await enviarWhatsapp(from, respuesta);
      // Guardar respuesta de NETO en historial
      try { await guardarMensaje(usuario.id, 'neto', respuesta); } catch(e) {}
    }
  } catch (error) { log.error({ tag: 'WEBHOOK', err: error.message }, 'Error en webhook'); notificarErrorAdmin('WEBHOOK', error.message); registrarError('WEBHOOK', error.message, { stack: error.stack, whatsapp: from }); }

  };
}

module.exports = createWebhookHandler;
