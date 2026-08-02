import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El chokepoint de avisos proactivos. Lo que se fija acá es su contrato, no su copy:
 *
 *   1. La in-app sale AUNQUE el canal WhatsApp falle, esté ausente o el usuario no tenga
 *      número. Es la razón de existir del módulo: el WhatsApp libre no se entrega fuera de
 *      la ventana de 24h de Meta, así que si un fallo de WhatsApp se llevara la in-app, el
 *      canal garantizado se caería justo con el que ya sabemos que no llega.
 *   2. Nunca lanza. Los llamadores lo usan dentro de bucles de destinatarios; una excepción
 *      no aborta el aviso de los demás.
 *
 * El punto 2 es la parte que un test flojo deja pasar: sin try/catch POR CANAL, un rechazo
 * de `enviarWhatsapp` sube al catch externo del llamador, el test de ese llamador sigue
 * verde (la promesa resuelve undefined igual) y sin embargo el bucle abortó a mitad. Por eso
 * se verifica acá, sobre el chokepoint, y no allá.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true, msgId: 'wamid.1' }) };
const notifMock = { crearNotificacion: vi.fn().mockResolvedValue(true) };

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/notifications-db.js', notifMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { notificarUsuario, CANALES, sanitizarParaWeb } = require('../../lib/notify-user');

const BASE = {
  usuarioId: 'u1',
  whatsapp: '51999888777',
  tipo: 'prueba',
  mensaje: 'Hola *mundo*',
  titulo: 'Hola mundo',
  link: '/dashboard',
};

beforeEach(() => {
  vi.clearAllMocks();
  waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
  notifMock.crearNotificacion.mockResolvedValue(true);
});

describe('notificarUsuario: los dos canales', () => {
  it('AMBOS manda WhatsApp y escribe la in-app', async () => {
    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledWith(
      '51999888777', 'Hola *mundo*', { tipo: 'prueba', usuarioId: 'u1', template: null },
    );
    expect(notifMock.crearNotificacion).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ wa: { ok: true, msgId: 'wamid.1' }, inApp: true });
  });

  it('SOLO_IN_APP no toca WhatsApp, y su `wa` da false en el gate de los llamadores', async () => {
    const { wa, inApp } = await notificarUsuario({
      canales: CANALES.SOLO_IN_APP, motivo: 'el usuario no tiene WhatsApp vinculado', ...BASE,
    });

    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(inApp).toBe(true);
    // Los call-sites que gatean analytics hacen `wa.ok && !wa.skipped`. Sin ramificar por canal.
    expect(wa.ok && !wa.skipped).toBe(false);
  });

  it('SOLO_WHATSAPP no escribe la campana', async () => {
    const { inApp } = await notificarUsuario({
      canales: CANALES.SOLO_WHATSAPP, motivo: 'el destinatario todavía no tiene cuenta web', ...BASE,
    });

    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(notifMock.crearNotificacion).not.toHaveBeenCalled();
    expect(inApp).toBe(false);
  });
});

describe('notificarUsuario: la in-app no depende de WhatsApp', () => {
  it('un usuario web-first (whatsapp null) igual recibe la in-app', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: false, skipped: 'no_whatsapp' });

    const { wa, inApp } = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE, whatsapp: null });

    // Se llama igual: enviarWhatsapp hace no-op y deja la fila `skipped_no_whatsapp`, que es
    // lo que distingue "no tiene número" de "nunca entró al cron".
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(wa.skipped).toBe('no_whatsapp');
    expect(inApp).toBe(true);
  });

  it('si enviarWhatsapp LANZA, la in-app se escribe igual y nada sale hacia afuera', async () => {
    waMock.enviarWhatsapp.mockRejectedValueOnce(new Error('boom'));

    const { wa, inApp } = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(inApp).toBe(true);
    expect(wa.ok).toBe(false);
    expect(wa.error).toBe('boom');
  });

  it('si crearNotificacion LANZA, no propaga y el resultado de WhatsApp se conserva', async () => {
    notifMock.crearNotificacion.mockRejectedValueOnce(new Error('rls'));

    const { wa, inApp } = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(inApp).toBe(false);
    expect(wa).toEqual({ ok: true, msgId: 'wamid.1' });
  });

  it('bloqueado por la ventana de 24h de Meta: WhatsApp no llegó, la campana sí', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: false, code: 131047, error: 'fuera de ventana' });

    const { wa, inApp } = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(wa.code).toBe(131047);
    expect(inApp).toBe(true);
  });

  it('un mock viejo que devuelve `true` en vez del objeto no rompe el contador del llamador', async () => {
    waMock.enviarWhatsapp.mockResolvedValue(true);

    const { wa } = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(wa.ok).toBe(true);
  });
});

describe('notificarUsuario: el texto in-app', () => {
  it('deriva el cuerpo del mensaje de WhatsApp sin su markdown', () => {
    expect(sanitizarParaWeb('Hola *Favio*, _revisa_ esto')).toBe('Hola Favio, revisa esto');
  });

  it('por default el cuerpo es el mensaje sanitizado, y `datos.link` lleva el deeplink', async () => {
    await notificarUsuario({ canales: CANALES.AMBOS, ...BASE, datos: { space_id: 's1' } });

    expect(notifMock.crearNotificacion).toHaveBeenCalledWith(
      'u1', 'sistema', 'Hola mundo', 'Hola mundo', { space_id: 's1', link: '/dashboard' },
    );
  });

  it('`cuerpo` explícito gana (los call-sites que truncan pasan su propio texto)', async () => {
    await notificarUsuario({
      canales: CANALES.AMBOS, ...BASE,
      cuerpo: 'resumen recortado', tipoInApp: 'recordatorio',
    });

    expect(notifMock.crearNotificacion).toHaveBeenCalledWith(
      'u1', 'recordatorio', 'Hola mundo', 'resumen recortado', { link: '/dashboard' },
    );
  });

  it('sin título no se escribe una fila vacía en la campana', async () => {
    const { inApp } = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE, titulo: null });

    expect(notifMock.crearNotificacion).not.toHaveBeenCalled();
    expect(inApp).toBe(false);
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('notificarUsuario: la declaración de canales', () => {
  it('sin canales sale por los DOS y deja rastro: el castigo por no declarar vive en el build', async () => {
    const { inApp } = await notificarUsuario({ ...BASE });

    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(inApp).toBe(true);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('un canal único sin motivo se loguea como error', async () => {
    await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, ...BASE });

    expect(logMock.error).toHaveBeenCalled();
  });

  it('CANALES es un enum cerrado y congelado', () => {
    expect(Object.isFrozen(CANALES)).toBe(true);
    expect(Object.values(CANALES).sort()).toEqual(['ambos', 'solo_in_app', 'solo_whatsapp']);
  });

  it('avisa por log cuando el aviso no llegó por NINGÚN canal', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: false, code: 131047 });
    notifMock.crearNotificacion.mockResolvedValue(false);

    await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(logMock.warn).toHaveBeenCalled();
  });

  it('un usuario de prueba silenciado no cuenta como aviso perdido', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, skipped: 'test_user' });
    notifMock.crearNotificacion.mockResolvedValue(false);

    await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(logMock.warn).not.toHaveBeenCalled();
  });
});
