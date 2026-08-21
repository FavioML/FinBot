import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * Qué hace cada cron cuando la lectura FALLA.
 *
 * `cron/checks.js` tenía 31 lecturas con la forma `const { data } = await supabase...`, que
 * descartan el `{ error }`. supabase-js no lanza: devuelve `{ data: null, error }`. Sin leer
 * ese error, una caída de Supabase se lee exactamente igual que "no hay a quién avisar" — el
 * cron corre, no falla, no loguea, y no deja fila en `errores`.
 *
 * No está medido que esta clase haya apagado un cron en producción. Lo que sí está medido es
 * el gemelo: `checkRecordatorioOnboarding` estuvo **12 días sin destinatarios** por un filtro
 * que envejeció (`onboarding_completado`), y nadie lo notó por el mismo motivo — un cron sin
 * población y un cron con la base caída producen el mismo silencio. Ese cron ya leía su error
 * desde entonces; sus vecinos no, y entre ellos estaban los que alimentan `checkActivacionDia2`
 * y `checkSurveyTriggers`.
 *
 * Este archivo NO prueba que las lecturas nombren `error` — eso lo hace el guard estático de
 * `lecturas-leen-el-error.test.js`, y un guard de forma no demuestra que la forma sirva.
 * Acá se corre el cron de verdad con la tabla en error y se afirma el EFECTO: a quién se
 * notificó, a quién no, y qué quedó en el log.
 *
 * Las cuatro afirmaciones que este archivo protege, en orden de importancia:
 *
 *  1. **Un dedup que falla no puede reenviar.** Son 5 y fallan ABIERTO: `data` en null
 *     significa "todavía no le avisamos". `checkPremiumExpiry` y `checkTrialExpiry` corren
 *     cada hora con gate >=8am, así que una Supabase intermitente se vuelve hasta 16 avisos
 *     idénticos en un día. Es B6 con otra causa.
 *  2. **Una población que falla tiene que dejar rastro.** El comportamiento ya era el
 *     correcto (no mandar); lo que faltaba era la línea que distingue "no había nadie" de
 *     "no se pudo preguntar".
 *  3. **Una decisión por usuario también.** Ahí ni siquiera cambia el destino — el `continue`
 *     era el mismo — así que el log es lo ÚNICO observable, y por eso lo único que se puede
 *     afirmar.
 *  4. **Y las accesorias NO pueden cortar.** Un `if (error) return` puesto donde no va apaga
 *     un cron entero por un hipo. `describe('las accesorias no cortan')` es la contraprueba:
 *     si alguien "completa el trabajo" agregando el corte que falta, esos tests mueren.
 *
 * **La primera versión de este archivo dejaba 12 mutaciones vivas**, y las tres causas valen
 * más que la lista:
 *
 *   · Los dedups de espacios y suscripciones **nunca se alcanzaban**, porque sus servicios
 *     (`obtenerBalanceEspacio`, `detectarSuscripciones`) estaban mockeados devolviendo vacío
 *     y el cron cortaba antes. Un mock que devuelve nada es un test que no llega.
 *   · El assert de tag comparaba subcadenas sobre el JSON entero, así que `'EXPIRY'` daba por
 *     bueno un log de `'EXPIRY_WARN'` y cuatro logs distintos se tapaban entre sí.
 *   · Las decisiones por-usuario no tenían caso, porque su comportamiento no cambia. Lo que
 *     hay que mirar ahí es justamente lo que faltaba.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/** Tablas en error, por nombre: `{ usuarios: { message: 'boom' } }`. */
let errores = {};
/** Toda escritura, para poder afirmar que un downgrade se aplicó (o no). */
let escrituras = [];

const notificar = vi.fn();
const notificarAdmin = vi.fn();

/**
 * El mock filtra de verdad sobre `eq`/`neq`/`in`/`or`/`is` **y sobre los rangos**, y eso no es
 * adorno: es la lección de `nudge-primer-gasto.test.js`, cuya primera versión tenía la cadena
 * entera en no-op y pasaba **en verde con el bug reintroducido**.
 *
 * Acá la trampa apareció en los rangos. Con `lt` en no-op, la query de expirados
 * (`.lt('premium_vence', hoy)`) capturaba al MISMO usuario que el aviso de 3 días y
 * `notificar` salía dos veces, así que los controles fallaban por un motivo que no tenía nada
 * que ver con el caso.
 *
 * `head: true` devuelve `{ count }` y no `{ data }`, como el PostgREST real: los dos
 * call-sites de conteo del archivo (`checkActivacionDia2` y el mensaje del muro) leen `count`,
 * y un mock que devolviera `data` los dejaría en `undefined` por el motivo equivocado.
 */
function makeChain(table) {
  const filtros = [];
  let esConteo = false;
  const chain = {};
  for (const m of ['ilike']) chain[m] = () => chain;
  /**
   * `order` + `limit(1)` implementan "la mas reciente" de verdad. Con los dos en no-op el
   * mock devolvia la PRIMERA fila del fixture, asi que una mutacion que borre el `.order` o
   * invierta `ascending` salia verde — y las dos lecturas que dependen de eso
   * (`ultimaTx` en la inactividad, `ultimoTurno` en la activacion) deciden por FECHA.
   */
  let orden = null;
  let tope = null;
  chain.order = (col, opts) => { orden = { col, asc: !opts || opts.ascending !== false }; return chain; };
  chain.limit = (n) => { tope = n; return chain; };
  /**
   * `null` se excluye a mano porque JS lo coerciona a 0 y `null < '2026-08-20'` da true,
   * mientras que en SQL `NULL < x` es NULL, o sea que la fila NO entra. Sin esta línea, un
   * usuario en trial (`premium_vence` null) caería en la query de expirados de Pro.
   */
  const rango = (cmp) => (col, val) => {
    filtros.push((f) => f[col] !== null && f[col] !== undefined && cmp(f[col], val));
    return chain;
  };
  chain.gt = rango((a, b) => a > b);
  chain.gte = rango((a, b) => a >= b);
  chain.lt = rango((a, b) => a < b);
  chain.lte = rango((a, b) => a <= b);
  /**
   * `neq` y `not(...,'eq',...)` **descartan las filas con NULL**, como SQL: `col <> v` con
   * `col` en NULL da NULL, o sea que la fila no entra. Es la misma trampa que este repo ya
   * pago dos veces (`SIN_TRIAL_ACTIVO` en el propio `checks.js`, y el `coalesce(is_test_user,
   * false)` de la migracion 057), y afecta a dos queries reales del archivo:
   * `.neq('is_test_user', true)` y `.not('status', 'eq', 'abandoned')`, las dos sobre columnas
   * nullables. Un mock que las tratara con la semantica de JS seria mas benevolo que Postgres.
   */
  const noEsNull = (f, col) => f[col] !== null && f[col] !== undefined;
  /** Sólo las formas que usa el archivo: `.not('col', 'is', null)` y `.not('col', 'eq', v)`. */
  chain.not = (col, op, val) => {
    if (op === 'is' && val === null) filtros.push((f) => noEsNull(f, col));
    else if (op === 'eq') filtros.push((f) => noEsNull(f, col) && f[col] !== val);
    return chain;
  };
  chain.select = (_cols, opts) => { if (opts && opts.count) esConteo = true; return chain; };
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => noEsNull(f, col) && f[col] !== val); return chain; };
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
    if (val === null) filtros.push((f) => f[col] === null || f[col] === undefined);
    return chain;
  };
  chain.or = (expr) => {
    filtros.push((f) => String(expr).split(',').some((cond) => {
      const [col, op, val] = cond.split('.');
      if (op === 'is' && val === 'null') return f[col] === null || f[col] === undefined;
      if (op === 'eq') return String(f[col]) === val;
      if (op === 'neq') return f[col] !== undefined && f[col] !== null && String(f[col]) !== val;
      return false;
    }));
    return chain;
  };
  const resolver = () => {
    if (errores[table]) return { data: null, count: null, error: errores[table] };
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
  chain.single = () => Promise.resolve(
    errores[table]
      ? { data: null, error: errores[table] }
      : { data: (resolver().data || [])[0] || null, error: null },
  );
  chain.maybeSingle = chain.single;
  chain.then = (resolve) => resolve(resolver());
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => {
      const base = makeChain(t);
      return {
        ...base,
        update: (patch) => { escrituras.push({ tabla: t, patch }); return makeChain(t); },
        insert: () => makeChain(t),
        delete: () => makeChain(t),
      };
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

/**
 * Servicios que los crons llaman después de decidir a quién avisar.
 *
 * Los tres que se reconfiguran por test están declarados aparte: un mock que devuelve vacío
 * hace que el cron corte ANTES de llegar al dedup, y eso dejó dos mutaciones vivas sin que
 * ningún test se pusiera rojo.
 */
const balanceEspacio = vi.fn();
const ownerEsPro = vi.fn();
const detectarSuscripciones = vi.fn();

const serviciosMock = [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }) }],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin }],
  ['lib/pro-payment.js', { solicitarComprobante: vi.fn(), esperaComprobante: vi.fn() }],
  ['gmail.js', { revocarAccesoGmail: vi.fn().mockResolvedValue({ revocadas: 0 }) }],
  ['services/summaries.js', {
    generarResumenMensual: vi.fn().mockResolvedValue('resumen'),
    generarResumenSemanal: vi.fn().mockResolvedValue('resumen'),
    generarResumenDiario: vi.fn().mockResolvedValue('resumen del día'),
  }],
  ['services/recommendations.js', { verificarAlertasProactivas: vi.fn().mockResolvedValue('alerta') }],
  ['services/debts.js', { obtenerDeudasProximasVencer: vi.fn().mockResolvedValue([]) }],
  ['services/spending-alerts.js', {
    generarAlertasFugas: vi.fn().mockResolvedValue([{ x: 1 }]),
    generarMensajeFugas: vi.fn().mockResolvedValue('fugas'),
    guardarAlertas: vi.fn(),
  }],
  ['services/neto-score.js', {
    upsertScore: vi.fn(),
    obtenerTendenciaScore: vi.fn().mockResolvedValue({ current: 70, diff: 2 }),
    scoreLabel: () => 'bien',
  }],
  ['services/metas.js', { calcularRitmoAhorro: () => ({ enRitmo: true, montoMensual: 100 }) }],
  ['services/shared-spaces.js', { obtenerBalanceEspacio: balanceEspacio, ownerEsPro }],
  ['services/subscriptions/index.js', { detectarSuscripciones }],
  ['services/survey-triggers.js', { checkSurveyTriggers: vi.fn() }],
];
for (const [rel, exports] of serviciosMock) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// `notificarUsuario` se reemplaza preservando CANALES: el cron lo desestructura al cargar.
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
 * Los tags de los `log.error` emitidos, como lista.
 *
 * **Comparar sobre esta lista y no sobre el JSON del log es la corrección que mató cuatro
 * mutaciones.** `expect(JSON.stringify(calls)).toContain('EXPIRY')` da verde con un log de
 * `'EXPIRY_WARN'`, así que quitarle el log a la query de expirados no rompía nada: el del
 * aviso de 3 días lo cubría por subcadena. Un tag se compara por igualdad o no se compara.
 */
const tagsLogueados = () => logMock.error.mock.calls.map((c) => c[0] && c[0].tag);

beforeEach(() => {
  tablas = {};
  errores = {};
  escrituras = [];
  notificar.mockClear();
  notificar.mockResolvedValue({ wa: { ok: true, msgId: 'wamid.1' }, inApp: true });
  notificarAdmin.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
  balanceEspacio.mockResolvedValue({ debts: [] });
  ownerEsPro.mockResolvedValue(true);
  detectarSuscripciones.mockResolvedValue({ suscripciones_detectadas: [] });
});

/** El destinatario tipo: Pro, alta cerrada, quiere recordatorios. */
const PRO = {
  id: 'u-pro', whatsapp: '51900000001', nombre: 'María Quispe',
  plan: 'premium', onboarding_completado: true, recordatorios_activos: true,
  supabase_auth_id: 'auth-1', manos_libres: true,
  cuenta_borrada_at: null, trial_estado: null, is_test_user: false,
};

// ───────────────────────────────────────────────────────────────────────────────
// 1. Los dedups que fallan ABIERTO. Son los únicos que CAMBIAN de comportamiento.
// ───────────────────────────────────────────────────────────────────────────────
describe('un dedup que no se puede leer no reenvía el aviso', () => {
  /**
   * El fixture es deliberadamente un usuario **a quien YA se le avisó hoy**: la fila de
   * `notificaciones` existe. Con la tabla sana el cron hace `continue` y no manda nada.
   * Con la tabla en error, la versión vieja no veía esa fila y **volvía a mandar** — el
   * mismo aviso, en cada corrida horaria desde las 8am.
   *
   * Los dos controles separan las hipótesis: si el mock devolviera `[]` en vez de error, el
   * test pasaría por "no había fila" en vez de por "no se pudo leer".
   */
  it('premium vence en 3 días: la fila de dedup existe pero la tabla está caída', async () => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    // premium_vence exactamente en 3 días, que es lo que selecciona la query.
    tablas.usuarios = [{ ...PRO, premium_vence: '2026-08-23' }];
    // `fecha` no es relleno: el dedup filtra `.gte('fecha', inicioHoy)`, así que una fila sin
    // esa columna queda fuera de la query y el Control A falla — que es como se descubrió.
    const filaDedup = {
      id: 'n1', usuario_id: 'u-pro', tipo: 'recordatorio',
      titulo: 'Plan Pro vence en 3 días', fecha: new Date().toISOString(),
    };
    tablas.notificaciones = [filaDedup];

    // Control A: con la tabla sana no reenvía (o sea, el fixture del dedup sí pega).
    await checks.checkPremiumExpiry();
    expect(notificar).not.toHaveBeenCalled();

    // Control B: sin la fila de dedup SÍ se le manda, o sea que el usuario era alcanzable
    // y el "no notificó" del caso real no viene de que el fixture quede fuera de la query.
    tablas.notificaciones = [];
    await checks.checkPremiumExpiry();
    expect(notificar).toHaveBeenCalledTimes(1);

    // El caso: la fila está, pero la tabla no responde.
    notificar.mockClear();
    tablas.notificaciones = [filaDedup];
    errores.notificaciones = { message: 'connection reset' };
    await checks.checkPremiumExpiry();

    expect(notificar, 'un error de lectura reenvió el aviso de vencimiento').not.toHaveBeenCalled();
    expect(tagsLogueados()).toContain('EXPIRY_WARN');
  });

  it('premium vence hoy: mismo dedup, mismo cron horario', async () => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    tablas.usuarios = [{ ...PRO, premium_vence: '2026-08-20' }];

    // Control: sin error, este usuario recibe el aviso de "vence hoy".
    await checks.checkPremiumExpiry();
    expect(notificar).toHaveBeenCalledTimes(1);

    notificar.mockClear();
    errores.notificaciones = { message: 'timeout' };
    await checks.checkPremiumExpiry();
    expect(notificar).not.toHaveBeenCalled();
    expect(tagsLogueados()).toContain('EXPIRY_HOY');
  });

  it('fin de prueba (d11/d14): el aviso que el trial existe para mandar tampoco se duplica', async () => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    // trial_vence hoy → cae en el aviso d14; y `trial_vence < hoy` es false, así que no baja al muro.
    tablas.usuarios = [{ ...PRO, trial_estado: 'activo', trial_vence: '2026-08-20', premium_vence: null }];

    await checks.checkTrialExpiry();
    expect(notificar, 'el fixture no llega al aviso d14: el caso de abajo no probaría nada').toHaveBeenCalledTimes(1);

    notificar.mockClear();
    errores.notificaciones = { message: 'connection reset' };
    await checks.checkTrialExpiry();
    expect(notificar, 'un error de lectura reenvió el aviso de fin de prueba').not.toHaveBeenCalled();
    // `via` distingue este log del que emite la query de vencidos, que comparte el tag.
    expect(logMock.error.mock.calls.some((c) => c[0].tag === 'TRIAL_EXPIRY' && c[0].via === 'd14')).toBe(true);
  });

  /**
   * El cuarto dedup, semanal. **La primera versión de este archivo no lo alcanzaba**:
   * `obtenerBalanceEspacio` estaba mockeado devolviendo `{ debts: [] }`, así que el cron
   * cortaba antes y la mutación "quitarle el corte al dedup" sobrevivía en verde. Un mock que
   * devuelve vacío es un test que no llega.
   */
  it('recordatorio de espacios: la anti-fatiga de 10 días caída no reenvía el balance', async () => {
    vi.setSystemTime(enLima('2026-08-21T18:00:00'));   // viernes 6pm
    tablas.shared_spaces = [{ id: 'sp1', name: 'Depa' }];
    tablas.space_members = [{
      space_id: 'sp1', user_id: 'u-pro',
      usuarios: { whatsapp: '51900000001', nombre: 'María Quispe', recordatorios_activos: true },
    }];
    balanceEspacio.mockResolvedValue({ debts: [{ from: 'u-pro', to: 'u2', toNombre: 'Ana Torres', amount: 120 }] });

    // Control: sin fila de dedup, el balance sale.
    await checks.checkRecordatorioEspacios();
    expect(notificar, 'el fixture no llega al dedup del espacio').toHaveBeenCalledTimes(1);

    notificar.mockClear();
    errores.notificaciones = { message: 'connection reset' };
    await checks.checkRecordatorioEspacios();
    expect(notificar, 'la anti-fatiga caída reenvió el balance').not.toHaveBeenCalled();
    expect(tagsLogueados()).toContain('ESPACIOS_REMIND');
  });

  /**
   * El quinto, y el de intercambio más parejo: este aviso sale una vez por ciclo (sólo si
   * faltan EXACTAMENTE 3 días para el cobro), así que fallar cerrado cuesta el aviso entero
   * hasta el mes que viene. Va cerrado igual porque el error que lo dispara es una Supabase
   * caída, y en ese estado el envío tampoco iba a funcionar.
   */
  it('recordatorio de suscripción: el dedup por ciclo caído no duplica el aviso de cobro', async () => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    tablas.usuarios = [{ ...PRO }];
    // último pago el 23-jul → próximo cobro el 23-ago → faltan exactamente 3 días.
    detectarSuscripciones.mockResolvedValue({
      suscripciones_detectadas: [{
        estado: 'activa', ultimo_pago: '2026-07-23', nombre: 'Netflix',
        monto_detectado: 44.9, moneda: 'PEN', icono: '🎬',
      }],
    });

    await checks.checkRecordatorioSuscripciones();
    expect(notificar, 'el fixture no llega al dedup de la suscripción').toHaveBeenCalledTimes(1);

    notificar.mockClear();
    errores.notificaciones = { message: 'connection reset' };
    await checks.checkRecordatorioSuscripciones();
    expect(notificar, 'el dedup caído duplicó el aviso de cobro').not.toHaveBeenCalled();
    expect(tagsLogueados()).toContain('SUB_REMIND');
  });

  /**
   * El sexto de la clase, y el único que no es un dedup: la anti-fatiga de las 8pm. Falla
   * abierto igual, pero **al revés de lo que uno espera**: sin leer el error, `recentEvents`
   * queda en null, `recibioMensajeReciente` en false, y el cron manda igual. O sea que una
   * caída de Supabase no silencia el recordatorio de inactividad — lo DISPARA, contra la
   * población que la anti-fatiga existe para proteger.
   */
  it('inactividad a las 8pm: la anti-fatiga caída no autoriza el envío', async () => {
    vi.setSystemTime(enLima('2026-08-20T20:00:00'));
    tablas.usuarios = [{ ...PRO, created_at: '2026-07-01T00:00:00Z' }];
    tablas.transacciones = [{ usuario_id: 'u-pro', fecha: '2026-08-10' }];  // 10 días sin anotar
    tablas.survey_events = [];

    // Control: con survey_events sana, este usuario SÍ recibe el recordatorio.
    await checks.checkRecordatorioDiario();
    expect(notificar, 'el fixture no alcanza al cron: el resto del caso no probaría nada').toHaveBeenCalledTimes(1);

    notificar.mockClear();
    errores.survey_events = { message: 'connection reset' };
    await checks.checkRecordatorioDiario();
    expect(notificar, 'la anti-fatiga caída dejó salir el mensaje').not.toHaveBeenCalled();
    expect(tagsLogueados()).toContain('INACTIVITY');
  });

  /**
   * No es sobre errores, y va acá igual: es lo que le da sentido al `.order(...).limit(1)`
   * que el mock ahora implementa de verdad.
   *
   * Una revisión adversarial señaló que `order` y `limit` estaban en no-op, así que el mock
   * devolvía la PRIMERA fila del fixture y una mutación que borrara el `.order` —o invirtiera
   * `ascending`— salía verde. Con una sola transacción por usuario eso no se nota nunca; hace
   * falta un fixture donde la respuesta correcta y la incorrecta DIFIERAN. Acá difieren: la
   * más reciente es de ayer (no corresponde recordatorio) y hay una de hace meses.
   */
  it('el recordatorio mira la última transacción, no una cualquiera', async () => {
    vi.setSystemTime(enLima('2026-08-20T20:00:00'));
    tablas.usuarios = [{ ...PRO, created_at: '2026-07-01T00:00:00Z' }];
    tablas.transacciones = [
      { usuario_id: 'u-pro', fecha: '2026-05-02' },   // vieja: leerla daría 110 días sin anotar
      { usuario_id: 'u-pro', fecha: '2026-08-19' },   // la real: ayer
    ];
    tablas.survey_events = [];

    await checks.checkRecordatorioDiario();
    expect(notificar, 'le recordó a alguien que anotó ayer: se leyó la transacción vieja').not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 2. Las poblaciones. El comportamiento ya era el correcto; faltaba el rastro.
// ───────────────────────────────────────────────────────────────────────────────
describe('una población que no se puede leer deja rastro', () => {
  /**
   * Cada fila es un cron, su gate horario, la tabla cuya caída lo deja sin destinatarios, y
   * el tag EXACTO que tiene que aparecer. El tag es parte del caso: un log con el tag de otro
   * cron manda a mirar el lugar equivocado, y es el error más fácil de cometer copiando la
   * línea de al lado.
   *
   * **`checkPremiumExpiry` aparece tres veces y a horas distintas, a propósito.** Tiene tres
   * queries de población con tres tags, y las dos primeras viven detrás de `getHours() >= 8`.
   * A las 3am sólo corre la de expirados, que es la única forma de exigir su log por separado:
   * con una sola fila a las 10am, quitarle el log a esa query no rompía nada porque los otros
   * dos seguían ahí. Lo mismo con `checkTrialExpiry`, cuya rama de vencidos tampoco tiene gate.
   */
  const CASOS = [
    ['checkResumenMensual',            '2026-09-01T09:00:00', 'usuarios',      'MENSUAL'],
    ['checkResumenSemanal',            '2026-08-17T08:00:00', 'usuarios',      'SEMANAL'],
    ['checkRecordatorioDiario',        '2026-08-20T20:00:00', 'usuarios',      'INACTIVITY'],
    ['checkAlertasProactivas',         '2026-08-19T10:00:00', 'usuarios',      'ALERTA_PROACTIVA'],
    ['checkRecordatorioOnboarding',    '2026-08-20T10:00:00', 'usuarios',      'ONBOARDING_REMINDER'],
    ['checkActivacionDia2',            '2026-08-20T10:00:00', 'usuarios',      'ACTIVACION_DIA2'],
    ['checkDetectorFugas',             '2026-08-19T11:00:00', 'usuarios',      'FUGAS'],
    ['checkCalcularNetoScore',         '2026-08-20T06:00:00', 'usuarios',      'SCORE'],
    ['checkNotificacionScore',         '2026-08-16T10:00:00', 'usuarios',      'SCORE_NOTIF'],
    ['checkCheckInPlanes',             '2026-08-15T11:00:00', 'usuarios',      'CHECKIN_PLANES'],
    ['checkRecordatorioEspacios',      '2026-08-21T18:00:00', 'shared_spaces', 'ESPACIOS_REMIND'],
    ['checkRecordatoriosCostos',       '2026-08-20T09:00:00', 'admin_costs',   'COSTOS_REMIND'],
    ['checkSurveyConversions',         '2026-08-20T07:00:00', 'survey_events', 'SURVEY_CONV'],
    ['checkRecordatorioSuscripciones', '2026-08-20T10:00:00', 'usuarios',      'SUB_REMIND'],
    ['checkResumenDiarioManosLibres',  '2026-08-20T21:00:00', 'usuarios',      'RESUMEN_DIARIO'],
    ['checkGmailHuerfanos',            '2026-08-20T10:00:00', 'gmail_cuentas', 'GMAIL_HUERFANOS'],
    // Las tres de checkPremiumExpiry, separadas por hora para que cada log se exija solo.
    ['checkPremiumExpiry',             '2026-08-20T03:00:00', 'usuarios',      'EXPIRY'],
    ['checkPremiumExpiry',             '2026-08-20T10:00:00', 'usuarios',      'EXPIRY_WARN'],
    ['checkPremiumExpiry',             '2026-08-20T10:00:00', 'usuarios',      'EXPIRY_HOY'],
    // La rama de vencidos de checkTrialExpiry, sin gate horario.
    ['checkTrialExpiry',               '2026-08-20T03:00:00', 'usuarios',      'TRIAL_EXPIRY'],
  ];

  it.each(CASOS)('%s @ %s loguea cuando %s no se puede leer (tag %s)', async (nombre, cuando, tabla, tag) => {
    vi.setSystemTime(enLima(cuando));
    errores[tabla] = { message: 'boom-' + tabla };

    await checks[nombre]();

    expect(notificar, nombre + ' notificó a alguien con la tabla caída').not.toHaveBeenCalled();
    expect(notificarAdmin, nombre + ' escribió al admin con la tabla caída').not.toHaveBeenCalled();
    // Igualdad, no subcadena: 'EXPIRY' está contenido en 'EXPIRY_WARN'.
    expect(tagsLogueados(), nombre + ' no dejó un log con el tag ' + tag).toContain(tag);
    const conEseTag = logMock.error.mock.calls.filter((c) => c[0].tag === tag);
    expect(JSON.stringify(conEseTag), nombre + ' logueó sin el mensaje del error').toContain('boom-' + tabla);
  });

  /**
   * El aviso de fin de prueba tiene su propio caso porque comparte el tag `TRIAL_EXPIRY` con
   * la rama de vencidos: lo que lo distingue es el campo `via`, que sólo pone ese log. Sin
   * esto, quitarle el log a la query de los avisos no rompía nada.
   */
  it('el aviso de fin de prueba loguea con su `via` cuando no puede leer a quién avisar', async () => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    errores.usuarios = { message: 'boom-trial' };
    await checks.checkTrialExpiry();
    const vias = logMock.error.mock.calls.filter((c) => c[0].tag === 'TRIAL_EXPIRY').map((c) => c[0].via);
    expect(vias, 'los dos avisos (d11 y d14) tienen que dejar su propia línea').toEqual(
      expect.arrayContaining(['d11', 'd14']),
    );
  });

  /**
   * Los casos de arriba pueden pasar por vacuidad: si el gate horario no deja arrancar al
   * cron, tampoco notifica y tampoco loguea. La expectativa de tag ya lo cubre — este test la
   * aísla para que un fallo diga "el gate horario del caso está mal" y no "el cron no loguea".
   */
  it.each(CASOS)('%s @ %s SÍ corre en ese horario (si no, el caso de arriba miente)', async (nombre, cuando, tabla) => {
    vi.setSystemTime(enLima(cuando));
    errores[tabla] = { message: 'centinela' };
    await checks[nombre]();
    expect(logMock.error, nombre + ' no llegó a leer nada: revisá el gate horario del caso').toHaveBeenCalled();
  });

  /**
   * Y el espejo: fuera de su horario, un cron no lee nada. Sin esto, alguien podría "arreglar"
   * un caso rojo aflojando el gate en vez de corrigiendo la hora del fixture.
   */
  it('fuera del gate horario ningún cron llega a leer (3am Lima)', async () => {
    vi.setSystemTime(enLima('2026-08-20T03:00:00'));
    for (const t of ['usuarios', 'shared_spaces', 'admin_costs', 'survey_events']) {
      errores[t] = { message: 'no deberia leerse' };
    }
    // checkPremiumExpiry / checkTrialExpiry / checkGmailHuerfanos quedan fuera a propósito:
    // sus downgrades y barridos corren a toda hora, y arriba se los mide justamente a las 3am.
    for (const n of ['checkResumenMensual', 'checkResumenSemanal', 'checkRecordatorioDiario',
      'checkAlertasProactivas', 'checkRecordatorioOnboarding', 'checkActivacionDia2',
      'checkDetectorFugas', 'checkCalcularNetoScore', 'checkNotificacionScore', 'checkCheckInPlanes',
      'checkRecordatorioEspacios', 'checkRecordatoriosCostos', 'checkSurveyConversions',
      'checkRecordatorioSuscripciones', 'checkResumenDiarioManosLibres']) {
      await checks[n]();
    }
    expect(logMock.error, 'un cron leyó fuera de su ventana horaria').not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 3. Las decisiones por usuario. El destino no cambia; el rastro sí.
// ───────────────────────────────────────────────────────────────────────────────
describe('una decisión por usuario que falla deja el userId en el log', () => {
  /**
   * Estas cuatro ya fallaban cerrado **por accidente**: el `data` en null caía en el mismo
   * `continue` que "este usuario no califica". El destino era el correcto, así que la mutación
   * no cambia a quién se notifica — y por eso la primera versión de este archivo las dejaba
   * vivas a las tres que existían entonces. Lo único observable es el log, que es exactamente
   * lo que faltaba: sin él, un fallo sistemático se ve idéntico a "nadie calificaba hoy".
   *
   * Tres usan `throw` en vez de `log` + `continue`, porque el `catch` del loop ya loguea con
   * el `userId`. Por eso el assert mira el `userId`: es lo que distingue un fallo por usuario
   * de un fallo de población.
   */
  const CASOS = [
    ['la última transacción (inactividad 8pm)', 'checkRecordatorioDiario', '2026-08-20T20:00:00', 'transacciones', 'INACTIVITY', 'u-pro'],
    ['el conteo de gastos (activación día 2)', 'checkActivacionDia2', '2026-08-20T10:00:00', 'transacciones', 'ACTIVACION_DIA2', 'u-web'],
    ['el último turno del chat (activación día 2)', 'checkActivacionDia2', '2026-08-20T10:00:00', 'conversaciones', 'ACTIVACION_DIA2', 'u-web'],
    ['las metas activas (check-in de planes)', 'checkCheckInPlanes', '2026-08-15T11:00:00', 'metas_ahorro', 'CHECKIN_PLANES', 'u-pro'],
  ];

  it.each(CASOS)('%s', async (_desc, cron, cuando, tabla, tag, userId) => {
    vi.setSystemTime(enLima(cuando));
    tablas.usuarios = [
      { ...PRO, created_at: '2026-07-01T00:00:00Z' },
      // El de activación: sin cuenta web, con WhatsApp, dado de alta hace ~36h.
      {
        ...PRO, id: 'u-web', whatsapp: '51900000002', supabase_auth_id: null,
        activacion_nudge_at: null, manos_libres: false,
        created_at: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
      },
    ];
    tablas.transacciones = [{ usuario_id: 'u-pro', fecha: '2026-08-01' }, { usuario_id: 'u-web', fecha: '2026-08-19' }];
    tablas.conversaciones = [{ usuario_id: 'u-web', rol: 'usuario', created_at: new Date().toISOString() }];
    tablas.metas_ahorro = [{ id: 'm1', usuario_id: 'u-pro', nombre: 'Viaje', completada: false, monto_objetivo: 1000, monto_actual: 100 }];
    tablas.survey_events = [];

    errores[tabla] = { message: 'boom-' + tabla };
    await checks[cron]();

    const mio = logMock.error.mock.calls.filter((c) => c[0].tag === tag && c[0].userId === userId);
    expect(mio.length, 'ningún log con tag ' + tag + ' y userId ' + userId).toBeGreaterThan(0);
    expect(JSON.stringify(mio)).toContain('boom-' + tabla);
  });

  /**
   * El mismo caso pero por ESPACIO, no por usuario, y por eso va aparte: la lectura de
   * `space_members` no decide sobre una persona sino sobre un espacio entero, así que el log
   * lleva `spaceId`.
   *
   * **Esta sobrevivió a la primera prueba por mutación**, y el motivo es el que hace que la
   * clase entera sea difícil de ver: sin el corte, el `(members || [])` de abajo convierte el
   * error en un loop vacío. Nadie recibe nada, igual que con el corte. El comportamiento es
   * idéntico byte a byte — lo único que cambia es que quede escrito, y por eso el log es lo
   * único que se puede afirmar.
   */
  it('los miembros del espacio: el error deja el spaceId en el log', async () => {
    vi.setSystemTime(enLima('2026-08-21T18:00:00'));
    tablas.shared_spaces = [{ id: 'sp1', name: 'Depa' }];
    balanceEspacio.mockResolvedValue({ debts: [{ from: 'u-pro', to: 'u2', toNombre: 'Ana Torres', amount: 120 }] });
    errores.space_members = { message: 'boom-space_members' };

    await checks.checkRecordatorioEspacios();

    const mio = logMock.error.mock.calls.filter((c) => c[0].tag === 'ESPACIOS_REMIND' && c[0].spaceId === 'sp1');
    expect(mio.length, 'ningún log con tag ESPACIOS_REMIND y spaceId sp1').toBeGreaterThan(0);
    expect(JSON.stringify(mio)).toContain('boom-space_members');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 4. Lo que NO se tocó. Un corte de más apaga un cron por un hipo.
// ───────────────────────────────────────────────────────────────────────────────
describe('las accesorias no cortan', () => {
  /**
   * `mensajeMuro(usuario, conteoTx)` usa el conteo sólo para elegir entre "*7 gastos*" y
   * "tus gastos". Y cuando este conteo se lee, el downgrade **ya se aplicó**: cortar acá
   * dejaría a alguien recién bajado al muro sin ninguna explicación de por qué perdió el
   * dashboard. Si alguien "completa" el arreglo agregando un `continue`, este test muere.
   */
  it('el trial vencido avisa igual aunque no se pueda contar sus gastos', async () => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    tablas.usuarios = [{ ...PRO, trial_estado: 'activo', trial_vence: '2026-08-10', premium_vence: null, estado_pago: null }];
    errores.transacciones = { message: 'timeout en el conteo' };

    await checks.checkTrialExpiry();

    const aviso = notificar.mock.calls.find((c) => c[0].tipo === 'trial_vencido');
    expect(aviso, 'el aviso del muro se perdió por no poder contar gastos').toBeDefined();
    // El copy degrada al genérico, que es justamente lo tolerable.
    expect(aviso[0].mensaje).toContain('tus gastos');
    expect(escrituras.some((e) => e.tabla === 'usuarios' && e.patch.plan === 'free'), 'el downgrade no se aplicó').toBe(true);
    // Se degradó, no se silenció: queda un warn, no un error.
    expect(logMock.warn).toHaveBeenCalled();
  });

  /**
   * La otra accesoria: el conteo por evento de `checkSurveyConversions`. Corre hasta
   * cientos de veces por corrida con un `catch` silencioso deliberado, así que un log por
   * fallo sería ruido. Se cuenta y se reporta una línea agregada — que es lo que distingue
   * "nadie convirtió" de "no se pudo preguntar", la confusión que dejaba el panel admin
   * graficando 0% estructural.
   */
  it('las conversiones que no se pueden evaluar se reportan agregadas, no una por una', async () => {
    vi.setSystemTime(enLima('2026-08-20T07:00:00'));
    const haceDosDias = new Date(Date.now() - 2 * 86400000).toISOString();
    tablas.survey_events = [
      { id: 'e1', user_id: 'u-pro', sent_at: haceDosDias, event_type: 'inactivity_reminder', conversion_within_24h: false },
      { id: 'e2', user_id: 'u-pro', sent_at: haceDosDias, event_type: 'reminder_d3', conversion_within_24h: false },
      { id: 'e3', user_id: 'u-pro', sent_at: haceDosDias, event_type: 'reminder_d7', conversion_within_24h: false },
    ];
    errores.transacciones = { message: 'timeout' };

    await checks.checkSurveyConversions();

    // Una sola línea para los tres eventos, no tres.
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0][0]).toMatchObject({ tag: 'SURVEY_CONV', fallidos: 3, evaluados: 3 });
  });
});
