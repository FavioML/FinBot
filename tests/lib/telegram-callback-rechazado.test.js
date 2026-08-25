import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import Module from 'module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

/**
 * 9A-bis · `responderCallback` devolvía `true` sin mirar la respuesta de Telegram.
 *
 * Telegram no rechaza con un status HTTP: contesta **200 con `{ ok: false, description }`** en
 * el cuerpo. Así que el `await fetch(...)` sin leer el body no distinguía "el admin ya vio esto"
 * de "Telegram lo tiró", y lo que se tira es justamente el diagnóstico que 9A puso en el popup
 * del botón: *"no se activó Pro y la solicitud NO volvió a pendiente"*, *"NO uses /activar
 * (registra S/0)"*. El rechazo más común no es exótico —un `callback_query` de más de ~15
 * minutos ya venció— y el resultado era un admin convencido de que aprobó.
 *
 * El arreglo tiene dos mitades y las dos se miden acá: `responderCallback` devuelve `false`, y
 * el webhook usa ese `false` para mandar el mismo texto por el otro canal (mensaje al chat).
 * Sin la segunda, el `false` no le llega a nadie y el diagnóstico se pierde igual.
 */

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const p = require.resolve(path.join(projectRoot, 'lib/logger.js'));
require.cache[p] = { id: p, filename: p, loaded: true, exports: logMock };

const telegram = require('../../lib/telegram');

const respuesta = (body, status = 200) => ({ status, json: async () => body });

describe('responderCallback: un rechazo de Telegram no es un aviso entregado', () => {
  const origFetch = global.fetch;
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
    logMock.error.mockClear();
  });
  afterEach(() => { global.fetch = origFetch; });

  it('ok:true → true (control: si esto también diera false, lo de abajo no probaría nada)', async () => {
    global.fetch = vi.fn(async () => respuesta({ ok: true, result: true }));
    await expect(telegram.responderCallback('cb-1', 'Aprobado ✅')).resolves.toBe(true);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('200 con ok:false → false, y queda el motivo escrito', async () => {
    global.fetch = vi.fn(async () => respuesta({ ok: false, description: 'query is too old' }));
    await expect(telegram.responderCallback('cb-1', 'Aprobado ✅')).resolves.toBe(false);
    expect(logMock.error).toHaveBeenCalled();
    expect(String(logMock.error.mock.calls[0][0].err)).toMatch(/too old/);
  });

  it('un cuerpo que no es JSON tampoco cuenta como entregado', async () => {
    // Telegram detrás de un proxy puede devolver HTML. `res.json()` rechaza, y sin el
    // `.catch(() => null)` ese rechazo cae en el catch de la función: mismo `false`, otra rama.
    //
    // **La primera versión de este caso decía cubrir eso y no lo cubría**, y lo dijo por
    // escrito: su único assert era `resolves.toBe(false)`, que las DOS ramas producen. Medido
    // por la revisión adversarial: quitando el `.catch` los 6 casos seguían verdes. Lo que
    // discrimina es CUÁL log salió, así que eso es lo que se afirma.
    global.fetch = vi.fn(async () => ({ status: 502, json: async () => { throw new Error('not json'); } }));
    await expect(telegram.responderCallback('cb-1', 'Aprobado ✅')).resolves.toBe(false);
    const mensajes = logMock.error.mock.calls.map((c) => String(c[1]));
    expect(mensajes.some((m) => /rechazó el answerCallbackQuery/i.test(m)), 'salió por el catch de excepción: falta el `.catch(() => null)`').toBe(true);
    expect(mensajes.some((m) => /Excepción en answerCallbackQuery/i.test(m))).toBe(false);
  });

  it('sin token no llama a Telegram (invariante vieja, intacta)', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    global.fetch = vi.fn();
    await expect(telegram.responderCallback('cb-1', 'x')).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('el webhook no deja perder el diagnóstico cuando el popup no llega', () => {
  const origFetch = global.fetch;
  let tgMock;
  let handler;

  beforeEach(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secreto';
    process.env.TELEGRAM_ADMIN_CHAT_ID = '12345';
    tgMock = {
      enviarTelegramA: vi.fn(async () => true),
      responderCallback: vi.fn(async () => true),
      editarCaptionTelegram: vi.fn(async () => true),
    };
    const cmdMock = {
      procesarComandoAdmin: vi.fn(async () => 'ok'),
      procesarCallbackAdmin: vi.fn(async () => ({ answer: '⚠️ No se activó Pro. Revisar a mano — NO uses /activar (registra S/0).' })),
    };
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      const norm = String(id).replace(/\\/g, '/');
      if (norm.endsWith('lib/telegram')) return tgMock;
      if (norm.endsWith('./admin-commands')) return cmdMock;
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve(path.join(projectRoot, 'handlers/telegram-webhook.js'))];
    handler = require('../../handlers/telegram-webhook');
    Module.prototype.require = orig;
  });
  afterEach(() => { global.fetch = origFetch; });

  const disparar = async () => {
    const req = {
      headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
      body: { callback_query: { id: 'cb-1', data: 'pro:approve:mensual:pago-1', message: { message_id: 7, chat: { id: 12345 } } } },
    };
    const res = { sendStatus: vi.fn() };
    await (handler.telegramWebhookHandler || handler)(req, res);
  };

  it('si Telegram acepta el popup, no duplica el mensaje (control)', async () => {
    await disparar();
    expect(tgMock.responderCallback).toHaveBeenCalled();
    expect(tgMock.enviarTelegramA).not.toHaveBeenCalled();
  });

  it('el fallback se ESPERA, no se dispara y se olvida', async () => {
    // Sin el `await`, un fallo del envío queda como unhandled rejection y el handler ya
    // devolvió. Con los mocks resolviendo al instante las dos formas se ven idénticas, así que
    // el caso mide lo único que las separa: si el handler volvió ANTES de que el envío
    // terminara. Quitar el `await` sobrevivía.
    //
    // **Ojo con REASIGNAR `tgMock.enviarTelegramA`: no funciona.** El handler destructura sus
    // dependencias al cargar el módulo (`const { enviarTelegramA } = require(...)`), así que
    // pisar la propiedad después del `require` deja al handler llamando a la función vieja y el
    // caso sale verde sin ejercitar nada. Es el gotcha del destructuring que ya está anotado en
    // el catálogo de harness. Hay que mutar la implementación del MISMO `vi.fn()`.
    let terminado = false;
    tgMock.enviarTelegramA.mockImplementationOnce(() => new Promise((r) => setTimeout(() => { terminado = true; r(true); }, 0)));
    tgMock.responderCallback.mockResolvedValueOnce(false);
    await disparar();
    expect(terminado, 'el handler no esperó el fallback').toBe(true);
  });

  it('si Telegram RECHAZA el popup, el mismo texto sale por el chat', async () => {
    tgMock.responderCallback.mockResolvedValueOnce(false);
    await disparar();
    expect(tgMock.enviarTelegramA).toHaveBeenCalled();
    const [chatId, texto] = tgMock.enviarTelegramA.mock.calls[0];
    expect(String(chatId)).toBe('12345');
    // el diagnóstico completo, no un "algo falló": es lo único que le dice al admin qué NO hacer
    expect(texto).toMatch(/NO uses \/activar/);
  });
});
