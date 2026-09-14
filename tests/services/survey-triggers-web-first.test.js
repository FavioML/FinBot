import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El COMPORTAMIENTO del ítem 23 (01-sep-2026), que ningún guard estático puede afirmar.
 *
 * `tests/canal-unico-sin-cuenta-web.test.js` verifica la FORMA: que no quede un corte por falta
 * de número sin declarar. Eso no dice si el usuario web-first recibe algo, ni cuál de los seis
 * triggers le llega — y es justo la mitad que importa, porque el defecto era invisible en
 * producción: el cron corría, no fallaba, y un `continue` se veía igual que un usuario que no
 * calificaba.
 *
 * Lo que se afirma acá, y cada caso mira las DOS mitades (que llegue lo que tiene que llegar
 * **y** que no llegue lo que no):
 *
 *   · sin número, el aviso sale igual, por `CANALES.AMBOS`, con `whatsapp: null`;
 *   · el cuerpo in-app NO le pide acciones de WhatsApp a quien no tiene WhatsApp;
 *   · la fila de `survey_events` dice `in_app`, que es lo que después lee la anti-fatiga;
 *   · los DOS triggers exentos (`reminder_d14`, `feedback_open_30tx`) no salen **y no queman
 *     nada**: sin fila, el día que agregue un número los recibe;
 *   · esa exención es por FALTA DE NÚMERO, no un apagado: con número, los dos salen.
 *
 * Medido en producción el 01-sep-2026, que es de dónde salen los fixtures: 17 usuarios sin
 * WhatsApp, los 17 con cuenta web y recordatorios prendidos, con CERO eventos de los ocho
 * triggers de este archivo en toda su historia.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/** Todo INSERT, para poder afirmar qué se registró y qué NO. */
let inserts = [];

const notificar = vi.fn().mockResolvedValue({ wa: { ok: false, skipped: 'no_whatsapp' }, inApp: true, email: { ok: false } });

function makeChain(table, registroFiltros = null) {
  const filtros = [];
  let esConteo = false;
  let tope = null;
  const chain = {};
  const anotar = (col, val) => { if (registroFiltros) registroFiltros[col] = val; };
  chain.order = () => chain;
  chain.limit = (n) => { tope = n; return chain; };
  const rango = (cmp) => (col, val) => {
    filtros.push((f) => f[col] !== null && f[col] !== undefined && cmp(f[col], val));
    return chain;
  };
  chain.gt = rango((a, b) => a > b);
  chain.gte = rango((a, b) => a >= b);
  chain.lt = rango((a, b) => a < b);
  chain.lte = rango((a, b) => a <= b);
  chain.select = (_cols, opts) => { if (opts && opts.count) esConteo = true; return chain; };
  chain.eq = (col, val) => { anotar(col, val); filtros.push((f) => f[col] === val); return chain; };
  chain.in = (col, arr) => { anotar(col, arr); filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
    anotar(col, val);
    if (val === null) filtros.push((f) => f[col] === null || f[col] === undefined);
    return chain;
  };
  const resolver = () => {
    let filas = (tablas[table] || []).filter((f) => filtros.every((p) => p(f)));
    if (tope !== null) filas = filas.slice(0, tope);
    return esConteo ? { data: null, count: filas.length, error: null } : { data: filas, count: filas.length, error: null };
  };
  chain.single = () => Promise.resolve({ data: (resolver().data || [])[0] || null, error: null });
  chain.maybeSingle = chain.single;
  chain.then = (resolve) => resolve(resolver());
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => ({
      ...makeChain(t),
      // El insert devuelve la fila escrita: `registrarEvento` hace `.select('id').single()` y
      // corta con `if (!eventoId) return false`. Un doble que devolviera vacío apagaría los
      // one-shot y este archivo saldría verde sin haber ejercitado un solo envío.
      // La fila insertada entra a `tablas`, no solo a `inserts`: sin ida y vuelta, el DELETE de
      // abajo no podría resolverse contra nada y el harness no vería si el WHERE apunta bien.
      insert: (patch) => {
        inserts.push({ tabla: t, patch });
        const fila = { id: 'ev-' + inserts.length, ...patch };
        (tablas[t] = tablas[t] || []).push(fila);
        const c = makeChain(t);
        c.single = () => Promise.resolve({ data: fila, error: null });
        return c;
      },
      update: () => makeChain(t),
      // Hasta el 14-sep-2026 este DELETE resolvía contra la tabla con sus filtros, para los casos
      // de `liberarClaimSinEntrega`. Se fueron con los dos `wake_up`, que eran sus únicos
      // llamadores: hoy `survey-triggers.js` no borra nada.
      delete: () => makeChain(t),
    })),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

// El canal in-app se mockea de VERDAD (no se reemplaza `notificarUsuario` en estos casos):
// `crearNotificacion` devuelve `false` en error en vez de lanzar, y ése es exactamente el
// escenario que el claim liberado viene a cubrir. Un doble que lanzara no lo reproduce.
const crearNotificacion = vi.fn().mockResolvedValue(true);

function stub(rel, exports) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('lib/db.js', dbMock);
stub('lib/logger.js', logMock);
stub('lib/notifications-db.js', { crearNotificacion });
stub('lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: false, skipped: 'no_whatsapp' }) });
stub('lib/email.js', { enviarEmail: vi.fn().mockResolvedValue({ ok: false, skipped: 'canal_no_declarado' }) });

// Se preserva `CANALES`: `survey-triggers` lo desestructura al cargar, así que reemplazar el
// módulo entero dejaría `canales: undefined` y el chokepoint asumiría AMBOS solo. Con eso, un
// call-site que perdiera su declaración pasaría este archivo en verde.
const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};
const { CANALES } = notifyReal;

const { checkSurveyTriggers } = require('../../services/survey-triggers');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

/** Las 10:05 de Lima, que es la única ventana en que este cron hace algo. */
const A_LAS_DIEZ = new Date('2026-09-01T10:05:00-05:00');
const haceDias = (d) => new Date(A_LAS_DIEZ.getTime() - d * 86400000).toISOString();

const WEB_FIRST = {
  id: 'u-web', whatsapp: null, nombre: 'Ana Web', recordatorios_activos: true,
  onboarding_completado: true, onboarding_paso: 0, supabase_auth_id: 'auth-1',
  cuenta_borrada_at: null,
};
const CON_NUMERO = {
  id: 'u-wa', whatsapp: '51999111222', nombre: 'Beto Chat', recordatorios_activos: true,
  onboarding_completado: true, onboarding_paso: 0, supabase_auth_id: 'auth-2',
  cuenta_borrada_at: null,
};

/** Siembra la población y corre el cron dentro de su ventana horaria. */
async function correr(usuarios, { txs = [], eventos = [] } = {}) {
  tablas = { usuarios, transacciones: txs, survey_events: eventos, errores: [], nlp_errors: [] };
  inserts = [];
  notificar.mockClear();
  crearNotificacion.mockClear();
  vi.setSystemTime(A_LAS_DIEZ);
  await checkSurveyTriggers();
}

const avisoDe = (userId) => notificar.mock.calls.map((c) => c[0]).find((a) => a.usuarioId === userId);
const eventosDe = (userId) => inserts.filter((i) => i.tabla === 'survey_events' && i.patch.user_id === userId);

/** El texto in-app que de verdad va a ver la campana (el chokepoint no lo deriva si hay cuerpo). */
const cuerpoInApp = (aviso) => (aviso.cuerpo != null ? aviso.cuerpo : aviso.mensaje);

beforeEach(() => {
  logMock.error.mockClear(); logMock.warn.mockClear();
});

describe('el usuario sin WhatsApp recibe los triggers que sí puede usar', () => {
  it('reminder_d3 le llega por la campana, con whatsapp null y por AMBOS', async () => {
    await correr([{ ...WEB_FIRST, created_at: haceDias(3.2) }]);

    const aviso = avisoDe('u-web');
    expect(aviso, 'no se le mandó nada: el corte volvió').toBeTruthy();
    expect(aviso.canales).toBe(CANALES.AMBOS);
    expect(aviso.whatsapp).toBe(null);
    expect(aviso.tipo).toBe('survey_reminder_d3');
    expect(aviso.titulo).toBeTruthy();   // sin título el chokepoint no escribe la campana
  });

  it('el cuerpo in-app no le pide acciones de WhatsApp a quien no tiene WhatsApp', async () => {
    await correr([{ ...WEB_FIRST, created_at: haceDias(3.2) }]);
    const texto = cuerpoInApp(avisoDe('u-web'));

    // Las tres formas que el copy de WhatsApp usa y que en la campana no existen. Sin este
    // caso, "sacar el corte" se conformaba con entregar un texto que dice "escríbeme" a alguien
    // que no tiene por dónde escribir.
    expect(texto).not.toMatch(/escríbeme|mándame|envíame/i);
    expect(texto).not.toMatch(/\/silenciar/);
    expect(texto).not.toMatch(/Yape|screenshot|foto/i);
    // Y la mitad positiva: tiene que decirle algo que SÍ puede hacer.
    expect(texto).toMatch(/anot|gasto/i);
  });

  it('la fila de survey_events dice in_app, que es lo que lee la anti-fatiga', async () => {
    await correr([{ ...WEB_FIRST, created_at: haceDias(3.2) }]);
    const evs = eventosDe('u-web');
    expect(evs.length).toBe(1);
    expect(evs[0].patch.channel).toBe('in_app');
    expect(evs[0].patch.event_type).toBe('reminder_d3');
  });

  it('con número, la MISMA corrida escribe whatsapp en el ledger', async () => {
    // El control de los tres casos de arriba: si el ternario del canal se rompiera hacia
    // `in_app` siempre, aquéllos seguirían verdes y el ledger mentiría del otro lado.
    await correr([{ ...CON_NUMERO, created_at: haceDias(3.2) }]);
    expect(eventosDe('u-wa')[0].patch.channel).toBe('whatsapp');
    expect(avisoDe('u-wa').whatsapp).toBe('51999111222');
  });
});

describe('los dos triggers exentos: no salen sin número, y no queman nada', () => {
  it('reminder_d14 no sale, y NO deja fila', async () => {
    await correr([{ ...WEB_FIRST, created_at: haceDias(14.2) }]);

    expect(avisoDe('u-web'), 'salió un aviso que no se puede contestar').toBeFalsy();
    expect(eventosDe('u-web'), 'quedó fila: la próxima vez no se lo manda ni con número').toEqual([]);
  });

  it('feedback_open_30tx no sale, y NO quema el one-shot', async () => {
    const txs = Array.from({ length: 30 }, (_, i) => ({ id: 'tx' + i, usuario_id: 'u-web', fecha: '2026-08-20' }));
    await correr([{ ...WEB_FIRST, created_at: haceDias(60) }], { txs });

    expect(avisoDe('u-web')).toBeFalsy();
    // El unique index de `feedback_open_30tx` es irreversible: una fila acá es para siempre.
    expect(eventosDe('u-web')).toEqual([]);
  });

  it('la exención es por falta de NÚMERO, no un apagado: con número los dos salen', async () => {
    // Sin este caso, "arreglar" el ítem borrando los dos triggers pasaría los dos casos de
    // arriba en verde. Es el negativo que impide que la exención sea un `return false` global.
    await correr([{ ...CON_NUMERO, created_at: haceDias(14.2) }]);
    expect(avisoDe('u-wa').tipo).toBe('survey_reminder_d14');

    const txs = Array.from({ length: 30 }, (_, i) => ({ id: 'tx' + i, usuario_id: 'u-wa', fecha: '2026-08-20' }));
    await correr([{ ...CON_NUMERO, created_at: haceDias(60) }], { txs });
    expect(avisoDe('u-wa').tipo).toBe('survey_feedback_open_30tx');
  });
});

describe('un reminder_dN que no salió por ningún canal NO se registra', () => {
  /**
   * La otra mitad de la misma clase, y la que estaba abierta en 4 de los 8 triggers.
   *
   * El docblock de `enviarYRegistrar` prometía desde siempre *"si falla, no registra (así
   * reintenta próxima vez)"* y era FALSO: `notificarUsuario` nunca lanza y su retorno se
   * descartaba. La fila que quedaba hacía dos daños permanentes: el dedup por tipo de cada
   * `maybeReminderD*` corta con cualquier fila previa —ese recordatorio no se manda nunca más—
   * y encima gasta la anti-fatiga de 7 días, así que un aviso que no salió apaga al siguiente
   * que sí habría salido.
   *
   * (La mitad one-shot de esta clase, `liberarClaimSinEntrega`, vivía en un describe aparte y
   * se fue el 14-sep-2026 con los dos `wake_up`, sus únicos llamadores.)
   */
  it('el chokepoint traduce un `crearNotificacion` en false a `inApp: false`', async () => {
    // El eslabón del que dependen los casos de abajo, ejercitado con la función REAL. Sin esto,
    // prueban que `enviarYRegistrar` decide bien sobre un `inApp` que YO le paso, y no que ese
    // `inApp` llegue a false cuando la base falla — `crearNotificacion` devuelve false en vez de
    // lanzar, y ésa es la mitad silenciosa.
    crearNotificacion.mockResolvedValueOnce(false);
    const r = await notifyReal.notificarUsuario({
      canales: CANALES.AMBOS, usuarioId: 'u-web', whatsapp: null,
      tipo: 't', mensaje: 'm', titulo: 'T',
    });
    expect(r.inApp).toBe(false);
    expect(r.wa.ok).toBe(false);
  });

  it('no deja fila, y lo dice', async () => {
    notificar.mockResolvedValueOnce({ wa: { ok: false, skipped: 'no_whatsapp' }, inApp: false, email: { ok: false } });
    await correr([{ ...WEB_FIRST, created_at: haceDias(3.2) }]);

    expect(eventosDe('u-web'), 'quedó fila de un aviso que nadie recibió').toEqual([]);
    expect(logMock.warn.mock.calls.map((c) => c[1]).join(' | ')).toMatch(/no salio por ningun canal/);
  });

  it('la fila del día siguiente no queda bloqueada por la del día que falló', async () => {
    // La consecuencia que hace que esto importe: con la fila puesta, `maybeReminderD3` corta
    // para siempre. Sin ella, la corrida siguiente manda.
    notificar.mockResolvedValueOnce({ wa: { ok: false, skipped: 'no_whatsapp' }, inApp: false, email: { ok: false } });
    await correr([{ ...WEB_FIRST, created_at: haceDias(3.2) }]);
    const eventosTrasElFallo = eventosDe('u-web');

    await correr([{ ...WEB_FIRST, created_at: haceDias(3.4) }], { eventos: eventosTrasElFallo.map((e) => e.patch) });
    expect(avisoDe('u-web'), 'el aviso fallido bloqueó al del día siguiente').toBeTruthy();
    expect(eventosDe('u-web')[0].patch.channel).toBe('in_app');
  });

  it('un correo entregado SÍ cuenta como salida, aunque los otros dos canales fallen', async () => {
    // El canal que la primera versión del predicado se olvidó. Con `email` declarado —lo que el
    // CLAUDE.md empuja para los avisos que importan— un correo entregado se leía como "no salió
    // nada": el reminder no se registraba y el one-shot se liberaba, o sea un correo idéntico
    // por día.
    notificar.mockResolvedValueOnce({ wa: { ok: false, skipped: 'no_whatsapp' }, inApp: false, email: { ok: true, msgId: 'm1' } });
    await correr([{ ...WEB_FIRST, created_at: haceDias(3.2) }]);

    expect(eventosDe('u-web').length, 'un aviso entregado por correo no quedó registrado').toBe(1);
  });

  it('un silencio pedido (is_test_user) no es un canal caído', async () => {
    // `enviarWhatsapp` devuelve `{ ok: true, skipped: 'test_user' }` para una cuenta de prueba, y
    // el chokepoint lo excluye a propósito de su "sin entrega en ningún canal". Tratarlo como
    // fallo reintentaría todos los días contra una cuenta que pidió silencio.
    notificar.mockResolvedValueOnce({ wa: { ok: true, skipped: 'test_user' }, inApp: false, email: { ok: false } });
    await correr([{ ...CON_NUMERO, created_at: haceDias(3.2) }]);

    expect(eventosDe('u-wa').length).toBe(1);
  });
});

describe('lo que el corte tapaba de rebote sigue tapado, pero por su propio gate', () => {
  it('la lápida no recibe nada: la cierra el filtro, no la falta de número', async () => {
    // La cuenta borrada queda con `whatsapp` NULL, así que hasta el 01-sep la salvaba de
    // rebote el corte. Hoy tiene que ser el `.is('cuenta_borrada_at', null)` quien la deje
    // afuera — y la única forma de comprobarlo es una lápida SIN número, que es como quedan.
    const lapida = { ...WEB_FIRST, id: 'u-baja', created_at: haceDias(3.2), cuenta_borrada_at: haceDias(1) };
    await correr([lapida]);

    expect(avisoDe('u-baja')).toBeFalsy();
    expect(eventosDe('u-baja')).toEqual([]);
  });

  it('el opt-out sigue mandando, con número o sin él', async () => {
    await correr([{ ...WEB_FIRST, created_at: haceDias(3.2), recordatorios_activos: false }]);
    expect(avisoDe('u-web')).toBeFalsy();
  });

  it('la anti-fatiga cuenta la fila in_app: no se le apilan dos avisos', async () => {
    // El acoplamiento de `CANALES_EMPUJE`. Si el ledger volviera a decir `whatsapp` sobre un
    // aviso in-app esto seguiría verde; lo que este caso protege es el otro lado, que el
    // lector no vuelva a filtrar solo `whatsapp` y deje de ver su propia marca.
    const eventos = [{
      id: 'e1', user_id: 'u-web', event_type: 'reminder_d3', channel: 'in_app',
      sent_at: haceDias(2),
    }];
    await correr([{ ...WEB_FIRST, created_at: haceDias(7.2) }], { eventos });

    expect(avisoDe('u-web'), 'la anti-fatiga no vio su propia fila in_app').toBeFalsy();
  });
});
