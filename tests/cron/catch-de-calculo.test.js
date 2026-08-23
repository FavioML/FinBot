import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * Los `catch` de los bucles de CÁLCULO de `cron/checks.js`, uno por sitio.
 *
 * B25 cerró los cinco que empujan avisos. Quedaban ocho `catch (e) { /* silent *\/ }` en los
 * loops que CALCULAN (score, espacios, eventos, suscripciones, resumen). Todos hacen lo
 * correcto —saltar al siguiente, porque un aviso menos es mejor que un cron muerto— y ninguno
 * lo dice: un servicio que falla para TODOS produce exactamente el mismo silencio que "no
 * había a quién avisarle". Es el gemelo de las 31 lecturas del ítem 1, con el error llegando
 * por `throw` en vez de por `{ error }`.
 *
 * **Un test por SITIO, no por forma.** La lección del ítem 7: los cuatro dedups `reminder_dN`
 * se probaban sólo con el de día 3 y las otras tres mutaciones sobrevivían con todo en verde.
 * Ocho catches, ocho casos.
 *
 * **Y cada caso afirma DOS cosas**, porque el riesgo del arreglo es tan grande como el del
 * bug: que el log lleve el id de a quién se le perdió, y que el loop **siga** —que el segundo
 * usuario reciba lo suyo—. La segunda es la contraprueba de "no puse un `return` donde no va";
 * un `if (error) return` mal puesto apaga un cron entero por un hipo.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};

/**
 * Mock de PostgREST con los filtros que estos crons usan de verdad. `eq`/`in`/`not`/rangos
 * filtran; `head: true` devuelve `{ count }` como el real. Sin filtrado, la población de un
 * cron se colaría en la de otro y los casos saldrían verdes por el motivo equivocado.
 */
function makeChain(table) {
  const filtros = [];
  let esConteo = false;
  const chain = {};
  for (const m of ['ilike', 'order', 'limit']) chain[m] = () => chain;
  const noEsNull = (f, col) => f[col] !== null && f[col] !== undefined;
  const rango = (cmp) => (col, val) => { filtros.push((f) => noEsNull(f, col) && cmp(f[col], val)); return chain; };
  chain.gt = rango((a, b) => a > b);
  chain.gte = rango((a, b) => a >= b);
  chain.lt = rango((a, b) => a < b);
  chain.lte = rango((a, b) => a <= b);
  chain.select = (_cols, opts) => { if (opts && opts.count) esConteo = true; return chain; };
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => noEsNull(f, col) && f[col] !== val); return chain; };
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => { if (val === null) filtros.push((f) => !noEsNull(f, col)); return chain; };
  chain.not = (col, op, val) => {
    if (op === 'is' && val === null) filtros.push((f) => noEsNull(f, col));
    else if (op === 'eq') filtros.push((f) => noEsNull(f, col) && f[col] !== val);
    return chain;
  };
  chain.or = () => chain;
  const resolver = () => {
    const filas = (tablas[table] || []).filter((f) => filtros.every((p) => p(f)));
    return esConteo ? { data: null, count: filas.length, error: null } : { data: filas, count: filas.length, error: null };
  };
  // `single` con cero filas devuelve PGRST116, `maybeSingle` no: aliasearlos es el defecto de
  // harness que el ítem 8 del backlog ya pagó (el mock devolvía el error donde el cliente real
  // nunca lo devuelve, y al revés).
  chain.maybeSingle = () => Promise.resolve({ data: resolver().data[0] || null, error: null });
  chain.single = () => Promise.resolve(resolver().data[0]
    ? { data: resolver().data[0], error: null }
    : { data: null, error: { code: 'PGRST116', message: 'no rows' } });
  chain.then = (resolve) => resolve(resolver());
  return chain;
}

const escrituras = [];
const dbMock = {
  supabase: {
    from: vi.fn((t) => {
      const base = makeChain(t);
      return {
        ...base,
        update: (patch) => { escrituras.push({ tabla: t, op: 'update', patch }); return makeChain(t); },
        insert: (patch) => { escrituras.push({ tabla: t, op: 'insert', patch }); return makeChain(t); },
        delete: () => { escrituras.push({ tabla: t, op: 'delete' }); return makeChain(t); },
      };
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

const notificar = vi.fn();
const upsertScore = vi.fn();
const obtenerTendenciaScore = vi.fn();
const calcularRitmoAhorro = vi.fn();
const balanceEspacio = vi.fn();
const ownerEsPro = vi.fn();
const detectarSuscripciones = vi.fn();
const generarResumenDiario = vi.fn();
const revocarGmail = vi.fn();

const serviciosMock = [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }) }],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn() }],
  ['lib/pro-payment.js', { solicitarComprobante: vi.fn(), esperaComprobante: vi.fn() }],
  ['gmail.js', { revocarAccesoGmail: revocarGmail }],
  ['services/summaries.js', {
    generarResumenMensual: vi.fn().mockResolvedValue('resumen'),
    generarResumenSemanal: vi.fn().mockResolvedValue('resumen'),
    generarResumenDiario,
  }],
  ['services/recommendations.js', { verificarAlertasProactivas: vi.fn().mockResolvedValue('alerta') }],
  ['services/debts.js', { obtenerDeudasProximasVencer: vi.fn().mockResolvedValue([]) }],
  ['services/spending-alerts.js', {
    generarAlertasFugas: vi.fn().mockResolvedValue([]),
    generarMensajeFugas: vi.fn().mockResolvedValue('fugas'),
    guardarAlertas: vi.fn(),
  }],
  ['services/neto-score.js', { upsertScore, obtenerTendenciaScore, scoreLabel: () => 'bien' }],
  ['services/metas.js', { calcularRitmoAhorro }],
  ['services/shared-spaces.js', { obtenerBalanceEspacio: balanceEspacio, ownerEsPro }],
  ['services/subscriptions/index.js', { detectarSuscripciones }],
  ['services/survey-triggers.js', { checkSurveyTriggers: vi.fn() }],
];
for (const [rel, exports] of serviciosMock) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};

const checks = require('../../cron/checks');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

/** Un instante real cuyo horario en Lima (UTC-5) es el que el gate del cron exige. */
const enLima = (iso) => new Date(iso + '-05:00');

/**
 * Los `log.error` como `{tag, ...campos}`. Comparar el tag por IGUALDAD y no por subcadena es
 * la corrección que en `lecturas-con-error.test.js` mató cuatro mutaciones: `'SCORE'` como
 * subcadena da por bueno un log de `'SCORE_NOTIF'`.
 */
const erroresConTag = (tag) => logMock.error.mock.calls.map((c) => c[0]).filter((o) => o && o.tag === tag);
/** Los `usuarioId`/`userId` que aparecen en los `log.error` de ese tag. */
const idsLogueados = (tag) => erroresConTag(tag).map((o) => o.usuarioId ?? o.userId ?? o.spaceId);
/** A quién se le llegó a notificar, por id. */
const notificados = () => notificar.mock.calls.map((c) => c[0].usuarioId);

const PRO_A = {
  id: 'u-a', whatsapp: '51900000001', nombre: 'Ana Rojas', plan: 'premium',
  onboarding_completado: true, recordatorios_activos: true, manos_libres: true,
};
const PRO_B = { ...PRO_A, id: 'u-b', whatsapp: '51900000002', nombre: 'Beto Díaz' };

/** Falla para el primero, anda para el segundo: mide el log Y que el loop siga. */
const fallaPara = (id, valor) => vi.fn(async (arg) => {
  const quien = typeof arg === 'string' ? arg : (arg && (arg.id || arg.usuario_id));
  if (quien === id) throw new Error('servicio caído');
  return typeof valor === 'function' ? valor(arg) : valor;
});

beforeEach(() => {
  tablas = {};
  escrituras.length = 0;
  logMock.error.mockClear();
  logMock.info.mockClear();
  notificar.mockClear().mockResolvedValue({ wa: { ok: true }, inApp: true });
  upsertScore.mockReset().mockResolvedValue(undefined);
  obtenerTendenciaScore.mockReset().mockResolvedValue({ current: 70, diff: 2 });
  calcularRitmoAhorro.mockReset().mockReturnValue({ enRitmo: true, montoMensual: 100 });
  balanceEspacio.mockReset().mockResolvedValue({ debts: [] });
  ownerEsPro.mockReset().mockResolvedValue(true);
  detectarSuscripciones.mockReset().mockResolvedValue({ suscripciones_detectadas: [] });
  generarResumenDiario.mockReset().mockResolvedValue('resumen del día');
  revocarGmail.mockReset().mockResolvedValue({ revocadas: 0 });
});

// ───────────────────────────────────────────────────────────────────────────────
// 1. checkCalcularNetoScore — el PRODUCTOR. No empuja nada, y por eso su silencio
//    se paga el domingo: sin score no hay tendencia, y `checkNotificacionScore` no
//    encuentra a quién avisarle. Dos crons callados por una sola caída.
// ───────────────────────────────────────────────────────────────────────────────
describe('el cálculo del score', () => {
  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-23T06:05'));
    tablas.usuarios = [PRO_A, PRO_B];
  });

  it('el usuario cuyo score no se pudo calcular queda en el log, y el siguiente se calcula igual', async () => {
    upsertScore.mockImplementation(fallaPara('u-a'));
    await checks.checkCalcularNetoScore();

    expect(idsLogueados('SCORE')).toContain('u-a');
    expect(upsertScore).toHaveBeenCalledTimes(2);
  });

  it('el conteo final distingue "no se calculó ninguno" de "no había usuarios"', async () => {
    // `count: 0` a secas se lee como padrón vacío. Es exactamente la confusión que dejó
    // `checkRecordatorioOnboarding` doce días sin destinatarios sin que nadie lo notara.
    upsertScore.mockRejectedValue(new Error('servicio caído'));
    await checks.checkCalcularNetoScore();

    const resumen = logMock.info.mock.calls.map((c) => c[0]).filter((o) => o && o.tag === 'SCORE');
    expect(resumen.some((o) => o.fallidos === 2)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 2 y 3. Los dos avisos semanales/quincenales de Pro.
// ───────────────────────────────────────────────────────────────────────────────
describe('el score semanal', () => {
  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-23T10:05')); // domingo
    tablas.usuarios = [PRO_A, PRO_B];
  });

  it('el que no pudo recibirlo queda en el log, y el otro sí lo recibe', async () => {
    obtenerTendenciaScore.mockImplementation(fallaPara('u-a', { current: 70, diff: 2 }));
    await checks.checkNotificacionScore();

    expect(idsLogueados('SCORE_NOTIF')).toContain('u-a');
    expect(notificados()).toEqual(['u-b']);
  });
});

describe('el check-in de planes de ahorro', () => {
  beforeEach(() => {
    vi.setSystemTime(enLima('2026-09-01T11:05'));
    tablas.usuarios = [PRO_A, PRO_B];
    tablas.metas_ahorro = [
      { id: 'm-a', usuario_id: 'u-a', nombre: 'Cusco', completada: false, status: 'active', monto_objetivo: 1000, monto_actual: 100, fecha_limite: '2026-12-01', created_at: '2026-01-01' },
      { id: 'm-b', usuario_id: 'u-b', nombre: 'Laptop', completada: false, status: 'active', monto_objetivo: 2000, monto_actual: 500, fecha_limite: '2026-12-01', created_at: '2026-01-01' },
    ];
  });

  it('el usuario cuyo ritmo no se pudo calcular queda en el log, y el otro recibe su check-in', async () => {
    // `calcularRitmoAhorro` es síncrono y corre POR META dentro del loop del usuario: es el
    // único throw que puede tumbar el armado del mensaje a mitad de camino.
    calcularRitmoAhorro.mockImplementation((m) => {
      if (m.usuario_id === 'u-a') throw new Error('ritmo caído');
      return { enRitmo: true, montoMensual: 100 };
    });
    await checks.checkCheckInPlanes();

    expect(idsLogueados('CHECKIN_PLANES')).toContain('u-a');
    expect(notificados()).toEqual(['u-b']);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 4 y 5. Espacios: dos catches anidados que NO son el mismo caso. El de adentro
//    pierde un MIEMBRO; el de afuera pierde el espacio entero, con todos sus
//    miembros, incluida la plata ajena que nadie va a reclamar.
// ───────────────────────────────────────────────────────────────────────────────
describe('el recordatorio de espacios compartidos', () => {
  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-21T18:05')); // viernes
    tablas.shared_spaces = [{ id: 'sp-1', name: 'Depa' }, { id: 'sp-2', name: 'Viaje' }];
    // `u-b` vive SÓLO en sp-1. Con él también en sp-2, "el otro miembro recibió" se cumplía
    // con el aviso del OTRO espacio, y un `break` dentro del catch interno —que se lleva a
    // todos los miembros que faltaban de sp-1— sobrevivía en verde. Lo midió la revisión
    // adversarial: el fixture, no el código, era lo que hacía pasar el caso.
    tablas.space_members = [
      { space_id: 'sp-1', user_id: 'u-a', usuarios: { whatsapp: '51900000001', nombre: 'Ana', recordatorios_activos: true } },
      { space_id: 'sp-1', user_id: 'u-b', usuarios: { whatsapp: '51900000002', nombre: 'Beto', recordatorios_activos: true } },
      { space_id: 'sp-2', user_id: 'u-d', usuarios: { whatsapp: '51900000004', nombre: 'Dana', recordatorios_activos: true } },
    ];
    tablas.notificaciones = [];
    balanceEspacio.mockResolvedValue({ debts: [
      { from: 'u-a', to: 'u-c', toNombre: 'Caro', amount: 120 },
      { from: 'u-b', to: 'u-c', toNombre: 'Caro', amount: 90 },
      { from: 'u-d', to: 'u-c', toNombre: 'Caro', amount: 70 },
    ] });
  });

  it('el miembro al que no se le pudo avisar queda en el log, y los DEMÁS DE SU ESPACIO reciben', async () => {
    notificar.mockImplementation(async (p) => {
      if (p.usuarioId === 'u-a') throw new Error('meta caída');
      return { wa: { ok: true }, inApp: true };
    });
    await checks.checkRecordatorioEspacios();

    const ids = erroresConTag('ESPACIOS_REMIND').map((o) => o.userId);
    expect(ids).toContain('u-a');
    // `u-b` es el compañero de sp-1 que viene DESPUÉS del que falló: es el único que puede
    // delatar un corte del loop interno.
    expect(notificados()).toContain('u-b');
    expect(notificados()).toContain('u-d');
  });

  it('el espacio entero que se cae queda en el log con su spaceId, y el siguiente espacio sigue', async () => {
    // `ownerEsPro` corre ANTES del loop de miembros: su throw se lleva el espacio completo.
    ownerEsPro.mockImplementation(async (id) => {
      if (id === 'sp-1') throw new Error('tier caído');
      return true;
    });
    await checks.checkRecordatorioEspacios();

    expect(erroresConTag('ESPACIOS_REMIND').map((o) => o.spaceId)).toContain('sp-1');
    // sp-2 no se pierde con él: `u-d` sólo puede haber recibido por ese espacio.
    expect(notificados()).toContain('u-d');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 6. Conversiones: la ACCESORIA. Corre por evento, hasta cientos por corrida, y su
//    catch silencioso es deliberado — un log por fallo sería ruido que nadie lee.
//    Lo que estaba mal es que la cuenta agregada que SÍ existe no contaba el throw.
// ───────────────────────────────────────────────────────────────────────────────
describe('la conversión de recordatorios', () => {
  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-23T07:05'));
    tablas.survey_events = [
      // `sent_at` tiene que caer DENTRO de la ventana de la query (que filtra por rango sobre
      // el string ISO) y a la vez ser una fecha imposible. Un 'fecha-rota' cualquiera lo
      // descarta el `.lte(...)` antes del loop y el caso sale verde sin haber ejercitado nada.
      { id: 'e-1', user_id: 'u-a', event_type: 'reminder_d3', conversion_within_24h: false, sent_at: '2026-08-15T99:99:99.000Z' },
      { id: 'e-2', user_id: 'u-b', event_type: 'reminder_d7', conversion_within_24h: false, sent_at: new Date(Date.now() - 3 * 86400000).toISOString() },
    ];
    // La transacción de `u-b` DENTRO de su ventana de 24h. Sin ella, `e-2` no producía ninguna
    // señal y cortar el loop tras el primer fallo salía verde: `evaluados` es `eventos.length`
    // pase lo que pase. Lo midió la revisión adversarial con un `break` que sobrevivía.
    tablas.transacciones = [{ id: 'tx-1', usuario_id: 'u-b', created_at: new Date(Date.now() - 3 * 86400000 + 3600000).toISOString() }];
  });

  it('el evento que revienta entra en la cuenta agregada, y el siguiente se evalúa igual', async () => {
    // `sent_at` basura hace explotar el `.toISOString()` del cálculo de la ventana. Antes de
    // esto el throw se tragaba entero: el panel volvía a graficar la conversión subcontada,
    // que es exactamente el síntoma que esta función existe para curar.
    await checks.checkSurveyConversions();

    const agregados = erroresConTag('SURVEY_CONV');
    expect(agregados).toHaveLength(1);
    expect(agregados[0].fallidos).toBe(1);
    expect(agregados[0].evaluados).toBe(2);
    // Y la contraprueba de continuidad: `e-2` sí se marcó.
    const marcados = logMock.info.mock.calls.map((c) => c[0]).filter((o) => o && o.tag === 'SURVEY_CONV');
    expect(marcados.some((o) => o.marcados === 1)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 7 y 8. Los dos avisos diarios.
// ───────────────────────────────────────────────────────────────────────────────
describe('el recordatorio de cobro de suscripciones', () => {
  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-23T10:05'));
    tablas.usuarios = [PRO_A, PRO_B];
    tablas.notificaciones = [];
    const en3dias = new Date(Date.now() + 3 * 86400000);
    detectarSuscripciones.mockResolvedValue({ suscripciones_detectadas: [{
      nombre: 'Netflix', monto_detectado: 44.9, moneda: 'PEN', icono: '🎬', estado: 'activa',
      ultimo_pago: new Date(en3dias.getTime() - 30 * 86400000).toISOString().slice(0, 10),
      proximo_pago: en3dias.toISOString().slice(0, 10),
    }] });
  });

  it('el usuario cuyas suscripciones no se pudieron mirar queda en el log, y el otro recibe su aviso', async () => {
    detectarSuscripciones.mockImplementation(fallaPara('u-a', { suscripciones_detectadas: [] }));
    await checks.checkRecordatorioSuscripciones();

    expect(idsLogueados('SUB_REMIND')).toContain('u-a');
    expect(detectarSuscripciones).toHaveBeenCalledTimes(2);
  });
});

describe('el resumen diario de Manos Libres', () => {
  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-23T21:05'));
    tablas.usuarios = [PRO_A, PRO_B];
  });

  it('el resumen que no se pudo armar queda en el log, y el otro usuario recibe el suyo', async () => {
    // Es el único cron donde el silencio contradice algo que la persona PIDIÓ: Manos Libres
    // es opt-in explícito y su usuario espera el resumen todas las noches.
    generarResumenDiario.mockImplementation(fallaPara('u-a', 'resumen del día'));
    await checks.checkResumenDiarioManosLibres();

    expect(idsLogueados('RESUMEN_DIARIO')).toContain('u-a');
    expect(notificados()).toEqual(['u-b']);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Un rechazo que NO es un `Error`. El `catch` silencioso viejo era incapaz de fallar;
// uno que loguea `e.message` a secas tira `TypeError` DENTRO del catch, la excepción
// se escapa del `for`, la traga el catch externo por la misma vía, y se saltan todos
// los que faltaban. El cron sale con `count: 0`: el peor caso causado por el manejo
// del peor caso. Lo midió la revisión adversarial de este commit.
//
// Va por SITIO y no por la forma del helper: revertir `msgErr(e)` a `e.message` en uno solo de
// los sitios de abajo tiene que morir, y con un caso único sobrevivirían los otros.
//
// **Alcance honesto, medido:** `msgErr` se aplicó a los 41 `catch` de `cron/checks.js`, y esta
// tabla cubre NUEVE — los siete de este ítem más los dos loops de PLAN, que son los caros
// (premium que no baja, trial que no cae al muro). Los ~32 restantes reciben la misma defensa
// sin caso propio: revertirlos de a uno pasa la suite. No es deuda de este commit —el estado
// previo de esos sitios era exactamente `e.message`— pero está medido y escrito.
// ───────────────────────────────────────────────────────────────────────────────
describe('un rechazo que no es un Error no se lleva puesto el loop', () => {
  const espacios = () => {
    tablas.shared_spaces = [{ id: 'sp-1', name: 'Depa' }, { id: 'sp-2', name: 'Viaje' }];
    tablas.space_members = [
      { space_id: 'sp-1', user_id: 'u-a', usuarios: { whatsapp: '51900000001', nombre: 'Ana', recordatorios_activos: true } },
      { space_id: 'sp-1', user_id: 'u-b', usuarios: { whatsapp: '51900000002', nombre: 'Beto', recordatorios_activos: true } },
      { space_id: 'sp-2', user_id: 'u-d', usuarios: { whatsapp: '51900000004', nombre: 'Dana', recordatorios_activos: true } },
    ];
    tablas.notificaciones = [];
    balanceEspacio.mockResolvedValue({ debts: [
      { from: 'u-a', to: 'u-c', toNombre: 'Caro', amount: 120 },
      { from: 'u-b', to: 'u-c', toNombre: 'Caro', amount: 90 },
      { from: 'u-d', to: 'u-c', toNombre: 'Caro', amount: 70 },
    ] });
  };
  const usuarios = () => { tablas.usuarios = [PRO_A, PRO_B]; };
  const conSuscripcion = () => {
    usuarios();
    tablas.notificaciones = [];
    const en3dias = new Date(Date.now() + 3 * 86400000);
    detectarSuscripciones.mockResolvedValue({ suscripciones_detectadas: [{
      nombre: 'Netflix', monto_detectado: 44.9, moneda: 'PEN', icono: '🎬', estado: 'activa',
      ultimo_pago: new Date(en3dias.getTime() - 30 * 86400000).toISOString().slice(0, 10),
      proximo_pago: en3dias.toISOString().slice(0, 10),
    }] });
  };

  /** `[nombre, hora Lima, fixture, romper(), cron, tag, quién NO puede perderse]` */
  const SITIOS = [
    ['el cálculo del score', '2026-08-23T06:05', usuarios,
      () => upsertScore.mockImplementation(async (id) => { if (id === 'u-a') throw null; }),
      'checkCalcularNetoScore', 'SCORE', () => expect(upsertScore).toHaveBeenCalledTimes(2)],

    ['el score semanal', '2026-08-23T10:05', usuarios,
      () => obtenerTendenciaScore.mockImplementation(async (id) => { if (id === 'u-a') throw null; return { current: 70, diff: 2 }; }),
      'checkNotificacionScore', 'SCORE_NOTIF', () => expect(notificados()).toContain('u-b')],

    ['el check-in de planes', '2026-09-01T11:05', () => {
      usuarios();
      tablas.metas_ahorro = [
        { id: 'm-a', usuario_id: 'u-a', nombre: 'Cusco', completada: false, status: 'active', monto_objetivo: 1000, monto_actual: 100, fecha_limite: '2026-12-01', created_at: '2026-01-01' },
        { id: 'm-b', usuario_id: 'u-b', nombre: 'Laptop', completada: false, status: 'active', monto_objetivo: 2000, monto_actual: 500, fecha_limite: '2026-12-01', created_at: '2026-01-01' },
      ];
    },
    () => calcularRitmoAhorro.mockImplementation((m) => { if (m.usuario_id === 'u-a') throw null; return { enRitmo: true, montoMensual: 100 }; }),
    'checkCheckInPlanes', 'CHECKIN_PLANES', () => expect(notificados()).toContain('u-b')],

    ['el miembro de un espacio', '2026-08-21T18:05', espacios,
      () => notificar.mockImplementation(async (p) => { if (p.usuarioId === 'u-a') throw null; return { wa: { ok: true } }; }),
      'checkRecordatorioEspacios', 'ESPACIOS_REMIND', () => expect(notificados()).toContain('u-b')],

    ['el espacio entero', '2026-08-21T18:05', espacios,
      () => ownerEsPro.mockImplementation(async (id) => { if (id === 'sp-1') throw null; return true; }),
      'checkRecordatorioEspacios', 'ESPACIOS_REMIND', () => expect(notificados()).toContain('u-d')],

    ['el recordatorio de suscripciones', '2026-08-23T10:05', conSuscripcion,
      () => detectarSuscripciones.mockImplementation(async (id) => { if (id === 'u-a') throw null; return { suscripciones_detectadas: [] }; }),
      'checkRecordatorioSuscripciones', 'SUB_REMIND', () => expect(detectarSuscripciones).toHaveBeenCalledTimes(2)],

    ['el resumen diario', '2026-08-23T21:05', usuarios,
      () => generarResumenDiario.mockImplementation(async (u) => { if (u.id === 'u-a') throw null; return 'resumen'; }),
      'checkResumenDiarioManosLibres', 'RESUMEN_DIARIO', () => expect(notificados()).toContain('u-b')],

    // Los dos loops de PLAN. No son de este ítem —sus catches ya logueaban— pero el barrido de
    // `msgErr` los tocó, y acá saltarse a los que faltan no es un aviso menos: es un premium
    // vencido que sigue con acceso y un trial que no cae al muro. `revocarAccesoGmail` corre
    // ANTES del aviso en los dos, así que su rechazo se lleva el downgrade de los siguientes.
    ['el downgrade de premium vencido', '2026-08-23T03:05', () => {
      tablas.usuarios = [
        { ...PRO_A, premium_vence: '2026-08-01', estado_pago: 'pagado', cuenta_borrada_at: null, trial_estado: null },
        { ...PRO_B, premium_vence: '2026-08-01', estado_pago: 'pagado', cuenta_borrada_at: null, trial_estado: null },
      ];
    },
    () => revocarGmail.mockImplementation(async (id) => { if (id === 'u-a') throw null; return { revocadas: 0 }; }),
    'checkPremiumExpiry', 'EXPIRY', () => expect(revocarGmail).toHaveBeenCalledTimes(2)],

    ['la bajada al muro por trial vencido', '2026-08-23T03:05', () => {
      tablas.usuarios = [
        { ...PRO_A, trial_estado: 'activo', trial_vence: '2026-08-01', estado_pago: 'pagado', premium_desde: null, premium_vence: null },
        { ...PRO_B, trial_estado: 'activo', trial_vence: '2026-08-01', estado_pago: 'pagado', premium_desde: null, premium_vence: null },
      ];
      tablas.transacciones = [];
    },
    () => revocarGmail.mockImplementation(async (id) => { if (id === 'u-a') throw null; return { revocadas: 0 }; }),
    'checkTrialExpiry', 'TRIAL_EXPIRY', () => expect(revocarGmail).toHaveBeenCalledTimes(2)],
  ];

  for (const [nombre, hora, fixture, romper, cron, tag, sigue] of SITIOS) {
    it(nombre + ': loguea y sigue igual', async () => {
      vi.setSystemTime(enLima(hora));
      fixture();
      romper();
      await checks[cron]();
      // El log del sitio existe (el del catch EXTERNO no lleva id: si aparece ése, el loop
      // murió y este assert es lo que lo delata).
      expect(erroresConTag(tag).some((o) => o.usuarioId || o.userId || o.spaceId)).toBe(true);
      sigue();
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// La contraprueba del arreglo: ninguno de los ocho puede haberse vuelto un corte.
// ───────────────────────────────────────────────────────────────────────────────
describe('ningún catch se convirtió en un corte', () => {
  it('con el servicio caído para TODOS, cada cron recorre a todos igual', async () => {
    vi.setSystemTime(enLima('2026-08-23T06:05'));
    tablas.usuarios = [PRO_A, PRO_B, { ...PRO_A, id: 'u-c' }];
    upsertScore.mockRejectedValue(new Error('caído'));
    await checks.checkCalcularNetoScore();
    expect(upsertScore).toHaveBeenCalledTimes(3);
  });

  it('y el que se cae en el primer espacio no se lleva los demás', async () => {
    vi.setSystemTime(enLima('2026-08-21T18:05'));
    tablas.shared_spaces = [{ id: 'sp-1', name: 'Depa' }, { id: 'sp-2', name: 'Viaje' }, { id: 'sp-3', name: 'Casa' }];
    tablas.space_members = [];
    tablas.notificaciones = [];
    balanceEspacio.mockRejectedValue(new Error('caído'));
    await checks.checkRecordatorioEspacios();
    expect(balanceEspacio).toHaveBeenCalledTimes(3);
  });
});
