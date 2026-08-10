import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * B14 en RUNTIME, no por barrido de texto.
 *
 * `tests/cron/dedup-claim-in-app.test.js` verifica que la LÍNEA diga `llegoElAviso(variable)`.
 * Eso alcanza para que nadie la borre en un refactor, y no alcanza para dos cosas:
 *
 *   1. Un error de SCOPE. Estos son crons por reloj (8pm y cada hora); `cron/checks.js` es JS,
 *      así que `tsc` no lo mira, y una variable mal nombrada explota recién cuando el cron
 *      dispara, tumbando la corrida ENTERA de recordatorios para todos. `checkPremiumExpiry` sí
 *      lo ejercitaba otro test; **el upsell d28 de `checkRecordatorioDiario` no lo ejercitaba
 *      ninguno**, que es justo uno de los dos call-sites que B14 agregó.
 *   2. Que la guarda decida lo correcto. Un barrido de texto no distingue
 *      `if (llegoElAviso(x))` de `if (!llegoElAviso(x))`.
 *
 * Acá se ejecutan los dos crons de verdad, con `notificarUsuario` mockeado para elegir el
 * resultado de la entrega. El caso que importa es el 131047: Meta rechaza el texto libre fuera
 * de la ventana de 24h devolviendo `{ok:false, code:131047}` **sin `skipped`**, y el
 * destinatario de estos dos avisos —alguien que terminó su prueba o que dejó de pagar— es justo
 * quien lleva días sin escribir.
 *
 * OJO CON CÓMO SE COMPRUEBA EL SCOPE, porque la primera versión de este archivo lo hizo mal.
 * Tenía un tercer caso que buscaba un `ReferenceError` en `log.error` y pasaba SIEMPRE: el
 * `catch` por usuario de `checkRecordatorioDiario` (`cron/checks.js:227`) es
 * `catch(e) { /* silencioso por usuario *\/ }` — **no loguea nada**. O sea que la aserción era
 * vacua y encima describía mal el mecanismo: un error ahí no deja rastro en ningún lado.
 * Lo delató la mutación (renombrar la variable mataba el primer caso y no el que decía cubrirlo).
 * Lo único que delata un error de scope acá es el EFECTO: `solicitarComprobante` no se llama.
 * Eso ya lo afirma el primer caso, y por eso el tercero se borró en vez de arreglarse.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

let usuariosData = [];
const solicitar = vi.fn().mockResolvedValue(true);
const notificar = vi.fn();

function makeChain(table) {
  const chain = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'limit', 'order', 'not', 'in', 'is', 'or', 'ilike']) {
    chain[m] = () => chain;
  }
  // El insert en `survey_events` es el claim one-shot del upsell: tiene que devolver fila con
  // id, o el cron hace `continue` antes de llegar a la línea que este test mira.
  chain.single = () => Promise.resolve({ data: { id: 'ev1' }, error: null });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.then = (resolve) => {
    if (table === 'usuarios') return resolve({ data: usuariosData, error: null });
    return resolve({ data: [], error: null, count: 0 });
  };
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => {
      const base = makeChain(t);
      return { ...base, update: () => makeChain(t), insert: () => makeChain(t) };
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }) }],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn() }],
  ['lib/pro-payment.js', { solicitarComprobante: solicitar, esperaComprobante: vi.fn() }],
  ['gmail.js', { revocarAccesoGmail: vi.fn().mockResolvedValue({ revocadas: 0 }) }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// `notify-user` se mockea PRESERVANDO `CANALES`: el cron lo desestructura al cargar, y sin la
// constante real el módulo revienta al importarse, no en la aserción.
const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};

const { checkRecordatorioDiario, checkPremiumExpiry } = require('../../cron/checks');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

// 8pm Lima = 01:00Z del día siguiente. Es el único horario en que corre el recordatorio diario.
const OCHO_PM_LIMA = '2026-08-16T01:05:00Z';
// 10am Lima: pasado el gate horario de checkPremiumExpiry.
const MEDIA_MANANA = '2026-08-15T15:00:00Z';

const NO_LLEGO = { wa: { ok: false, code: 131047 }, inApp: false };
const LLEGO_WA = { wa: { ok: true, msgId: 'wamid.1' }, inApp: false };

beforeEach(() => {
  solicitar.mockClear();
  notificar.mockClear();
  usuariosData = [];
});

describe('upsell d28: la ventana de comprobante no se abre si el aviso no llegó', () => {
  // Free (planConfig.recordatorios = false) y 29 días desde el alta: la rama del upsell.
  const usuarioUpsell = () => ([{
    id: 'u1', whatsapp: '51999888777', nombre: 'Ana', plan: 'free',
    recordatorios_activos: true,
    created_at: new Date(Date.now() - 29 * 86400000).toISOString(),
  }]);

  it('con el aviso ENTREGADO por WhatsApp, la abre', async () => {
    vi.setSystemTime(new Date(OCHO_PM_LIMA));
    usuariosData = usuarioUpsell();
    notificar.mockResolvedValue(LLEGO_WA);

    await checkRecordatorioDiario();

    // Anti-vacuidad: si el cron no llegó a mandar el aviso, la aserción de abajo no dice nada.
    expect(notificar, 'el cron no llegó a la rama del upsell').toHaveBeenCalled();
    expect(solicitar).toHaveBeenCalledWith('u1');
  });

  it('con Meta rechazando fuera de la ventana de 24h (131047), NO la abre', async () => {
    vi.setSystemTime(new Date(OCHO_PM_LIMA));
    usuariosData = usuarioUpsell();
    notificar.mockResolvedValue(NO_LLEGO);

    await checkRecordatorioDiario();

    expect(notificar, 'el cron no llegó a la rama del upsell').toHaveBeenCalled();
    expect(solicitar).not.toHaveBeenCalled();
  });

});

describe('downgrade por vencimiento: misma regla', () => {
  const usuarioVencido = () => ([{
    id: 'u2', whatsapp: '51988777666', nombre: 'Beto', plan: 'premium',
    premium_vence: '2026-08-01', estado_pago: 'pagado',
  }]);

  it('con el aviso entregado, abre la ventana', async () => {
    vi.setSystemTime(new Date(MEDIA_MANANA));
    usuariosData = usuarioVencido();
    notificar.mockResolvedValue(LLEGO_WA);

    await checkPremiumExpiry();

    expect(notificar).toHaveBeenCalled();
    expect(solicitar).toHaveBeenCalledWith('u2');
  });

  it('sin entrega por ningún canal, no la abre', async () => {
    vi.setSystemTime(new Date(MEDIA_MANANA));
    usuariosData = usuarioVencido();
    notificar.mockResolvedValue(NO_LLEGO);

    await checkPremiumExpiry();

    expect(notificar).toHaveBeenCalled();
    expect(solicitar).not.toHaveBeenCalled();
  });
});
