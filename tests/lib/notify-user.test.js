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
const emailMock = { enviarEmail: vi.fn().mockResolvedValue({ ok: true, msgId: 'resend-1' }) };

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/email.js', emailMock],
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
  emailMock.enviarEmail.mockResolvedValue({ ok: true, msgId: 'resend-1' });
});

describe('notificarUsuario: los dos canales', () => {
  it('AMBOS manda WhatsApp y escribe la in-app', async () => {
    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });

    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledWith(
      '51999888777', 'Hola *mundo*', { tipo: 'prueba', usuarioId: 'u1', template: null },
    );
    expect(notifMock.crearNotificacion).toHaveBeenCalledTimes(1);
    // `email` es el tercer canal (27-ago). Sin declararlo, sale `canal_no_declarado`, que es
    // la MISMA forma que devuelve `enviarEmail`: el llamador no ramifica por canal.
    expect(res).toEqual({ wa: { ok: true, msgId: 'wamid.1' }, inApp: true, email: { ok: false, skipped: 'canal_no_declarado' } });
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

  /**
   * El sanitizador NO puede tocar una URL, y esto se prueba con tokens REALES en vez de con
   * una cadena que "parece" un token: el alfabeto base64url mete `_` de forma dispersa, así
   * que un solo ejemplo elegido a mano puede no tener ninguno y pasar en verde por suerte.
   *
   * Con el `.replace(/[*_]/g,'')` pelado, 460 de estos 1000 links quedan alterados y los 460
   * fallan la verificación. Es el aviso de fin de prueba llegando con su único camino a la
   * app roto, al usuario que todavía no tiene cuenta web — que es justo a quien va dirigido.
   */
  it('no toca las URL: un link firmado sobrevive y sigue verificando', () => {
    const { construirLinkActivacion, verificarTokenActivacion } = require('../../lib/activacion');
    const previo = process.env.ACTIVATION_TOKEN_SECRET;
    process.env.ACTIVATION_TOKEN_SECRET = 'secreto-de-prueba-para-el-sanitizador';
    try {
      let conGuionBajo = 0;
      for (let i = 0; i < 1000; i++) {
        const id = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
        const link = construirLinkActivacion(id);
        expect(link, 'sin link firmado el test no prueba nada').toBeTruthy();
        const token = link.split('t=')[1];
        if (token.includes('_')) conGuionBajo++;
        const salido = sanitizarParaWeb('Míralos ahora:\n👉 ' + link).split('t=')[1];
        expect(salido).toBe(token);
        expect((verificarTokenActivacion(salido) || {}).uid).toBe(id);
      }
      // Antivacuidad: si ningún token trae el carácter que el sanitizador borra, el bucle de
      // arriba pasa sin ejercitar nada. Medido, 463 de 1000. Sólo se cuenta `_`: `*` no está
      // en el alfabeto base64url, así que buscarlo era una condición muerta que inflaba la
      // sensación de cobertura sin agregar un caso.
      expect(conGuionBajo, 'ningún token tenía `_`: este test no está probando el caso').toBeGreaterThan(100);
    } finally {
      if (previo === undefined) delete process.env.ACTIVATION_TOKEN_SECRET;
      else process.env.ACTIVATION_TOKEN_SECRET = previo;
    }
  });

  it('sigue borrando el markdown que rodea a una URL', () => {
    expect(sanitizarParaWeb('*Mira* https://app.neto.pe/activar?t=a_b*c _ya_'))
      .toBe('Mira https://app.neto.pe/activar?t=a_b*c ya');
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

/**
 * El TERCER canal (27-ago-2026). Lo que se fija acá es la misma clase de contrato que arriba:
 * aislamiento entre canales y una declaración explícita.
 *
 * El detalle de diseño que estas aserciones protegen, y que es contraintuitivo: el correo
 * sale EN PARALELO al WhatsApp, no como fallback de su resultado. La forma tentadora —"si
 * WhatsApp falló, mandá correo"— no funciona, y no se deduce leyendo el código: el veredicto
 * de WhatsApp no existe todavía cuando esta función retorna. Medido sobre 30 días, Meta
 * aceptó 556 POSTs y devolvió `sent` en los 556; el fracaso llegó después por callback en 459
 * (452 con código 131047). El rechazo síncrono, que es el único visible acá, salió CERO veces.
 * Un fallback condicionado a `wa.ok` habría mandado cero correos.
 */
describe('notificarUsuario: el canal de correo', () => {
  const CON_EMAIL = { ...BASE, email: { to: 'a@b.com', asunto: 'Tu deuda vence hoy' } };

  it('sin declarar `email` no se manda ningún correo', async () => {
    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...BASE });
    expect(emailMock.enviarEmail).not.toHaveBeenCalled();
    expect(res.email).toEqual({ ok: false, skipped: 'canal_no_declarado' });
  });

  it('declarado, sale y reusa el texto de la campana', async () => {
    // El correo NO tiene copy propio: si lo tuviera, sería un cuarto lugar donde el mismo
    // aviso puede envejecer distinto.
    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...CON_EMAIL });
    expect(emailMock.enviarEmail).toHaveBeenCalledWith('a@b.com', expect.objectContaining({
      asunto: 'Tu deuda vence hoy',
      titulo: 'Hola mundo',
      cuerpo: 'Hola mundo',      // sanitizado: el markdown de WhatsApp no va al correo
      link: '/dashboard',
      usuarioId: 'u1',
      tipo: 'prueba',
    }));
    expect(res.email).toEqual({ ok: true, msgId: 'resend-1' });
  });

  it('el correo sale AUNQUE WhatsApp falle, y viceversa', async () => {
    waMock.enviarWhatsapp.mockRejectedValueOnce(new Error('Meta caído'));
    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...CON_EMAIL });
    expect(res.wa.ok).toBe(false);
    expect(res.email.ok).toBe(true);
    expect(res.inApp).toBe(true);
  });

  it('un correo que falla no se lleva los otros dos canales', async () => {
    emailMock.enviarEmail.mockRejectedValueOnce(new Error('Resend caído'));
    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...CON_EMAIL });
    expect(res.wa.ok).toBe(true);
    expect(res.inApp).toBe(true);
    expect(res.email).toEqual({ ok: false, error: 'Resend caído' });
    expect(logMock.error).toHaveBeenCalled();
  });

  it('NO es fallback: el correo sale aunque WhatsApp haya salido bien', async () => {
    // La aserción que mata la "mejora" de mandar correo solo cuando WhatsApp falla. Con esa
    // condición el canal no se usaría casi nunca, porque el fallo de WhatsApp es asíncrono.
    await notificarUsuario({ canales: CANALES.AMBOS, ...CON_EMAIL });
    expect(waMock.enviarWhatsapp).toHaveBeenCalled();
    expect(emailMock.enviarEmail).toHaveBeenCalled();
  });

  it('`to` nulo sigue llamando al canal: la fila skipped_no_email es el rastro', async () => {
    emailMock.enviarEmail.mockResolvedValueOnce({ ok: false, skipped: 'no_email' });
    const res = await notificarUsuario({
      canales: CANALES.AMBOS, ...BASE, email: { to: null, asunto: 'x' },
    });
    // Sin la llamada no hay fila, y "el usuario no tiene correo" sería indistinguible de
    // "este aviso no declara el canal". Mismo criterio que `skipped_no_whatsapp`.
    expect(emailMock.enviarEmail).toHaveBeenCalledWith(null, expect.anything());
    expect(res.email).toEqual({ ok: false, skipped: 'no_email' });
  });

  it('sin asunto no se manda nada, y se grita', async () => {
    const res = await notificarUsuario({
      canales: CANALES.AMBOS, ...BASE, email: { to: 'a@b.com' },
    });
    expect(emailMock.enviarEmail).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
    expect(res.email).toEqual({ ok: false, skipped: 'canal_no_declarado' });
  });

  it('SOLO_IN_APP con correo declarado: el correo sale igual', async () => {
    // Decisión, no accidente: el enum modela "WhatsApp y/o campana", y el correo es una
    // dimensión aparte. Un aviso que evita WhatsApp a propósito (porque no entrega) es
    // justamente el que más gana con el correo.
    const res = await notificarUsuario({
      canales: CANALES.SOLO_IN_APP, motivo: 'prueba', ...CON_EMAIL,
    });
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(emailMock.enviarEmail).toHaveBeenCalled();
    expect(res.email.ok).toBe(true);
  });

  it('con claimInApp fallido no sale NINGÚN canal, correo incluido', async () => {
    // Si el correo saliera sin el claim, el dedup del llamador quedaría ciego y el cron lo
    // repetiría en cada corrida — el bug B6 con un canal que además entrega.
    notifMock.crearNotificacion.mockResolvedValueOnce(false);
    const res = await notificarUsuario({ canales: CANALES.AMBOS, ...CON_EMAIL, claimInApp: true });
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(emailMock.enviarEmail).not.toHaveBeenCalled();
    expect(res.email).toEqual({ ok: false, skipped: 'canal_no_declarado' });
  });

  it('el aviso llegó por correo NO se reporta como "sin entrega en ningún canal"', async () => {
    // El log de ops que dice "esto no llegó a nadie". Sin el término de correo, un aviso que
    // sí llegó por correo se reportaría como perdido — y ese log es lo que se mira para
    // decidir si el canal sirve.
    waMock.enviarWhatsapp.mockResolvedValueOnce({ ok: false, code: 131047 });
    notifMock.crearNotificacion.mockResolvedValueOnce(false);
    await notificarUsuario({ canales: CANALES.AMBOS, ...CON_EMAIL });
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('y si NO llegó por ninguno, sí se reporta', async () => {
    // El control positivo del caso anterior: sin él, un `logMock.warn` que nunca se llama
    // pasaría las dos aserciones.
    waMock.enviarWhatsapp.mockResolvedValueOnce({ ok: false, code: 131047 });
    notifMock.crearNotificacion.mockResolvedValueOnce(false);
    emailMock.enviarEmail.mockResolvedValueOnce({ ok: false, skipped: 'no_email' });
    await notificarUsuario({ canales: CANALES.AMBOS, ...CON_EMAIL });
    expect(logMock.warn).toHaveBeenCalled();
  });
});
