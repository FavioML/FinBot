const log = require('./logger');
const { enviarWhatsapp } = require('./whatsapp');
const { crearNotificacion } = require('./notifications-db');

/**
 * Canales de un aviso PROACTIVO — el que Neto empuja: crons, triggers, avisos de espacios.
 * No cubre las respuestas del webhook, que son turno de conversación.
 *
 * Se declaran con una constante, y no con booleanos ni con un string suelto, por tres
 * razones concretas:
 *   · un typo es `undefined` al cargar el módulo, no un canal que se cae en silencio;
 *   · `grep -rn "CANALES.SOLO_" .` es la auditoría completa de las excepciones;
 *   · el conjunto es cerrado: no existe "olvidé declarar" que se parezca a un valor válido.
 *
 * AMBOS es el default del producto, no un default del código: hay que escribirlo. El
 * WhatsApp libre no se entrega fuera de la ventana de 24h de Meta (131047) y las plantillas
 * están descartadas (ver docs/whatsapp-templates.md), así que la in-app es el único canal
 * que llega a todos. Un aviso que solo existe en WhatsApp, para el inactivo no existe.
 */
const CANALES = Object.freeze({
  AMBOS: 'ambos',
  SOLO_WHATSAPP: 'solo_whatsapp',
  SOLO_IN_APP: 'solo_in_app',
});

const CANALES_VALIDOS = new Set(Object.values(CANALES));

/**
 * WhatsApp renderiza *negrita* y _cursiva_; la webapp los mostraría literales. Es el
 * `.replace(/[*_]/g, '')` que estaba copiado en los 17 call-sites duales.
 */
function sanitizarParaWeb(texto) {
  return String(texto == null ? '' : texto).replace(/[*_]/g, '');
}

/**
 * Lo que se devuelve como `wa` cuando el canal WhatsApp NO fue declarado. Tiene la misma
 * forma que devuelve `enviarWhatsapp` a propósito: el gate de `checkTrialExpiry`
 * (`wa.ok && !wa.skipped`) da false sin tener que ramificar por canal.
 */
const WA_NO_DECLARADO = Object.freeze({ ok: false, skipped: 'canal_no_declarado' });

/**
 * Único camino para mandarle un aviso proactivo a un usuario.
 *
 * Qué hace y qué NO hace:
 *   · SÍ: obliga a declarar canales, manda WhatsApp e in-app en ese orden, deriva el texto
 *     in-app del de WhatsApp, aísla cada canal, y devuelve el resultado crudo de WhatsApp
 *     para quien lo necesite.
 *   · NO: dedupe. Vive en el call-site y hoy tiene cuatro mecanismos distintos (query contra
 *     `notificaciones` por tipo+titulo+fecha; ledger JSONB `deudas.recordatorios_enviados`;
 *     claim atómico sobre `survey_events`; la sola ventana horaria del cron). Absorberlos
 *     acá obligaría a reimplementar los cuatro y a que este módulo conozca `deudas` y
 *     `survey_events`. Peor: un dedupe genérico "mismo tipo + mismo día" rompería el
 *     catch-up de deudas, que a propósito manda el touch más avanzado alcanzado.
 *   · NO: gate de plan. Eso lo cubre `tests/cron/lecturas-proactivas.test.js`, que mira la
 *     función completa del cron y no el envío.
 *
 * Best-effort absoluto: NUNCA lanza. Cada canal tiene su try/catch propio, así que un canal
 * caído no se lleva al otro ni corta el bucle de destinatarios del llamador.
 *
 * @param {object}  o
 * @param {string}  o.canales      CANALES.AMBOS | SOLO_WHATSAPP | SOLO_IN_APP. Obligatorio.
 * @param {string} [o.motivo]      Obligatorio cuando `canales` !== AMBOS. Va al log. Escribirlo
 *                                 sobre AMBOS es ruido y el guard estático lo rechaza.
 *                                 Ojo: el guard lo busca dentro de los ~300 chars siguientes a
 *                                 `canales:`, así que va inmediatamente después, sin un
 *                                 comentario largo en el medio.
 * @param {string}  o.usuarioId    id interno de `usuarios`. Necesario para la in-app y para
 *                                 `notification_deliveries`.
 * @param {string} [o.whatsapp]    número destino. `null` es válido y esperado (usuario
 *                                 web-first): la in-app sale igual y el intento queda como
 *                                 `skipped_no_whatsapp` en `notification_deliveries`.
 * @param {string}  o.tipo         slug de observabilidad → `notification_deliveries.tipo`.
 * @param {string}  o.mensaje      texto WhatsApp, con su markdown.
 * @param {object} [o.template]    payload de plantilla de Meta; pasa tal cual.
 * @param {string} [o.titulo]      título in-app. Obligatorio si el canal in-app está declarado:
 *                                 sin él la campana muestra una fila vacía.
 * @param {string} [o.tipoInApp]   `notificaciones.tipo`, o sea la familia de icono de la
 *                                 campana. Default 'sistema'. Es una taxonomía DISTINTA de
 *                                 `tipo` (que es granular): colapsarlas rompe una de las dos.
 * @param {string} [o.cuerpo]      override del texto in-app. Default: sanitizarParaWeb(mensaje).
 *                                 Sin truncado por default — quien hoy corta a 400 o 200 chars
 *                                 lo pasa explícito, así cada migración queda byte-idéntica.
 * @param {string} [o.link]        deeplink → `datos.link`, lo consume notification-bell.tsx.
 * @param {object} [o.datos]       extras de `datos` (se mergean debajo de `link`).
 *
 * @returns {Promise<{wa: {ok:boolean, code?:number, error?:string, msgId?:string, skipped?:string},
 *                    inApp: boolean}>}
 */
async function notificarUsuario({
  canales,
  motivo = null,
  usuarioId = null,
  whatsapp = null,
  tipo = null,
  mensaje = '',
  template = null,
  titulo = null,
  tipoInApp = 'sistema',
  cuerpo = null,
  link = null,
  datos = null,
}) {
  // Canal inválido o ausente: se ASUME AMBOS y se grita en el log. Lanzar acá violaría el
  // best-effort y dejaría al usuario sin aviso por un error del programador. El castigo por
  // no declarar vive en el build (tests/notificaciones-duales.test.js), no en producción.
  let modo = canales;
  if (!CANALES_VALIDOS.has(modo)) {
    log.error({ tag: 'NOTIF', tipo, usuarioId, canales },
      'Aviso proactivo sin canales declarados: se asume AMBOS');
    modo = CANALES.AMBOS;
  }
  if (modo !== CANALES.AMBOS && !motivo) {
    log.error({ tag: 'NOTIF', tipo, usuarioId, canales: modo },
      'Canal único sin motivo declarado');
  }

  const quiereWa = modo === CANALES.AMBOS || modo === CANALES.SOLO_WHATSAPP;
  const quiereInApp = modo === CANALES.AMBOS || modo === CANALES.SOLO_IN_APP;

  let wa = WA_NO_DECLARADO;
  if (quiereWa) {
    try {
      // Se llama SIEMPRE, incluso con `whatsapp` null: enviarWhatsapp hace no-op y deja la
      // fila `skipped_no_whatsapp`. Sin esa fila, un usuario web-first es indistinguible de
      // uno que nunca entró al cron.
      wa = await enviarWhatsapp(whatsapp, mensaje, { tipo, usuarioId, template });
    } catch (e) {
      // enviarWhatsapp no lanza por contrato. El try existe igual porque la in-app NO puede
      // depender de que ese contrato se sostenga para siempre — y porque los tests lo mockean
      // con `mockRejectedValueOnce`, que es exactamente ese escenario.
      log.error({ tag: 'NOTIF', tipo, usuarioId, err: e.message }, 'enviarWhatsapp lanzó');
      wa = { ok: false, error: e.message };
    }
    // Algunos mocks del repo devuelven `true` en vez del objeto de resultado. Normalizar acá
    // evita que un contador de diagnóstico quede en cero por una forma de mock.
    if (!wa || typeof wa !== 'object') wa = { ok: !!wa };
  }

  let inApp = false;
  if (quiereInApp) {
    if (!usuarioId || !titulo) {
      log.error({ tag: 'NOTIF', tipo, usuarioId, titulo },
        'Aviso in-app sin usuarioId o sin título: no se escribe');
    } else {
      try {
        inApp = await crearNotificacion(
          usuarioId,
          tipoInApp,
          titulo,
          cuerpo != null ? cuerpo : sanitizarParaWeb(mensaje),
          Object.assign({}, datos || {}, link ? { link } : {}),
        );
      } catch (e) {
        log.error({ tag: 'NOTIF', tipo, usuarioId, err: e.message }, 'crearNotificacion lanzó');
        inApp = false;
      }
    }
  }

  // La única línea que importa de verdad para ops: el aviso salió y no llegó a nadie.
  // `skipped_test` no cuenta como falla (is_test_user es un silencio pedido).
  const waLlego = wa.ok === true && !wa.skipped;
  if (!waLlego && !inApp && wa.skipped !== 'test_user') {
    log.warn({
      tag: 'NOTIF', tipo, usuarioId, canales: modo, motivo,
      waCode: wa.code != null ? wa.code : null,
      waSkip: wa.skipped || null,
    }, 'Aviso proactivo sin entrega en ningún canal');
  }

  return { wa, inApp };
}

module.exports = { notificarUsuario, CANALES, sanitizarParaWeb };
