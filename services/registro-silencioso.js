const { parsearRegistroManual } = require('./parsers');
const { guardarTransaccion } = require('./transactions');
const { descargarMedia, transcribirAudio, extraerPagoDeImagen } = require('./media-intake');
const { esperaComprobante, esPagoNeto, registrarSolicitudPro, reclamarSolicitudPro, liberarSolicitudPro } = require('../lib/pro-payment');
const { resolverTipoPlan, PRO_PRECIOS } = require('../lib/config');
const { notificarAdmin } = require('../lib/admin-notify');
const { enviarWhatsapp, TIPO_CONFIRMACION_SIN_NUMERO, anunciarVeredictoD10 } = require('../lib/whatsapp');
const { registrarError, msgErr } = require('../lib/error-monitor');
const { hoyPeru } = require('../lib/dates');
const log = require('../lib/logger');

/**
 * El texto de la confirmación. Se arma con lo que devolvió `guardarTransaccion`, NO con lo que
 * dijo el parser: la categoría persistida puede diferir de la parseada (una regla por comercio,
 * la resolución canónica de B28/B30), y confirmarle una categoría que no es la que va a ver en
 * el dashboard es contarle otra cosa.
 *
 * Moneda: la convención del producto es mostrar la fila en la moneda que se pagó y el
 * equivalente en soles solo si no es PEN. `monto_pen` puede ser NULL a propósito (conversión
 * fuera de rango), y ahí se omite en vez de inventar un número.
 */
function textoConfirmacion(tx) {
  const moneda = tx.moneda || 'PEN';
  // `toFixed(2)` como en todo el resto del producto (`webhook.js`, `summaries.js`, `deudas.js`).
  // Sin esto un gasto de 25.50 sale "S/ 25.5", y este es el ÚNICO mensaje que este camino le
  // puede llegar a entregar a una persona. `parseFloat` porque PostgREST puede devolver una
  // columna `numeric` como string.
  const fmt = (v) => parseFloat(v).toFixed(2);
  let linea = (moneda === 'USD' ? '$ ' : 'S/ ') + fmt(tx.monto);
  if (moneda !== 'PEN' && tx.monto_pen != null) linea += ' (S/ ' + fmt(tx.monto_pen) + ')';
  return '✅ Anoté tu ' + ((tx.tipo || 'gasto') === 'gasto' ? 'gasto' : 'ingreso') + ': ' + linea +
    (tx.comercio ? ' en ' + tx.comercio : '') +
    (tx.categoria ? '\nCategoría: ' + tx.categoria : '');
}

/**
 * INTENTA confirmarle el gasto al número que le guardamos, y de paso mide D10.
 *
 * Este camino existe porque no podemos responderle: Meta dejó de mandar su número y el envío por
 * BSUID no está habilitado. Pero **la fila tiene su `whatsapp`**, aprendido cuando todavía
 * llegaba, y esa vía nunca se probó. Si funciona, sobra la mitad de esta maquinaria.
 *
 * Por qué acá y no en un probe manual: la medición pasiva no puede cerrar porque estar mapeado y
 * estar oculto no se observan a la vez (el BSUID llega JUNTO al número), y el probe manual exige
 * que alguien esté mirando dentro de las 24h del primer caso real. Acá se contesta sola la
 * primera vez que ocurra, sin mensaje sintético: si la premisa es falsa, la persona recibe
 * exactamente lo que le corresponde y hoy no recibe.
 *
 * **Nunca cambia el desenlace del registro.** El gasto ya está guardado cuando esto corre; que
 * el envío falle es el resultado ESPERADO, no un error del flujo.
 *
 * El veredicto NO se decide acá: un 200 de Meta solo dice que encoló, y ya hubo dos veces en
 * este trabajo en que un 200 sobre un destinatario inexistente casi produjo una conclusión
 * falsa. Lo decide el callback de status, en `avisarVeredictoD10` (`lib/whatsapp.js`).
 */
async function intentarConfirmar(usuario, tx) {
  if (!usuario || !usuario.id || !usuario.whatsapp) return false;
  // `guardarTransaccion` NO siempre devuelve la fila que acaba de escribir. En un hit de dedup
  // (mismo usuario/fecha/monto/comercio dentro de 10s) devuelve el `dup`, que sale de un
  // `select('id, tarjeta_last4')`: sin monto, sin comercio, sin categoría. Un `!tx` no lo atrapa
  // —es un objeto válido— y el mensaje salía literalmente "Anoté tu gasto: S/ undefined". Además
  // no hay nada que confirmar: ese gasto ya estaba. El dedup de Gmail devuelve `null` y cae acá
  // por el mismo lado.
  if (!tx || tx.monto == null) return false;
  let r;
  try {
    r = await enviarWhatsapp(usuario.whatsapp, textoConfirmacion(tx),
      { tipo: TIPO_CONFIRMACION_SIN_NUMERO, usuarioId: usuario.id });
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'Falló el intento de confirmación');
    return false;
  }
  // `supabase-js` y `enviarWhatsapp` no lanzan: sin mirar el resultado, un rechazo se lee igual
  // que un envío bueno. Y `skipped` es el peor caso — un `ok:true` que NUNCA salió a Meta (el
  // usuario está marcado `is_test_user`, que es lo que hacen los harness): reportarlo como
  // encolado sería medir nada y creer que se midió.
  if (!r || r.skipped) {
    log.info({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, skipped: r && r.skipped },
      'Confirmación no enviada: no mide D10');
    return false;
  }
  log.info({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, ok: r.ok, code: r.code, msgId: r.msgId },
    'Confirmación intentada al número guardado (D10)');
  // Rechazo SÍNCRONO de Meta: `registrarEntrega` escribe la fila sin `wamid`, así que no va a
  // haber callback y el veredicto no llegaría nunca. Y este es el desenlace ESPERADO si la
  // premisa se sostiene — o sea que delegar todo al callback dejaba el experimento mudo
  // justamente en el caso más probable.
  //
  // **Solo cuenta si Meta CONTESTÓ.** `enviarWhatsapp` devuelve el mismo `{ok:false}` cuando el
  // POST ni siquiera llegó —el timeout de 15s que B22 puso justo porque Graph cuelga, un DNS
  // caído, una respuesta no-JSON— y ahí `code` viene en `null`. Anunciar eso decía "la premisa
  // se sostiene" sin haber medido nada, y encima quemaba el throttle: la medición real quedaba
  // cancelada de por vida. Es la MISMA clase de B19, cien líneas más arriba en este archivo, un
  // desenlace transitorio envenenando un Set de módulo hasta el próximo deploy.
  if (r.ok === false) {
    if (r.code == null) {
      log.warn({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, err: r.error },
        'El envío no llegó a Meta: transitorio, no es veredicto de D10');
      return true;
    }
    try {
      await anunciarVeredictoD10({ usuarioId: usuario.id, llego: false, code: r.code, error: r.error, origen: 'envio' });
    } catch (e) {
      log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'No se pudo avisar el veredicto de D10');
    }
  }
  return true;
}

/**
 * Registra un gasto de alguien a quien NO podemos responder.
 *
 * El caso: un usuario activó un username de WhatsApp, así que Meta dejó de mandar su número
 * y manda solo el BSUID. Lo reconocemos porque se lo aprendimos antes (migración 065), pero
 * `enviarWhatsapp` necesita un número y enviar por BSUID no está habilitado en nuestra WABA.
 * O sea: sabemos quién es y qué gastó, y no tenemos boca para contestarle.
 *
 * Decisión de Favio (2026-08-08): registrar igual. Anotar el gasto es lo que el modelo promete
 * gratis para siempre, y perder el gasto de alguien IDENTIFICADO es peor que no confirmárselo.
 * Lo verá en el dashboard, que es el canal que sí le llega.
 *
 * **Desde el 15-ago-2026 la confirmación se INTENTA igual** (`intentarConfirmar`, decisión de
 * Favio): el "no podemos responderle" del párrafo de arriba es una premisa que nunca se midió, y
 * este es el único punto del sistema donde se puede medir sin molestar a nadie. Si resulta falsa,
 * la persona recibe la confirmación que le corresponde; si es cierta, el envío falla y todo queda
 * exactamente como estaba. El nombre del archivo se queda hasta que haya un veredicto.
 *
 * Deliberadamente delgado: `parsearRegistroManual` es el mismo extractor del flujo normal y
 * `guardarTransaccion` es el que ya centraliza validación de monto, conversión USD→PEN y dedup.
 * Nada de lógica de dinero se reimplementa acá — si divergiera, este camino guardaría plata
 * distinta que el camino normal y nadie lo notaría, porque no hay respuesta que lo delate.
 *
 * No hay gate de plan a propósito: escribir nunca se corta, lo que se cobra es leer.
 *
 * @returns {Promise<{registrado: boolean, motivo: string}>}
 */
async function registrarGastoSilencioso(texto, usuario) {
  const limpio = (texto || '').trim();
  if (!limpio) return { registrado: false, motivo: 'sin_texto' };
  if (!usuario || !usuario.id) return { registrado: false, motivo: 'sin_usuario' };

  let datos;
  try {
    datos = await parsearRegistroManual(limpio, hoyPeru());
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'Parser falló');
    return { registrado: false, motivo: 'parser_error' };
  }

  // El usuario mandó algo que no es un gasto (una consulta, un saludo, un comando). No hay
  // nada que guardar y tampoco forma de responderle: se descarta, pero queda el log.
  if (!datos || !datos.ok) return { registrado: false, motivo: 'no_es_gasto' };

  let tx;
  try {
    tx = await guardarTransaccion(usuario.id, { ...datos, descripcion_original: limpio.substring(0, 200) });
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'No se pudo guardar la transacción');
    return { registrado: false, motivo: 'guardado_error' };
  }

  log.info({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, tipo: datos.tipo }, 'Gasto registrado sin poder responder');
  // Va DESPUÉS de que el gasto está guardado y no condiciona nada: el registro es la promesa,
  // la confirmación es el experimento. `intento` viaja de vuelta porque el aviso de primera vez
  // lo necesita: sin él afirmaba que se había intentado en caminos donde no se intentó nada.
  const intento = await intentarConfirmar(usuario, tx);
  return { registrado: true, motivo: 'ok', intento };
}

// Throttle del aviso al admin. Hace falta porque `esperaComprobante` no vence cuando el
// usuario quedó en `onboarding_paso === 2`, y a este usuario nada le puede pedir que salga de
// ahí: sin esto, cada foto suya era otro Telegram.
//
// **La clave incluye monto y comercio, no solo el usuario, y eso es lo que lo hace seguro.**
// La rama que se throttlea es "no parece el pago a Neto", que es exactamente donde cae un
// comprobante REAL que Vision leyó mal (`esPagoNeto` exige que el comercio matchee /neto|favio/
// y el monto sea el del plan: un "F. Mendoza L." queda afuera). Con la clave por usuario a
// secas, una captura cualquiera quemaba el aviso y el comprobante que llegara después se
// perdía sin un solo grito. Con monto+comercio, repetir la MISMA captura calla y una distinta
// avisa.
//
// Un Set de módulo alcanza: es cadencia de aviso, no estado, y el peor caso de un redeploy es
// un aviso repetido. Suma a la lista de estado en memoria del CLAUDE.md (instancia única).
const avisados = new Set();
async function avisarUnaVez(clave, mensaje) {
  if (avisados.has(clave)) return false;
  // La clave se RESERVA antes del await, no después. Entre el `has` y el `add` hay un POST a
  // Telegram sin timeout, y el patrón real de este camino es una persona mandando varios
  // mensajes seguidos (6 en 13 minutos, el 08-ago): con el `add` al final, los dos pasaban el
  // `has` y salían dos avisos idénticos. La versión anterior lo ponía después argumentando que
  // así no se quema la clave si el envío falla — y eso no compra nada, porque `notificarAdmin`
  // se traga sus propios errores y nunca rechaza.
  avisados.add(clave);
  await notificarAdmin(mensaje);
  return true;
}

/**
 * Avisa la PRIMERA vez que un usuario conocido cae al camino silencioso.
 *
 * Hasta el 10-ago-2026 esto no había pasado nunca: los 7 mensajes reales sin `from` vinieron
 * todos de BSUIDs que no están en `usuarios`. O sea que el día que ocurra es un evento nuevo
 * —alguien a quien conocemos dejó de mandar su número— y hasta ahora lo único que lo registraba
 * era un `log.warn` en Railway que nadie mira. Enterarse importa por dos cosas: es la primera
 * oportunidad real de medir si al número guardado todavía se le puede escribir
 * (`qa-e2e/probe-envio-username.mjs`), y es alguien que a partir de ese momento **no recibe
 * ninguna respuesta** del bot.
 *
 * Una vez por usuario y por instancia. El try/catch es defensa en profundidad, no una rama
 * que se pueda ejercitar: `notificarAdmin` traga sus propios errores y nunca rechaza. No le
 * escribas un test con `mockRejectedValue` — probaría una rama que producción no toma.
 */
async function avisarPrimeraVezSilencioso(usuario, tipo, resultado) {
  if (!usuario || !usuario.id) return;
  // Los harness E2E (`qa-bsuid-username`, `qa-bsuid-media`) siembran un usuario con BSUID y le
  // pegan al webhook REAL sin `from`, o sea que producen este evento en cada corrida. Sin este
  // corte el aviso se dispara con cada `usuario.id` nuevo —la clave del throttle es el id— y el
  // detector se vuelve ruido justo donde tiene que ser raro: es lo único que abre sola la
  // ventana para medir la premisa de [[bsuid]]. Pasó el 13-ago-2026 y me lo comí como si fuera
  // un usuario real.
  //
  // Y lo caro no es el ruido: el aviso trae el comando del probe ya armado con el número, y el
  // número que siembra el harness es `519` + 8 dígitos al azar, o sea el celular peruano de
  // cualquiera. Correrlo mientras la fila sembrada todavía existe le manda un WhatsApp de
  // verdad a un desconocido. `is_test_user` es la misma marca que ya usa `enviarWhatsapp` para
  // no llamar a Meta, y un usuario real nunca la lleva.
  if (usuario.is_test_user === true) return;
  // `r` es null cuando el tipo no se puede procesar a ciegas (un documento, un sticker), y sin
  // esto el aviso decía literalmente "no registrado (null)".
  const desenlace = !resultado ? 'no se puede procesar a ciegas'
    : (resultado.registrado ? 'registrado' : 'no registrado: ' + resultado.motivo);
  // Acá se ofrecía el comando del probe manual, y después una versión que afirmaba de plano que
  // la confirmación ya se había intentado. Las dos estaban mal, y la segunda peor: el intento
  // solo ocurre si se registró una transacción, y el primer mensaje de alguien que acaba de
  // perder su número es lo MENOS probable que sea un gasto ("hola", una pregunta, un sticker).
  // Como este aviso es one-shot por usuario, prometer un veredicto que no viene lo dejaba
  // esperando para siempre un Telegram que no existe, con instrucción de no medir a mano.
  const comoMedir = !usuario.whatsapp
    ? 'No tiene número guardado, así que no hay nada que medir por WhatsApp.'
    : (resultado && resultado.intento)
      ? 'Ya se le intentó la confirmación al número guardado (D10): el veredicto llega en otro ' +
        'Telegram. No corras `probe-envio-username`, sería un segundo mensaje a la misma persona.'
      : 'Este mensaje NO produjo ningún intento de confirmación, así que D10 sigue sin medirse ' +
        '(no se registró una transacción nueva: puede haber sido un saludo, una consulta, un ' +
        'formato que no se procesa a ciegas, o un gasto repetido que cayó en el dedup). Se va a ' +
        'medir solo en cuanto esta persona registre un gasto. Si quieres forzarlo ahora:\n' +
        '`node qa-e2e/probe-envio-username.mjs ' + usuario.whatsapp + ' --confirmar`';
  try {
    await avisarUnaVez(usuario.id + '|primera-vez-silencioso',
      '🔕 *Primera vez sin número* — el usuario `' + usuario.id + '`' +
      (usuario.whatsapp ? ' (' + usuario.whatsapp + ')' : '') +
      ' escribió y Meta ya NO manda su número. Lo reconocimos por su BSUID.\n\n' +
      'Mensaje de tipo *' + tipo + '* → ' + desenlace + '.\n\n' + comoMedir);
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'No se pudo avisar la primera vez');
  }
}

// El pago de alguien a quien no se le puede responder es lo último que puede perderse en
// silencio, así que este aviso NO se throttlea.
//
// El texto no afirma que no quedó NADA: cuando `registrarSolicitudPro` rechaza, el throw casi
// siempre viene de la notificación al admin, o sea DESPUÉS de que el INSERT en `pagos` ya pegó.
// Decir "hay que reconstruirlo a mano" ahí llevaba derecho a una segunda fila de pago.
function avisarAdminPagoPerdido(usuario, monto, detalle) {
  return notificarAdmin('🚨 *Comprobante Pro a medias* — usuario `' + usuario.id + '`' +
    (usuario.whatsapp ? ' (número guardado: ' + usuario.whatsapp + ')' : '') +
    ', monto detectado ' + (isNaN(monto) ? '?' : 'S/ ' + monto) + '.\n\n' +
    'Escribe con username de WhatsApp, así que Meta ya no manda su número. Al chat solo se le ' +
    'INTENTA escribir al número guardado (D10) y todavía no se sabe si eso llega: no cuentes ' +
    'con avisarle por ahí.\n\n' +
    'Qué falló: ' + detalle + '\n\n' +
    'REVISA la tabla `pagos` ANTES de crear nada: puede haber quedado una fila igual.');
}

/**
 * Guarda una transacción ya parseada (la salida de Vision) para alguien a quien no podemos
 * responder. El gemelo de `registrarGastoSilencioso`, para cuando el "parser" fue la imagen.
 *
 * Misma regla que arriba y por el mismo motivo: acá no se valida plata. El monto, la
 * conversión USD→PEN y el dedup los sigue decidiendo `guardarTransaccion`.
 */
async function registrarPagoParseado(parsed, usuario) {
  if (!usuario || !usuario.id) return { registrado: false, motivo: 'sin_usuario' };
  if (!parsed || parsed.tipo === 'no_pago') return { registrado: false, motivo: 'no_es_pago' };
  if (!parsed.monto || isNaN(parseFloat(parsed.monto))) return { registrado: false, motivo: 'sin_monto' };

  let tx;
  try {
    tx = await guardarTransaccion(usuario.id, { ...parsed, fecha: parsed.fecha || hoyPeru() });
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'No se pudo guardar la transacción');
    return { registrado: false, motivo: 'guardado_error' };
  }

  log.info({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, tipo: parsed.tipo }, 'Pago de imagen registrado sin poder responder');
  const intento = await intentarConfirmar(usuario, tx);
  return { registrado: true, motivo: 'ok', intento };
}

/**
 * Nota de voz de alguien a quien no podemos responder: se transcribe y reentra por el mismo
 * camino que el texto. Es exactamente lo que hace el flujo normal — el audio nunca fue un
 * formato aparte, es texto con un paso previo.
 */
async function registrarAudioSilencioso(message, usuario) {
  const mediaId = message && message.audio && message.audio.id;
  if (!mediaId) return { registrado: false, motivo: 'sin_media_id' };

  let texto;
  try {
    const { buffer, mimeType } = await descargarMedia(mediaId, {
      tag: 'AUDIO', mimeFallback: message.audio.mime_type || 'audio/ogg',
    });
    texto = await transcribirAudio(buffer, mimeType);
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario && usuario.id }, 'No se pudo transcribir el audio');
    // La rama normal registra en `errores` y le dice al usuario "no pude procesarlo" para que
    // reenvíe. Acá no hay a quién decírselo, así que la fila en `errores` es TODO el rastro que
    // va a quedar — y es donde viven los stacks del backend para diagnosticar después.
    registrarError('BSUID_SILENCIOSO', 'No se pudo transcribir el audio: ' + e.message,
      { stack: e.stack, usuarioId: usuario && usuario.id, whatsapp: (usuario && usuario.whatsapp) || null });
    return { registrado: false, motivo: 'media_error' };
  }

  if (!texto) return { registrado: false, motivo: 'audio_ilegible' };
  return registrarGastoSilencioso(texto, usuario);
}

/**
 * Captura de Yape/Plin/banco de alguien a quien no podemos responder.
 *
 * El caso delicado es el **comprobante Pro**: si el usuario estaba por mandar su pago, tratarlo
 * como un gasto cualquiera le registraría S/10 a nombre de "Favio Mendoza" y su Pro no se
 * activaría nunca, sin que nadie se entere. Así que se registra la solicitud igual —
 * `registrarSolicitudPro` sube el comprobante, inserta en `pagos` y avisa al admin con la foto
 * y los botones— saltando el único paso que no se puede dar: el "comprobante recibido" al
 * usuario. Favio lo aprueba como cualquier otro (decisión suya, 2026-08-09).
 *
 * Si esperaba comprobante pero la captura NO parece el pago a Neto, no se adivina: se guarda
 * como gasto y sale un aviso al admin. Ese es el caso donde un Vision equivocado costaría un pago.
 */
async function registrarImagenSilenciosa(message, usuario) {
  const mediaId = message && message.image && message.image.id;
  if (!mediaId) return { registrado: false, motivo: 'sin_media_id' };
  if (!usuario || !usuario.id) return { registrado: false, motivo: 'sin_usuario' };

  let buffer, mimeType, parsed;
  try {
    ({ buffer, mimeType } = await descargarMedia(mediaId, {
      tag: 'IMAGEN', mimeFallback: message.image.mime_type || 'image/jpeg',
    }));
    parsed = await extraerPagoDeImagen(buffer, mimeType, hoyPeru());
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'No se pudo leer la imagen');
    registrarError('BSUID_SILENCIOSO', 'No se pudo leer la imagen: ' + e.message,
      { stack: e.stack, usuarioId: usuario.id, whatsapp: usuario.whatsapp || null });
    return { registrado: false, motivo: 'media_error' };
  }

  // Espejo del camino interactivo (`handlers/webhook.js`, rama de imagen): lo que decide si
  // esto es un comprobante es el CONTENIDO, no `esperando_comprobante`. Ver el comentario largo
  // de allá; en resumen, el flag como interruptor de modo perdía el gasto en una posición y el
  // pago en la otra. Acá pesa todavía más: no hay respuesta que delate ninguna de las dos.
  const esperaba = esperaComprobante(usuario);
  if (esPagoNeto(parsed)) {
    // Reenviar la captura abría una SEGUNDA solicitud una vez que el flag salió de la decisión
    // (antes lo cortaba `registrarSolicitudPro` apagándolo). `pago_pendiente` es "hay una
    // solicitud sin resolver": la limpian tanto aprobar como rechazar.
    //
    // La guarda era `if (usuario.pago_pendiente)`, una lectura hecha ANTES de bajar el media y
    // de llamar a Vision, así que cubría el reenvío y no dos capturas en vuelo. El claim
    // atómico es el mismo que usa `handlers/webhook.js`; acá pesa más porque este canal no
    // puede pedirle nada al usuario: lo único que queda de una carrera perdida es el aviso.
    let reclamado;
    try {
      reclamado = await reclamarSolicitudPro(usuario.id);
    } catch (eClaim) {
      // No es "otro ganó": es que no se sabe. Tratarlo como pendiente daría por buena una
      // solicitud que no existe, y acá no hay nadie a quien contárselo después.
      const detalle = msgErr(eClaim);
      log.error({ tag: 'BSUID_SILENCIOSO', err: detalle, usuarioId: usuario.id }, 'No se pudo reclamar la solicitud Pro');
      registrarError('BSUID_SILENCIOSO', 'No se pudo reclamar la solicitud Pro: ' + detalle,
        { stack: eClaim && eClaim.stack, usuarioId: usuario.id, whatsapp: usuario.whatsapp || null });
      const rErr = await registrarPagoParseado(parsed, usuario);
      // Con dedup, igual que su hermana de abajo. Un claim falla cuando PostgREST está mal, o
      // sea de forma CORRELACIONADA: sin la clave, cada captura que entre durante la caída
      // dispara un Telegram nuevo, y la alarma que avisa de un pago perdido se vuelve ruido
      // justo cuando importa. La clave incluye el monto y el comercio para no tapar dos pagos
      // distintos del mismo usuario. Lo señaló la revisión adversarial.
      await avisarUnaVez(usuario.id + '|claim-pago-caido|' + parsed.monto + '|' + (parsed.comercio || ''),
        '⚠️ No se pudo abrir la solicitud Pro de `' + usuario.id + '` (username de WhatsApp): ' + detalle +
        '\n\nVision leyó: *' + (parsed.comercio || '(sin comercio)') + '* — ' + parsed.monto + '\n\n' +
        (rErr.registrado ? 'El gasto quedó anotado.' : 'El gasto TAMPOCO se pudo anotar (' + rErr.motivo + ').') +
        '\nNo hay solicitud que aprobar y este usuario no tiene número al que pedirle que reenvíe.' +
        // El UPDATE del claim pudo commitear y perderse la respuesta. Si quedó puesto, no hay
        // NINGUNA ruta que lo limpie sola: `rechazarSolicitudPro` exige una fila `pagos`
        // pendiente y `/pago` busca por número, que este usuario no tiene. Decir qué mirar es
        // la diferencia entre un callejón sin salida y un minuto de trabajo manual.
        '\n\n⚠️ Revisá `usuarios.pago_pendiente` de ese id: si el UPDATE llegó a commitear, ' +
        'quedó en true sin fila en `pagos` y hay que bajarlo a mano — si no, no puede pagar por ningún canal.');
      return { registrado: rErr.registrado, motivo: 'comprobante_claim_error', intento: rErr.intento };
    }
    if (!reclamado) {
      // El gasto se anota IGUAL. La primera versión de esta guarda retornaba acá sin guardar, y
      // acá eso es lo más caro del repo: si la solicitud pendiente salió de un falso positivo,
      // ESTA captura es el pago real, y este usuario no tiene forma de reclamar ni de enterarse.
      const rPend = await registrarPagoParseado(parsed, usuario);
      log.info({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, registrado: rPend.registrado },
        'Captura de pago con solicitud ya pendiente: no se abre otra');
      await avisarUnaVez(usuario.id + '|segunda-captura-pago|' + parsed.monto + '|' + (parsed.comercio || ''),
        '⏳ Un usuario con *username de WhatsApp* (`' + usuario.id + '`) mandó OTRA captura que parece un pago ' +
        'a Neto y ya tiene una solicitud sin resolver.\n\nVision leyó: *' + (parsed.comercio || '(sin comercio)') + '* — ' + parsed.monto + '\n\n' +
        'Si la pendiente era un falso positivo, ESTA puede ser el pago de verdad. ' +
        (rPend.registrado ? 'El gasto quedó anotado igual.' : 'El gasto NO se pudo anotar (' + rPend.motivo + ').'));
      return { registrado: rPend.registrado, motivo: 'comprobante_ya_pendiente', intento: rPend.intento };
    }
    const montoDet = parseFloat(parsed.monto);
    let pagoId = null, comprobantePath = null, usuarioMarcado = false;
    try {
      ({ pagoId, comprobantePath, usuarioMarcado } = await registrarSolicitudPro({
        usuario,
        monto: montoDet,
        montoDetectado: montoDet,
        tipoPlan: resolverTipoPlan(montoDet, usuario.tipo_plan),
        metodoPago: parsed.metodo_pago || 'Yape',
        comprobanteBuffer: buffer,
        mimeType,
        origen: 'whatsapp',
        yaReclamado: true,
      }) || {});
    } catch (e) {
      log.error({ tag: 'BSUID_SILENCIOSO', err: msgErr(e), usuarioId: usuario.id }, 'Falló registrar la solicitud Pro');
      // El claim ya está tomado y acá no sabemos si la fila quedó: `registrarSolicitudPro`
      // lanza casi siempre DESPUÉS del INSERT (la notificación al admin). Soltarlo igual es la
      // dirección correcta de error — un duplicado se rechaza, un usuario marcado sin
      // solicitud y sin número no tiene NINGUNA salida: ni `/pago`, ni el panel, ni reenviar.
      await liberarSolicitudPro(usuario.id);
      await avisarAdminPagoPerdido(usuario, montoDet, msgErr(e) +
        ' · revisá `pagos` antes de crear nada: la fila puede haber quedado');
      return { registrado: false, motivo: 'comprobante_error' };
    }

    // `registrarSolicitudPro` NO lanza cuando algo sale mal por dentro: Storage, el INSERT en
    // `pagos` y el UPDATE de `usuarios` tienen try/catch propios que solo loguean. O sea que
    // el `catch` de arriba casi nunca corre y una solicitud a medias vuelve como si nada.
    // Los dos que quedan importan, no solo el `pagoId`:
    //   · sin `pagoId` no hay solicitud: el pago no existe en ningún lado.
    //   · sin `comprobantePath` la fila queda sin la imagen (llegó por Telegram, no a la DB).
    // Un canal que puede responder se entera por el usuario cuando algo de esto falla. Este no.
    //
    // `usuarioMarcado` YA NO se mira, y eso es una consecuencia del claim, no un descuido: con
    // `yaReclamado` las tres columnas de `usuarios` las escribió el UPDATE condicional que nos
    // dejó llegar hasta acá, así que si estuvieran sin escribir no habríamos entrado. Mirarlo
    // sólo podría producir la alarma al revés — "no se marcó `pago_pendiente`" sobre una
    // solicitud sana— y este aviso va al admin para que reconstruya un pago a mano.
    const faltantes = [
      !pagoId && 'no quedó la fila en `pagos`',
      !comprobantePath && 'el comprobante no subió a Storage',
    ].filter(Boolean);
    if (faltantes.length) {
      log.error({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, pagoId, comprobantePath, usuarioMarcado },
        'Solicitud Pro incompleta');
      // Sin `pagoId` no hay nada que aprobar, y el claim quedaría puesto sobre la nada. Este
      // usuario no tiene número: si no se suelta acá, no vuelve a poder pagar por ningún lado.
      if (!pagoId) await liberarSolicitudPro(usuario.id);
      await avisarAdminPagoPerdido(usuario, montoDet, faltantes.join(' · '));
      // Sin `pagoId` no hay nada; con `pagoId` la solicitud existe y es aprobable, solo que
      // coja. Se distingue para que el aviso no mande a reconstruir algo que ya está.
      if (!pagoId) return { registrado: false, motivo: 'comprobante_sin_pago' };
      return { registrado: true, motivo: 'comprobante_pro_incompleto' };
    }

    // Este aviso va PEGADO al de `registrarSolicitudPro`, que es el que manda la tarjeta con la
    // foto y los botones: dice "el comprobante de arriba" y esa referencia es posicional. Se
    // intentó moverlo después de `registrarPagoParseado` para poder contar si la confirmación
    // salió, y eso mete en el medio un round-trip a la DB más un POST a Meta de hasta 15s que
    // puede emitir su propio Telegram (el veredicto de D10) — o sea que "el de arriba" pasaba a
    // señalar otra cosa. El texto no afirma un desenlace, así que no necesita ese dato.
    await notificarAdmin('🔕 El comprobante de arriba llegó de un usuario con *username de WhatsApp*: ' +
      'se registró la solicitud pero NO se le confirmó el comprobante por chat, y tampoco se va a ' +
      'enterar cuando lo apruebes. Apróbalo normal.\n\n' +
      // Antes decía "no se le pudo confirmar NADA", y desde el 15-ago es falso: se le intenta la
      // confirmación del GASTO al número guardado. Sin esta línea el aviso manda a compensar a
      // mano algo que quizá ya llegó.
      '_Del gasto sí se le intenta una confirmación al número guardado (D10); si esa llega, te avisa otro Telegram._');
    // El gasto de la suscripción se registra igual que en el camino normal: es plata que salió.
    const rPro = await registrarPagoParseado(parsed, usuario);
    return { registrado: true, motivo: 'comprobante_pro', intento: rPro.intento };
  }

  // Se avisa DESPUÉS de intentar guardar y con el resultado en la mano: el aviso decía
  // "se registró como gasto" antes de registrarlo, y hay tres formas de que no se registre
  // (no_pago, monto ilegible, guardarTransaccion que rechaza).
  const r = await registrarPagoParseado(parsed, usuario);
  // El aviso dice "esto puede ser un comprobante que Vision leyó mal". Hay DOS señales de eso y
  // hace falta cualquiera de las dos:
  //
  //   · el flag puesto — el usuario venía a mandar su comprobante;
  //   · el MONTO es el de un plan aunque el comercio no matchee — el caso "F. Mendoza L." con
  //     S/10, que es literalmente el ejemplo que justifica el throttle de arriba.
  //
  // La segunda no estaba, y sin ella quedaba abierta justo la mitad que este cambio vino a
  // cerrar: el username-only que RENUEVA sigue con `plan='premium'`, nadie le pone el flag, y
  // su comprobante mal leído se anotaba como gasto sin que nadie se enterara nunca. Lo encontró
  // la segunda revisión adversarial del diff.
  //
  // Lo que NO se hace es avisar por toda captura: eso convertiría cada foto de estos usuarios
  // en un Telegram, que es lo que el throttle existe para evitar.
  const montoNum = parseFloat(parsed && parsed.monto);
  const pareceMontoDePlan = !isNaN(montoNum) && (
    Math.abs(montoNum - PRO_PRECIOS.mensual) < 0.5 || Math.abs(montoNum - PRO_PRECIOS.anual) < 1.5
  );
  if (!esperaba && !pareceMontoDePlan) return r;
  const monto = parsed && parsed.monto != null ? parsed.monto : '?';
  const comercio = (parsed && parsed.comercio) || '(sin comercio)';
  await avisarUnaVez(usuario.id + '|no-es-pago|' + monto + '|' + comercio,
    '⚠️ Un usuario con *username de WhatsApp* (`' + usuario.id + '`) mandó una captura mientras ' +
    'esperaba enviar su comprobante Pro, y no parece el pago a Neto.\n\n' +
    'Vision leyó: *' + comercio + '* — ' + monto + '\n' +
    (r.registrado ? 'Se registró como gasto.' : 'No se registró nada (' + r.motivo + ').') + '\n\n' +
    'Si eso ERA su pago (un nombre mal leído, un monto mal leído), hay que activarlo a mano: ' +
    // Decía "no se le puede pedir que reenvíe la captura", en absoluto. Desde el 15-ago al
    // número guardado sí se le INTENTA escribir, así que la afirmación depende de un veredicto
    // (D10) que todavía no está. Es el tercer aviso de esta clase; los otros dos se corrigieron
    // en la misma pasada y este se había quedado.
    'por el chat solo se le puede INTENTAR (D10), todavía no sabemos si le llega.');
  return r;
}

module.exports = {
  registrarGastoSilencioso,
  registrarPagoParseado,
  registrarAudioSilencioso,
  registrarImagenSilenciosa,
  avisarPrimeraVezSilencioso,
  textoConfirmacion,
};
