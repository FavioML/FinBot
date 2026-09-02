import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

/**
 * 02-sep-2026. El OTP inverso estaba estructuralmente roto para quien llega sin número.
 *
 * El webhook corta en `if (!from)` y hace `return` ~360 líneas ANTES del matcheo de
 * `NETO-XXXXXX`, así que el código de un usuario username-only no se leía nunca. Para esa
 * persona el onboarding web quedaba colgado para siempre en "Esperando tu confirmación...":
 * `/api/onboarding` poletea `usuarios.whatsapp` y `webapp_otp.verified_at`, y las DOS las
 * escribe únicamente ese handler inalcanzable. Ni reintentar ni regenerar el código servían.
 *
 * Julio Mejia mandó 9 códigos en 9 minutos y terminó reclamando por Instagram, que es el único
 * motivo por el que se supo. Sus 9 filas en `errores` eran indistinguibles de las de cualquier
 * otro mensaje sin `from`.
 *
 * Lo que se asierta acá es el CABLEADO (que el webhook llegue al verificador y no descarte el
 * mensaje); las ramas de vinculación viven en `tests/services/otp-sin-numero.test.js`.
 */

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;
const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
const registrarError = vi.fn();
require('../../lib/error-monitor').registrarError = registrarError;
const buscarUsuarioPorBsuid = vi.fn().mockResolvedValue(null);
require('../../helpers/db-helpers').buscarUsuarioPorBsuid = buscarUsuarioPorBsuid;
const registrarGastoSilencioso = vi.fn().mockResolvedValue({ registrado: true, motivo: 'ok' });
require('../../services/registro-silencioso').registrarGastoSilencioso = registrarGastoSilencioso;
require('../../services/registro-silencioso').avisarPrimeraVezSilencioso = vi.fn().mockResolvedValue(undefined);
const notificarAdmin = vi.fn().mockResolvedValue(true);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn();

const verificarCuentaWebPorBsuid = vi.fn().mockResolvedValue({ estado: 'vinculada', usuarioId: 'u-1', nombre: 'Julio' });
require('../../services/otp-sin-numero').verificarCuentaWebPorBsuid = verificarCuentaWebPorBsuid;

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

let seq = 0;
function enviar(texto, bsuid = 'PE.1388235929393206') {
  const message = { id: 'wamid-otp-' + (seq++), type: 'text', text: { body: texto }, from_user_id: bsuid };
  const body = { entry: [{ changes: [{ value: { messages: [message] } }] }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return webhookHandler(
    { headers: { 'x-hub-signature-256': signature }, rawBody, body },
    { sendStatus: vi.fn() }
  );
}

describe('OTP inverso de un usuario SIN número visible', () => {
  beforeEach(() => {
    verificarCuentaWebPorBsuid.mockReset().mockResolvedValue({ estado: 'vinculada', usuarioId: 'u-1', nombre: 'Julio' });
    registrarError.mockClear();
    buscarUsuarioPorBsuid.mockReset().mockResolvedValue(null);
    registrarGastoSilencioso.mockReset().mockResolvedValue({ registrado: true, motivo: 'ok' });
    notificarAdmin.mockClear();
    enviarWhatsapp.mockClear();
    obtenerOCrearUsuario.mockReset();
  });

  it('el código llega al verificador en vez de morir en el descarte', async () => {
    await enviar('Hola Neto, verifica mi cuenta web: NETO-598929');
    expect(verificarCuentaWebPorBsuid).toHaveBeenCalledWith('PE.1388235929393206', 'NETO-598929');
  });

  // El corazón de la regresión: antes esto era una fila en `errores` y nada más.
  it('NO se descarta como "mensaje sin from"', async () => {
    await enviar('Hola Neto, verifica mi cuenta web: NETO-598929');
    expect(registrarError).not.toHaveBeenCalled();
  });

  // Orden: el OTP se atiende ANTES de preguntar si el BSUID nos suena. Sin esto, el código de un
  // usuario ya conocido caería en `registrarGastoSilencioso`, que lo trataría como un gasto.
  it('un usuario CONOCIDO que manda su código lo vincula, no lo anota como gasto', async () => {
    buscarUsuarioPorBsuid.mockResolvedValue({ id: 'u-conocido', bsuid: 'PE.999' });
    await enviar('NETO-123456', 'PE.999');
    expect(verificarCuentaWebPorBsuid).toHaveBeenCalledWith('PE.999', 'NETO-123456');
    expect(registrarGastoSilencioso).not.toHaveBeenCalled();
  });

  // **BSUID propio.** `avisosVinculacion` es un `Map` de módulo que no se limpia entre tests (el
  // throttle del aviso, igual que `otpIntentos`), así que reusar el BSUID por defecto —que los
  // casos de arriba ya usaron con estado `vinculada`— sale throttleado y el fallo se lee como
  // "no avisa" cuando lo que pasó es otra cosa.
  it('avisa al admin que quedó vinculado y que no se le puede contestar', async () => {
    await enviar('NETO-598929', 'PE.avisa');
    const aviso = notificarAdmin.mock.calls.at(-1)?.[0] || '';
    expect(aviso).toMatch(/VINCULADA POR BSUID/i);
    expect(aviso).toMatch(/No se le puede responder/i);
    expect(aviso).toContain('PE.avisa');
    // Texto plano: `lib/telegram.js` no manda `parse_mode`, así que el HTML saldría a la vista.
    expect(aviso).not.toMatch(/<b>|<code>/);
  });

  it('no le intenta responder por WhatsApp (no hay a dónde)', async () => {
    await enviar('NETO-598929');
    expect(enviarWhatsapp).not.toHaveBeenCalled();
    expect(obtenerOCrearUsuario).not.toHaveBeenCalled();
  });

  // Control: sin esto, un cableado que mandara TODO al verificador pasaría los tests de arriba.
  it('un mensaje sin código sigue el camino de siempre', async () => {
    await enviar('gasté 30 soles en el almuerzo');
    expect(verificarCuentaWebPorBsuid).not.toHaveBeenCalled();
    expect(registrarError).toHaveBeenCalledTimes(1);
  });

  // Un código mal tipeado no es el caso que `errores` vigila, y ensuciarlo dispararía la alerta
  // de volumen por gente equivocándose.
  it('un código inválido no ensucia `errores` ni avisa al admin', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'invalido' });
    await enviar('NETO-000000');
    expect(registrarError).not.toHaveBeenCalled();
    expect(notificarAdmin).not.toHaveBeenCalled();
  });

  // **BSUID propio a propósito.** `otpIntentos` es un `Map` de módulo que no se limpia entre
  // tests (es el estado en memoria que documenta el CLAUDE.md, sección "instancia única"), así
  // que los casos de arriba ya gastaron las 5 fichas del BSUID por defecto y este salía
  // throttleado. El test decía "el conflicto no avisa" cuando lo que pasaba era otra cosa.
  it('el conflicto sí se avisa: es el único que necesita una mano humana', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'conflicto', usuarioId: 'u-2', nombre: 'Ana' });
    await enviar('NETO-777777', 'PE.conflicto');
    expect(notificarAdmin.mock.calls.at(-1)?.[0] || '').toMatch(/CONFLICTO/i);
  });

  // **El throttle se prueba por el camino del ATACANTE, que es `invalido`, no por el del éxito.**
  // El código se busca global-by-code (sin scoping por cuenta), así que el throttle es la única
  // defensa contra adivinar 6 dígitos. La primera versión de este test mandaba 6 mensajes con el
  // mock devolviendo `vinculada`: dejaba en verde una mutación que agregaba `invalido` a los
  // estados que DEVUELVEN la ficha, con lo cual cada intento fallido se reembolsaba solo y el
  // throttle dejaba de existir. Lo encontró la revisión adversarial.
  it('el rate limit corta la fuerza bruta: 5 intentos FALLIDOS y el sexto no pasa', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'invalido' });
    for (let i = 0; i < 6; i++) await enviar('NETO-11111' + i, 'PE.bruto');
    // Exacto, no `<= 5`: con `<=` un throttle que cortara en el primero también pasaría, y eso
    // rompería a un usuario legítimo que se equivoca una vez.
    expect(verificarCuentaWebPorBsuid.mock.calls.length).toBe(5);
  });

  // Un fallo NUESTRO sí devuelve la ficha: la persona no puede quedar castigada 15 minutos por un
  // hipo de la base, y acá no hay canal para mandarle el "volvé a intentar en un minuto".
  it('una lectura caída no le come el cupo al usuario', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'lectura_fallida' });
    for (let i = 0; i < 8; i++) await enviar('NETO-22222' + i, 'PE.hipo');
    expect(verificarCuentaWebPorBsuid.mock.calls.length).toBe(8);
  });

  // El vínculo se escribió pero la señal que destraba la webapp no. La persona sigue en el
  // spinner y no tiene canal por el que enterarse, así que el Telegram es el único camino al
  // arreglo: no puede decir "se destrabó".
  const UUID = '84ea9bdd-10ac-486b-b01c-69509f6e9a9d';

  it('una vinculación a medias avisa que la persona SIGUE trabada', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'vinculada_sin_destrabar', usuarioId: UUID, nombre: 'Julio' });
    await enviar('NETO-598929', 'PE.amedias');
    const aviso = notificarAdmin.mock.calls.at(-1)?.[0] || '';
    expect(aviso).toMatch(/A MEDIAS/i);
    expect(aviso).toMatch(/sigue viendo/i);
    expect(aviso).not.toMatch(/se destrabó/i);
    // Trae el arreglo listo: sin esto el aviso dice que hay un problema y no qué hacer.
    expect(aviso).toMatch(/update webapp_otp/i);
    // Y el literal va por el ID, entre comillas SIMPLES: en SQL las dobles son identificadores,
    // así que un comando con dobles no se puede pegar. El BSUID no se concatena nunca.
    expect(aviso).toContain("id = '" + UUID + "'");
  });

  // Sin un id utilizable no se emite un comando roto: se dice qué buscar.
  it('sin un id con forma de UUID no emite un SQL impegable', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'vinculada_sin_destrabar', usuarioId: "x' or 1=1; --", nombre: 'Julio' });
    await enviar('NETO-598929', 'PE.raro');
    const aviso = notificarAdmin.mock.calls.at(-1)?.[0] || '';
    expect(aviso).not.toMatch(/update webapp_otp/i);
    expect(aviso).not.toContain('or 1=1');
    expect(aviso).toMatch(/a mano/i);
  });

  // **Los desenlaces accionables dejan el código VIVO a propósito, así que la persona reenvía.**
  // Julio reenvió 9 veces en 9 minutos: sin throttle, una base con hipo produce 9 Telegrams
  // idénticos, cada uno con su comando de arreglo.
  it('el aviso no se repite por cada reenvío', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'vinculada_sin_destrabar', usuarioId: UUID, nombre: 'Julio' });
    for (let i = 0; i < 5; i++) await enviar('NETO-33333' + i, 'PE.spam');
    expect(notificarAdmin).toHaveBeenCalledTimes(1);
  });

  it('el throttle del aviso es por persona: otro BSUID sí avisa', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'conflicto', usuarioId: UUID, nombre: 'Ana' });
    await enviar('NETO-444444', 'PE.uno');
    await enviar('NETO-444444', 'PE.dos');
    expect(notificarAdmin).toHaveBeenCalledTimes(2);
  });

  // `error` cubre cuatro desenlaces que son todos culpa nuestra (RPC caído, resultado inesperado,
  // cero filas, la excepción del catch). La regla es el par: si invita a reintentar, reembolsa.
  it('un fallo nuestro (`error`) tampoco le come el cupo', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'error' });
    for (let i = 0; i < 8; i++) await enviar('NETO-55555' + i, 'PE.nuestro');
    expect(verificarCuentaWebPorBsuid.mock.calls.length).toBe(8);
  });

  // El destrabe previsto de una vinculación a medias es reenviar (cae en `ya_vinculada`, que
  // reintenta el burn). Sin reembolso ese camino se come 5 fichas y deja a la persona bloqueada
  // 15 minutos con la pantalla girando, castigada por un fallo nuestro.
  it('una vinculación a medias no bloquea el reintento que la destraba', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'vinculada_sin_destrabar', usuarioId: UUID });
    for (let i = 0; i < 8; i++) await enviar('NETO-66666' + i, 'PE.reintenta');
    expect(verificarCuentaWebPorBsuid.mock.calls.length).toBe(8);
  });

  // Meta puede mandar un mensaje sin `from` Y sin `from_user_id` (así llegaron los 4 del
  // 01-ago-2026). Si uno de esos trae un código, no hay BSUID al cual vincular — y lo que NO
  // puede pasar es que se pierda la fila en `errores`, que es el único rastro diagnóstico que
  // existe justo en el caso donde no hay ninguna otra pista.
  it('un mensaje sin BSUID con un código igual deja su rastro en `errores`', async () => {
    const message = { id: 'wamid-sinbsuid', type: 'text', text: { body: 'NETO-598929' } };
    const body = { entry: [{ changes: [{ value: { messages: [message] } }] }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
    await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, { sendStatus: vi.fn() });

    expect(verificarCuentaWebPorBsuid).not.toHaveBeenCalled();
    expect(registrarError).toHaveBeenCalledTimes(1);
  });
});
