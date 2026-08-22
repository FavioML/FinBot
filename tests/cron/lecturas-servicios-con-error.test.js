import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * Qué hace cada SERVICIO cuando la lectura falla.
 *
 * El gemelo de `lecturas-con-error.test.js`, para el otro lado del perímetro. El ítem 1 cerró
 * las 31 lecturas de `cron/checks.js`, y su propia revisión dejó dicho que eso no alcanzaba
 * por construcción: los crons no hacen todas sus queries en `checks.js`, las delegan a nueve
 * servicios. Una lectura muda que vive en un servicio produce exactamente el mismo silencio,
 * con la diferencia de que el guard del ítem 1 no la veía.
 *
 * **Alcance honesto.** No está medido que esta clase le haya mandado un mensaje equivocado a
 * nadie. Lo medido es la forma, y que el gemelo —`checkRecordatorioOnboarding`— estuvo 12 días
 * sin destinatarios sin dejar rastro. Lo que sigue afirma qué PASA hoy con la tabla caída, no
 * qué pasó en producción.
 *
 * **Las cuatro clases, que no comparten arreglo.** Es la taxonomía del ítem 1 y dos de sus
 * ramas son opuestas, así que aplicarla mal es peor que no aplicarla:
 *
 *  1. **Falla ABIERTO.** El error no silencia el envío: lo DISPARA. Son las nueve de
 *     `survey-triggers.js` — anti-fatiga, blackout, los dos conteos y los cuatro dedups. Un
 *     `data` en null significa "todavía no le avisamos" y el trigger sigue de largo.
 *  2. **Población.** El comportamiento correcto ya era no mandar; lo que faltaba era
 *     distinguir "hoy no calificaba nadie" de "no se pudo preguntar".
 *  3. **Decisión de contenido.** Las cinco de `summaries.js`: un `[]` silencioso no produce un
 *     resumen que falta, produce un resumen con números equivocados. Mandar mal un número de
 *     plata es peor que no mandar.
 *  4. **Accesoria.** Un null degrada, no decide. Acá el arreglo es el OPUESTO: sólo log.
 *     `describe('las accesorias no cortan')` es la contraprueba — si alguien "completa el
 *     trabajo" agregándoles el corte que les falta a las otras tres, esos tests mueren.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/**
 * Inyector de fallos. Recibe `(tabla, filtros, op, patch)` y devuelve el error o null.
 *
 * El `op` (`select` / `update` / `insert` / …) separa la mitad que LEE de la que ESCRIBE
 * cuando las dos tocan la misma tabla y la misma fila: es lo único que permite tumbar el
 * `update` de la cuota mensual sin tumbar también la lectura de la meta, que es justo el caso
 * que decide si esa escritura es accesoria o no.
 *
 * **Recibe los filtros y no sólo el nombre de la tabla, y sin eso la mitad de este archivo no
 * se podría escribir.** Los cuatro dedups de `survey-triggers` y su anti-fatiga leen la MISMA
 * tabla (`survey_events`): con un injector por tabla, tirar `survey_events` rompe las dos
 * lecturas a la vez y no hay forma de saber cuál de los dos arreglos mató el envío — o sea que
 * una mutación en cualquiera de los dos sobreviviría tapada por el otro. Acá el dedup se
 * distingue porque filtra por `event_type` y la anti-fatiga por `channel`, y los gastos de los
 * ingresos porque filtran `tipo` con valores distintos.
 */
let fallar = () => null;
/** Toda escritura, para poder afirmar que un ledger se aplicó (o no). */
let escrituras = [];

function makeChain(table, op = 'select', patch = null) {
  const filtros = [];
  /** `{ col, val }` de cada `eq`, que es lo que mira el injector. */
  const vistos = [];
  let esConteo = false;
  let orden = null;
  let tope = null;
  const chain = {};
  /**
   * `ilike` FILTRA de verdad. Estuvo en no-op y eso hacia pasar los controles por el motivo
   * equivocado: con la tabla sembrada con una deuda de 'Pedro', `abonarDeuda(u, 'Juan')` la
   * encontraba igual, o sea que ninguno de los controles de `debts` probaba nada sobre el
   * filtro que decide DE QUIEN es la deuda que se abona. Lo encontro una revision adversarial
   * corriendo el mock contra un fixture que no coincide.
   */
  chain.ilike = (col, patron) => {
    vistos.push({ col, val: patron });
    // El `%` de PostgREST se traduce a `.*` DESPUÉS de escapar el resto: `%` no es un
    // metacarácter de regex, así que sobrevive al escape intacto.
    const escapado = String(patron).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escapado.split('%').join('.*') + '$', 'i');
    filtros.push((f) => typeof f[col] === 'string' && re.test(f[col]));
    return chain;
  };
  chain.order = (col, opts) => { orden = { col, asc: !opts || opts.ascending !== false }; return chain; };
  chain.limit = (n) => { tope = n; return chain; };
  const rango = (cmp) => (col, val) => {
    vistos.push({ col, val });
    filtros.push((f) => f[col] !== null && f[col] !== undefined && cmp(f[col], val));
    return chain;
  };
  chain.gt = rango((a, b) => a > b);
  chain.gte = rango((a, b) => a >= b);
  chain.lt = rango((a, b) => a < b);
  chain.lte = rango((a, b) => a <= b);
  const noEsNull = (f, col) => f[col] !== null && f[col] !== undefined;
  chain.not = (col, op, val) => {
    if (op === 'is' && val === null) filtros.push((f) => noEsNull(f, col));
    else if (op === 'eq') filtros.push((f) => noEsNull(f, col) && f[col] !== val);
    return chain;
  };
  chain.select = (_cols, opts) => { if (opts && opts.count) esConteo = true; return chain; };
  chain.eq = (col, val) => { vistos.push({ col, val }); filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => noEsNull(f, col) && f[col] !== val); return chain; };
  chain.in = (col, arr) => { vistos.push({ col, val: arr }); filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
    vistos.push({ col, val });
    if (val === null) filtros.push((f) => f[col] === null || f[col] === undefined);
    return chain;
  };
  const resolver = () => {
    const err = fallar(table, vistos, op, patch);
    if (err) return { data: null, count: null, error: err };
    // Un `insert(...).select().single()` devuelve la fila ESCRITA, no lo que ya habia en la
    // tabla. Sin esto, `crearEspacio` recibe null y revienta con un TypeError antes de llegar
    // al guard que se quiere medir — o sea que el test fallaria por el motivo equivocado.
    // Vale igual para el `upsert`: `guardarPresupuesto` hace `upsert(...).select().single()` y
    // sin esta rama recibia PGRST116 —la fila no estaba en `tablas`— o sea que su control salia
    // rojo por una carencia del mock y no por el codigo.
    if ((op === 'insert' || op === 'upsert') && patch) return { data: [{ id: 'nuevo-' + table, ...patch }], count: 1, error: null };
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
  /**
   * Con CERO filas, `.single()` devuelve **`PGRST116`**, no `{ data: null, error: null }`.
   *
   * El mock devolvía lo segundo, y eso tapaba una clasificación al revés: un
   * `if (error) throw error` sobre un `.single()` por id convierte "esa fila no existe" en
   * excepción y deja MUERTO el `if (!fila)` de la línea siguiente. Ningún test podía verlo,
   * porque el mock nunca producía el caso. Lo encontró una revisión adversarial leyendo el
   * mock contra los gotchas de PostgREST del propio proyecto.
   */
  chain.single = () => Promise.resolve(
    (() => {
      const r = resolver();
      if (r.error) return { data: null, error: r.error };
      const fila = (r.data || [])[0];
      if (!fila) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      return { data: fila, error: null };
    })(),
  );
  /**
   * **`maybeSingle` NO es `single`, y el mock las tenia aliaseadas.** Con cero filas,
   * `maybeSingle` devuelve `{ data: null, error: null }`; el que devuelve `PGRST116` es
   * `single`. El alias hacia que cualquier caso escrito sobre un `maybeSingle` vacio
   * ejercitara una rama de error que la produccion nunca produce — y `shared-spaces.js:176`
   * tiene escrito en un comentario justamente por que eligio `maybeSingle`.
   */
  chain.maybeSingle = () => Promise.resolve(
    (() => {
      const r = resolver();
      if (r.error) return { data: null, error: r.error };
      return { data: (r.data || [])[0] || null, error: null };
    })(),
  );
  chain.then = (resolve) => resolve(resolver());
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => {
      const base = makeChain(t);
      // El segundo argumento se REGISTRA. `retroaplicarRegla` hace
      // `update(updates, { count: 'exact' })`, y sin esto el mock devolvia `count` igual —o sea
      // que su control pasaba aunque el codigo dejara de pedirlo—. Lo noto la revision
      // adversarial. Se guarda en la escritura para poder afirmarlo.
      const registrar = (op) => (patch, opts) => {
        escrituras.push({ tabla: t, op, patch, opts: opts || null });
        return makeChain(t, op, patch);
      };
      return { ...base, update: registrar('update'), insert: registrar('insert'), delete: registrar('delete'), upsert: registrar('upsert') };
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const notificar = vi.fn();

/**
 * `services/categories` carga el cliente de OpenAI al requerirse, y `detectarCategoriaIA` lo
 * llama. Se stubea acá y no con `vi.mock` por el mismo motivo que `lib/db`: estos servicios son
 * CommonJS y desestructuran en el `require`, así que hay que sembrar el cache antes de cargarlos.
 */
const openaiMock = { openai: { chat: { completions: { create: vi.fn() } } } };

for (const [rel, exports] of [['lib/db.js', dbMock], ['lib/logger.js', logMock], ['lib/ai.js', openaiMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
// `notificarUsuario` se reemplaza preservando CANALES: los servicios lo desestructuran al cargar.
const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};

const surveys = require('../../services/survey-triggers');
const debts = require('../../services/debts');
const summaries = require('../../services/summaries');
const metas = require('../../services/metas');
const espacios = require('../../services/shared-spaces');
const transactions = require('../../services/transactions');
const budget = require('../../services/budget');
const categories = require('../../services/categories');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

/** Un instante real cuyo horario en Lima (UTC-5) es el que el gate del cron exige. */
const enLima = (iso) => new Date(iso + '-05:00');
const BOOM = { message: 'boom', code: '08006' };
/** Los tags de los `log.error` emitidos, como lista. Un tag se compara por igualdad. */
const tagsLogueados = () => logMock.error.mock.calls.map((c) => c[0] && c[0].tag);

beforeEach(() => {
  tablas = {};
  escrituras = [];
  fallar = () => null;
  notificar.mockClear();
  notificar.mockResolvedValue({ wa: { ok: true, msgId: 'wamid.1' }, inApp: true });
  logMock.error.mockClear();
  logMock.warn.mockClear();
  // `info` y el cliente de OpenAI tambien: un `mockResolvedValue` que sobrevive a su caso hace
  // pasar al siguiente por una razon que ese caso no puso. Lo noto la revision adversarial.
  logMock.info.mockClear();
  openaiMock.openai.chat.completions.create.mockReset();
});

/** Filtró por esta columna (con este valor, si se pide). */
const filtro = (vistos, col, val) =>
  vistos.some((v) => v.col === col && (val === undefined || v.val === val));

/**
 * El destinatario tipo de `checkSurveyTriggers`: alta cerrada, quiere recordatorios, tiene
 * WhatsApp, y lleva **3 días exactos** desde el registro — o sea que califica para
 * `reminder_d3` si y sólo si no tiene transacciones.
 */
const HOY = '2026-08-20T10:05:00';
const USUARIO = {
  id: 'u-1', whatsapp: '51900000001', nombre: 'María Quispe',
  created_at: '2026-08-17T10:00:00.000Z',
  recordatorios_activos: true, onboarding_completado: true,
  onboarding_paso: null, supabase_auth_id: 'auth-1', cuenta_borrada_at: null,
};

/** Una transacción de hoy: convierte a `USUARIO` en alguien que SÍ anota. */
const TX = { id: 't-1', usuario_id: 'u-1', fecha: '2026-08-20', tipo: 'gasto', monto: 20 };

// ───────────────────────────────────────────────────────────────────────────────
// 1. Falla ABIERTO. Son las únicas que CAMBIAN de comportamiento: sin el arreglo,
//    el error no silencia el mensaje, lo dispara.
// ───────────────────────────────────────────────────────────────────────────────
describe('en survey-triggers, una lectura caída no autoriza el envío', () => {
  beforeEach(() => {
    vi.setSystemTime(enLima(HOY));
    tablas.usuarios = [USUARIO];
  });

  /**
   * El control. Sin él, todos los casos de abajo podrían estar pasando porque el cron no manda
   * nada nunca — por el gate horario, por el filtro de población, por un fixture mal armado.
   * Este test es el que dice que el camino al envío existe y se recorre.
   */
  it('control: sin fallos y sin transacciones, el recordatorio del día 3 SÍ sale', async () => {
    await surveys.checkSurveyTriggers();
    expect(notificar).toHaveBeenCalledTimes(1);
    expect(notificar.mock.calls[0][0].tipo).toBe('survey_reminder_d3');
  });

  /** El otro control: con transacciones, el trigger del día 3 no aplica y no sale nada. */
  it('control: con transacciones anotadas no sale ningún recordatorio de primer gasto', async () => {
    tablas.transacciones = [TX];
    await surveys.checkSurveyTriggers();
    expect(notificar).not.toHaveBeenCalled();
  });

  it('la anti-fatiga de 7 días caída no autoriza el envío', async () => {
    // Sólo la anti-fatiga: es la lectura de `survey_events` que filtra por `channel`.
    fallar = (t, v) => (t === 'survey_events' && filtro(v, 'channel') ? BOOM : null);
    await surveys.checkSurveyTriggers();
    expect(notificar, 'una caída de la base disparó el mensaje en vez de silenciarlo').not.toHaveBeenCalled();
    expect(tagsLogueados()).toContain('SURVEY_TRIG');
  });

  it('el dedup del propio recordatorio caído no lo reenvía', async () => {
    // Sólo el dedup por trigger: filtra por `event_type`. La anti-fatiga sigue sana, así que
    // este caso aísla el segundo arreglo del primero.
    fallar = (t, v) => (t === 'survey_events' && filtro(v, 'event_type') ? BOOM : null);
    await surveys.checkSurveyTriggers();
    expect(notificar, 'sin poder leer si ya se envió, se envió de nuevo').not.toHaveBeenCalled();
  });

  it('el blackout de 24h caído no encuesta a quien acaba de tener un error', async () => {
    fallar = (t) => (t === 'errores' ? BOOM : null);
    await surveys.checkSurveyTriggers();
    expect(notificar).not.toHaveBeenCalled();
  });

  /**
   * La segunda mitad del blackout, y necesita su propio caso: `tuvoErrorReciente` hace DOS
   * lecturas y la de `nlp_errors` sólo se alcanza cuando la de `errores` devuelve vacío. Con
   * un único caso sobre `errores`, quitarle el `if` a la segunda sobrevivía en verde.
   */
  it('y la mitad de nlp_errors del blackout tampoco', async () => {
    fallar = (t) => (t === 'nlp_errors' ? BOOM : null);
    await surveys.checkSurveyTriggers();
    expect(notificar).not.toHaveBeenCalled();
  });

  /**
   * El conteo de transacciones es el que hace el daño más vistoso: `count || 0` convierte a
   * alguien que anota todos los días en alguien que nunca anotó nada, y le manda el copy de
   * primer gasto. El control de arriba ("con transacciones no sale nada") es lo que le da
   * sentido a este: la fila existe, lo que falla es poder contarla.
   */
  it('el conteo de transacciones caído no manda copy de primer gasto a quien sí anota', async () => {
    tablas.transacciones = [TX];
    fallar = (t) => (t === 'transacciones' ? BOOM : null);
    await surveys.checkSurveyTriggers();
    expect(notificar, 'un usuario activo recibió el recordatorio de "todavía no anotas nada"').not.toHaveBeenCalled();
  });

  /**
   * El conteo por ventana es OTRA función (`contarTransaccionesUltimos`) y otro arreglo. Se
   * distingue del anterior porque filtra por `fecha`. Sin este caso, revertir uno de los dos
   * quedaba tapado por el test del otro.
   */
  it('y el conteo por ventana de días también', async () => {
    // Día 14 desde el registro con onboarding cerrado: la rama que lee `contarTransaccionesUltimos`.
    tablas.usuarios = [{ ...USUARIO, created_at: '2026-08-06T10:00:00.000Z' }];
    tablas.transacciones = [TX, { ...TX, id: 't-2' }, { ...TX, id: 't-3' }];
    fallar = (t, v) => (t === 'transacciones' && filtro(v, 'fecha') ? BOOM : null);
    await surveys.checkSurveyTriggers();
    expect(notificar).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 2. Población: el destino no cambia, así que el log es lo ÚNICO observable.
// ───────────────────────────────────────────────────────────────────────────────
describe('una población que no se puede leer deja rastro', () => {
  it('survey-triggers loguea con su tag cuando no puede leer a quién evaluar', async () => {
    vi.setSystemTime(enLima(HOY));
    fallar = (t) => (t === 'usuarios' ? BOOM : null);
    await surveys.checkSurveyTriggers();
    expect(notificar).not.toHaveBeenCalled();
    expect(tagsLogueados(), 'no quedó rastro: "no había nadie" y "no se pudo preguntar" salen igual')
      .toContain('SURVEY_TRIG');
  });

  /**
   * La contraprueba del anterior: sin fallo, esa línea NO se emite. Sin esto, un
   * `log.error` incondicional pasaría el test de arriba.
   */
  it('y no loguea nada cuando la población se lee bien', async () => {
    vi.setSystemTime(enLima(HOY));
    tablas.usuarios = [USUARIO];
    await surveys.checkSurveyTriggers();
    expect(tagsLogueados()).toEqual([]);
  });

  it('la población del recordatorio de deudas no se lee como "hoy no vence ninguna"', async () => {
    fallar = (t) => (t === 'deudas' ? BOOM : null);
    await expect(debts.obtenerDeudasProximasVencer(), 'devolvió [] : el cron lo lee como que no hay deudas')
      .rejects.toMatchObject({ message: 'boom' });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 3. Decisión de contenido: el resumen con un número mal es peor que sin resumen.
// ───────────────────────────────────────────────────────────────────────────────
describe('un resumen no se manda con la mitad de los números', () => {
  const USUARIO_RESUMEN = { id: 'u-1', nombre: 'María', whatsapp: '51900000001' };

  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-20T09:00:00'));
    tablas.transacciones = [
      { id: 'g1', usuario_id: 'u-1', tipo: 'gasto', fecha: '2026-07-15', monto: 100, monto_pen: 100, categoria: 'Comida' },
      { id: 'i1', usuario_id: 'u-1', tipo: 'ingreso', fecha: '2026-07-10', monto: 500, monto_pen: 500 },
      { id: 'g2', usuario_id: 'u-1', tipo: 'gasto', fecha: '2026-08-20', monto: 30, monto_pen: 30, categoria: 'Taxi' },
      { id: 'i2', usuario_id: 'u-1', tipo: 'ingreso', fecha: '2026-08-20', monto: 80, monto_pen: 80 },
    ];
  });

  it('control: con todo sano el resumen mensual se genera', async () => {
    await expect(summaries.generarResumenMensual(USUARIO_RESUMEN)).resolves.toBeTruthy();
  });

  it('si no se pueden leer los gastos del mes, no se manda nada y queda dicho', async () => {
    fallar = (t, v) => (t === 'transacciones' && filtro(v, 'tipo', 'gasto') ? BOOM : null);
    await expect(summaries.generarResumenMensual(USUARIO_RESUMEN)).rejects.toMatchObject({ message: 'boom' });
    expect(tagsLogueados(), 'el catch per-user del resumen diario es silencioso: sin este log no queda rastro')
      .toContain('RESUMEN');
  });

  /**
   * La que más daño hace callada, y por eso va con su propio caso: los gastos se leen bien y
   * sólo fallan los ingresos. Antes, `(ingresos || [])` daba total 0 y el resumen anunciaba un
   * ahorro negativo igual a TODO el gasto del mes. El mensaje salía; los números eran falsos.
   */
  it('si no se pueden leer los ingresos, tampoco: el ahorro saldría negativo por todo el gasto', async () => {
    fallar = (t, v) => (t === 'transacciones' && filtro(v, 'tipo', 'ingreso') ? BOOM : null);
    await expect(summaries.generarResumenMensual(USUARIO_RESUMEN)).rejects.toMatchObject({ message: 'boom' });
  });

  it('control: con todo sano el resumen diario se genera', async () => {
    await expect(summaries.generarResumenDiario(USUARIO_RESUMEN)).resolves.toBeTruthy();
  });

  it('y lo mismo del lado del resumen diario', async () => {
    fallar = (t, v) => (t === 'transacciones' && filtro(v, 'tipo', 'ingreso') ? BOOM : null);
    await expect(summaries.generarResumenDiario(USUARIO_RESUMEN)).rejects.toMatchObject({ message: 'boom' });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 4. Decisión por usuario: "no encontré esa deuda" es una mentira distinta de un
//    silencio, porque el usuario se va convencido de que Neto no le entendió.
// ───────────────────────────────────────────────────────────────────────────────
describe('lo que no se pudo leer no se reporta como que no existe', () => {
  beforeEach(() => {
    tablas.deudas = [{ id: 'd-1', usuario_id: 'u-1', contraparte: 'Juan', estado: 'activa', monto_pendiente: '100', moneda: 'PEN' }];
    tablas.metas_ahorro = [{ id: 'm-1', usuario_id: 'u-1', nombre: 'Viaje', completada: false, monto_objetivo: '1000', monto_actual: '100' }];
  });

  it('control: con la deuda presente, el abono la encuentra', async () => {
    await expect(debts.abonarDeuda('u-1', 'Juan', 50)).resolves.toBeTruthy();
  });

  it('un abono contra la base caída no dice "no le debes nada a esa persona"', async () => {
    fallar = (t) => (t === 'deudas' ? BOOM : null);
    await expect(debts.abonarDeuda('u-1', 'Juan', 50), 'devolvió null: el handler lo traduce a "no encontré esa deuda" y el abono se pierde')
      .rejects.toMatchObject({ message: 'boom' });
  });

  it('marcar una deuda como pagada tampoco', async () => {
    fallar = (t) => (t === 'deudas' ? BOOM : null);
    await expect(debts.marcarDeudaPagada('u-1', 'Juan')).rejects.toMatchObject({ message: 'boom' });
  });

  it('ni consolidar lo que se le debe a alguien', async () => {
    fallar = (t) => (t === 'deudas' ? BOOM : null);
    await expect(debts.consolidarDeudasPorContraparte('u-1', 'Juan')).rejects.toMatchObject({ message: 'boom' });
  });

  it('ni saldar todo: un "no había nada que saldar" deja el saldo abierto', async () => {
    fallar = (t) => (t === 'deudas' ? BOOM : null);
    await expect(debts.saldarTodasDeudas('u-1', 'Juan')).rejects.toMatchObject({ message: 'boom' });
  });

  it('y la lista de deudas caída no es "no tienes deudas"', async () => {
    fallar = (t) => (t === 'deudas' ? BOOM : null);
    await debts.obtenerDeudas('u-1');
    expect(tagsLogueados()).toContain('DEUDAS');
  });

  it('un aporte a meta contra la base caída no dice "no encontré esa meta"', async () => {
    fallar = (t) => (t === 'metas_ahorro' ? BOOM : null);
    await expect(metas.abonarMeta('u-1', 'Viaje', 50)).rejects.toMatchObject({ message: 'boom' });
  });

  /** El patrón builder: la query se arma arriba y se resuelve en el `await q` de abajo. */
  it('la lista de metas caída no es "todavía no tienes metas"', async () => {
    fallar = (t) => (t === 'metas_ahorro' ? BOOM : null);
    await expect(metas.obtenerMetas('u-1')).rejects.toMatchObject({ message: 'boom' });
  });

  it('los logros caídos no son "todavía no tienes logros"', async () => {
    fallar = (t) => (t === 'logros' ? BOOM : null);
    await expect(metas.obtenerLogros('u-1')).rejects.toMatchObject({ message: 'boom' });
  });

  it('y una racha que no se pudo leer no es una racha de cero semanas', async () => {
    fallar = (t) => (t === 'meta_aportes' ? BOOM : null);
    await expect(metas.verificarRachaAportes('u-1', 'm-1')).rejects.toMatchObject({ message: 'boom' });
  });

  it('el ajuste dinámico de la cuota tampoco se salta en silencio', async () => {
    fallar = (t) => (t === 'metas_ahorro' ? BOOM : null);
    await expect(metas.ajustarDinamico('m-1')).rejects.toMatchObject({ message: 'boom' });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 5. Y las accesorias NO pueden cortar. Un `if (error) return` puesto donde no va
//    apaga un flujo entero por un hipo.
// ───────────────────────────────────────────────────────────────────────────────
describe('las accesorias no cortan', () => {
  /**
   * `marcarRespuestaProactiva` la llama el webhook por CADA mensaje entrante, con un
   * `.catch(() => {})` encima. Es medición pura: no decide a quién se le manda nada. Si
   * alguien le pone el `throw` que sí llevan los ocho triggers, convierte una lectura fallida
   * en ruido del camino caliente — y estos dos tests son los que se lo impiden.
   */
  it('la marca de respuesta no explota cuando no se puede buscar el envío', async () => {
    fallar = (t) => (t === 'survey_events' ? BOOM : null);
    await expect(surveys.marcarRespuestaProactiva('u-1', 'gracias')).resolves.toBeUndefined();
    expect(tagsLogueados()).toContain('SURVEY_RESP');
  });

  it('ni cuando se encuentra el envío pero no se puede marcar', async () => {
    tablas.survey_events = [{ id: 'e-1', user_id: 'u-1', channel: 'whatsapp', responded_at: null, sent_at: '2026-08-19T10:00:00.000Z', response_data: null }];
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    // Sólo la ESCRITURA falla: la búsqueda encuentra la fila. Sin distinguirlas, el caso de
    // arriba tapaba este y quitarle el log al update sobrevivía.
    let leido = false;
    fallar = (t) => {
      if (t !== 'survey_events') return null;
      if (!leido) { leido = true; return null; }
      return BOOM;
    };
    await expect(surveys.marcarRespuestaProactiva('u-1', 'gracias')).resolves.toBeUndefined();
    expect(escrituras.some((e) => e.tabla === 'survey_events' && e.op === 'update'),
      'ni siquiera intentó marcar: el corte se puso donde no iba').toBe(true);
    expect(tagsLogueados()).toContain('SURVEY_RESP');
  });

  /**
   * La cuota mensual es un valor DERIVADO: se recalcula sola en el aporte siguiente. Que no se
   * pueda guardar no puede tumbar el aporte, que es lo que el usuario efectivamente pidió.
   */
  it('un aporte a meta se registra aunque la cuota mensual no se pueda actualizar', async () => {
    tablas.metas_ahorro = [{
      id: 'm-1', usuario_id: 'u-1', nombre: 'Viaje', completada: false,
      monto_objetivo: '1000', monto_actual: '100', fecha_limite: '2026-12-31', monthly_quota: '100',
    }];
    // La lectura anda; sólo la escritura de la cuota falla.
    // Sólo el UPDATE de `monthly_quota`. Filtrar por tabla+op no alcanza: `abonarMeta` hace
    // ANTES otro update sobre la misma fila —el guard atómico de `completada`— y tumbar ese
    // hace fallar el aporte por un motivo que no tiene nada que ver con lo que se mide.
    fallar = (t, v, op, patch) => (t === 'metas_ahorro' && op === 'update' && patch && 'monthly_quota' in patch ? BOOM : null);
    await expect(metas.abonarMeta('u-1', 'Viaje', 50)).resolves.toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 6. Lo que la primera versión de este archivo NO sostenía.
// ───────────────────────────────────────────────────────────────────────────────
/**
 * **Los 30 tests de arriba pasaban en verde con 10 de estos arreglos revertidos.** Salió de
 * `scripts/mutar-lecturas-error.mjs`, no de leer el archivo, y las tres causas valen más que
 * la lista:
 *
 *   · **Un caso por FORMA en vez de por sitio.** Los cuatro dedups de `reminder_dN` son cuatro
 *     `if` distintos; el test los ejercitaba con un usuario de día 3, así que los de día 7, 14
 *     y 30 nunca se corrían. Misma forma no es el mismo arreglo — y acá ni siquiera es el
 *     mismo camino.
 *   · **Un `resolves` no mira el log.** El caso de la cuota mensual afirmaba que el aporte no
 *     se cae, y eso vale igual con el `log.error` borrado: la mutación no cambia el valor de
 *     retorno. Una accesoria necesita las DOS mitades — que no corte **y** que hable.
 *   · **Un archivo entero sin ejercitar.** `shared-spaces.js` no se importaba, así que sus
 *     arreglos no tenían quién los mirara.
 */
describe('los sitios que la mutación encontró descubiertos', () => {
  beforeEach(() => { vi.setSystemTime(enLima(HOY)); });

  /** Una regla que de verdad MUEVE la parte de cada uno respecto del 50/50 por defecto. */
  const REGLAS_ANTES = [{ category: 'Comida', splits: { 'u-1': 90, 'u-2': 10 } }];
  const sembrarEspacio = () => {
    tablas.shared_spaces = [{ id: 's-1', name: 'Casa', split_rules: [{ category: 'Comida', splits: { 'u-1': 10, 'u-2': 90 } }] }];
    tablas.space_members = [
      { space_id: 's-1', user_id: 'u-1', split_percentage: 50, usuarios: { nombre: 'María', whatsapp: '51900000001' } },
      { space_id: 's-1', user_id: 'u-2', split_percentage: 50, usuarios: { nombre: 'Ana', whatsapp: '51900000002' } },
    ];
  };

  /**
   * Los otros tres dedups de recordatorio. Cada fila arma al usuario que califica para ESE
   * trigger y para ninguno anterior en el orden de prioridad.
   */
  const DEDUPS = [
    ['reminder_d7', { created_at: '2026-08-13T10:00:00.000Z' }, []],
    ['reminder_d14', { created_at: '2026-08-06T10:00:00.000Z' }, [{ ...TX, fecha: '2026-08-19' }]],
    ['reminder_d30', { created_at: '2026-07-21T10:00:00.000Z' }, [{ ...TX, fecha: '2026-07-25' }]],
  ];

  it.each(DEDUPS)('control: el %s sale cuando su dedup se puede leer', async (ev, campos, txs) => {
    tablas.usuarios = [{ ...USUARIO, ...campos }];
    tablas.transacciones = txs;
    await surveys.checkSurveyTriggers();
    expect(notificar).toHaveBeenCalledTimes(1);
    expect(notificar.mock.calls[0][0].tipo).toBe('survey_' + ev);
  });

  it.each(DEDUPS)('y el dedup caído del %s no lo reenvía', async (ev, campos, txs) => {
    tablas.usuarios = [{ ...USUARIO, ...campos }];
    tablas.transacciones = txs;
    fallar = (t, v) => (t === 'survey_events' && filtro(v, 'event_type') ? BOOM : null);
    await surveys.checkSurveyTriggers();
    expect(notificar).not.toHaveBeenCalled();
  });

  /**
   * El mes de comparación del resumen mensual. Se distingue de los otros dos `gasto` por su
   * ventana: con la fecha de hoy fijada, el mes anterior arranca el 2026-07-01 y el
   * anterior-al-anterior el 2026-06-01.
   */
  it('el mes de comparación caído no deja anunciar una subida de gasto inventada', async () => {
    vi.setSystemTime(enLima('2026-08-20T09:00:00'));
    tablas.transacciones = [
      { id: 'g1', usuario_id: 'u-1', tipo: 'gasto', fecha: '2026-07-15', monto: 100, monto_pen: 100, categoria: 'Comida' },
      { id: 'i1', usuario_id: 'u-1', tipo: 'ingreso', fecha: '2026-07-10', monto: 500, monto_pen: 500 },
    ];
    fallar = (t, v) => (t === 'transacciones' && filtro(v, 'fecha', '2026-06-01') ? BOOM : null);
    await expect(summaries.generarResumenMensual({ id: 'u-1', nombre: 'María' })).rejects.toMatchObject({ message: 'boom' });
  });

  /**
   * Los gastos del resumen DIARIO. Se distinguen de los del mensual porque filtran la fecha
   * con `eq` y no con un rango.
   */
  it('los gastos de hoy caídos no producen un resumen diario a medias', async () => {
    vi.setSystemTime(enLima('2026-08-20T09:00:00'));
    tablas.transacciones = [{ id: 'g2', usuario_id: 'u-1', tipo: 'gasto', fecha: '2026-08-20', monto: 30, monto_pen: 30, categoria: 'Taxi' }];
    fallar = (t, v, op) => (t === 'transacciones' && op === 'select'
      && v.some((x) => x.col === 'fecha' && x.val === '2026-08-20') && filtro(v, 'tipo', 'gasto') ? BOOM : null);
    await expect(summaries.generarResumenDiario({ id: 'u-1', nombre: 'María' })).rejects.toMatchObject({ message: 'boom' });
  });

  /**
   * La rama de recuperación de la carrera entre dos aportes: el UPDATE atómico no matchea
   * ninguna fila (`PGRST116`, otra corrida ya la completó) y la RE-LECTURA también falla.
   * Devolver `meta: undefined` ahí le pasa el problema al handler disfrazado de meta vacía.
   */
  it('si la relectura tras una carrera de aportes falla, no devuelve una meta vacía', async () => {
    tablas.metas_ahorro = [{ id: 'm-1', usuario_id: 'u-1', nombre: 'Viaje', completada: false, monto_objetivo: '1000', monto_actual: '100' }];
    fallar = (t, v, op) => {
      if (t !== 'metas_ahorro') return null;
      if (op === 'update') return { code: 'PGRST116', message: 'no rows' };
      // La relectura de la rama de recuperación filtra por `id`; la búsqueda inicial por
      // `usuario_id`, así que esa última sigue sana y el flujo llega hasta acá.
      return v.some((x) => x.col === 'id') ? BOOM : null;
    };
    await expect(metas.abonarMeta('u-1', 'Viaje', 50)).rejects.toMatchObject({ message: 'boom' });
  });

  /** Las dos mitades de una accesoria: que NO corte, y que DIGA que no se aplicó. */
  it('la cuota mensual que no se pudo guardar queda dicha, además de no cortar el aporte', async () => {
    tablas.metas_ahorro = [{
      id: 'm-1', usuario_id: 'u-1', nombre: 'Viaje', completada: false,
      monto_objetivo: '1000', monto_actual: '100', fecha_limite: '2026-12-31', monthly_quota: '100',
    }];
    fallar = (t, v, op, patch) => (t === 'metas_ahorro' && op === 'update' && patch && 'monthly_quota' in patch ? BOOM : null);
    await expect(metas.abonarMeta('u-1', 'Viaje', 50)).resolves.toBeTruthy();
    expect(tagsLogueados(), 'la cuota mostrada queda vieja y nadie se entera').toContain('METAS');
  });

  it('y el ajuste dinámico que no se pudo guardar tampoco rompe, pero avisa', async () => {
    tablas.metas_ahorro = [{
      id: 'm-1', usuario_id: 'u-1', nombre: 'Viaje', completada: false,
      monto_objetivo: '1000', monto_actual: '100', fecha_limite: '2026-12-31', monthly_quota: '100',
    }];
    fallar = (t, v, op, patch) => (t === 'metas_ahorro' && op === 'update' && patch && 'monthly_quota' in patch ? BOOM : null);
    await expect(metas.ajustarDinamico('m-1')).resolves.toBeTruthy();
    expect(tagsLogueados()).toContain('METAS');
  });

  /**
   * `shared-spaces.js` no se importaba en este archivo, así que sus tres arreglos no tenían
   * quién los sostuviera. El del dueño es el más caro: un espacio sin dueño es un espacio sin
   * quien pague, y la fila del espacio ya quedó escrita.
   */
  it('un espacio no se crea a medias: sin su dueño, la creación falla', async () => {
    fallar = (t) => (t === 'space_members' ? BOOM : null);
    await expect(espacios.crearEspacio('u-1', 'Casa', 'roommates'),
      'el espacio quedó creado sin dueño y nadie se enteró').rejects.toMatchObject({ message: 'boom' });
  });

  it('control: con todo sano el espacio se crea', async () => {
    await expect(espacios.crearEspacio('u-1', 'Casa', 'roommates')).resolves.toBeTruthy();
  });

  /**
   * La población del aviso de cambio de reparto. El comportamiento correcto ya era no avisar;
   * lo que faltaba era distinguirlo de "este espacio tiene un solo miembro" — y lo que se
   * deja de avisar es que se movió plata ajena.
   */
  it('si no se puede leer quiénes son los miembros, nadie queda avisado y queda dicho', async () => {
    tablas.shared_spaces = [{ id: 's-1', name: 'Casa', split_rules: [] }];
    fallar = (t) => (t === 'space_members' ? BOOM : null);
    await espacios.notificarReglasEditadas('s-1', 'u-1', []);
    expect(notificar).not.toHaveBeenCalled();
    expect(tagsLogueados()).toContain('ESPACIO_REGLAS_AVISO');
  });

  /**
   * Y el cuerpo del mensaje: con `split_rules` ilegible, `despues` queda en `[]` y el aviso
   * le anuncia a cada miembro que se borraron TODAS las reglas por categoría — un cambio de
   * reparto que no ocurrió.
   */
  it('y si no se pueden leer las reglas nuevas, no se anuncia un reparto inventado', async () => {
    sembrarEspacio();
    // Sólo la SEGUNDA lectura del espacio (la del cuerpo) falla: la primera arma la población.
    let leidas = 0;
    fallar = (t) => (t === 'shared_spaces' && ++leidas > 1 ? BOOM : null);
    await espacios.notificarReglasEditadas('s-1', 'u-1', REGLAS_ANTES);
    expect(notificar, 'salió un aviso construido sobre reglas que no se pudieron leer').not.toHaveBeenCalled();
  });

  /**
   * El control, y sin él el caso de arriba pasaba con el arreglo revertido: la primera versión
   * usaba `weights` donde el motor espera `splits`, así que la regla no nombraba a nadie, el
   * reparto caía al de por defecto y NINGÚN porcentaje se movía. Sin cambio no hay línea que
   * escribir, y `notificar` no se llamaba con el guard ni sin él.
   */
  it('control: cuando las reglas SÍ se leen, el aviso del cambio de reparto sale', async () => {
    sembrarEspacio();
    await espacios.notificarReglasEditadas('s-1', 'u-1', REGLAS_ANTES);
    expect(notificar).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 7. Lo que encontró la revisión adversarial del diff.
// ───────────────────────────────────────────────────────────────────────────────
describe('el mock discrimina, y "no hay fila" no es un fallo', () => {
  /**
   * **La contraprueba del `ilike`.** Estuvo en no-op, así que los cuatro controles de `debts`
   * pasaban con cualquier contraparte: la deuda de Pedro salía cuando se buscaba la de Juan.
   * Un mock que no implementa el filtro del que depende el caso no puede distinguir el código
   * arreglado del roto — y ese filtro decide DE QUIÉN es la deuda que se abona.
   */
  it('una contraparte que no coincide no devuelve la deuda de otro', async () => {
    tablas.deudas = [{ id: 'd-1', usuario_id: 'u-1', contraparte: 'Pedro', estado: 'activa', monto_pendiente: '100', monto_original: '100', moneda: 'PEN' }];
    await expect(debts.abonarDeuda('u-1', 'Juan', 50),
      'el mock devolvió la deuda de Pedro cuando se buscaba la de Juan').resolves.toBeNull();
  });

  /**
   * `PGRST116` es "cero filas", y `.single()` lo devuelve como error igual. Un
   * `if (error) throw` a secas convierte "esa meta ya no existe" en excepción, que es una
   * clasificación al revés: no es un fallo de infraestructura, es el caso que el `!meta` de
   * la línea siguiente ya cubría.
   */
  it('ajustar una meta que ya no existe devuelve null, no explota', async () => {
    tablas.metas_ahorro = [];
    await expect(metas.ajustarDinamico('m-borrada'),
      '"esa meta no existe" se convirtió en excepción').resolves.toBeNull();
  });

  /** Y el positivo del mismo par: un fallo REAL de esa lectura sí tiene que cortar. */
  it('pero un fallo real de esa lectura sí corta', async () => {
    tablas.metas_ahorro = [{ id: 'm-1', usuario_id: 'u-1', fecha_limite: '2026-12-31', completada: false, monto_objetivo: '1000', monto_actual: '100' }];
    fallar = (t) => (t === 'metas_ahorro' ? BOOM : null);
    await expect(metas.ajustarDinamico('m-1')).rejects.toMatchObject({ message: 'boom' });
  });

  /**
   * Lo mismo del lado de los espacios: un espacio borrado es un caso legítimo que el `!space`
   * ya manejaba en silencio. Tratarlo como fallo llena el log de `log.error` por espacios que
   * alguien borró a propósito — ruido a nivel error, que es la dirección que enseña a ignorar
   * los logs.
   */
  it('avisar sobre un espacio que ya no existe no loguea un error', async () => {
    tablas.shared_spaces = [];
    tablas.space_members = [];
    await espacios.notificarReglasEditadas('s-borrado', 'u-1', []);
    expect(notificar).not.toHaveBeenCalled();
    expect(tagsLogueados(), 'un espacio borrado se reportó como fallo de lectura').toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 8. Las dos del resumen SEMANAL, que vivían un archivo más adentro.
// ───────────────────────────────────────────────────────────────────────────────
/**
 * Son las que hicieron transitiva la derivación del perímetro: `generarResumenSemanal` está en
 * `summaries.js` —dentro del perímetro desde el primer día, y con sus dos hermanas arregladas
 * en este mismo commit— pero delega en estas dos, que viven en otros archivos.
 *
 * Y son un recordatorio de que la mutación manda: llegaron con la revisión adversarial, se
 * arreglaron, **y sobrevivieron a la primera corrida del mutador** porque nadie las probaba.
 */
describe('las dos que alimentan el resumen semanal', () => {
  const SEMANA = [
    { id: 'g1', usuario_id: 'u-1', tipo: 'gasto', fecha: '2026-08-19', monto: 40, monto_pen: 40, categoria: 'Comida' },
  ];

  beforeEach(() => { vi.setSystemTime(enLima('2026-08-20T09:00:00')); });

  it('control: los gastos de la semana se leen', async () => {
    tablas.transacciones = SEMANA;
    await expect(transactions.obtenerGastosSemana('u-1')).resolves.toHaveLength(1);
  });

  /**
   * El `[]` corta `generarResumenSemanal` con `if (!gastosSemana.length) return null`: el
   * resumen del domingo no sale y no queda una línea. Y por WhatsApp, el intent
   * `listar_gastos_semana` responde "no registraste gastos esta semana", que es falso.
   */
  it('si no se pueden leer, no se reporta una semana sin gastos', async () => {
    tablas.transacciones = SEMANA;
    fallar = (t) => (t === 'transacciones' ? BOOM : null);
    await expect(transactions.obtenerGastosSemana('u-1')).rejects.toMatchObject({ message: 'boom' });
  });

  it('control: los presupuestos del mes se leen', async () => {
    tablas.presupuestos = [{ id: 'p-1', usuario_id: 'u-1', mes: 8, anio: 2026, categoria: 'Comida', monto_limite: '500' }];
    await expect(budget.obtenerPresupuestosMes('u-1')).resolves.toHaveLength(1);
  });

  /**
   * Con `[]`, `limiteTotal` queda en 0 y el bloque de presupuesto DESAPARECE del resumen sin
   * decirlo; y `formatearEstadoPresupuesto` responde "No tienes presupuestos configurados",
   * que además invita a volver a crearlos.
   */
  it('y un presupuesto que no se puede leer no es un presupuesto que no existe', async () => {
    tablas.presupuestos = [{ id: 'p-1', usuario_id: 'u-1', mes: 8, anio: 2026, categoria: 'Comida', monto_limite: '500' }];
    fallar = (t) => (t === 'presupuestos' ? BOOM : null);
    await expect(budget.obtenerPresupuestosMes('u-1')).rejects.toMatchObject({ message: 'boom' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 9. El camino de USUARIO: transactions, budget y categories (ítem 8).
// ───────────────────────────────────────────────────────────────────────────
/**
 * Los tres archivos que entraron al perímetro cuando la derivación se volvió transitiva.
 *
 * **La taxonomía es la misma, y sus dos ramas opuestas se reparten distinto que en el cron.**
 * Allá el arreglo por defecto terminó siendo `throw`, porque lo que seguía era un AVISO y los
 * handlers responden "no pude, intenta de nuevo". Acá lo que sigue suele ser el gasto que la
 * persona acaba de escribir, y un corte de más lo pierde. Por eso conviven, en el mismo commit
 * y a veces en la misma función, tres arreglos distintos:
 *
 *   · **falla ABIERTO a propósito** — el dedup de `guardarTransaccion`. Sigue de largo y ahora
 *     lo dice. Una fila duplicada se borra; un gasto perdido no se recupera.
 *   · **decisión de CONTENIDO → `throw`** — `obtenerGastosMes`, `formatearEstadoPresupuesto`,
 *     `obtenerCategoriasUsuario`. Un `[]` mudo no produce un número que falta: produce el
 *     número equivocado, o un menú de onboarding para alguien que ya tiene su árbol.
 *   · **resultado DISCRIMINADO** — `recategorizarTransaccion` y `corregirTransaccionEspecifica`,
 *     que ya modelan el fallo en su contrato `{ ok, msg }`. Ahí lanzar cambiaría la mentira por
 *     silencio (el catch del webhook no le contesta al usuario); el motivo la cambia por la
 *     verdad.
 *   · **accesoria** — `buscarReglaComercio`, el conteo de activación, la escritura de las
 *     subcategorías. Sólo log, con su contraprueba de que NO cortan.
 */

/** Los tags de los `log.warn`, que es donde va lo accesorio. */
const tagsWarn = () => logMock.warn.mock.calls.map((c) => c[0] && c[0].tag);

describe('registrar un gasto: el dedup falla ABIERTO y ahora lo dice', () => {
  const DATOS = { tipo: 'gasto', monto: 50, comercio: 'Taxi', categoria: 'Transporte', descripcion_original: 'gaste 50 en taxi' };

  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    tablas.usuarios = [{ ...USUARIO, plan: 'premium' }];
  });

  /**
   * El control, y hace falta por partida doble: dice que el camino al insert existe, y dice
   * que el dedup DEDUPEA — sin esto, el caso de abajo podría estar pasando porque el dedup
   * nunca encuentra nada.
   */
  it('control: un gasto repetido dentro de la ventana no se inserta dos veces', async () => {
    tablas.transacciones = [];
    const primera = await transactions.guardarTransaccion('u-1', DATOS);
    expect(primera).toBeTruthy();
    // La fila que acaba de escribir el mock no queda en `tablas`, así que se siembra a mano
    // con el mismo `dedup_hash` que va a calcular la segunda llamada.
    tablas.transacciones = [{ ...primera, created_at: new Date().toISOString() }];
    escrituras = [];
    const segunda = await transactions.guardarTransaccion('u-1', DATOS);
    expect(segunda.id, 'el dedup no reconoció la fila que ya estaba').toBe(primera.id);
    expect(escrituras.filter((e) => e.tabla === 'transacciones' && e.op === 'insert'),
      'se insertó igual habiendo dedup').toEqual([]);
  });

  /**
   * **El caso que define este ítem.** La lectura del dedup cae y el gasto se registra IGUAL:
   * un corte acá pierde lo que la persona acaba de escribir, que es el daño que el producto no
   * puede permitirse. Lo que cambia es que deja rastro.
   */
  it('si el dedup no se puede consultar, el gasto se registra igual y queda el log', async () => {
    tablas.transacciones = [];
    fallar = (t, v, op) => (t === 'transacciones' && op === 'select' && filtro(v, 'dedup_hash') ? BOOM : null);
    const tx = await transactions.guardarTransaccion('u-1', DATOS);
    expect(tx, 'la lectura del dedup se llevó puesto el gasto').toBeTruthy();
    expect(escrituras.some((e) => e.tabla === 'transacciones' && e.op === 'insert'),
      'el gasto no llegó a insertarse').toBe(true);
    expect(tagsLogueados(), 'la caída del dedup no dejó una sola línea').toContain('DEDUP');
  });

  /**
   * La otra mitad del mismo statement: el `23505` de Gmail. La fila YA está (por eso el
   * conflicto), así que acá no hay nada que salvar — lo único que decide la lectura es si el
   * barrido recibe la fila ganadora o el 23505 re-lanzado, y las dos son honestas. Sólo log.
   */
  it('el dedup de Gmail que no se puede releer re-lanza el 23505 y lo dice', async () => {
    tablas.transacciones = [];
    fallar = (t, v, op) => {
      if (t !== 'transacciones') return null;
      if (op === 'insert') return { code: '23505', message: 'duplicate key' };
      if (op === 'select' && filtro(v, 'gmail_msg_id')) return BOOM;
      return null;
    };
    await expect(transactions.guardarTransaccion('u-1', { ...DATOS, esGmail: true, gmail_msg_id: 'msg-1' }))
      .rejects.toMatchObject({ code: '23505' });
    expect(tagsLogueados(), 'no se pudo releer la fila ganadora y no quedó rastro').toContain('DEDUP_GMAIL');
  });

  /**
   * Accesoria, con su contraprueba: el conteo alimenta el evento de primer gasto y el
   * `conteoTx` de la cadencia del empujón a la webapp, pero el gasto ya está escrito. Si
   * alguien "completa el trabajo" poniéndole el corte que sí llevan las otras, este test muere.
   */
  it('el conteo de activación caído no corta el registro (accesoria)', async () => {
    tablas.transacciones = [];
    fallar = (t, v, op) => (t === 'transacciones' && op === 'select' && v.length === 1 && filtro(v, 'usuario_id') ? BOOM : null);
    const tx = await transactions.guardarTransaccion('u-1', DATOS);
    expect(tx, 'un conteo de analytics se llevó puesto el gasto').toBeTruthy();
    expect(tagsWarn(), 'el conteo cayó sin dejar rastro').toContain('ACTIVACION');
  });

  /**
   * `buscarReglaComercio` es accesoria por su CALL-SITE: la llama `guardarTransaccion` antes
   * del insert y sin catch propio. Un throw acá perdería el gasto para salvar su etiqueta.
   */
  it('una regla de comercio que no se puede leer no impide registrar el gasto', async () => {
    tablas.transacciones = [];
    fallar = (t) => (t === 'reglas_comercio' ? BOOM : null);
    const tx = await transactions.guardarTransaccion('u-1', DATOS);
    expect(tx, 'no poder leer la regla se llevó puesto el gasto').toBeTruthy();
    expect(tagsWarn()).toContain('REGLA');
  });

  /**
   * Y el negativo que hace falta para que el anterior signifique algo: **la mayoría de los
   * comercios NO tiene regla**, y eso llega como `PGRST116` desde un `.single()`. Sin este
   * caso, un `if (error) log.warn` a secas pasaría el test de arriba y llenaría el log con un
   * warning por cada gasto de la historia.
   */
  it('y un comercio SIN regla no es un fallo que loguear', async () => {
    tablas.transacciones = [];
    tablas.reglas_comercio = [];
    const tx = await transactions.guardarTransaccion('u-1', DATOS);
    expect(tx).toBeTruthy();
    expect(tagsWarn(), '"este comercio no tiene regla" se reportó como fallo de lectura').not.toContain('REGLA');
  });
});

describe('los totales del mes no se responden con la mitad de los números', () => {
  beforeEach(() => { vi.setSystemTime(enLima('2026-08-20T10:00:00')); });

  const DEL_MES = [{ id: 'g1', usuario_id: 'u-1', tipo: 'gasto', fecha: '2026-08-11', monto: 30, monto_pen: 30, categoria: 'Comida' }];

  it('control: los gastos del mes se leen', async () => {
    tablas.transacciones = DEL_MES;
    await expect(transactions.obtenerGastosMes('u-1')).resolves.toHaveLength(1);
  });

  /**
   * El hermano exacto de `obtenerGastosSemana`. Con `[]`, `/mes` responde "Sin movimientos
   * este mes aun" y el saludo anuncia S/ 0.00 sobre una persona que sí gastó.
   */
  it('si no se pueden leer, no se reporta un mes sin gastos', async () => {
    tablas.transacciones = DEL_MES;
    fallar = (t) => (t === 'transacciones' ? BOOM : null);
    await expect(transactions.obtenerGastosMes('u-1')).rejects.toMatchObject({ message: 'boom' });
  });

  /**
   * `obtenerUltimaTransaccion` usa `.single()`, así que "todavía no anotó nada" llega como
   * `PGRST116`. Este par es el que separa las dos hipótesis: sin el negativo, un
   * `if (error) throw` a secas convierte a todo usuario nuevo en una excepción.
   */
  it('un usuario sin transacciones devuelve null, no explota', async () => {
    tablas.transacciones = [];
    await expect(transactions.obtenerUltimaTransaccion('u-1')).resolves.toBeNull();
  });

  it('pero una caída no se responde como "no hay transacciones recientes"', async () => {
    tablas.transacciones = DEL_MES;
    fallar = (t) => (t === 'transacciones' ? BOOM : null);
    await expect(transactions.obtenerUltimaTransaccion('u-1')).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('corregir una categoría: "no encontré" tiene que ser cierto', () => {
  beforeEach(() => { vi.setSystemTime(enLima('2026-08-20T10:00:00')); });

  const DE_STARBUCKS = [{ id: 'g1', usuario_id: 'u-1', tipo: 'gasto', comercio: 'Starbucks Lima', fecha: '2026-08-19', monto: 20, categoria: 'Otros', created_at: '2026-08-19T10:00:00Z' }];

  it('control: con el gasto ahí, se recategoriza', async () => {
    tablas.transacciones = DE_STARBUCKS;
    const res = await transactions.recategorizarTransaccion('u-1', 'Starbucks Lima', 'Comida');
    expect(res.ok).toBe(true);
  });

  it('control: un comercio que no existe se responde como que no existe', async () => {
    tablas.transacciones = DE_STARBUCKS;
    const res = await transactions.recategorizarTransaccion('u-1', 'Wong', 'Comida');
    expect(res.ok).toBe(false);
    expect(res.msg).toMatch(/No encontre/i);
  });

  /**
   * La lectura cae y el mensaje lo dice. **Lanzar no serviría acá**: uno de los dos call-sites
   * es `/cambiar`, un comando del webhook, y hasta este commit su catch no le contestaba nada
   * al usuario.
   */
  it('si la búsqueda cae, no se responde que el comercio no existe', async () => {
    tablas.transacciones = DE_STARBUCKS;
    // **Cae SÓLO la primera lectura**, y esa precisión es lo que hace que el caso pruebe algo.
    // Con el fixture tumbando las dos, neutralizar esta guarda dejaba pasar el flujo al
    // reintento por palabra, que caía igual y devolvía el MISMO mensaje: la segunda guarda
    // tapaba a la primera y la mutación sobrevivía en verde. Lo encontró el mutador.
    // Acá la del reintento (`%Starbucks%`, sin espacio) SÍ resuelve y encuentra la fila, así
    // que sin esta guarda la función devolvería `ok: true`.
    fallar = (t, v, op) => {
      if (t !== 'transacciones' || op !== 'select') return null;
      const patron = (v.find((x) => x.col === 'comercio') || {}).val || '';
      return patron.indexOf(' ') >= 0 ? BOOM : null;
    };
    const res = await transactions.recategorizarTransaccion('u-1', 'Starbucks Lima', 'Comida');
    expect(res.ok).toBe(false);
    expect(res.msg, 'una caída se anunció como "no encontré ninguna transacción"').toMatch(/No pude buscar/i);
    expect(tagsLogueados()).toContain('RECATEGORIZAR');
  });

  /**
   * Y el reintento PALABRA POR PALABRA por separado, que es un sitio distinto aunque la forma
   * sea la misma: es el último recurso antes de "no encontré nada", así que si cae y el bucle
   * sigue, el mensaje afirma que se buscó. Un caso por FORMA en vez de por SITIO dejaba viva
   * esta mutación (la lección de los cuatro `reminder_dN` del ítem 7).
   */
  it('y el reintento por palabra tampoco puede caer en silencio', async () => {
    tablas.transacciones = DE_STARBUCKS;
    // La primera lectura (`%Starbucks Wong%`) no encuentra nada y devuelve []; la del
    // reintento, con una sola palabra, es la que cae.
    fallar = (t, v, op) => {
      if (t !== 'transacciones' || op !== 'select') return null;
      const patron = (v.find((x) => x.col === 'comercio') || {}).val || '';
      return patron.indexOf(' ') === -1 ? BOOM : null;
    };
    const res = await transactions.recategorizarTransaccion('u-1', 'Starbucks Wong', 'Comida');
    expect(res.ok).toBe(false);
    expect(res.msg, 'el reintento cayó y el mensaje dijo que no había gastos').toMatch(/No pude buscar/i);
  });

  /**
   * `corregirTransaccionEspecifica` es el patrón builder (`let query = supabase…`) y devuelve
   * `{ ok, comercio }`, sin `msg`. El motivo discriminado es lo que le permite al bucle de
   * correcciones múltiples imprimir la línea correcta sin abortar las demás.
   */
  it('la corrección específica distingue "no existe" de "no pude buscarlo"', async () => {
    tablas.transacciones = DE_STARBUCKS;
    const sinFallo = await transactions.corregirTransaccionEspecifica('u-1', 'Wong', null, null, 'Comida', null);
    expect(sinFallo).toEqual({ ok: false, comercio: 'Wong' });

    fallar = (t, v, op) => (t === 'transacciones' && op === 'select' ? BOOM : null);
    const conFallo = await transactions.corregirTransaccionEspecifica('u-1', 'Starbucks Lima', null, null, 'Comida', null);
    expect(conFallo.motivo, 'una caída se reportó igual que un comercio inexistente').toBe('error');
    expect(tagsLogueados()).toContain('CORREGIR_TX');
  });

  /** El `update` de la retroaplicación: 0 es el número cierto, pero no puede anunciarse solo. */
  it('una retroaplicación rechazada no se anuncia como hecha', async () => {
    tablas.transacciones = DE_STARBUCKS;
    fallar = (t, v, op) => (t === 'transacciones' && op === 'update' ? BOOM : null);
    await expect(transactions.retroaplicarRegla('u-1', 'Starbucks', 'Comida', null)).resolves.toBe(0);
    expect(tagsLogueados()).toContain('RETROAPLICAR');
  });

  it('control: una retroaplicación que sí aplica devuelve su conteo', async () => {
    tablas.transacciones = DE_STARBUCKS;
    await expect(transactions.retroaplicarRegla('u-1', 'Starbucks', 'Comida', null)).resolves.toBe(1);
    // Y que el conteo lo haya PEDIDO. Sin esto el caso pasaba igual con el `{ count: 'exact' }`
    // borrado, porque el mock devuelve `count` siempre: el número que se le anuncia al usuario
    // venía del mock y no del código.
    const upd = escrituras.find((e) => e.tabla === 'transacciones' && e.op === 'update');
    expect(upd && upd.opts, 'el update dejó de pedir el conteo exacto').toMatchObject({ count: 'exact' });
  });
});

describe('la alerta de presupuesto se calla, pero no en silencio', () => {
  const PRESUPUESTO = [{ id: 'p-1', usuario_id: 'u-1', mes: 8, anio: 2026, categoria: 'Comida', subcategoria: null, monto_limite: '100', alerta_porcentaje: 80 }];
  const GASTOS = [{ id: 'g1', usuario_id: 'u-1', tipo: 'gasto', fecha: '2026-08-11', monto: 95, monto_pen: 95, categoria: 'Comida' }];
  const USUARIO_PRO = { ...USUARIO, plan: 'premium' };

  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    tablas.presupuestos = PRESUPUESTO;
    tablas.transacciones = GASTOS;
  });

  it('control: al 95% del límite, la alerta sale', async () => {
    const alerta = await budget.verificarAlertaPresupuesto(USUARIO_PRO, 'Comida', null);
    expect(alerta, 'el camino a la alerta no se recorre: los casos de abajo no probarían nada').toMatch(/95/);
  });

  /**
   * **Acá NO se lanza, y es la decisión del ítem.** Esta función corre DESPUÉS de que el gasto
   * se escribió, pegada a su confirmación: un throw se llevaría puesta la confirmación de un
   * gasto que sí quedó guardado. La alerta se pierde y queda dicho.
   */
  it('si no se puede leer el presupuesto, el gasto se confirma sin alerta y queda el log', async () => {
    fallar = (t) => (t === 'presupuestos' ? BOOM : null);
    await expect(budget.verificarAlertaPresupuesto(USUARIO_PRO, 'Comida', null)).resolves.toBeNull();
    expect(tagsLogueados(), 'la alerta no salió y nadie se enteró de por qué').toContain('PRESUPUESTO');
  });

  /**
   * La otra query del mismo `Promise.all`, y hace falta su propio caso: con los gastos en null
   * el total da 0 y tampoco sale alerta, o sea que el síntoma es idéntico. Un caso por
   * `Promise.all` en vez de por elemento dejaba viva la mitad.
   */
  it('y si no se pueden leer los gastos del mes, tampoco se inventa una alerta', async () => {
    fallar = (t, v, op) => (t === 'transacciones' && op === 'select' ? BOOM : null);
    await expect(budget.verificarAlertaPresupuesto(USUARIO_PRO, 'Comida', null)).resolves.toBeNull();
    expect(tagsLogueados()).toContain('PRESUPUESTO');
  });

  /**
   * `formatearEstadoPresupuesto` sí lanza, y la diferencia con la de arriba es lo que se
   * IMPRIME: con `allTxs` en null cada categoría sale con "S/ 0.00 / S/ 100" y la barra vacía.
   * No es un bloque que falta, es el número de plata que más daño hace.
   */
  it('control: el estado del presupuesto imprime lo gastado', async () => {
    await expect(budget.formatearEstadoPresupuesto('u-1')).resolves.toMatch(/95\.00/);
  });

  it('y no se imprime "S/ 0.00 gastado" cuando lo que falló fue la lectura', async () => {
    fallar = (t, v, op) => (t === 'transacciones' && op === 'select' ? BOOM : null);
    await expect(budget.formatearEstadoPresupuesto('u-1')).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('el árbol de categorías: no tener y no poder preguntar no son lo mismo', () => {
  const ARBOL = [
    { id: 'c-1', usuario_id: 'u-1', nombre: 'Comida', padre_id: null, activa: true, created_at: '2026-01-01T00:00:00Z' },
    { id: 'c-2', usuario_id: 'u-1', nombre: 'Cafeteria', padre_id: 'c-1', activa: true, created_at: '2026-01-01T00:00:00Z' },
  ];

  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    tablas.categorias_usuario = ARBOL;
  });

  it('control: el árbol se lee con sus subcategorías', async () => {
    const cats = await categories.obtenerCategoriasUsuario('u-1');
    expect(cats).toHaveLength(1);
    expect(cats[0].subcategorias).toHaveLength(1);
  });

  it('control: un usuario sin árbol propio devuelve null', async () => {
    tablas.categorias_usuario = [];
    await expect(categories.obtenerCategoriasUsuario('u-1')).resolves.toBeNull();
  });

  /**
   * **El `null` de esta lectura no es cosmético: `webhook.js` ramifica por él para ofrecer el
   * MENÚ de onboarding, y el de `/categorias` además escribe `onboarding_paso: 10`.** O sea que
   * una lectura caída le ofrecía volver a elegir sus categorías a alguien que ya las tiene, y
   * el número que escribiera después entraba a `crearCategoriasDesdeIndices` sobre un árbol
   * lleno.
   */
  it('si el árbol no se puede leer, NO se responde que el usuario no tiene árbol', async () => {
    fallar = (t) => (t === 'categorias_usuario' ? BOOM : null);
    await expect(categories.obtenerCategoriasUsuario('u-1')).rejects.toMatchObject({ message: 'boom' });
  });

  /**
   * Y su contraprueba de call-site, que es la mitad que le da sentido al throw: en el camino
   * del gasto el árbol es ACCESORIO —agrega categorías al prompt, no lo reemplaza— y
   * `handlers/intents/transacciones.js` dispara esta función como promesa suelta. Un rechazo
   * acá se llevaría puesto el registro del gasto para salvar su etiqueta.
   */
  it('pero clasificar un gasto degrada a las canónicas en vez de romperse', async () => {
    fallar = (t) => (t === 'categorias_usuario' ? BOOM : null);
    openaiMock.openai.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '{"categoria":"Transporte","subcategoria":null}' } }],
    });
    await expect(categories.detectarCategoriaIA('taxi 20', 'u-1'),
      'un fallo al leer el árbol se llevó puesta la clasificación del gasto')
      .resolves.toMatchObject({ categoria: 'Transporte' });
    expect(tagsWarn(), 'degradó a las canónicas sin decirlo').toContain('CATEGORIAS');
  });

  it('control: buscar una raíz que existe la encuentra', async () => {
    await expect(categories.crearCategoriaLibreUsuario('u-1', 'Comida')).resolves.toBeUndefined();
    expect(escrituras.filter((e) => e.tabla === 'categorias_usuario'),
      'la raíz ya existía y se insertó igual').toEqual([]);
  });

  /**
   * `buscarCategoriaRaiz` es el dedup de raíces, y su `null` se lee de dos maneras opuestas
   * según quién pregunta: "no existe, creala" o "no hay dónde colgar la subcategoría". Una
   * lectura caída rompe las dos. No lleva excepción de `PGRST116`: es `.limit(1)`.
   */
  it('una raíz que no se puede buscar no se responde como una raíz que no existe', async () => {
    fallar = (t, v, op) => (t === 'categorias_usuario' && op === 'select' ? BOOM : null);
    await expect(categories.crearCategoriaLibreUsuario('u-1', 'Comida')).resolves.toBeUndefined();
    expect(escrituras.filter((e) => e.tabla === 'categorias_usuario' && e.op === 'insert'),
      'con la lectura caída se insertó una raíz que podía estar duplicada').toEqual([]);
    expect(tagsWarn(), 'el fallo entró por la misma puerta que "no existe"').toContain('CATEGORIAS');
  });

  /**
   * El catch de `crearSubcategoriaLibreUsuario` era `/* silencioso *\/`, o sea que cualquier
   * arreglo de sus dos queries habría sido decorativo — un `throw` cuyo destino es un catch
   * mudo compra el mismo silencio que el `return` que se saca (`verificarRachaAportes`, ítem 7).
   */
  it('el dedup de subcategorías caído no inserta la subcategoría duplicada', async () => {
    // El VALOR de `padre_id` es lo único que separa las dos lecturas: `buscarCategoriaRaiz`
    // filtra `is('padre_id', null)` y este dedup `eq('padre_id', padre.id)`. Con `filtro(v,
    // 'padre_id')` a secas caía la PRIMERA, la función salía por el throw de esa otra guarda,
    // y este caso pasaba sin haber ejercitado nunca el dedup. Lo encontró el mutador.
    fallar = (t, v, op) => (t === 'categorias_usuario' && op === 'select' && v.some((x) => x.col === 'padre_id' && x.val) ? BOOM : null);
    await categories.crearSubcategoriaLibreUsuario('u-1', 'Comida', 'Postres');
    expect(escrituras.filter((e) => e.op === 'insert'),
      'no se pudo comprobar si ya existía y se insertó igual').toEqual([]);
    expect(tagsWarn(), 'el catch silencioso se tragó el fallo').toContain('CATEGORIAS');
  });

  it('control: una subcategoría nueva sí se crea', async () => {
    await categories.crearSubcategoriaLibreUsuario('u-1', 'Comida', 'Postres');
    expect(escrituras.filter((e) => e.op === 'insert' && e.patch && e.patch.nombre === 'Postres')).toHaveLength(1);
  });

  /** Y la ESCRITURA de esa misma función, que es la otra mitad del trinquete. */
  it('una subcategoría que no se pudo escribir deja rastro', async () => {
    fallar = (t, v, op) => (t === 'categorias_usuario' && op === 'insert' ? BOOM : null);
    await categories.crearSubcategoriaLibreUsuario('u-1', 'Comida', 'Postres');
    expect(tagsWarn(), 'el insert fue rechazado y la subcategoría desapareció sin una línea').toContain('CATEGORIAS');
  });

  /**
   * El onboarding: `crearCategoriasDesdeIndices` corre desde `handlers/onboarding.js`, que no
   * tiene catch. Por eso el try es por ITERACIÓN — un throw que suba deja al usuario sin
   * respuesta y clavado en el paso 10, y las categorías que sí se pudieron crear se pierden.
   */
  it('en el onboarding, una raíz que no se puede releer no tumba las demás', async () => {
    tablas.categorias_usuario = [];
    fallar = (t, v, op) => {
      if (t !== 'categorias_usuario') return null;
      if (op === 'insert') return { code: '23505', message: 'duplicate key' };
      return BOOM;
    };
    await expect(categories.crearCategoriasDesdeIndices('u-1', [1, 2]),
      'el throw subió hasta el onboarding').resolves.toBeUndefined();
    expect(tagsWarn()).toContain('CATEGORIAS');
  });

  /** La escritura de las subcategorías del onboarding: accesoria, pero no muda. */
  it('una subcategoría del onboarding rechazada deja rastro', async () => {
    tablas.categorias_usuario = [];
    // Falla SOLO el insert de las subcategorías (las que llevan `padre_id`).
    fallar = (t, v, op, patch) => (t === 'categorias_usuario' && op === 'insert' && patch && patch.padre_id ? BOOM : null);
    await categories.crearCategoriasDesdeIndices('u-1', [1]);
    expect(tagsWarn(), 'las subcategorías del onboarding se perdieron en silencio').toContain('CATEGORIAS');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 10. Las guardas PREEXISTENTES de estos tres archivos, que nada sostenía.
// ───────────────────────────────────────────────────────────────────────────
/**
 * **No arreglan nada: cubren.** La prueba por mutación del ítem 7 midió 37 guardas del
 * perímetro que ya estaban arregladas y que ninguna mutación mataba — o sea que existían,
 * hacían lo correcto, y nada las sostenía si alguien las revertía. Con el mutador viendo
 * además las guardas `if (error && …)` (la forma obligada de todo `.single()`, porque
 * `PGRST116` es "cero filas" y no un fallo), la cuenta subió a 43.
 *
 * Acá se cierran las **ocho que viven en los tres archivos de este ítem**, para que la
 * afirmación "estos tres archivos están barridos" sea cierta en los dos sentidos: no queda
 * lectura muda, y no queda guarda sin quien la sostenga. Las 35 restantes viven en
 * `neto-score`, `shared-spaces`, `debts`, `summaries`, `survey-triggers`, `spending-alerts`,
 * `metas`, `subscriptions/detector`, `recommendations` y `cron/checks.js`, y siguen abiertas.
 */
describe('las guardas que ya estaban y nada sostenía', () => {
  const UNA_TX = [{ id: 'g1', usuario_id: 'u-1', tipo: 'gasto', comercio: 'Starbucks', fecha: '2026-08-19', monto: 20, categoria: 'Otros', created_at: '2026-08-19T10:00:00Z' }];

  beforeEach(() => {
    vi.setSystemTime(enLima('2026-08-20T10:00:00'));
    tablas.transacciones = UNA_TX;
  });

  /** El `update` de `recategorizarTransaccion`: la lectura encuentra la fila y la escritura falla. */
  it('un update rechazado no se responde como "Listo, lo movi"', async () => {
    fallar = (t, v, op) => (t === 'transacciones' && op === 'update' ? BOOM : null);
    const res = await transactions.recategorizarTransaccion('u-1', 'Starbucks', 'Comida');
    expect(res.ok).toBe(false);
    expect(res.msg).toMatch(/Error actualizando/i);
  });

  /** El mismo update, por id. Es otra función y otra guarda, aunque la forma sea la misma. */
  it('recategorizar por id tampoco anuncia un cambio que no se escribió', async () => {
    fallar = (t, v, op) => (t === 'transacciones' && op === 'update' ? BOOM : null);
    await expect(transactions.recategorizarPorId('g1', 'Comida')).resolves.toEqual({ ok: false, msg: 'Error actualizando.' });
  });

  it('control: por id, sin fallo, aplica', async () => {
    await expect(transactions.recategorizarPorId('g1', 'Comida')).resolves.toEqual({ ok: true });
  });

  /** El update de `corregirTransaccionEspecifica`, que devuelve `{ ok:false, comercio }`. */
  /**
   * **`ok: false` no alcanza como aserción acá, y esa es la lección del caso.** Un comercio que
   * no existe devuelve `ok: false` igual, así que el test pasaba con las dos hipótesis — y con
   * eso dejó pasar un defecto real: el update rechazado devolvía `{ ok:false, comercio }`, la
   * forma EXACTA de "no existe", y el bucle de correcciones imprimía "no encontré gasto de X"
   * sobre un gasto que acababa de leer. Lo encontró la revisión adversarial; la aserción que
   * lo habría atrapado es la del `motivo`.
   */
  it('la corrección específica no confirma un update rechazado', async () => {
    fallar = (t, v, op) => (t === 'transacciones' && op === 'update' ? BOOM : null);
    const res = await transactions.corregirTransaccionEspecifica('u-1', 'Starbucks', null, null, 'Comida', null);
    expect(res.ok).toBe(false);
    expect(res.motivo, 'un update rechazado se reportó con la misma forma que un comercio inexistente').toBe('error');
    expect(tagsLogueados()).toContain('CORREGIR_TX');
  });

  /**
   * La guarda `} else if (error)` del onboarding, que el mutador no veía por anclar en el `if`
   * a principio de línea — el mismo punto ciego que su docblock declara haber cerrado para la
   * disyunción, un `else` más allá. Es el fallo NO-23505 al crear la raíz: no es la carrera del
   * índice único, es un rechazo de verdad, y sin el log el usuario se queda sin la categoría
   * que eligió y sin una línea que lo diga.
   */
  it('una raíz del onboarding rechazada por un fallo real deja rastro', async () => {
    tablas.categorias_usuario = [];
    fallar = (t, v, op, patch) => (t === 'categorias_usuario' && op === 'insert' && patch && !patch.padre_id ? BOOM : null);
    await categories.crearCategoriasDesdeIndices('u-1', [1]);
    expect(tagsWarn(), 'la raíz fue rechazada y el onboarding siguió sin decirlo').toContain('CATEGORIAS');
    expect(escrituras.filter((e) => e.op === 'insert' && e.patch && e.patch.padre_id),
      'sin raíz no hay dónde colgar subcategorías, y se colgaron igual').toEqual([]);
  });

  /**
   * El `upsert` de la regla. Su docblock cuenta por qué existe la guarda —el llamador anunciaba
   * "✅ Regla creada" sin una sola fila en `reglas_comercio`— y aun así nada la sostenía.
   */
  it('una regla que no se pudo escribir no se anuncia como creada', async () => {
    fallar = (t, v, op) => (t === 'reglas_comercio' && op === 'upsert' ? BOOM : null);
    const res = await transactions.guardarReglaComercio('u-1', 'Starbucks', 'Alimentación', 'Cafeteria');
    expect(res).toEqual({ ok: false, motivo: 'error' });
    expect(tagsLogueados()).toContain('REGLA');
  });

  it('control: una regla que sí se escribe vuelve con su destino', async () => {
    const res = await transactions.guardarReglaComercio('u-1', 'Starbucks', 'Alimentación', 'Cafeteria');
    expect(res.ok).toBe(true);
    expect(res.destino.categoria).toBe('Alimentación');
  });

  /** El `upsert` del presupuesto: es plata que el usuario cree haber configurado. */
  it('un presupuesto que no se pudo guardar no se responde como configurado', async () => {
    fallar = (t, v, op) => (t === 'presupuestos' && op === 'upsert' ? BOOM : null);
    await expect(budget.guardarPresupuesto('u-1', 'Comida', 500)).rejects.toMatchObject({ message: 'boom' });
  });

  it('control: el presupuesto se guarda y vuelve la fila', async () => {
    await expect(budget.guardarPresupuesto('u-1', 'Comida', 500)).resolves.toMatchObject({ monto_limite: 500 });
  });

  /**
   * La rama `23505` del onboarding: la raíz ya existía, y las subcategorías se cuelgan de la
   * que está. Sin esta rama, el `else if (error)` la trata como fallo, `padreId` queda en null
   * y el usuario se lleva la raíz sin una sola subcategoría — el síntoma que el comentario del
   * propio código describe.
   */
  it('en el onboarding, una raíz que ya existía igual recibe sus subcategorías', async () => {
    tablas.categorias_usuario = [{ id: 'c-1', usuario_id: 'u-1', nombre: 'Alimentación', padre_id: null, activa: true, created_at: '2026-01-01T00:00:00Z' }];
    fallar = (t, v, op, patch) => (t === 'categorias_usuario' && op === 'insert' && patch && !patch.padre_id
      ? { code: '23505', message: 'duplicate key' } : null);
    await categories.crearCategoriasDesdeIndices('u-1', [1]);
    const subs = escrituras.filter((e) => e.op === 'insert' && e.patch && e.patch.padre_id === 'c-1');
    expect(subs.length, 'la raíz ya existía y las subcategorías no se colgaron de ella').toBeGreaterThan(0);
  });

  /**
   * `crearCategoriaLibreUsuario` distingue el `23505` —que acá es CORRECTO, porque entre la
   * búsqueda y el insert hay un await a OpenAI y otro mensaje pudo crear la raíz— de un fallo
   * real. Las dos direcciones, porque una sola deja pasar la mutación por el otro lado.
   */
  it('una categoría libre rechazada por un fallo real deja rastro', async () => {
    tablas.categorias_usuario = [];
    fallar = (t, v, op) => (t === 'categorias_usuario' && op === 'insert' ? BOOM : null);
    await categories.crearCategoriaLibreUsuario('u-1', 'Comida casera');
    expect(tagsWarn()).toContain('CATEGORIAS');
  });

  it('pero perder la carrera del índice único NO es un fallo que loguear', async () => {
    tablas.categorias_usuario = [];
    fallar = (t, v, op) => (t === 'categorias_usuario' && op === 'insert' ? { code: '23505', message: 'duplicate key' } : null);
    await categories.crearCategoriaLibreUsuario('u-1', 'Comida casera');
    expect(tagsWarn(), 'la carrera que el índice único cierra se reportó como fallo').toEqual([]);
  });

  /**
   * Y el veredicto de `asegurarCategoriaUsuario`, que su propio docblock justifica: sin
   * distinguir `'error'` de `'ya-existe'`, un fallo de programación es indistinguible de una
   * decisión correcta.
   */
  it('asegurar una categoría distingue el fallo real del 23505', async () => {
    const ARBOL = [{ id: 'c-1', usuario_id: 'u-1', nombre: 'Comida casera', padre_id: null, activa: true, created_at: '2026-01-01T00:00:00Z' }];
    tablas.categorias_usuario = ARBOL;
    fallar = (t, v, op) => (t === 'categorias_usuario' && op === 'insert' ? BOOM : null);
    await expect(categories.asegurarCategoriaUsuario('u-1', 'Transporte')).resolves.toBe('error');

    tablas.categorias_usuario = ARBOL;
    fallar = (t, v, op) => (t === 'categorias_usuario' && op === 'insert' ? { code: '23505', message: 'duplicate key' } : null);
    await expect(categories.asegurarCategoriaUsuario('u-1', 'Transporte'),
      'la carrera que gana el índice único se reportó como error').resolves.toBe('ya-existe');
  });
});
