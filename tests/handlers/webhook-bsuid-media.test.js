import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// El camino silencioso con MEDIA: un usuario que activó un username de WhatsApp manda una foto
// de Yape o una nota de voz. Meta no manda su número, así que no hay a dónde responderle, pero
// lo reconocemos por su BSUID (migración 065) y anotar el gasto no depende de poder contestar.
//
// Hasta el 09-ago-2026 esto solo funcionaba con texto. Importa por volumen: 12 de los 34
// usuarios que registraron algo en los últimos 60 días lo hacen por captura.
//
// A diferencia de webhook-sin-from.test.js, acá NO se mockean las funciones de
// registro-silencioso: se ejercita el service de verdad y se mockea la capa de abajo (Meta,
// OpenAI, guardarTransaccion). Si no, el test pasaría verde con el service vacío.

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

// Devuelve lo que devuelve el real (`{ok, msgId}`), no `undefined`. Con `undefined` el intento
// de confirmación se lee como "no se pudo medir" y el aviso de primera vez cambia de rama, o sea
// que el mock decidía el resultado del test por una diferencia que producción no tiene.
const enviarWhatsapp = vi.fn().mockResolvedValue({ ok: true, msgId: 'wamid.conf' });
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const buscarUsuarioPorBsuid = vi.fn();
require('../../helpers/db-helpers').buscarUsuarioPorBsuid = buscarUsuarioPorBsuid;
const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

const guardarTransaccion = vi.fn().mockResolvedValue({ categoria: 'Alimentación' });
require('../../services/transactions').guardarTransaccion = guardarTransaccion;

const parsearRegistroManual = vi.fn();
require('../../services/parsers').parsearRegistroManual = parsearRegistroManual;

const registrarSolicitudPro = vi.fn().mockResolvedValue({ pagoId: 'pago-1', comprobantePath: 'u/1.jpg', usuarioMarcado: true });
require('../../lib/pro-payment').registrarSolicitudPro = registrarSolicitudPro;

// Quién puede abrir la solicitud ya no lo decide la columna que trae la fila del usuario, sino
// un UPDATE condicional (`reclamarSolicitudPro`). Su semántica propia —incluido el NULL de
// `pago_pendiente`— se prueba contra un almacén que filtra de verdad en
// `tests/handlers/webhook-comprobante-carrera.test.js`; acá se mockea porque lo que se mide es
// qué hace ESTE canal con cada uno de sus tres desenlaces.
const reclamarSolicitudPro = vi.fn().mockResolvedValue(true);
require('../../lib/pro-payment').reclamarSolicitudPro = reclamarSolicitudPro;

// La contraparte: si la solicitud no quedó, el claim se suelta. Sin eso este usuario —que no
// tiene número— queda marcado como "tiene una solicitud" sobre nada, y no hay canal por el que
// pueda volver a pagar ni comando manual que lo alcance (`/pago` busca por whatsapp).
const liberarSolicitudPro = vi.fn().mockResolvedValue(undefined);
require('../../lib/pro-payment').liberarSolicitudPro = liberarSolicitudPro;

const notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;

const registrarError = vi.fn();
require('../../lib/error-monitor').registrarError = registrarError;

// Solo `audio` del cliente OpenAI: reemplazar el objeto entero dejaría a Vision sin
// `chat.completions.create`, que es lo que parchea tests/setup.js sobre la instancia compartida.
const transcriptionsCreate = vi.fn();
require('../../lib/ai').openai.audio = { transcriptions: { create: transcriptionsCreate } };
const visionCreate = globalThis.__mockOpenAICreate;

function makeChain(data = []) {
  const c = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'ilike', 'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit', 'single', 'maybeSingle']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (onF, onR) => Promise.resolve({ data, error: null }).then(onF, onR);
  return c;
}
require('../../lib/db').supabase.from = vi.fn(() => makeChain([]));

const createWebhookHandler = require('../../handlers/webhook');
const procesarMensajeLibre = vi.fn().mockResolvedValue('ok');
const webhookHandler = createWebhookHandler(procesarMensajeLibre);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const CONOCIDO = { id: 'u-conocido', bsuid: 'PE.999', whatsapp: '51999000111', esperando_comprobante: false };

let wamidSeq = 0;
function postSinFrom(extra) {
  // Sin `from` ni `wa_id`: el payload exacto que manda Meta cuando el usuario tiene username.
  const message = { id: 'wamid-bm-' + (wamidSeq++), from_user_id: 'PE.999', ...extra };
  const body = { entry: [{ changes: [{ value: { messages: [message], contacts: [{ user_id: 'PE.999' }] } }] }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return webhookHandler(
    { headers: { 'x-hub-signature-256': signature }, rawBody, body },
    { sendStatus: vi.fn() },
  );
}

const imagen = () => ({ type: 'image', image: { id: 'media-img', mime_type: 'image/jpeg' } });
const audio = () => ({ type: 'audio', audio: { id: 'media-aud', mime_type: 'audio/ogg' } });

// Ramifica por URL en vez de por orden de llamada. La versión anterior encadenaba
// `mockResolvedValueOnce` (metadata) + un default con `arrayBuffer`, y eso servía UNA sola
// descarga: en la segunda, la llamada de metadata caía en el default —que no tiene `.json`—
// y `descargarMedia` reventaba antes de llegar a Vision. El test de dedup pasaba por eso y no
// por el dedup: verificado neutralizando `isDuplicateWamid`, con los 13 tests en verde.
function mockFetchOk(mime) {
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('media.meta')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    }
    return { ok: true, json: async () => ({ url: 'https://media.meta/x', mime_type: mime }) };
  });
}

function visionResponde(obj) {
  visionCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

// Al admin le puede llegar más de un aviso por el mismo mensaje (el de "primera vez sin
// número" y el del comprobante son eventos distintos), así que contar llamadas totales hace
// que un test se rompa por un aviso que no es el suyo. Estos helpers preguntan por el aviso
// concreto.
const avisos = () => notificarAdmin.mock.calls.map((c) => c[0]);
const avisosQueMatchean = (re) => avisos().filter((m) => re.test(m));
const PRIMERA_VEZ = /Primera vez sin número/i;

const YAPE_GASTO = {
  tipo: 'gasto', monto: 23.45, moneda: 'PEN', comercio: 'Pollería El Rancho',
  categoria: 'Alimentación', subcategoria: 'Restaurantes', metodo_pago: 'Yape', fecha: '2026-08-09',
};

/**
 * Hasta el 15-ago-2026 estos tests afirmaban `expect(enviarWhatsapp).not.toHaveBeenCalled()`: el
 * camino era silencioso de verdad. Se cambió a propósito (D10, decisión de Favio) — la
 * confirmación se INTENTA al número guardado, porque "a esta gente no se le puede escribir" es
 * una premisa que nunca se midió y este es el único punto donde se mide sin molestar a nadie.
 *
 * La aserción no se debilitó, se volvió más específica, y eso importa: lo que el `not` protegía
 * era que no se colara un turno de conversación en un camino que no puede sostenerlo. Exigir UNA
 * llamada, al número guardado y con el `tipo` del experimento sigue prohibiendo exactamente eso.
 * Cambiarla por un `toHaveBeenCalled()` pelado sí habría sido perder cobertura.
 */
function esperarConfirmacionD10(enviar, { numero = '51999000111' } = {}) {
  expect(enviar).toHaveBeenCalledOnce();
  const [dest, texto, opts] = enviar.mock.calls[0];
  expect(dest).toBe(numero);
  expect(opts).toMatchObject({ tipo: 'confirmacion_sin_numero' });
  // Sin `usuarioId` la fila de `notification_deliveries` queda huérfana y el callback no puede
  // decir de quién era: la medición se pierde justo cuando ocurre el caso que se espera hace
  // meses.
  expect(opts.usuarioId).toBeTruthy();
  expect(texto).toBeTruthy();
  return { dest, texto, opts };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('mensaje sin `from` con media, de un usuario reconocido por BSUID', () => {
  beforeEach(() => {
    enviarWhatsapp.mockClear().mockResolvedValue({ ok: true, msgId: 'wamid.conf' });
    // La fila que devuelve `guardarTransaccion`, no un stub con la categoría suelta: la
    // confirmación se arma con ESTA fila, y un fixture irreal la dejaba sin monto (que es
    // justo el caso del dedup, cubierto aparte en tests/services/registro-silencioso.test.js).
    guardarTransaccion.mockClear().mockResolvedValue({ id: 'tx1', tipo: 'gasto', monto: 23.45, moneda: 'PEN', comercio: 'Pollería El Rancho', categoria: 'Alimentación' });
    registrarSolicitudPro.mockClear().mockResolvedValue({ pagoId: 'pago-1', comprobantePath: 'u/1.jpg', usuarioMarcado: true });
    reclamarSolicitudPro.mockClear().mockResolvedValue(true);
    liberarSolicitudPro.mockClear().mockResolvedValue(undefined);
    notificarAdmin.mockClear();
    registrarError.mockClear();
    procesarMensajeLibre.mockClear();
    transcriptionsCreate.mockReset();
    parsearRegistroManual.mockReset();
    visionCreate.mockReset().mockResolvedValue({ choices: [{ message: { content: '{}' } }] });
    buscarUsuarioPorBsuid.mockReset().mockResolvedValue({ ...CONOCIDO });
  });

  describe('imagen (foto de Yape/Plin)', () => {
    it('registra el gasto que ve Vision y le INTENTA la confirmación al número guardado', async () => {
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);

      await postSinFrom(imagen());

      expect(guardarTransaccion).toHaveBeenCalledOnce();
      const [usuarioId, datos] = guardarTransaccion.mock.calls[0];
      expect(usuarioId).toBe('u-conocido');
      expect(datos.monto).toBe(23.45);
      esperarConfirmacionD10(enviarWhatsapp);
    });

    it('la confirmación usa la categoría PERSISTIDA, no la que dijo Vision', async () => {
      mockFetchOk('image/jpeg');
      // Vision dice 'Alimentación'; una regla por comercio la resolvió a otra cosa al guardar.
      // Confirmarle la de Vision le contaría una categoría que no es la que ve en el dashboard.
      guardarTransaccion.mockResolvedValue({ tipo: 'gasto', monto: 23.45, moneda: 'PEN', comercio: 'Pollería El Rancho', categoria: 'Delivery' });
      visionResponde(YAPE_GASTO);

      await postSinFrom(imagen());

      const { texto } = esperarConfirmacionD10(enviarWhatsapp);
      expect(texto).toContain('Delivery');
      expect(texto).not.toContain('Alimentación');
    });

    it('a un usuario sin número guardado no se le intenta nada', async () => {
      // Web-first: `whatsapp` NULL. No hay a dónde mandar y no hay nada que medir; sin esta
      // guarda el envío entra igual y `enviarWhatsapp` escribe una fila `skipped_no_whatsapp`
      // que ensucia justo la consulta con la que se lee el veredicto.
      buscarUsuarioPorBsuid.mockResolvedValue({ ...CONOCIDO, whatsapp: null });
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);

      await postSinFrom(imagen());

      expect(guardarTransaccion).toHaveBeenCalledOnce();
      expect(enviarWhatsapp).not.toHaveBeenCalled();
    });

    it('una imagen que no es un pago no registra nada', async () => {
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'no_pago' });

      await postSinFrom(imagen());

      expect(guardarTransaccion).not.toHaveBeenCalled();
      expect(enviarWhatsapp).not.toHaveBeenCalled();
    });

    it('si Vision falla, el webhook no revienta y no se inventa una transacción', async () => {
      mockFetchOk('image/jpeg');
      visionCreate.mockRejectedValueOnce(new Error('vision down'));

      await postSinFrom(imagen());

      expect(guardarTransaccion).not.toHaveBeenCalled();
    });

    it('sin fecha en la captura, cae al día de hoy', async () => {
      mockFetchOk('image/jpeg');
      const { fecha, ...sinFecha } = YAPE_GASTO;
      visionResponde(sinFecha);

      await postSinFrom(imagen());

      expect(guardarTransaccion.mock.calls[0][1].fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('audio (nota de voz)', () => {
    it('transcribe y registra el gasto dictado', async () => {
      mockFetchOk('audio/ogg');
      transcriptionsCreate.mockResolvedValue({ text: 'gasté 30 soles en el almuerzo' });
      parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 30, comercio: 'almuerzo' });

      await postSinFrom(audio());

      expect(transcriptionsCreate).toHaveBeenCalledOnce();
      expect(parsearRegistroManual).toHaveBeenCalledWith('gasté 30 soles en el almuerzo', expect.any(String));
      expect(guardarTransaccion).toHaveBeenCalledOnce();
      esperarConfirmacionD10(enviarWhatsapp);
    });

    it('un audio ilegible se intenta transcribir y ahí muere', async () => {
      mockFetchOk('audio/ogg');
      transcriptionsCreate.mockResolvedValue({ text: '   ' });

      await postSinFrom(audio());

      expect(transcriptionsCreate).toHaveBeenCalledOnce();
      expect(parsearRegistroManual).not.toHaveBeenCalled();
      expect(guardarTransaccion).not.toHaveBeenCalled();
    });

    // El gasto se pierde y no hay reintento (el webhook responde 200 antes de procesar, así que
    // Meta ya dio la entrega por buena). La fila en `errores` es todo el rastro que queda, y
    // tiene que ser consultable POR USUARIO: es la primera query cuando alguien reclama que su
    // gasto no aparece.
    it('si falla la transcripción, queda en `errores` atribuido al usuario', async () => {
      mockFetchOk('audio/ogg');
      transcriptionsCreate.mockRejectedValue(new Error('whisper down'));

      await postSinFrom(audio());

      expect(registrarError).toHaveBeenCalledOnce();
      const [tag, mensaje, opts] = registrarError.mock.calls[0];
      expect(tag).toBe('BSUID_SILENCIOSO');
      expect(mensaje).toMatch(/whisper down/);
      expect(opts.usuarioId).toBe('u-conocido');
      expect(opts.stack).toBeTruthy();
    });

    it('una consulta dictada se transcribe pero no registra nada (no se puede contestar)', async () => {
      mockFetchOk('audio/ogg');
      transcriptionsCreate.mockResolvedValue({ text: '¿cuánto gasté este mes?' });
      parsearRegistroManual.mockResolvedValue({ ok: false });

      await postSinFrom(audio());

      // Lo que tiene dientes es que SÍ se transcribió y aun así no se guardó nada: el parser
      // dijo que no era un gasto. (Que `procesarMensajeLibre` no se llame no prueba nada acá:
      // el NLP es inalcanzable desde el bloque `if (!from)` con o sin este cambio.)
      expect(transcriptionsCreate).toHaveBeenCalledOnce();
      expect(parsearRegistroManual).toHaveBeenCalledWith('¿cuánto gasté este mes?', expect.any(String));
      expect(guardarTransaccion).not.toHaveBeenCalled();
    });
  });

  describe('comprobante Pro (el caso con plata de por medio)', () => {
    // Un id distinto por test: el throttle del aviso al admin es un Set de MÓDULO y sobrevive
    // al beforeEach, así que compartir id haría que un test se comiera el aviso del siguiente
    // (y el del throttle pasaría por el motivo equivocado).
    let seq = 0;
    let usuarioId;
    beforeEach(() => {
      usuarioId = 'u-comprobante-' + (++seq);
      buscarUsuarioPorBsuid.mockResolvedValue({
        ...CONOCIDO, id: usuarioId, esperando_comprobante: true, comprobante_solicitado_at: new Date().toISOString(),
      });
    });

    it('registra la solicitud aunque no se le pueda confirmar, y avisa al admin', async () => {
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas', metodo_pago: 'Yape' });

      await postSinFrom(imagen());

      expect(registrarSolicitudPro).toHaveBeenCalledOnce();
      const arg = registrarSolicitudPro.mock.calls[0][0];
      expect(arg.usuario.id).toBe(usuarioId);
      expect(arg.montoDetectado).toBe(10);
      expect(Buffer.isBuffer(arg.comprobanteBuffer)).toBe(true);   // el comprobante llega a Storage
      // Y le dice que el claim ya está tomado: sin esto se repite el UPDATE de las tres
      // columnas, y su fallo devolvería `usuarioMarcado:false` sobre una solicitud sana —
      // justo la alarma de "solicitud incompleta" que este canal manda al admin.
      expect(arg.yaReclamado).toBe(true);
      // El gasto de la suscripción se registra igual que en el camino normal.
      expect(guardarTransaccion).toHaveBeenCalledOnce();
      // El "comprobante recibido" sigue SIN mandarse: lo único que sale es la confirmación del
      // gasto, que es la que mide D10. Confirmarle además el pago sería prometerle un estado que
      // depende de que Favio lo apruebe, y por este canal no nos vamos a poder desdecir.
      const { texto } = esperarConfirmacionD10(enviarWhatsapp);
      expect(texto).not.toMatch(/comprobante/i);
      expect(notificarAdmin).toHaveBeenCalled();
    });

    // `registrarSolicitudPro` NO lanza cuando el INSERT en `pagos` falla: tiene try/catch
    // propio y devuelve `{pagoId: null}`. Ese es el modo de fallo REAL, y el que hay que
    // cubrir — el `mockRejectedValue` que había acá antes probaba una rama que en producción
    // casi no puede ocurrir, mientras la que sí ocurre salía como éxito.
    it('si el INSERT en `pagos` no quedó, el admin recibe una alarma en vez de un OK', async () => {
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas' });
      registrarSolicitudPro.mockResolvedValue({ pagoId: null, comprobantePath: null, usuarioMarcado: false });

      await postSinFrom(imagen());

      const alarmas = avisosQueMatchean(/a medias/i);
      expect(alarmas).toHaveLength(1);
      expect(alarmas[0]).toContain(usuarioId);
      expect(alarmas[0]).toMatch(/no quedó la fila en `pagos`/);
      // "en vez de un OK" es la mitad del nombre del test: contar SOLO el propio dejaba pasar
      // un "Apróbalo normal" espurio al lado de la alarma. El otro aviso es el de primera vez.
      expect(avisos()).toHaveLength(2);
      // Y no se le suma el gasto de suscripción a una solicitud que no existe.
      expect(guardarTransaccion).not.toHaveBeenCalled();
      // El claim vuelve a quedar libre: si no, este usuario no puede pagar nunca más.
      expect(liberarSolicitudPro).toHaveBeenCalledWith(usuarioId);
    });

    it('con la solicitud creada NO suelta el claim', async () => {
      // El control de la línea de arriba: soltarlo siempre reabre la carrera que el claim
      // vino a cerrar y apaga el badge de "pendiente" sobre una solicitud que sí existe.
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas' });

      await postSinFrom(imagen());

      expect(liberarSolicitudPro).not.toHaveBeenCalled();
    });

    // Acá había un tercer caso —"el pago quedó pero el usuario no se marcó"— que MURIÓ con el
    // claim, y murió porque dejó de ser alcanzable: las tres columnas de `usuarios` las escribe
    // el UPDATE condicional que nos deja entrar, así que si no estuvieran escritas no habríamos
    // llegado hasta acá. Lo que sí es alcanzable, y no lo era antes, es que el claim no se
    // pueda hacer: ahí no se sabe si hay solicitud o no, y este canal no puede preguntar.
    it('si el claim no se pudo hacer, el gasto se anota y el admin recibe la alarma', async () => {
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas' });
      reclamarSolicitudPro.mockRejectedValue(new Error('timeout'));

      await postSinFrom(imagen());

      // No se abre nada a ciegas: podría haber una solicitud del otro lado de la carrera.
      expect(registrarSolicitudPro).not.toHaveBeenCalled();
      // Pero la captura NO se descarta: si la que ganó salió de un falso positivo, ésta es el
      // pago real, y el gasto es lo único que queda de ella.
      expect(guardarTransaccion).toHaveBeenCalledOnce();
      // El aviso va por `avisarUnaVez` y no por `avisarAdminPagoPerdido`: un claim falla
      // cuando PostgREST está mal, o sea para todos a la vez, y sin dedup cada captura que
      // entre durante la caída manda otro Telegram.
      const alarmas = avisosQueMatchean(/No se pudo abrir la solicitud Pro/i);
      expect(alarmas).toHaveLength(1);
      expect(alarmas[0]).toContain(usuarioId);
      expect(alarmas[0]).toMatch(/el gasto quedó anotado/i);
      expect(registrarError).toHaveBeenCalled();
    });

    it('y ese aviso no se repite mientras dura la caída', async () => {
      reclamarSolicitudPro.mockRejectedValue(new Error('timeout'));
      for (let i = 0; i < 3; i++) {
        mockFetchOk('image/jpeg');
        visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas' });
        await postSinFrom(imagen());
      }
      expect(avisosQueMatchean(/No se pudo abrir la solicitud Pro/i)).toHaveLength(1);
    });

    it('si el comprobante no subió a Storage, también avisa', async () => {
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas' });
      registrarSolicitudPro.mockResolvedValue({ pagoId: 'pago-1', comprobantePath: null, usuarioMarcado: true });

      await postSinFrom(imagen());

      expect(avisosQueMatchean(/Storage/)).toHaveLength(1);
    });

    // El throw de `registrarSolicitudPro` viene casi siempre de la notificación al admin, o sea
    // DESPUÉS del INSERT: el aviso no puede mandar a reconstruir el pago a ciegas.
    it('si registrar la solicitud lanza, el aviso manda a revisar `pagos` antes de crear nada', async () => {
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas' });
      registrarSolicitudPro.mockRejectedValue(new Error('storage caído'));

      await postSinFrom(imagen());

      const alarmas = avisosQueMatchean(/a medias/i);
      expect(alarmas).toHaveLength(1);
      expect(alarmas[0]).toMatch(/REVISA la tabla `pagos`/);
      expect(alarmas[0]).not.toMatch(/reconstruirlo a mano/);
      expect(avisos()).toHaveLength(2);
      // El claim se suelta aunque no sepamos si la fila quedó: un duplicado se rechaza, un
      // usuario sin número marcado sobre la nada no tiene ninguna salida.
      expect(liberarSolicitudPro).toHaveBeenCalledWith(usuarioId);
    });

    it('una captura que no es el pago a Neto se guarda como gasto y se avisa al admin', async () => {
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);

      await postSinFrom(imagen());

      expect(registrarSolicitudPro).not.toHaveBeenCalled();
      expect(guardarTransaccion).toHaveBeenCalledOnce();
      // El aviso se manda DESPUÉS de guardar y dice lo que de verdad pasó.
      expect(avisosQueMatchean(/Se registró como gasto/)).toHaveLength(1);
    });

    it('si además no se pudo registrar, el aviso no miente', async () => {
      mockFetchOk('image/jpeg');
      visionResponde({ ...YAPE_GASTO, monto: null });   // Vision no leyó el monto

      await postSinFrom(imagen());

      expect(guardarTransaccion).not.toHaveBeenCalled();
      expect(avisosQueMatchean(/No se registró nada/)).toHaveLength(1);
    });

    // `esperaComprobante` no vence cuando el usuario quedó en onboarding_paso 2, y a este
    // usuario nada le puede pedir que salga de ahí: sin throttle, cada foto suya es otro
    // Telegram.
    it('la MISMA captura repetida no vuelve a avisar', async () => {
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);
      await postSinFrom(imagen());
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);
      await postSinFrom(imagen());

      expect(avisosQueMatchean(/no parece el pago a Neto/)).toHaveLength(1);
    });

    // Lo que el throttle NO puede comerse: esta rama es justo donde cae un comprobante Pro real
    // que Vision leyó mal (un "F. Mendoza L.", un monto torcido). Con la clave por usuario a
    // secas, una captura cualquiera quemaba el aviso y el pago siguiente se perdía sin un grito.
    it('una captura DISTINTA del mismo usuario sí vuelve a avisar', async () => {
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);
      await postSinFrom(imagen());

      mockFetchOk('image/jpeg');
      visionResponde({ ...YAPE_GASTO, monto: 10, comercio: 'F. Mendoza L.' });
      await postSinFrom(imagen());

      expect(avisosQueMatchean(/no parece el pago a Neto/)).toHaveLength(2);
      expect(avisosQueMatchean(/F\. Mendoza L\./)).toHaveLength(1);
    });

    // El flag salió de la decisión el 14-ago-2026: lo que dice si una captura es un comprobante
    // es el CONTENIDO. Acá pesa más que en el camino interactivo, porque no hay respuesta que
    // delate ninguna de las dos pérdidas — ni el gasto que no se anotó ni el pago que no existe.
    it('sin el flag puesto, la captura del pago a Neto SIGUE siendo un comprobante', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue({
        ...CONOCIDO, id: usuarioId, esperando_comprobante: false, plan: 'premium',
      });
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas' });

      await postSinFrom(imagen());

      expect(registrarSolicitudPro).toHaveBeenCalledOnce();
      expect(guardarTransaccion).toHaveBeenCalledOnce();
    });

    it('sin el flag puesto, un gasto normal no dispara el aviso al admin', async () => {
      // El aviso dice "creía estar mandando su comprobante y Vision leyó otra cosa". Sin flag no
      // hay tal sospecha, y mandarlo igual convertiría cada foto de estos usuarios en un Telegram.
      buscarUsuarioPorBsuid.mockResolvedValue({ ...CONOCIDO, id: usuarioId, esperando_comprobante: false });
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);

      await postSinFrom(imagen());

      expect(registrarSolicitudPro).not.toHaveBeenCalled();
      expect(guardarTransaccion).toHaveBeenCalledOnce();
      expect(avisosQueMatchean(/no parece el pago a Neto/)).toHaveLength(0);
    });

    it('con una solicitud ya pendiente, la captura no abre otra pero el gasto se anota y el admin se entera', async () => {
      // Acá el return seco era lo más caro del repo: si la solicitud pendiente salió de un falso
      // positivo de `esPagoNeto`, ESTA captura es el pago real — y este usuario no tiene forma
      // de reclamar ni de enterarse de nada. Lo encontró la segunda revisión adversarial.
      // Quien pierde el claim es exactamente quien ya tiene una solicitud sin resolver: el
      // `UPDATE ... WHERE pago_pendiente IS NOT TRUE` no matchea su fila.
      reclamarSolicitudPro.mockResolvedValue(false);
      buscarUsuarioPorBsuid.mockResolvedValue({
        ...CONOCIDO, id: usuarioId, esperando_comprobante: false, pago_pendiente: true,
      });
      mockFetchOk('image/jpeg');
      visionResponde({ tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Favio Mendoza', categoria: 'Finanzas' });

      await postSinFrom(imagen());

      expect(registrarSolicitudPro).not.toHaveBeenCalled();
      expect(guardarTransaccion).toHaveBeenCalledOnce();
      expect(avisosQueMatchean(/ya tiene una solicitud sin resolver/)).toHaveLength(1);
    });

    // El aviso al admin dice "esto puede ser un comprobante que Vision leyó mal". Sin esta
    // segunda señal quedaba abierta justo la mitad que este cambio vino a cerrar: el
    // username-only que RENUEVA sigue con `plan='premium'`, nadie le pone el flag, y su
    // comprobante mal leído se anotaba como gasto sin que nadie se enterara nunca.
    it('sin el flag, un MONTO de plan con el comercio mal leído sí avisa al admin', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue({
        ...CONOCIDO, id: usuarioId, esperando_comprobante: false, plan: 'premium',
      });
      mockFetchOk('image/jpeg');
      visionResponde({ ...YAPE_GASTO, monto: 10, comercio: 'F. Mendoza L.' });

      await postSinFrom(imagen());

      expect(registrarSolicitudPro).not.toHaveBeenCalled();
      expect(guardarTransaccion).toHaveBeenCalledOnce();
      expect(avisosQueMatchean(/no parece el pago a Neto/)).toHaveLength(1);
    });
  });

  // Que un usuario CONOCIDO llegue sin número no había pasado nunca hasta el 10-ago-2026, y lo
  // único que lo registraba era un log de Railway que nadie mira. Es el evento que abre la
  // única ventana para medir si al número guardado todavía le llega algo.
  describe('aviso de la primera vez', () => {
    it('avisa al admin la primera vez que un conocido llega sin número', async () => {
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);
      buscarUsuarioPorBsuid.mockResolvedValue({ ...CONOCIDO, id: 'u-primera-vez' });

      await postSinFrom(imagen());

      const primeros = avisosQueMatchean(PRIMERA_VEZ);
      expect(primeros).toHaveLength(1);
      const aviso = primeros[0];
      expect(aviso).toContain('u-primera-vez');
      // Acá SÍ hubo intento (se registró un gasto), así que el aviso promete el veredicto y
      // desaconseja el probe manual, que sería un segundo mensaje a la misma persona. El
      // discriminante es el COMANDO ejecutable (`--confirmar`), no el nombre del archivo: la
      // rama del intento también lo nombra, justamente para decir que no se corra.
      expect(aviso).toMatch(/Ya se le intentó la confirmación/);
      expect(aviso).not.toContain('--confirmar');
    });

    it('si el mensaje NO produjo ningún intento, el aviso no promete un veredicto', async () => {
      // Es el caso más probable en el primer mensaje de alguien que acaba de perder su número:
      // "hola", una pregunta, un sticker. Nada de eso registra una transacción, así que no hay
      // envío, no hay fila y no va a llegar ningún veredicto. Y como este aviso es one-shot por
      // usuario, prometerlo dejaba a Favio esperando para siempre un Telegram que no existe,
      // con instrucción explícita de no medir a mano. Lo encontró la revisión adversarial.
      buscarUsuarioPorBsuid.mockResolvedValue({ ...CONOCIDO, id: 'u-sin-intento' });
      parsearRegistroManual.mockResolvedValue({ ok: false });

      await postSinFrom({ type: 'text', text: { body: 'hola, una pregunta' } });

      const aviso = avisosQueMatchean(PRIMERA_VEZ)[0];
      expect(aviso).toContain('NO produjo ningún intento');
      expect(aviso).toContain('--confirmar');   // acá sí se ofrece el comando manual, ejecutable
      expect(enviarWhatsapp).not.toHaveBeenCalled();
    });

    it('no lo repite en cada mensaje del mismo usuario', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue({ ...CONOCIDO, id: 'u-repetido' });
      parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 10 });

      await postSinFrom({ type: 'text', text: { body: 'gasté 10 en pan' } });
      await postSinFrom({ type: 'text', text: { body: 'gasté 20 en taxi' } });

      expect(notificarAdmin).toHaveBeenCalledOnce();
    });

    // El 13-ago-2026 esta alerta llegó por una corrida de `qa-bsuid-username.mjs`, que le pega
    // al webhook de producción con un usuario sembrado, y se leyó como un usuario real. Lo caro
    // no es el ruido: el aviso trae `probe-envio-username <numero> --confirmar` ya armado, y el
    // número del harness es `519` + 8 dígitos al azar — el celular de cualquiera. Correr ese
    // comando mientras la fila sembrada existe le manda un WhatsApp de verdad a un desconocido.
    it('NO avisa por un usuario de harness (is_test_user)', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue({ ...CONOCIDO, id: 'u-de-harness', is_test_user: true });
      parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 10 });

      await postSinFrom({ type: 'text', text: { body: 'gasté 10 en pan' } });

      expect(avisosQueMatchean(PRIMERA_VEZ)).toHaveLength(0);
      // Y el gasto SÍ se registra: la marca silencia el aviso al admin, no el camino. Sin esto
      // el test pasaría igual si `is_test_user` cortara el procesamiento entero.
      expect(guardarTransaccion).toHaveBeenCalledOnce();
    });

    // El control que le da sentido al de arriba: la misma llamada sin la marca sí avisa, así que
    // el cero no puede venir de que este camino dejó de avisar en general.
    it('el mismo mensaje sin la marca sí avisa', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue({ ...CONOCIDO, id: 'u-sin-marca' });
      parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 10 });

      await postSinFrom({ type: 'text', text: { body: 'gasté 10 en pan' } });

      expect(avisosQueMatchean(PRIMERA_VEZ)).toHaveLength(1);
    });

    it('también avisa cuando el tipo no se puede procesar (un documento)', async () => {
      buscarUsuarioPorBsuid.mockResolvedValue({ ...CONOCIDO, id: 'u-documento' });

      await postSinFrom({ type: 'document', document: { id: 'doc-1' } });

      expect(notificarAdmin).toHaveBeenCalledOnce();
      expect(notificarAdmin.mock.calls[0][0]).toMatch(/Primera vez sin número/i);
    });
  });

  // El control que le da sentido a todo lo de arriba: sin él, los casos positivos pasarían
  // igual si el código procesara a CUALQUIERA, y encima gastando una llamada a GPT-4o por
  // cada foto que le mande un desconocido.
  describe('control negativo: BSUID que no conocemos', () => {
    beforeEach(() => { buscarUsuarioPorBsuid.mockResolvedValue(null); });

    it('una imagen de un desconocido no llega ni a bajarse, mucho menos a Vision', async () => {
      mockFetchOk('image/jpeg');
      visionResponde(YAPE_GASTO);

      await postSinFrom(imagen());

      expect(global.fetch).not.toHaveBeenCalled();
      expect(visionCreate).not.toHaveBeenCalled();
      expect(guardarTransaccion).not.toHaveBeenCalled();
      expect(registrarError).toHaveBeenCalledTimes(1);
    });

    it('un audio de un desconocido tampoco se transcribe', async () => {
      mockFetchOk('audio/ogg');

      await postSinFrom(audio());

      expect(transcriptionsCreate).not.toHaveBeenCalled();
      expect(guardarTransaccion).not.toHaveBeenCalled();
    });
  });

  // Meta retransmite el webhook cada 30s mientras no le respondamos rápido. Antes de este
  // cambio el camino sin `from` no pasaba por el dedup, y ahora cada reintento costaría otra
  // llamada a Vision.
  it('una retransmisión del mismo wamid no vuelve a llamar a Vision', async () => {
    mockFetchOk('image/jpeg');
    visionResponde(YAPE_GASTO);
    const msg = { ...imagen(), id: 'wamid-repetido' };

    await postSinFrom(msg);
    await postSinFrom(msg);

    expect(visionCreate).toHaveBeenCalledOnce();
    expect(guardarTransaccion).toHaveBeenCalledOnce();
  });
});
