import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

/**
 * El OTP inverso de quien escribe SIN número visible (llega solo con su BSUID).
 *
 * 02-sep-2026: estaba estructuralmente roto. El webhook descartaba el mensaje antes de leer el
 * `NETO-XXXXXX`, y el onboarding web quedaba colgado para siempre. Julio Mejia mandó 9 códigos en
 * 9 minutos y terminó reclamando por Instagram.
 *
 * 12-sep-2026: además se le CONTESTA. Hasta ese día este camino no respondía nada, porque se creía
 * que Meta no dejaba escribir por BSUID, y la persona solo se enteraba porque la pantalla web
 * avanzaba. El aviso de éxito al admin, que era el único acuse, se retiró: su texto afirmaba "no se
 * le puede responder".
 *
 * Lo que se asierta acá es el CABLEADO (que el webhook llegue al verificador y conteste por BSUID);
 * las ramas de vinculación viven en `tests/services/otp-sin-numero.test.js` y los textos en
 * `tests/services/otp-mensaje-bsuid.test.js`.
 */

process.env.META_APP_SECRET = 'test-secret';
process.env.META_ACCESS_TOKEN = 'test-meta-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const enviarWhatsapp = vi.fn().mockResolvedValue({ ok: true });
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;
const resolverUsuarioEntrante = vi.fn();
require('../../helpers/db-helpers').resolverUsuarioEntrante = resolverUsuarioEntrante;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
const registrarError = vi.fn();
require('../../lib/error-monitor').registrarError = registrarError;
const notificarAdmin = vi.fn().mockResolvedValue(true);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn();
require('../../lib/atribucion').registrarOrigenDelAlta = vi.fn().mockResolvedValue(undefined);

// Solo el verificador se mockea: `mensajeOtpBsuid` corre el real, que es lo que recibe la persona.
const verificarCuentaWebPorBsuid = vi.fn();
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

/** Lo último que se le mandó a ese BSUID. */
const respuestaA = (bsuid) => (enviarWhatsapp.mock.calls.filter(([d]) => d === bsuid).at(-1) || [])[1] || '';

describe('OTP inverso de un usuario SIN número visible', () => {
  beforeEach(() => {
    verificarCuentaWebPorBsuid.mockReset().mockResolvedValue({ estado: 'vinculada', usuarioId: 'u-1', nombre: 'Julio Mejia' });
    resolverUsuarioEntrante.mockReset().mockResolvedValue({ id: 'u-x', onboarding_paso: 0, onboarding_completado: true });
    registrarError.mockClear();
    notificarAdmin.mockClear();
    enviarWhatsapp.mockClear();
    procesarMensajeLibre.mockClear();
  });

  it('el código llega al verificador en vez de morir en el descarte', async () => {
    await enviar('Hola Neto, verifica mi cuenta web: NETO-598929');
    expect(verificarCuentaWebPorBsuid).toHaveBeenCalledWith('PE.1388235929393206', 'NETO-598929');
    expect(registrarError).not.toHaveBeenCalled();
  });

  it('SE LE CONTESTA por su BSUID que la cuenta quedó vinculada', async () => {
    // Hasta el 12-sep-2026 este caso afirmaba lo contrario: "no le intenta responder".
    await enviar('NETO-598929', 'PE.contesta');
    expect(respuestaA('PE.contesta')).toMatch(/Julio, tu cuenta web quedó verificada y vinculada/);
  });

  // El OTP va ANTES de resolver al usuario: resolverlo daría de alta una fila vacía para un BSUID
  // desconocido, que después habría que fusionar con la cuenta web.
  it('no pasa por el alta', async () => {
    await enviar('NETO-598929', 'PE.sinalta');
    expect(resolverUsuarioEntrante).not.toHaveBeenCalled();
  });

  it('el éxito ya NO avisa al admin: la persona tiene su propio acuse', async () => {
    await enviar('NETO-598929', 'PE.exito');
    expect(notificarAdmin).not.toHaveBeenCalled();
  });

  // Control: sin esto, un cableado que mandara TODO al verificador pasaría los tests de arriba.
  it('un mensaje sin código sigue el camino normal: se resuelve por BSUID y se le contesta', async () => {
    await enviar('gasté 30 soles en el almuerzo', 'PE.normal');
    expect(verificarCuentaWebPorBsuid).not.toHaveBeenCalled();
    expect(resolverUsuarioEntrante).toHaveBeenCalledWith({ numero: null, bsuid: 'PE.normal' });
    expect(respuestaA('PE.normal')).toBe('ok');
    expect(registrarError).not.toHaveBeenCalled();
  });

  // Un código mal tipeado no es el caso que `errores` vigila, y ensuciarlo dispararía la alerta
  // de volumen por gente equivocándose. Pero la persona sí tiene que saberlo.
  it('un código inválido se lo dice a la persona, sin ensuciar `errores` ni avisar al admin', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'invalido' });
    await enviar('NETO-000000', 'PE.invalido');
    expect(respuestaA('PE.invalido')).toMatch(/no es válido o ya expiró/);
    expect(registrarError).not.toHaveBeenCalled();
    expect(notificarAdmin).not.toHaveBeenCalled();
  });

  // **BSUID propio a propósito.** `otpIntentos` y `avisosVinculacion` son `Map` de módulo que no
  // se limpian entre tests: reusar un BSUID ya gastado sale throttleado y se lee como otra cosa.
  it('el conflicto se avisa al admin y a la persona se la manda a soporte', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'conflicto', usuarioId: 'u-2', nombre: 'Ana' });
    await enviar('NETO-777777', 'PE.conflicto');
    expect(notificarAdmin.mock.calls.at(-1)?.[0] || '').toMatch(/CONFLICTO/i);
    expect(respuestaA('PE.conflicto')).toMatch(/soporte/i);
  });

  // **El throttle se prueba por el camino del ATACANTE, que es `invalido`, no por el del éxito.**
  // El código se busca global-by-code, así que el throttle es la única defensa contra adivinar 6
  // dígitos. Con el mock en `vinculada`, una mutación que reembolsara los `invalido` pasaba verde.
  it('el rate limit corta la fuerza bruta: 5 intentos FALLIDOS y el sexto no pasa', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'invalido' });
    for (let i = 0; i < 6; i++) await enviar('NETO-11111' + i, 'PE.bruto');
    // Exacto, no `<= 5`: con `<=` un throttle que cortara en el primero también pasaría.
    expect(verificarCuentaWebPorBsuid.mock.calls.length).toBe(5);
    // Y el sexto recibe el aviso del throttle, no silencio.
    expect(respuestaA('PE.bruto')).toMatch(/Demasiados intentos/);
  });

  // Un fallo NUESTRO devuelve la ficha: la persona no puede quedar castigada 15 minutos por un
  // hipo de la base mientras el mensaje que recibe la invita a reintentar en un minuto.
  it('una lectura caída no le come el cupo, y se le dice que reenvíe', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'lectura_fallida' });
    for (let i = 0; i < 8; i++) await enviar('NETO-22222' + i, 'PE.hipo');
    expect(verificarCuentaWebPorBsuid.mock.calls.length).toBe(8);
    expect(respuestaA('PE.hipo')).toMatch(/sigue siendo válido/);
  });

  const UUID = '84ea9bdd-10ac-486b-b01c-69509f6e9a9d';

  // El vínculo se escribió pero la señal que destraba la webapp no: necesita una mano humana.
  it('una vinculación a medias avisa que la persona SIGUE trabada', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'vinculada_sin_destrabar', usuarioId: UUID, nombre: 'Julio' });
    await enviar('NETO-598929', 'PE.amedias');
    const aviso = notificarAdmin.mock.calls.at(-1)?.[0] || '';
    expect(aviso).toMatch(/A MEDIAS/i);
    expect(aviso).toMatch(/sigue viendo/i);
    expect(aviso).toMatch(/update webapp_otp/i);
    // El literal va por el ID, entre comillas SIMPLES. El BSUID no se concatena nunca.
    expect(aviso).toContain("id = '" + UUID + "'");
    expect(respuestaA('PE.amedias')).toMatch(/sigue siendo válido/);
  });

  it('sin un id con forma de UUID no emite un SQL impegable', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'vinculada_sin_destrabar', usuarioId: "x' or 1=1; --", nombre: 'Julio' });
    await enviar('NETO-598929', 'PE.raro');
    const aviso = notificarAdmin.mock.calls.at(-1)?.[0] || '';
    expect(aviso).not.toMatch(/update webapp_otp/i);
    expect(aviso).not.toContain('or 1=1');
    expect(aviso).toMatch(/a mano/i);
  });

  // Los desenlaces accionables dejan el código VIVO a propósito, así que la persona reenvía.
  it('el aviso al admin no se repite por cada reenvío', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'vinculada_sin_destrabar', usuarioId: UUID, nombre: 'Julio' });
    for (let i = 0; i < 5; i++) await enviar('NETO-33333' + i, 'PE.spam');
    expect(notificarAdmin).toHaveBeenCalledTimes(1);
  });

  // Sin esto, el harness que verifica este camino contra PRODUCCIÓN le manda un Telegram real a
  // Favio en cada corrida. Con `conflicto`, que sí avisaría si no fuera un fixture.
  it('un fixture de QA no dispara el aviso', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'conflicto', usuarioId: UUID, nombre: 'QA', esTest: true });
    await enviar('NETO-598929', 'PE.qafixture');
    expect(notificarAdmin).not.toHaveBeenCalled();
  });

  it('el throttle del aviso es por persona: otro BSUID sí avisa', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'conflicto', usuarioId: UUID, nombre: 'Ana' });
    await enviar('NETO-444444', 'PE.uno');
    await enviar('NETO-444444', 'PE.dos');
    expect(notificarAdmin).toHaveBeenCalledTimes(2);
  });

  it('un fallo nuestro (`error`) tampoco le come el cupo', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'error' });
    for (let i = 0; i < 8; i++) await enviar('NETO-55555' + i, 'PE.nuestro');
    expect(verificarCuentaWebPorBsuid.mock.calls.length).toBe(8);
  });

  it('una vinculación a medias no bloquea el reintento que la destraba', async () => {
    verificarCuentaWebPorBsuid.mockResolvedValue({ estado: 'vinculada_sin_destrabar', usuarioId: UUID });
    for (let i = 0; i < 8; i++) await enviar('NETO-66666' + i, 'PE.reintenta');
    expect(verificarCuentaWebPorBsuid.mock.calls.length).toBe(8);
  });

  // Meta puede mandar un mensaje sin `from` Y sin `from_user_id` (los 4 del 01-ago-2026). Si uno
  // trae un código, no hay BSUID al cual vincular, y lo que no puede perderse es su rastro.
  it('un mensaje sin BSUID con un código deja su rastro en `errores` y no se contesta', async () => {
    const message = { id: 'wamid-sinbsuid', type: 'text', text: { body: 'NETO-598929' } };
    const body = { entry: [{ changes: [{ value: { messages: [message] } }] }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
    await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, { sendStatus: vi.fn() });

    expect(verificarCuentaWebPorBsuid).not.toHaveBeenCalled();
    expect(registrarError).toHaveBeenCalledTimes(1);
    expect(enviarWhatsapp).not.toHaveBeenCalled();
  });
});
