import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * Los dos wake-up de `services/survey-triggers.js` están APAGADOS desde el 14-sep-2026, y esto
 * es lo que impide que vuelvan sin que nadie lo decida.
 *
 * ─── Por qué se apagaron, con los números medidos ese día ───────────────────────────────
 *
 * `wake_up_inactive` (30+ días desde el alta y 0 gastos en 30 días) y `wake_up_onboarding` (7+
 * días con el alta a medias) persiguen, por definición, a quien no le escribe a Neto hace
 * semanas: la población que está fuera de la ventana de 24h de Meta por construcción. Medido
 * contra producción sobre 30 días:
 *
 *   · `survey_wake_up_inactive`: 32 WhatsApp enviados y **0 entregados**, los 32 con 131047. En
 *     toda su historia en `notification_deliveries`, 56 intentos y 0 entregas. La campana: 41
 *     filas y **0 leídas**, y 16 de los 34 destinatarios reales no tienen cuenta web, así que su
 *     fila no la ve nadie.
 *   · `survey_wake_up_onboarding`: 10 intentos en toda su historia, 0 entregados.
 *
 * Es el argumento que apagó el recordatorio de inactividad el 01-sep
 * (`tests/cron/inactividad-apagada.test.js`). Ese apagado dejó vivo a `wake_up_inactive` porque
 * "bifurca nuevo/churn", pero bifurcar el copy no cambia a quién le llega. Y apagar al hermano lo
 * empeoró: sus filas en `survey_events` tenían ocupada la anti-fatiga de 7 días, y al desaparecer
 * soltaron la cola. El 07-sep salieron 14 wake_up, 13 de ellos a gente cuyo último empuje era un
 * `inactivity_reminder` del 29 o 31-ago.
 *
 * ─── Por qué es de COMPORTAMIENTO, y por qué la población es una MATRIZ ─────────────────
 *
 * Un grep sobre `wake_up_inactive` se pondría rojo por su propia documentación. Acá se corre el
 * cron sobre quien antes lo recibía y se afirma que no le llega NADA, con ningún `tipo`: volver a
 * prenderlo con otro nombre es la forma barata de evadir este archivo.
 *
 * La primera versión tenía un fixture por perfil (45 y 60 días de inactivo, 20 de alta a
 * medias) y barría un solo día. La revisión adversarial le metió cinco reintroducciones que
 * dejaban la suite ENTERA en verde: umbral de 90 días, alta a medias a los 21, solo el día 1 del
 * mes, solo `plan === 'free'`, y reusar `enviarYRegistrar` a los 90 días (esta última no mueve
 * ningún conteo estático). O sea que el guard vigilaba sus fixtures, no la población. De ahí:
 *
 *   · las EDADES barren el rango, no un punto: 31 a 365 días de inactividad, 8 a 180 de alta a
 *     medias. Arrancan justo arriba de las ventanas que SÍ siguen vivas (`reminder_d3`/`d7`
 *     alcanzan a quien no terminó el alta, `reminder_d30` es el día 30), así que ningún trigger
 *     legítimo puede tocar a un fixture y el "nada" es exacto;
 *   · los PERFILES cubren cada forma de dirección (número, solo BSUID, solo cuenta web) y cada
 *     PLAN (muro, trial, pagado), y todos tienen `email`: un "arreglo" que lo mande solo por
 *     correo o solo al free tiene que tener a quién;
 *   · se barre un MES hora por hora, con el día 1 y los siete días de la semana adentro;
 *   · y además de `notificarUsuario` se miran los tres canales crudos, por si alguien vuelve a
 *     mandarlo por fuera del chokepoint.
 *
 * Con un CONTROL en la misma corrida, de dos puntas: `reminder_d3` el primer día y `reminder_d14`
 * once días después. La primera prueba que el runner corre; la segunda, que el barrido de verdad
 * avanza por el mes y que la anti-fatiga no lo trabó.
 *
 * ─── Lo que este archivo NO cubre ───────────────────────────────────────────────────────
 *
 * Corre `checkSurveyTriggers` y nada más. El mismo empuje escrito como cron nuevo en
 * `cron/checks.js` no pasa por acá: ahí lo frena `tests/cron/lecturas-proactivas.test.js` (todo
 * cron que empuja declara su gate de plan), no esta matriz. Y un umbral por encima de 395 días
 * (365 + el mes barrido) tampoco lo ve.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/** Todo INSERT, para afirmar que no se reclama el one-shot de un aviso apagado. */
let inserts = [];

const notificar = vi.fn().mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: false } });
// Los tres canales crudos, espiados: el chokepoint está mockeado, así que cualquier llamada que
// aparezca acá salió POR FUERA de `notificarUsuario`.
const enviarWhatsapp = vi.fn().mockResolvedValue({ ok: true });
const crearNotificacion = vi.fn().mockResolvedValue(true);
const enviarEmail = vi.fn().mockResolvedValue({ ok: true });

function makeChain(table) {
  const filtros = [];
  let esConteo = false;
  let tope = null;
  const chain = {};
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
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => f[col] !== val); return chain; };
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
    if (val === null) filtros.push((f) => f[col] === null || f[col] === undefined);
    return chain;
  };
  chain.not = (col, op, val) => {
    if (op === 'is' && val === null) filtros.push((f) => f[col] !== null && f[col] !== undefined);
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
      // El insert devuelve la fila escrita y la deja en `tablas`: `registrarEvento` corta con
      // `if (!eventoId) return false`, así que un doble que devolviera vacío apagaría los
      // one-shot por su cuenta y este archivo saldría verde sin que el código los apague. Y la
      // anti-fatiga lee esas filas en la corrida siguiente, igual que en producción.
      insert: (patch) => {
        inserts.push({ tabla: t, patch });
        const fila = { id: 'ev-' + inserts.length, ...patch };
        (tablas[t] = tablas[t] || []).push(fila);
        const c = makeChain(t);
        c.single = () => Promise.resolve({ data: fila, error: null });
        return c;
      },
      update: () => makeChain(t),
      delete: () => makeChain(t),
    })),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

function stub(rel, exports) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('lib/db.js', dbMock);
stub('lib/logger.js', logMock);
stub('lib/notifications-db.js', { crearNotificacion });
stub('lib/whatsapp.js', { enviarWhatsapp });
stub('lib/email.js', { enviarEmail });

// Se preserva `CANALES`: `survey-triggers` lo desestructura al cargar.
const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};

const { checkSurveyTriggers } = require('../../services/survey-triggers');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

/** 10:05 de Lima del primer día barrido: las edades de los fixtures se miden desde acá. */
const A_LAS_DIEZ = new Date('2026-09-14T10:05:00-05:00');
const haceDias = (d) => new Date(A_LAS_DIEZ.getTime() - d * 86400000).toISOString();
/** 14-sep → 14-oct: adentro caen el 1-oct y los siete días de la semana. */
const DIAS_BARRIDOS = 31;

/** Cómo le llegaba el aviso: por número, solo por BSUID (sin número visible), o solo por la web. */
const DIRECCIONES = {
  numeroConWeb: { whatsapp: '51999', bsuid: null, conWeb: true },
  numeroSinWeb: { whatsapp: '51998', bsuid: null, conWeb: false },
  soloWeb: { whatsapp: null, bsuid: null, conWeb: true },
  soloBsuid: { whatsapp: null, bsuid: 'PE.qa', conWeb: false },
};
/** Las tres caras de `plan`: el muro, el trial (plan premium sin pagar) y el que paga. */
const PLANES = {
  muro: { plan: 'free', trial_estado: 'vencido' },
  trial: { plan: 'premium', trial_estado: 'activo' },
  pagado: { plan: 'premium', trial_estado: 'convertido', estado_pago: 'pagado' },
};

function fixture(tag, { edad, dir, plan, alta = true }) {
  const id = `u-${tag}-${edad}-${dir}-${plan}`;
  const d = DIRECCIONES[dir];
  return {
    id, nombre: 'Persona ' + tag,
    whatsapp: d.whatsapp ? d.whatsapp + String(edad).padStart(4, '0') : null,
    bsuid: d.bsuid ? d.bsuid + id : null,
    supabase_auth_id: d.conWeb ? 'auth-' + id : null,
    email: id + '@example.com',
    ...PLANES[plan],
    recordatorios_activos: true, cuenta_borrada_at: null, is_test_user: false,
    onboarding_completado: alta, onboarding_paso: alta ? 0 : 100,
    created_at: haceDias(edad),
  };
}

/** Todas las edades con un perfil fijo, más todos los perfiles × planes con una edad fija. */
function matriz(tag, edades, edadFija, extra = {}) {
  const filas = new Map();
  for (const edad of edades) {
    const f = fixture(tag, { edad, dir: 'numeroSinWeb', plan: 'muro', ...extra });
    filas.set(f.id, f);
  }
  for (const dir of Object.keys(DIRECCIONES)) {
    for (const plan of Object.keys(PLANES)) {
      const f = fixture(tag, { edad: edadFija, dir, plan, ...extra });
      filas.set(f.id, f);
    }
  }
  return [...filas.values()];
}

// Arrancan en 31 y no en 30 a propósito: `reminder_d30` sigue vivo en [30, 31) y tocaría al
// fixture del borde, que es justo el que no tiene que recibir nada.
const INACTIVOS = matriz('inact', [31, 45, 90, 180, 365], 45);
// Los que usaron y dejaron de usar (la rama "churn" del copy viejo): un gasto el día del alta,
// o sea más de 30 días antes del primer día barrido.
const CHURN = matriz('churn', [31, 90], 60);
const TX_CHURN = CHURN.map((u, i) => ({ id: 'tx-' + i, usuario_id: u.id, fecha: u.created_at.split('T')[0], created_at: u.created_at }));
// Arrancan en 8: `reminder_d3` y `reminder_d7` exigen 0 gastos y NO el alta cerrada, así que en
// [3, 4) y [7, 8) le llegan legítimamente a quien quedó a medias.
const A_MEDIAS = matriz('medias', [8, 21, 60, 180], 21, { alta: false });

/** El que la corrida SÍ tiene que alcanzar. Con número y alta cerrada, así califica para d3 y d14. */
const CONTROL = {
  ...fixture('control', { edad: 3.2, dir: 'numeroConWeb', plan: 'trial' }),
  id: 'u-control',
};

/**
 * Un mes, hora por hora, sobre la MISMA tabla: lo que una corrida escribe lo ve la siguiente,
 * igual que en producción. Mover el gate horario o limitar el aviso a un día del mes o de la
 * semana son formas baratas de "arreglarlo" sin que un caso puntual se entere.
 */
async function barrerUnMes(usuarios, txs = []) {
  tablas = { usuarios, transacciones: txs, survey_events: [], errores: [], nlp_errors: [] };
  inserts = [];
  for (const fn of [notificar, enviarWhatsapp, crearNotificacion, enviarEmail]) fn.mockClear();
  const inicio = new Date('2026-09-14T00:05:00-05:00').getTime();
  for (let h = 0; h < DIAS_BARRIDOS * 24; h++) {
    vi.setSystemTime(new Date(inicio + h * 3600000));
    await checkSurveyTriggers();
  }
}

const tiposDe = (userId) => notificar.mock.calls.map((c) => c[0]).filter((a) => a.usuarioId === userId).map((a) => a.tipo);

/** Todo lo que les llegó a estos usuarios, por el chokepoint o por fuera de él. */
function loQueLesLlego(usuarios) {
  const ids = new Set(usuarios.map((u) => u.id));
  const direcciones = new Set(usuarios.flatMap((u) => [u.whatsapp, u.bsuid, u.email]).filter(Boolean));
  const deEllos = (x) => ids.has(x) || direcciones.has(x);
  return [
    ...notificar.mock.calls.map((c) => c[0]).filter((a) => deEllos(a.usuarioId))
      .map((a) => `notificarUsuario ${a.usuarioId} ${a.tipo}`),
    ...enviarWhatsapp.mock.calls.filter(([to, , o]) => deEllos(to) || deEllos(o && o.usuarioId))
      .map(([to]) => `enviarWhatsapp crudo a ${to}`),
    ...crearNotificacion.mock.calls.filter(([uid]) => deEllos(uid)).map(([uid, , titulo]) => `campana cruda ${uid} "${titulo}"`),
    ...enviarEmail.mock.calls.filter(([to, o]) => deEllos(to) || deEllos(o && o.usuarioId))
      .map(([to]) => `correo crudo a ${to}`),
    ...inserts.filter((i) => i.tabla === 'survey_events' && deEllos(i.patch.user_id))
      .map((i) => `survey_events ${i.patch.user_id} ${i.patch.event_type}`),
  ];
}

beforeEach(() => {
  notificar.mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: false } });
  logMock.error.mockClear();
});

describe('los dos wake_up están apagados y no vuelven solos', () => {
  it('la matriz cubre lo que dice cubrir (antivacuidad)', () => {
    // Si alguien achica las listas, lo de abajo sigue verde mirando menos. Cada número es
    // edades + 4 direcciones × 3 planes, menos el fixture que cae en las dos mitades cuando la
    // edad fija también está en el rango (45 en inactivos, 21 en alta a medias).
    expect(INACTIVOS.length).toBe(5 + 12 - 1);
    expect(CHURN.length).toBe(2 + 12);
    expect(A_MEDIAS.length).toBe(4 + 12 - 1);
    const todos = [...INACTIVOS, ...CHURN, ...A_MEDIAS];
    expect(new Set(todos.map((u) => u.plan + '/' + u.trial_estado)).size).toBe(3);
    expect(todos.every((u) => u.email)).toBe(true);
    expect(todos.some((u) => u.bsuid && !u.whatsapp)).toBe(true);
  });

  it('quien lleva 30+ días sin anotar no recibe nada de este cron, por ningún canal', async () => {
    await barrerUnMes([...INACTIVOS, ...CHURN, CONTROL], TX_CHURN);

    expect(tiposDe('u-control'), 'el control no salió: el barrido no ejercitó el runner y este caso no prueba nada')
      .toEqual(expect.arrayContaining(['survey_reminder_d3', 'survey_reminder_d14']));
    expect(loQueLesLlego([...INACTIVOS, ...CHURN]), 'un empuje de reactivación volvió').toEqual([]);
    expect(logMock.error, 'el runner reventó: el silencio de arriba sería un crash, no un apagado').not.toHaveBeenCalled();
  });

  it('quien quedó a medias en el alta no recibe nada de este cron, por ningún canal', async () => {
    await barrerUnMes([...A_MEDIAS, CONTROL]);

    expect(tiposDe('u-control'), 'el control no salió: el barrido no ejercitó el runner')
      .toEqual(expect.arrayContaining(['survey_reminder_d3', 'survey_reminder_d14']));
    expect(loQueLesLlego(A_MEDIAS), 'un empuje para terminar el alta volvió').toEqual([]);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
