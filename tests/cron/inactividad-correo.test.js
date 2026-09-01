import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * `checkRecordatorioInactividadSemanal`: a QUIÉN le sale el correo y a quién no.
 *
 * El ítem que lo trajo apagó el nudge de inactividad por WhatsApp y campana (ver
 * `tests/cron/inactividad-apagada.test.js`) y lo reemplazó por esto. Lo que hay que proteger
 * NO es que el correo salga: es el **destinatario**. La lección medida el 01-sep-2026 es que
 * "los inactivos" no son una población sino cinco, y la más grande —35 personas— **nunca
 * registró nada**, así que el aviso les mentiría por construcción. Ése es el corte que este
 * archivo blinda, junto con los dos extremos de la ventana.
 *
 * Cada caso trae su CONTROL, y no es ceremonia: un cron que no mandara nunca pasaría todos los
 * negativos en verde. Por eso el elegible de 10 días aparece en casi todos los fixtures.
 *
 * Lo que este archivo NO cubre, dicho en vez de disfrazado: que la lápida de la migración 073
 * no reciba. Eso lo afirma `tests/cron/lapida-no-recibe.test.js` sobre la QUERY, que es donde
 * vive el corte; acá la base está mockeada y los filtros de PostgREST se aplican sobre el
 * fixture, así que un caso de lápida mediría el doble y no el cron.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/** Tablas cuya LECTURA falla, por nombre. */
let errores = {};
/**
 * Las columnas que pidió cada `select` sobre `usuarios`. **Sin esto el doble es ciego a un
 * select incompleto**: devuelve el fixture entero pase lo que pase, así que quitarle `email`
 * a la query deja la suite en verde y en producción el correo sale como `skipped_no_email`
 * para todo el mundo. Verificado por mutación. Es la misma red que `selectsUsuarios` en
 * `tests/cron/comprobante-solo-si-llego.test.js`, y la regla que la explica es "una fila
 * parcial no puede decidir" de `app/CLAUDE.md`.
 */
let selectsUsuarios = [];
/** Tablas cuya ESCRITURA falla. Separado, igual que en `lecturas-con-error.test.js`. */
let erroresEscritura = {};
/** Igual que `selectsUsuarios`, para la lectura de la última anotación. */
let selectsTransacciones = [];

const notificar = vi.fn();

function makeChain(table, op = 'select') {
  const filtros = [];
  let esConteo = false;
  let orden = null;
  let tope = null;
  const chain = {};
  for (const m of ['ilike']) chain[m] = () => chain;
  chain.order = (col, opts) => { orden = { col, asc: !opts || opts.ascending !== false }; return chain; };
  chain.limit = (n) => { tope = n; return chain; };
  const rango = (cmp) => (col, val) => {
    filtros.push((f) => f[col] !== null && f[col] !== undefined && cmp(f[col], val));
    return chain;
  };
  chain.gt = rango((a, b) => a > b);
  chain.gte = rango((a, b) => a >= b);
  chain.lt = rango((a, b) => a < b);
  chain.lte = rango((a, b) => a <= b);
  const noEsNull = (f, col) => f[col] !== null && f[col] !== undefined;
  chain.not = (col, op2, val) => {
    if (op2 === 'is' && val === null) filtros.push((f) => noEsNull(f, col));
    else if (op2 === 'eq') filtros.push((f) => noEsNull(f, col) && f[col] !== val);
    return chain;
  };
  chain.select = (cols, opts) => {
    if (table === 'usuarios' && op === 'select' && typeof cols === 'string') selectsUsuarios.push(cols);
    if (table === 'transacciones' && op === 'select' && typeof cols === 'string') selectsTransacciones.push(cols);
    if (opts && opts.count) esConteo = true;
    return chain;
  };
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => noEsNull(f, col) && f[col] !== val); return chain; };
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
    if (val === null) filtros.push((f) => f[col] === null || f[col] === undefined);
    return chain;
  };
  const resolver = () => {
    const err = (op === 'select' ? errores[table] : erroresEscritura[table]) || null;
    if (err) return { data: null, count: null, error: err };
    let filas = (tablas[table] || []).filter((f) => filtros.every((p) => p(f)));
    if (orden) {
      const { col, asc } = orden;
      filas = [...filas].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
    }
    if (tope !== null) filas = filas.slice(0, tope);
    return esConteo
      ? { data: null, count: filas.length, error: null }
      : { data: filas, count: filas.length, error: null };
  };
  chain.single = () => Promise.resolve((() => {
    const r = resolver();
    return r.error ? { data: null, error: r.error } : { data: (r.data || [])[0] || null, error: null };
  })());
  chain.maybeSingle = chain.single;
  chain.then = (resolve) => resolve(resolver());
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => ({
      ...makeChain(t),
      insert: () => makeChain(t, 'insert'),
      update: () => makeChain(t, 'update'),
      delete: () => makeChain(t, 'delete'),
    })),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }), META_ERR_FUERA_VENTANA: 131047 }],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn() }],
  ['lib/pro-payment.js', { solicitarComprobante: vi.fn(), esperaComprobante: vi.fn() }],
  ['gmail.js', { revocarAccesoGmail: vi.fn().mockResolvedValue({ revocadas: 0 }) }],
  ['services/summaries.js', {
    generarResumenMensual: vi.fn(), generarResumenSemanal: vi.fn(), generarResumenDiario: vi.fn(),
  }],
  ['services/recommendations.js', { verificarAlertasProactivas: vi.fn() }],
  ['services/debts.js', {
    obtenerDeudasProximasVencer: vi.fn().mockResolvedValue([]),
    obtenerDeudasParaResumenSemanal: vi.fn().mockResolvedValue([]),
  }],
  ['services/spending-alerts.js', { generarAlertasFugas: vi.fn(), generarMensajeFugas: vi.fn(), guardarAlertas: vi.fn() }],
  ['services/neto-score.js', { upsertScore: vi.fn(), obtenerTendenciaScore: vi.fn(), scoreLabel: () => 'bien' }],
  ['services/metas.js', { calcularRitmoAhorro: () => ({ enRitmo: true, montoMensual: 100 }) }],
  ['services/shared-spaces.js', { obtenerBalanceEspacio: vi.fn(), ownerEsPro: vi.fn() }],
  ['services/subscriptions/index.js', { detectarSuscripciones: vi.fn() }],
  ['services/survey-triggers.js', { checkSurveyTriggers: vi.fn() }],
]) {
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

const enLima = (iso) => new Date(iso + '-05:00');
/** Jueves 20-ago-2026, 10:05am Lima: el único momento en que este cron hace algo. */
const JUEVES_10AM = '2026-08-20T10:05:00';

const BASE = {
  onboarding_completado: true, cuenta_borrada_at: null, is_test_user: false,
  recordatorios_activos: true, email: 'x@example.com', whatsapp: '51900000001',
  // 14 de los 17 de la cohorte real están en `free`, o sea detrás del muro. El default del
  // fixture es ése y no `premium`: si el cron alguna vez gateara por plan sin declararlo,
  // el caso positivo se caería en vez de pasar por el camino cómodo.
  plan: 'free', trial_estado: 'vencido', nombre: 'María Quispe',
};
const usuario = (id, extra) => ({ id, ...BASE, ...extra });
/**
 * Una transacción ANOTADA en esa fecha de calendario de Lima.
 *
 * Dos cosas que el fixture tiene que reproducir del PostgREST real, porque el cron depende de
 * las dos:
 *
 *   · **`created_at` es lo que decide, no `fecha`.** La primera es cuándo se anotó; la segunda
 *     es la fecha que el usuario declaró para el gasto, y son distintas para 11 de los 102
 *     usuarios de producción. Por eso cada fila lleva las dos con valores DISTINTOS: un
 *     fixture donde coinciden no puede ver qué columna lee el cron.
 *   · **`created_at` es `timestamp without time zone` y viaja SIN marca de zona**, guardando
 *     UTC. Las 17:00Z son las 12:00 de Lima, así que el día de calendario coincide con el que
 *     se pide. Un fixture con `Z` al final ocultaría el bug de zona horaria que el helper del
 *     cron existe para evitar.
 */
const anotadoEl = (usuario_id, fechaLima, extra) => ({
  id: 't-' + usuario_id, usuario_id,
  created_at: fechaLima + 'T17:00:00',
  // Retro-fechada a propósito, y muy lejos: si el cron leyera `fecha`, TODOS los fixtures
  // caerían fuera del techo de 30 días y ni un caso positivo pasaría.
  fecha: '2026-01-15',
  ...extra,
});

/** A quién se le mandó, por id. */
const destinatarios = () => notificar.mock.calls.map((c) => c[0] && c[0].usuarioId);
const llamadaDe = (id) => notificar.mock.calls.map((c) => c[0]).find((a) => a && a.usuarioId === id);
const tagsLogueados = (nivel) => logMock[nivel].mock.calls.map((c) => c[0] && c[0].tag);

beforeEach(() => {
  tablas = {};
  errores = {};
  selectsUsuarios = [];
  selectsTransacciones = [];
  erroresEscritura = {};
  vi.clearAllMocks();
  notificar.mockResolvedValue({ wa: { ok: false, skipped: 'canal_no_declarado' }, inApp: true, email: { ok: true } });
});

// ───────────────────────────────────────────────────────────────────────────────
// 1. La cohorte. Es lo único que este cron decide, y las cinco poblaciones
//    conviven en el mismo fixture para que un filtro flojo se vea de inmediato.
// ───────────────────────────────────────────────────────────────────────────────
describe('el correo va a la cohorte de 7-30 días CON historial, y a nadie más', () => {
  /** Las cinco poblaciones del 01-sep-2026, una fila cada una. */
  const LAS_CINCO = () => {
    tablas.usuarios = [
      usuario('u-activo'),        // anotó anteayer
      usuario('u-elegible'),      // 10 días: ÉSTE
      usuario('u-borde-7'),       // exactamente 7 días: entra
      usuario('u-borde-30'),      // exactamente 30 días: entra
      usuario('u-reactivacion'),  // 45 días: NO (otra decisión)
      usuario('u-nunca'),         // sin transacciones: NO (es alta incompleta)
    ];
    tablas.transacciones = [
      anotadoEl('u-activo', '2026-08-18'),
      anotadoEl('u-elegible', '2026-08-10'),
      anotadoEl('u-borde-7', '2026-08-13'),
      anotadoEl('u-borde-30', '2026-07-21'),
      anotadoEl('u-reactivacion', '2026-07-06'),
    ];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];
  };

  it('los tres de la ventana reciben; el activo, el de 45 días y el que nunca anotó, no', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    LAS_CINCO();

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios().sort()).toEqual(['u-borde-30', 'u-borde-7', 'u-elegible']);
  });

  /**
   * El caso que da nombre al ítem. Los 35 que nunca registraron nada son el grupo MÁS GRANDE
   * de los cinco, y son los únicos a quienes el copy le miente por construcción: no dejaron
   * de anotar algo que nunca anotaron. Ya los trabaja `checkRecordatorioOnboarding`.
   *
   * Va aparte del caso de arriba a propósito: si mañana alguien "arregla" el filtro tratando
   * la ausencia de transacciones como infinitos días de inactividad, el conjunto de arriba
   * cambia y este caso dice EXACTAMENTE cuál era el que no debía entrar.
   */
  it('el que nunca registró nada no es un inactivo: es un alta incompleta', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-nunca'), usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios(), 'le llegó "dejaste de anotar" a alguien que nunca anotó').not.toContain('u-nunca');
    expect(destinatarios(), 'CONTROL: el cron sí mandó algo en esta corrida').toContain('u-elegible');

    // **Y sale por su propio corte —`ultimaTx.length === 0`— sin ruido en el log.** Sin esta
    // aserción el caso pasa igual con el corte borrado, porque más abajo hay dos redes que lo
    // atajarían: el `!ultimaFecha` (un `undefined` no se convierte a fecha) y el
    // `Number.isFinite`. Es `feedback_negativo_que_rechaza_por_otra_condicion`: un verde no es
    // cobertura hasta saber POR QUÉ rechaza. Las redes se quedan; lo que se fija acá es que
    // el que decide sea el corte, y las redes dejan log — así que su silencio lo distingue.
    const ruido = [...logMock.warn.mock.calls, ...logMock.error.mock.calls]
      .filter((c) => c[0] && c[0].userId === 'u-nunca');
    expect(ruido, 'el que nunca anotó cayó en la red de la fecha ilegible, no en su propio corte').toEqual([]);
  });

  it('la baja de recordatorios apaga también el correo', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-baja', { recordatorios_activos: false }), usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-baja', '2026-08-10'), anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    // El pie de cada correo promete que el enlace de baja apaga TODOS los canales. Si esta
    // aserción muere, el producto está incumpliendo una promesa escrita en el correo mismo.
    expect(destinatarios()).toEqual(['u-elegible']);
  });

  it('sin correo no hay a quién mandarle: la query lo excluye', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-sin-mail', { email: null }), usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-sin-mail', '2026-08-10'), anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios()).toEqual(['u-elegible']);
  });

  it('mide cuándo ANOTÓ, no la fecha que declaró para el gasto', async () => {
    // `transacciones.fecha` es la fecha del gasto y `created_at` es cuándo se registró. Son
    // distintas para 11 de los 102 usuarios de producción, y las dos direcciones hacen daño:
    // una carga de Excel o un correo bancario viejo baja `max(fecha)` sin que la persona haya
    // dejado de usar Neto, y un gasto con fecha FUTURA ("el 15 pago el alquiler", hay 1
    // usuario así hoy) da días negativos y la saca de la cohorte en silencio.
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-futura'), usuario('u-retro')];
    tablas.transacciones = [
      // Anotó ayer, pero programó un gasto para dentro de un mes: sigue activo, no recibe.
      anotadoEl('u-futura', '2026-08-19', { fecha: '2026-09-15' }),
      // Anotó hace 10 días un gasto de enero: es de la cohorte, sí recibe.
      anotadoEl('u-retro', '2026-08-10', { fecha: '2026-01-15' }),
    ];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios(), 'la fecha futura del gasto lo sacó de la cohorte, o la vieja lo metió').toEqual(['u-retro']);
    expect(llamadaDe('u-retro').mensaje, 'contó los días desde la fecha del gasto, no desde la anotación').toMatch(/hace 10 días/);
  });

  /**
   * La mutación que sobrevivió a todo lo demás: cambiar `.order('created_at')` por
   * `.order('fecha')`. Con un solo gasto por usuario el orden no cambia nada, así que hace
   * falta alguien con DOS, donde las dos columnas eligen filas distintas.
   *
   * El escenario es real: alguien que hoy carga un gasto viejo (un Excel, un correo bancario
   * que escaneó Gmail) y antes de eso no anotaba hace veinte días. Por `created_at` está
   * activo; por `fecha` parece inactivo hace veinte días y recibiría el correo.
   */
  it('con dos gastos, elige el más reciente por fecha de ANOTACIÓN', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-dos')];
    tablas.transacciones = [
      // Anotado hace 20 días, gasto de agosto: el que ganaría ordenando por `fecha`.
      anotadoEl('u-dos', '2026-07-31', { id: 't-viejo', fecha: '2026-08-05' }),
      // Anotado ayer, gasto de enero: el que gana de verdad. La persona está activa.
      anotadoEl('u-dos', '2026-08-19', { id: 't-nuevo', fecha: '2026-01-10' }),
    ];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios(), 'le dijo "dejaste de anotar" a alguien que anotó ayer').toEqual([]);

    // Y la query PIDE la columna que decide. El doble devuelve la fila entera mire lo que mire
    // el `select`, así que sin esto un `.select('fecha')` pasa la suite en verde y en
    // producción `created_at` llega `undefined` para todo el mundo.
    expect(selectsTransacciones.length, 'el cron no leyó transacciones').toBeGreaterThan(0);
    for (const cols of selectsTransacciones) expect(cols).toContain('created_at');
  });

  /**
   * **El único bug de este cron que producción NO puede ver.** `created_at` es
   * `timestamp without time zone` y PostgREST lo devuelve sin marca de zona, guardando UTC.
   * `new Date('2026-08-11T02:00:00')` lo interpreta como hora LOCAL: en Railway, que corre en
   * UTC, eso coincide con lo correcto **por accidente**, así que el bug es invisible ahí y sólo
   * aparece desde una máquina en otra zona — o el día que el runtime cambie de zona.
   *
   * Por eso este caso fija `process.env.TZ` a mano en vez de confiar en la del proceso: si
   * dependiera de ella, en CI (UTC) las dos interpretaciones darían lo mismo y el caso pasaría
   * sin discriminar nada. Es la clase `feedback_guards_que_no_ven` en su versión del ENTORNO.
   */
  it('la fecha de anotación se ancla a UTC, no a la zona del proceso', async () => {
    const tzPrevia = process.env.TZ;
    try {
      process.env.TZ = 'America/Lima';
      // 02:00 UTC del 11 son las 21:00 del 10 en Lima. Leído como hora local de Lima serían
      // las 02:00 del 11, o sea un día MÁS: es el único par donde las dos lecturas difieren.
      expect(checks.fechaLimaDeTimestamp('2026-08-11T02:00:00')).toBe('2026-08-10');
      // Con la marca de zona explícita da lo mismo: el helper no la duplica.
      expect(checks.fechaLimaDeTimestamp('2026-08-11T02:00:00Z')).toBe('2026-08-10');
      expect(checks.fechaLimaDeTimestamp('2026-08-11T02:00:00+00:00')).toBe('2026-08-10');
      // Y lo que no se puede interpretar devuelve null en vez de un `Invalid Date` que después
      // se propaga como "hace NaN días" hasta la bandeja de alguien.
      expect(checks.fechaLimaDeTimestamp(null)).toBe(null);
      expect(checks.fechaLimaDeTimestamp('no-es-una-fecha')).toBe(null);
    } finally {
      if (tzPrevia === undefined) delete process.env.TZ; else process.env.TZ = tzPrevia;
    }
  });

  it('una anotación sin fecha interpretable no produce un correo que diga "hace NaN días"', async () => {
    // `transacciones.created_at` es NULLABLE, y `.order()` de PostgREST pone los NULL PRIMERO
    // en descendente: sin este corte, una sola fila así haría que esa persona se leyera como
    // "nunca anotó" para siempre. La rama existe y se recorre; no es una defensa muerta.
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-null'), usuario('u-basura'), usuario('u-elegible')];
    tablas.transacciones = [
      { id: 't-null', usuario_id: 'u-null', created_at: null, fecha: '2026-08-10' },
      { id: 't-basura', usuario_id: 'u-basura', created_at: 'no-es-una-fecha', fecha: '2026-08-10' },
      anotadoEl('u-elegible', '2026-08-10'),
    ];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios()).toEqual(['u-elegible']);
    // Y deja rastro: sin el warn, "no se pudo leer la fecha" se ve igual que "no calificaba".
    const avisados = logMock.warn.mock.calls.map((c) => c[0] && c[0].userId);
    expect(avisados).toContain('u-null');
    expect(avisados).toContain('u-basura');
  });

  /**
   * La red de NaN, ejercitada por su única puerta alcanzable desde un test.
   *
   * `NaN < 7` y `NaN > 30` son los dos **false**, así que sin el `Number.isFinite` un valor no
   * numérico atraviesa los dos cortes de la cohorte y llega al cuerpo del correo: a una bandeja
   * real le aparecería "hace NaN días". La guarda estaba en la primera versión de este cron, se
   * cayó al cambiar de columna, y un comentario siguió afirmando que existía — lo encontró la
   * segunda revisión adversarial, sobre el ARREGLO y no sobre el código original.
   *
   * **Y la guarda es INALCANZABLE hoy, medido acá y no supuesto.** Las dos fechas salen de la
   * misma `toLocaleDateString('en-CA')`, así que o las dos son `YYYY-MM-DD` o ninguna; y si
   * ninguna lo es, la corrida muere ANTES del bucle, en el `new Date(hoy + 'T00:00:00-05:00')
   * .toISOString()` que arma `inicioHoy`. O sea que el `Number.isFinite` es un piso sin caso
   * vivo, igual que el de `checkResumenDeudasSemanal`, y se queda por lo mismo: cuesta tres
   * líneas y lo que evita —un correo que dice "hace NaN días"— no se puede desdecir.
   *
   * Lo que este caso SÍ fija es la garantía de verdad: con el formato de fecha roto **no sale
   * un solo correo** y queda un error con el tag del cron. Eso es lo observable, y afirmarlo
   * es mejor que afirmar la rama que se creía alcanzable.
   */
  it('un formato de fecha inesperado NO produce un correo que diga "hace NaN días"', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    // `hoyPeru()` sale de acá. Un Node compilado sin full-ICU devuelve `8/20/2026` para
    // `en-CA`, y `Date.parse('8/20/2026T00:00:00Z')` es NaN.
    const originalTLDS = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function () { return '8/20/2026'; };
    try {
      await checks.checkRecordatorioInactividadSemanal();
    } finally {
      Date.prototype.toLocaleDateString = originalTLDS;
    }

    expect(destinatarios(), 'salió un correo con "hace NaN días"').toEqual([]);
    const gritos = logMock.error.mock.calls.filter((c) => c[0] && c[0].tag === 'INACT_EMAIL');
    expect(gritos.length, 'la corrida se cayó entera sin dejar una línea').toBeGreaterThan(0);
  });

  it('un nombre vacío no produce "Hola ." en la bandeja de nadie', async () => {
    // Hay 1 usuario sin nombre en la cohorte real. Sin `trim()` antes del `split`, un nombre
    // de solo espacios daba un saludo con un punto suelto.
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [
      usuario('u-sin-nombre', { nombre: null }),
      usuario('u-espacios', { nombre: '   ' }),
      usuario('u-con-nombre', { nombre: '  Ana Lucía Torres ' }),
    ];
    tablas.transacciones = [
      anotadoEl('u-sin-nombre', '2026-08-10'),
      anotadoEl('u-espacios', '2026-08-10'),
      anotadoEl('u-con-nombre', '2026-08-10'),
    ];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    expect(llamadaDe('u-sin-nombre').mensaje).toMatch(/^Hola\. /);
    expect(llamadaDe('u-espacios').mensaje, 'un nombre de solo espacios saludó con un punto suelto').toMatch(/^Hola\. /);
    expect(llamadaDe('u-con-nombre').mensaje).toMatch(/^Hola Ana\. /);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 2. El aviso en sí: canal, destinatario del correo y CTA.
// ───────────────────────────────────────────────────────────────────────────────
describe('lo que se le manda al elegible', () => {
  const soloElegible = () => {
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];
  };

  it('declara el canal de correo con su `to` y su asunto, y reclama la fila in-app', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    soloElegible();

    await checks.checkRecordatorioInactividadSemanal();

    const aviso = llamadaDe('u-elegible');
    expect(aviso, 'el cron no llegó a notificar: el resto del caso no prueba nada').toBeTruthy();
    // El `to` lo pone el LLAMADOR: `notificarUsuario` no lee la base. Si el `select` pierde la
    // columna `email`, esto queda en null y el correo se convierte en `skipped_no_email`.
    expect(aviso.email).toMatchObject({ to: 'x@example.com' });
    expect(String(aviso.email.asunto).length, 'sin asunto no hay correo').toBeGreaterThan(10);
    // El claim: la fila in-app se escribe ANTES del correo porque el dedup del día lee justo
    // esa fila. Sin esto el marcador iría después y un insert fallido lo dejaría ciego.
    expect(aviso.claimInApp).toBe(true);

    // **Y la query tiene que PEDIR las columnas de las que depende ese aviso.** El doble
    // devuelve el fixture entero mire lo que mire el `select`, así que sin esta aserción una
    // query sin `email` pasa la suite completa en verde y en producción todo correo sale
    // `skipped_no_email`. Lo mismo `whatsapp`, que elige el CTA: sin ella el cuerpo le pediría
    // a un usuario web-only que escriba por un canal que no tiene.
    expect(selectsUsuarios.length, 'el cron no consultó usuarios: el resto no prueba nada').toBe(1);
    expect(selectsUsuarios[0]).toContain('email');
    expect(selectsUsuarios[0]).toContain('whatsapp');
    expect(selectsUsuarios[0], 'sin recordatorios_activos la baja no se puede respetar').toContain('recordatorios_activos');
    // `nombre` faltaba, y es la columna cuya pérdida el doble tapa POR COMPLETO: sin ella
    // todos los correos empiezan "Hola." en vez de "Hola María." y ni un test se entera.
    // Verificado por mutación: quitarla del select dejaba los 29 casos en verde.
    expect(selectsUsuarios[0], 'sin nombre, todos los correos saludan a nadie').toContain('nombre');
    // WhatsApp NO: este mismo aviso entregaba 4 de 190 por ahí. Es la razón del apagado.
    expect(aviso.canales).toBe('solo_in_app');
  });

  it('el CTA es el que este destinatario puede ejecutar: WhatsApp si tiene número, la app si no', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-con-wa'), usuario('u-web', { whatsapp: null })];
    tablas.transacciones = [anotadoEl('u-con-wa', '2026-08-10'), anotadoEl('u-web', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    // 14 de los 17 de la cohorte están en `free`, o sea detrás del muro. Anotar sigue siendo
    // gratis, así que el CTA tiene que ser anotar — y por el camino que la persona TIENE.
    expect(llamadaDe('u-con-wa').mensaje).toMatch(/escríbeme por WhatsApp/);
    expect(llamadaDe('u-web').mensaje, 'a un usuario sin número se le pidió escribir por WhatsApp')
      .not.toMatch(/WhatsApp/);
    // `/app/i` NO sirve acá: matchea DENTRO de "WhatsApp", así que el positivo lo cumplía
    // también la rama que este caso viene a separar. Se afirma el destino literal.
    expect(llamadaDe('u-web').mensaje).toMatch(/app.neto.pe/);

    // Y la promesa de tiempo va SOLO donde es cierta: 2 de los 3 sin número están en `free`,
    // y para ellos `/dashboard` es el Paywall, así que "cinco segundos" sería falso.
    expect(llamadaDe('u-con-wa').mensaje).toMatch(/cinco segundos/);
    expect(llamadaDe('u-web').mensaje, 'se le prometió un tiempo a quien puede toparse con el muro')
      .not.toMatch(/cinco segundos/);
  });

  it('el título NO lleva el conteo de días: era la forma que apilaba una fila por disparo', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    soloElegible();

    await checks.checkRecordatorioInactividadSemanal();

    const aviso = llamadaDe('u-elegible');
    // El aviso viejo metía el conteo en el `titulo`, así que cada disparo abría una fila nueva
    // (11 sin leer para un mismo usuario). El dedup de este cron compara por `titulo`: con un
    // número adentro dejaría de encontrar su propia marca, que es el mismo bug con otra cara.
    expect(aviso.titulo).not.toMatch(/\d/);
    // Los días SÍ van en el cuerpo, que es donde informan sin romper el dedup.
    expect(aviso.mensaje).toMatch(/hace 10 días/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 3. Las dos ventanas que impiden la ráfaga. Son distintas y fallan para lados
//    distintos: ver los comentarios del cron.
// ───────────────────────────────────────────────────────────────────────────────
describe('nadie recibe dos correos', () => {
  it('el dedup del día: con la fila de hoy ya escrita, no se manda de nuevo', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notification_deliveries = [];
    tablas.notificaciones = [{
      id: 'n-1', usuario_id: 'u-elegible', tipo: 'recordatorio',
      titulo: 'Retomemos donde lo dejaste', fecha: enLima('2026-08-20T10:00:00').toISOString(),
    }];

    await checks.checkRecordatorioInactividadSemanal();
    expect(destinatarios(), 'un redeploy dentro de la ventana de 15 min mandaría dos').toEqual([]);

    // CONTROL: la misma fila fechada AYER no bloquea (el dedup es del día, no de la historia).
    notificar.mockClear();
    tablas.notificaciones[0].fecha = enLima('2026-08-19T10:00:00').toISOString();
    await checks.checkRecordatorioInactividadSemanal();
    expect(destinatarios()).toEqual(['u-elegible']);
  });

  it('la fatiga de correo: a quien ya recibió un correo hace pocos días no se le manda otro', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    // El resumen de deudas del lunes: tres días atrás, dentro de la ventana de 5.
    tablas.notification_deliveries = [{
      id: 1, usuario_id: 'u-elegible', canal: 'email', estado: 'sent',
      created_at: enLima('2026-08-17T09:05:00').toISOString(),
    }];

    await checks.checkRecordatorioInactividadSemanal();
    expect(destinatarios(), 'segundo correo en pocos días sobre un dominio que empezó a enviar el 31-ago').toEqual([]);

    // CONTROL 1: el mismo correo, pero de hace nueve días, queda fuera de la ventana de 5.
    notificar.mockClear();
    tablas.notification_deliveries[0].created_at = enLima('2026-08-11T09:05:00').toISOString();
    await checks.checkRecordatorioInactividadSemanal();
    expect(destinatarios()).toEqual(['u-elegible']);

    // CONTROL 2: un WhatsApp reciente NO bloquea el correo. La ventana es del canal de correo,
    // que es el único cuya reputación se está construyendo; si esto muriera, la ventana estaría
    // cortando por "cualquier aviso" y la cohorte se quedaría casi sin destinatarios.
    notificar.mockClear();
    tablas.notification_deliveries = [{
      id: 2, usuario_id: 'u-elegible', canal: 'whatsapp', estado: 'sent',
      created_at: enLima('2026-08-19T20:05:00').toISOString(),
    }];
    await checks.checkRecordatorioInactividadSemanal();
    expect(destinatarios()).toEqual(['u-elegible']);
  });

  /**
   * **El borde que casi convierte este cron en quincenal.** La ventana de fatiga tiene que ser
   * MENOR que la cadencia: con las dos en 7 días, la fila `sent` que este mismo cron escribió
   * el jueves pasado —unos segundos DESPUÉS del inicio de aquel tick— cae dentro de la ventana
   * del jueves siguiente, y la cohorte recibe semana por medio de forma no determinista. Lo
   * encontró una revisión adversarial; el caso de arriba (3 días bloquea, 9 no) no lo veía
   * porque ninguno de los dos toca el borde.
   */
  it('el correo de la semana pasada NO bloquea el de esta semana', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    // Exactamente lo que dejaría la corrida del jueves pasado: unos segundos después del tick.
    tablas.notification_deliveries = [{
      id: 1, usuario_id: 'u-elegible', canal: 'email', estado: 'sent',
      created_at: enLima('2026-08-13T10:05:12').toISOString(),
    }];

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios(), 'el cron se auto-suprimió: la cohorte recibiría semana por medio').toEqual(['u-elegible']);
  });

  it('el resumen de deudas del lunes SÍ bloquea el jueves', async () => {
    // La otra mitad del borde: bajar la ventana para no auto-suprimirse no puede dejar de
    // cortar lo que vino a cortar. Lunes 9am → jueves 10am son 3 días.
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [{
      id: 1, usuario_id: 'u-elegible', canal: 'email', estado: 'sent',
      created_at: enLima('2026-08-17T09:05:00').toISOString(),
    }];

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios()).toEqual([]);
  });

  it('si la campana se escribe y el correo no sale, lo dice a nivel error', async () => {
    // `enviados` cuenta CLAIMS. Sin `RESEND_API_KEY`, sin `EMAIL_OPTOUT_SECRET` (el fail-closed
    // de `lib/email.js`), con el tope diario o con un 5xx de Resend, `inApp` sigue en true y el
    // log diría "enviados: N" describiendo N correos que no salieron. El correo es el ÚNICO
    // canal por el que este cron existe: que se caiga entero no puede leerse como una corrida
    // normal.
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];
    notificar.mockResolvedValue({
      wa: { ok: false, skipped: 'canal_no_declarado' }, inApp: true,
      email: { ok: false, skipped: 'sin_baja' },
    });

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios(), 'el fixture no llegó a notificar').toEqual(['u-elegible']);
    const gritos = logMock.error.mock.calls.filter((c) => c[0] && c[0].tag === 'INACT_EMAIL');
    expect(gritos.length, 'la campana salió para toda la cohorte y ni un correo, y nadie lo dijo').toBeGreaterThan(0);
    expect(JSON.stringify(gritos)).toMatch(/no salió un solo correo/);
  });

  it('CONTROL: con el correo saliendo, no grita', async () => {
    // Sin esta mitad, un cron que gritara SIEMPRE pasaría el caso de arriba.
    vi.setSystemTime(enLima(JUEVES_10AM));
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios()).toEqual(['u-elegible']);
    expect(logMock.error.mock.calls.filter((c) => c[0] && c[0].tag === 'INACT_EMAIL')).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 4. El gate horario. Un cron semanal que corriera cualquier día manda siete veces.
// ───────────────────────────────────────────────────────────────────────────────
describe('corre un solo tick por semana', () => {
  const listo = () => {
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];
  };

  it.each([
    ['miércoles 10am', '2026-08-19T10:05:00'],
    ['viernes 10am', '2026-08-21T10:05:00'],
    ['jueves 9am', '2026-08-20T09:05:00'],
    ['jueves 11am', '2026-08-20T11:05:00'],
    ['jueves 10:20am (fuera de la ventana de 15 min)', '2026-08-20T10:20:00'],
  ])('no hace nada el %s', async (_desc, cuando) => {
    vi.setSystemTime(enLima(cuando));
    listo();
    await checks.checkRecordatorioInactividadSemanal();
    expect(destinatarios()).toEqual([]);
  });

  it('CONTROL: el jueves 10:05am sí manda (si no, los cinco de arriba pasan por nada)', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    listo();
    await checks.checkRecordatorioInactividadSemanal();
    expect(destinatarios()).toEqual(['u-elegible']);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 5. Qué pasa cuando una lectura se cae. Las cuatro fallan para lados distintos
//    y cada elección está argumentada en el cron: acá se fija cuál es cuál.
// ───────────────────────────────────────────────────────────────────────────────
describe('las lecturas caídas dejan rastro, y cada una falla para el lado que declara', () => {
  const listo = () => {
    tablas.usuarios = [usuario('u-elegible')];
    tablas.transacciones = [anotadoEl('u-elegible', '2026-08-10')];
    tablas.notificaciones = [];
    tablas.notification_deliveries = [];
  };

  it('la población caída: no se manda nada y queda el log (no se lee como "no había nadie")', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    listo();
    errores.usuarios = { message: 'connection reset' };

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios()).toEqual([]);
    expect(tagsLogueados('error')).toContain('INACT_EMAIL');
  });

  it('la última transacción caída: se salta a ESE usuario, con su userId en el log', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    listo();
    errores.transacciones = { message: 'timeout' };

    await checks.checkRecordatorioInactividadSemanal();

    expect(destinatarios(), 'sin fecha de última anotación no se puede afirmar "hace N días"').toEqual([]);
    const mio = logMock.error.mock.calls.filter((c) => c[0].tag === 'INACT_EMAIL' && c[0].userId === 'u-elegible');
    expect(mio.length, 'el fallo por usuario no dejó el userId: se ve igual que "no calificaba"').toBeGreaterThan(0);
  });

  it('el dedup del día caído falla ABIERTO: se manda igual, con warn', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    listo();
    errores.notificaciones = { message: 'connection reset' };

    await checks.checkRecordatorioInactividadSemanal();

    // Corre una vez por semana: fallar cerrado no posterga el aviso, lo pierde siete días. Lo
    // que se arriesga a cambio es un duplicado, y sólo con un segundo tick en la misma ventana.
    expect(destinatarios()).toEqual(['u-elegible']);
    expect(tagsLogueados('warn')).toContain('INACT_EMAIL');
  });

  it('la fatiga de correo caída falla CERRADO: no se manda, con warn', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    listo();
    errores.notification_deliveries = { message: 'connection reset' };

    await checks.checkRecordatorioInactividadSemanal();

    // La asimetría contra el caso de arriba es del daño, no del estilo: acá lo que se previene
    // es un correo de más sobre un dominio que empezó a enviar el 31-ago-2026, y lo que cuesta
    // callarse es un aviso NO urgente que vuelve el jueves siguiente.
    expect(destinatarios()).toEqual([]);
    expect(tagsLogueados('warn')).toContain('INACT_EMAIL');
  });

  it('sin claim de la campana no se manda el correo, y queda dicho', async () => {
    vi.setSystemTime(enLima(JUEVES_10AM));
    listo();
    // Lo que devuelve `notificarUsuario` cuando el insert de `notificaciones` falla: nunca
    // lanza, así que el `try` del cron no se entera. Sin mirar el resultado, el modo de falla
    // más caro —perder el aviso de la semana— sólo dejaba un warn con tag NOTIF.
    notificar.mockResolvedValue({ wa: { ok: false, skipped: 'claim_in_app_fallo' }, inApp: false, email: { ok: false } });

    await checks.checkRecordatorioInactividadSemanal();

    const mio = logMock.error.mock.calls.filter((c) => c[0].tag === 'INACT_EMAIL' && c[0].userId === 'u-elegible');
    expect(mio.length, 'el claim fallido no dejó rastro').toBeGreaterThan(0);
  });
});
