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
 *      lo ejercitaba otro test; **el upsell d28 de `checkUpsellPro` no lo ejercitaba
 *      ninguno**, que es justo uno de los dos call-sites que B14 agregó.
 *   2. Que la guarda decida lo correcto. Un barrido de texto no distingue
 *      `if (llegoElAviso(x))` de `if (!llegoElAviso(x))`.
 *
 * Acá se ejecutan los dos crons de verdad, con `notificarUsuario` mockeado para elegir el
 * resultado de la entrega.
 *
 * **El caso que importa cambió el 14-ago-2026 (B23), y la versión anterior de este archivo
 * blindaba una premisa falsa.** Decía que el caso típico es Meta devolviendo
 * `{ok:false, code:131047}` sin `skipped`, y por eso su caso "entregado" era `{wa:{ok:true}}`.
 * Medido contra producción: Meta **acepta** el POST y devuelve wamid; el 131047 llega después,
 * como callback de status. Cero filas `estado='blocked_24h'` en toda la historia contra 214 con
 * `fail_code=131047` desde el 01-ago, y de 260 envíos proactivos solo 40 entregados. O sea que
 * `{wa:{ok:true}}` era el caso NO entregado disfrazado del caso entregado, y el test lo fijaba.
 *
 * El caso que importa ahora es el usuario **WhatsApp-only** (44 de 106): Meta acepta el mensaje,
 * la fila in-app se escribe, y no hay campana donde verla. Antes eso abría la ventana de 48h.
 *
 * OJO CON CÓMO SE COMPRUEBA EL SCOPE, porque la primera versión de este archivo lo hizo mal.
 * Tenía un tercer caso que buscaba un `ReferenceError` en `log.error` y pasaba SIEMPRE, porque
 * el `catch` por usuario de `checkUpsellPro` era `catch(e) {}` a secas y no logueaba
 * nada. La aserción era vacua y encima describía mal el mecanismo. Lo delató la mutación
 * (renombrar la variable mataba el primer caso y no el que decía cubrirlo), y el caso se borró.
 *
 * **Eso cambió el 14-ago-2026: ese catch ahora sí loguea (B25).** O sea que `logMock.error` con
 * `tag: 'INACTIVITY'` volvió a ser un oráculo válido para un error de scope, y el caso borrado
 * se podría reconstruir. No se reconstruyó, y no por olvido: los casos de abajo ya afirman el
 * EFECTO (`solicitarComprobante` no se llama), que es lo que de verdad importa y no depende de
 * cómo se instrumente el catch. Queda dicho para que la próxima sesión no lo redescubra.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

let usuariosData = [];
// Las columnas que cada `.select()` sobre `usuarios` pidió durante la corrida. Es lo único que
// puede ver el hueco de abajo: con la DB mockeada, un select al que le falta una columna
// devuelve las filas del fixture igual.
let selectsUsuarios = [];
const solicitar = vi.fn().mockResolvedValue(true);
const notificar = vi.fn();

function makeChain(table) {
  const chain = {};
  for (const m of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'limit', 'order', 'not', 'in', 'is', 'or', 'ilike']) {
    chain[m] = () => chain;
  }
  chain.select = (cols) => {
    if (table === 'usuarios' && typeof cols === 'string') selectsUsuarios.push(cols);
    return chain;
  };
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

const { checkUpsellPro, checkPremiumExpiry } = require('../../cron/checks');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

// 8pm Lima = 01:00Z del día siguiente. Es el único horario en que corre el upsell a Pro.
const OCHO_PM_LIMA = '2026-08-16T01:05:00Z';
// 10am Lima: pasado el gate horario de checkPremiumExpiry.
const MEDIA_MANANA = '2026-08-15T15:00:00Z';

// Lo que devuelve `notificarUsuario`. `wa.ok:true` es lo que Meta contesta SIEMPRE que acepta
// el POST — incluso cuando el mensaje no se entrega —, así que acá es constante a propósito:
// lo único que separa un caso del otro es la fila in-app y la cuenta web del destinatario.
const AMBOS_CANALES = { wa: { ok: true, msgId: 'wamid.1' }, inApp: true };
// El claim in-app no se pudo escribir: no hay campana ni siquiera para el que tiene cuenta web.
const SIN_IN_APP = { wa: { ok: true, msgId: 'wamid.1' }, inApp: false };

const CON_WEB = '9ac31018-3c8c-47b2-b644-6a07fa2c79d0';

beforeEach(() => {
  solicitar.mockClear();
  notificar.mockClear();
  usuariosData = [];
  selectsUsuarios = [];
});

/**
 * El hueco que dejaba el fix de B23, medido antes de taparlo: quitarle `supabase_auth_id` a
 * cualquiera de los cuatro `select` dejaba **toda** la suite en verde. Y la degradación es
 * silenciosa y del lado que parece sano — la columna llega `undefined`, `llegoElAviso` devuelve
 * false siempre, y la ventana de comprobante no se abre nunca para nadie.
 *
 * Es la regla "una fila parcial no puede decidir" de `app/CLAUDE.md`, que ya se pagó una vez
 * con `mensajeMuro`. Los tests de arriba no pueden verlo: la DB está mockeada, así que un
 * select incompleto devuelve el fixture entero igual.
 */
describe('los selects que alimentan la guarda traen la columna que la guarda mira', () => {
  // El fixture NO puede estar vacío, y la primera versión de este test lo estaba. Con
  // `usuariosData = []` los cuatro bucles por usuario cortan por `length === 0` antes de
  // empezar, así que un `.select()` sobre `usuarios` agregado DENTRO de un bucle —un refetch de
  // la fila del destinatario, que es justo el caso que este guard existe para atrapar— quedaba
  // invisible y el conteo seguía en 4. Lo señaló la revisión adversarial del diff.
  //
  // Una fila sola alcanza para las cuatro queries: el mock de supabase ignora los filtros y
  // devuelve `usuariosData` para toda consulta a `usuarios`.
  const FILA_QUE_RECORRE_LOS_CUATRO_BUCLES = [{
    id: 'u3', whatsapp: '51977666555', nombre: 'Cali', plan: 'free',
    recordatorios_activos: true, supabase_auth_id: CON_WEB,
    premium_vence: '2026-08-01', estado_pago: 'pagado',
    created_at: new Date(Date.now() - 29 * 86400000).toISOString(),
  }];

  it('las cuatro queries de usuarios piden supabase_auth_id', async () => {
    // 8pm Lima pasa los dos gates horarios: `=== 20` el upsell a Pro, `>= 8` el de
    // vencimientos. Con una sola corrida se ejercitan las cuatro.
    vi.setSystemTime(new Date(OCHO_PM_LIMA));
    usuariosData = FILA_QUE_RECORRE_LOS_CUATRO_BUCLES;
    notificar.mockResolvedValue(AMBOS_CANALES);

    await checkUpsellPro();
    await checkPremiumExpiry();

    // Antivacuidad: si los bucles no corrieron, este guard no vio nada de lo que dice cubrir.
    expect(notificar, 'los crons no entraron a ningún bucle por usuario').toHaveBeenCalled();
    // El conteo fijo es lo que impide que esto describa una muestra: una query de usuarios
    // nueva en estos dos crons obliga a decidir si alimenta la decisión o no.
    expect(
      selectsUsuarios.length,
      'cambió la cantidad de queries a `usuarios` en estos dos crons: ' + JSON.stringify(selectsUsuarios),
    ).toBe(4);
    for (const cols of selectsUsuarios) {
      expect(cols, 'select sin la columna que decide si se abre la ventana: ' + cols)
        .toContain('supabase_auth_id');
    }
  });
});

describe('upsell d28: la ventana de comprobante solo se abre si hay dónde ver el aviso', () => {
  // Free (planConfig.recordatorios = false) y 29 días desde el alta: la rama del upsell.
  const usuarioUpsell = (supabase_auth_id) => ([{
    id: 'u1', whatsapp: '51999888777', nombre: 'Ana', plan: 'free',
    recordatorios_activos: true, supabase_auth_id,
    created_at: new Date(Date.now() - 29 * 86400000).toISOString(),
  }]);

  it('con cuenta web y la fila in-app escrita, la abre', async () => {
    vi.setSystemTime(new Date(OCHO_PM_LIMA));
    usuariosData = usuarioUpsell(CON_WEB);
    notificar.mockResolvedValue(AMBOS_CANALES);

    await checkUpsellPro();

    // Anti-vacuidad: si el cron no llegó a mandar el aviso, la aserción de abajo no dice nada.
    expect(notificar, 'el cron no llegó a la rama del upsell').toHaveBeenCalled();
    expect(solicitar).toHaveBeenCalledWith('u1');
  });

  // ESTE es B23. Con el predicado anterior (`wa.ok || inApp`) pasaba en verde: Meta aceptó y
  // la fila se escribió. Pero el destinatario es WhatsApp-only, así que esa fila no tiene
  // pantalla donde mostrarse y el WhatsApp casi nunca se entrega. 44 de 106 usuarios están acá.
  it('WhatsApp-only: Meta aceptó y la fila se escribió, pero NO la abre', async () => {
    vi.setSystemTime(new Date(OCHO_PM_LIMA));
    usuariosData = usuarioUpsell(null);
    notificar.mockResolvedValue(AMBOS_CANALES);

    await checkUpsellPro();

    expect(notificar, 'el cron no llegó a la rama del upsell').toHaveBeenCalled();
    expect(solicitar).not.toHaveBeenCalled();
  });

  it('con cuenta web pero sin fila in-app, tampoco la abre', async () => {
    vi.setSystemTime(new Date(OCHO_PM_LIMA));
    usuariosData = usuarioUpsell(CON_WEB);
    notificar.mockResolvedValue(SIN_IN_APP);

    await checkUpsellPro();

    expect(notificar, 'el cron no llegó a la rama del upsell').toHaveBeenCalled();
    expect(solicitar).not.toHaveBeenCalled();
  });
});

describe('downgrade por vencimiento: misma regla', () => {
  const usuarioVencido = (supabase_auth_id) => ([{
    id: 'u2', whatsapp: '51988777666', nombre: 'Beto', plan: 'premium',
    premium_vence: '2026-08-01', estado_pago: 'pagado', supabase_auth_id,
  }]);

  it('con cuenta web y la fila in-app escrita, abre la ventana', async () => {
    vi.setSystemTime(new Date(MEDIA_MANANA));
    usuariosData = usuarioVencido(CON_WEB);
    notificar.mockResolvedValue(AMBOS_CANALES);

    await checkPremiumExpiry();

    expect(notificar).toHaveBeenCalled();
    expect(solicitar).toHaveBeenCalledWith('u2');
  });

  it('WhatsApp-only: no la abre aunque Meta haya aceptado el mensaje', async () => {
    vi.setSystemTime(new Date(MEDIA_MANANA));
    usuariosData = usuarioVencido(null);
    notificar.mockResolvedValue(AMBOS_CANALES);

    await checkPremiumExpiry();

    expect(notificar).toHaveBeenCalled();
    expect(solicitar).not.toHaveBeenCalled();
  });

  it('sin fila in-app, no la abre', async () => {
    vi.setSystemTime(new Date(MEDIA_MANANA));
    usuariosData = usuarioVencido(CON_WEB);
    notificar.mockResolvedValue(SIN_IN_APP);

    await checkPremiumExpiry();

    expect(notificar).toHaveBeenCalled();
    expect(solicitar).not.toHaveBeenCalled();
  });
});
