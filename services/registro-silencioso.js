const { parsearRegistroManual } = require('./parsers');
const { guardarTransaccion } = require('./transactions');
const { descargarMedia, transcribirAudio, extraerPagoDeImagen } = require('./media-intake');
const { esperaComprobante, esPagoNeto, registrarSolicitudPro } = require('../lib/pro-payment');
const { resolverTipoPlan } = require('../lib/config');
const { notificarAdmin } = require('../lib/admin-notify');
const { registrarError } = require('../lib/error-monitor');
const { hoyPeru } = require('../lib/dates');
const log = require('../lib/logger');

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

  try {
    await guardarTransaccion(usuario.id, { ...datos, descripcion_original: limpio.substring(0, 200) });
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'No se pudo guardar la transacción');
    return { registrado: false, motivo: 'guardado_error' };
  }

  log.info({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, tipo: datos.tipo }, 'Gasto registrado sin poder responder');
  return { registrado: true, motivo: 'ok' };
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
  // `r` es null cuando el tipo no se puede procesar a ciegas (un documento, un sticker), y sin
  // esto el aviso decía literalmente "no registrado (null)".
  const desenlace = !resultado ? 'no se puede procesar a ciegas'
    : (resultado.registrado ? 'registrado' : 'no registrado: ' + resultado.motivo);
  // El comando solo se ofrece si hay número que medir. Un usuario web-first tiene `whatsapp`
  // NULL, y ahí la pregunta ni siquiera aplica.
  const comoMedir = usuario.whatsapp
    ? 'Es el momento de medir si al número guardado todavía le llega:\n' +
      '`node qa-e2e/probe-envio-username.mjs ' + usuario.whatsapp + ' --confirmar`'
    : 'No tiene número guardado, así que no hay nada que medir por WhatsApp.';
  try {
    await avisarUnaVez(usuario.id + '|primera-vez-silencioso',
      '🔕 *Primera vez sin número* — el usuario `' + usuario.id + '`' +
      (usuario.whatsapp ? ' (' + usuario.whatsapp + ')' : '') +
      ' escribió y Meta ya NO manda su número. Lo reconocimos por su BSUID.\n\n' +
      'Mensaje de tipo *' + tipo + '* → ' + desenlace + '.\n\n' +
      'A partir de ahora **no recibe ninguna respuesta del bot**. ' + comoMedir);
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
    'Escribe con username de WhatsApp, así que Meta ya no manda su número y el bot no le puede ' +
    'contestar por el chat.\n\n' +
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

  try {
    await guardarTransaccion(usuario.id, { ...parsed, fecha: parsed.fecha || hoyPeru() });
  } catch (e) {
    log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'No se pudo guardar la transacción');
    return { registrado: false, motivo: 'guardado_error' };
  }

  log.info({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, tipo: parsed.tipo }, 'Pago de imagen registrado sin poder responder');
  return { registrado: true, motivo: 'ok' };
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

  if (esperaComprobante(usuario)) {
    if (esPagoNeto(parsed)) {
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
        }) || {});
      } catch (e) {
        log.error({ tag: 'BSUID_SILENCIOSO', err: e.message, usuarioId: usuario.id }, 'Falló registrar la solicitud Pro');
        await avisarAdminPagoPerdido(usuario, montoDet, e.message);
        return { registrado: false, motivo: 'comprobante_error' };
      }

      // `registrarSolicitudPro` NO lanza cuando algo sale mal por dentro: Storage, el INSERT en
      // `pagos` y el UPDATE de `usuarios` tienen try/catch propios que solo loguean. O sea que
      // el `catch` de arriba casi nunca corre y una solicitud a medias vuelve como si nada.
      // Los TRES importan, no solo el `pagoId`:
      //   · sin `pagoId` no hay solicitud: el pago no existe en ningún lado.
      //   · sin `comprobantePath` la fila queda sin la imagen (llegó por Telegram, no a la DB).
      //   · sin `usuarioMarcado` el badge "pendiente" del panel no se prende —se calcula con
      //     `usuarios.pago_pendiente`— y encima `esperando_comprobante` sigue en true, así que
      //     una segunda captura abriría una SEGUNDA solicitud.
      // Un canal que puede responder se entera por el usuario cuando algo de esto falla. Este no.
      const faltantes = [
        !pagoId && 'no quedó la fila en `pagos`',
        !comprobantePath && 'el comprobante no subió a Storage',
        !usuarioMarcado && 'no se marcó `pago_pendiente` en `usuarios`',
      ].filter(Boolean);
      if (faltantes.length) {
        log.error({ tag: 'BSUID_SILENCIOSO', usuarioId: usuario.id, pagoId, comprobantePath, usuarioMarcado },
          'Solicitud Pro incompleta');
        await avisarAdminPagoPerdido(usuario, montoDet, faltantes.join(' · '));
        // Sin `pagoId` no hay nada; con `pagoId` la solicitud existe y es aprobable, solo que
        // coja. Se distingue para que el aviso no mande a reconstruir algo que ya está.
        if (!pagoId) return { registrado: false, motivo: 'comprobante_sin_pago' };
        return { registrado: true, motivo: 'comprobante_pro_incompleto' };
      }

      await notificarAdmin('🔕 El comprobante de arriba llegó de un usuario con *username de WhatsApp*: ' +
        'se registró la solicitud pero NO se le pudo confirmar nada por chat, y tampoco se va a ' +
        'enterar cuando lo apruebes. Apróbalo normal.');
      // El gasto de la suscripción se registra igual que en el camino normal: es plata que salió.
      await registrarPagoParseado(parsed, usuario);
      return { registrado: true, motivo: 'comprobante_pro' };
    }

    // Se avisa DESPUÉS de intentar guardar y con el resultado en la mano: el aviso decía
    // "se registró como gasto" antes de registrarlo, y hay tres formas de que no se registre
    // (no_pago, monto ilegible, guardarTransaccion que rechaza).
    const r = await registrarPagoParseado(parsed, usuario);
    const monto = parsed && parsed.monto != null ? parsed.monto : '?';
    const comercio = (parsed && parsed.comercio) || '(sin comercio)';
    await avisarUnaVez(usuario.id + '|no-es-pago|' + monto + '|' + comercio,
      '⚠️ Un usuario con *username de WhatsApp* (`' + usuario.id + '`) mandó una captura mientras ' +
      'esperaba enviar su comprobante Pro, y no parece el pago a Neto.\n\n' +
      'Vision leyó: *' + comercio + '* — ' + monto + '\n' +
      (r.registrado ? 'Se registró como gasto.' : 'No se registró nada (' + r.motivo + ').') + '\n\n' +
      'Si eso ERA su pago (un nombre mal leído, un monto mal leído), hay que activarlo a mano: ' +
      'no se le puede pedir que reenvíe la captura.');
    return r;
  }

  return registrarPagoParseado(parsed, usuario);
}

module.exports = {
  registrarGastoSilencioso,
  registrarPagoParseado,
  registrarAudioSilencioso,
  registrarImagenSilenciosa,
  avisarPrimeraVezSilencioso,
};
