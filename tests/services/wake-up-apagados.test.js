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
 * ─── La regla es una LISTA CERRADA, no una población ────────────────────────────────────
 *
 * Este archivo se escribió dos veces afirmando que su población de fixtures era "quien antes lo
 * recibía", y dos revisiones adversariales seguidas lo evadieron con la misma jugada: condicionar
 * el empuje a una subpoblación sin fixture (90 días, alta a medias a los 21, solo el día 1 del
 * mes, solo el free; después churn con 3+ gastos, paso 101, sin nombre, pagado con 90+ días, una
 * ventana en el día 150). Una población finita siempre deja afuera a la siguiente. Así que la
 * regla se invirtió: `TRIGGERS`, la lista que corre el cron, está FIJADA acá. Cualquier trigger
 * nuevo la rompe, apunte a quien apunte, y quien la toque se encuentra con este docblock.
 *
 * ─── Lo que hace la matriz, que la lista no ve ──────────────────────────────────────────
 *
 * La lista cerrada no ve un trigger VIVO que se ensancha (la ventana de `reminder_d30` pasada a
 * `[30, 91)`, digamos) ni el aviso reintroducido con un nombre existente. Para eso se corre el
 * cron un MES hora por hora, sobre la misma tabla, y se afirma que a esta población no le llega
 * NADA, por ningún canal:
 *
 *   · edades CONTINUAS con el perfil por defecto y cada plan: tramos de 30 días que, al envejecer
 *     durante el mes barrido, cubren sin huecos de 32 a 422 días de inactividad y de 9 a 219 de
 *     alta a medias. Arrancan un día arriba de las ventanas que siguen vivas (`reminder_d30` en
 *     [30, 31); `reminder_d3`/`d7` exigen 0 gastos y no el alta cerrada, en [3, 4) y [7, 8));
 *   · cada forma de dirección (número, solo BSUID, solo web) por cada plan, a una edad fija;
 *   · variantes a esa edad: `onboarding_paso` 1, 2, 10 y 101, sin `nombre`, churn con 1, 5 y 9
 *     gastos (10 ya dispara `webapp_invite_10tx`, que es legítimo);
 *   · todos con `email`, y además de `notificarUsuario` se miran los tres canales crudos y los
 *     inserts a CUALQUIER tabla (la campana escrita directo en `notificaciones` pasaba).
 *
 * Con un CONTROL en la misma corrida: `reminder_d3` el primer día y `reminder_d14` once días
 * después. Y se cuentan las corridas que pasaron el horario: tienen que ser 31, porque un barrido
 * recortado a 12 días dejaba todo verde con el control conforme.
 *
 * ─── Lo que este archivo NO cubre ───────────────────────────────────────────────────────
 *
 *   · una rama nueva DENTRO de un trigger vivo, condicionada a una combinación sin fixture (por
 *     ejemplo, solo BSUID con 150 días): ni la lista ni la matriz la ven;
 *   · un empuje llamado desde `checkSurveyTriggers` por fuera de `TRIGGERS`. Si escribe su propio
 *     `registrarEvento`, lo atrapa el conteo exacto de `tests/cron/survey-events-canal.test.js`;
 *   · el mismo empuje como cron nuevo en `cron/checks.js`: lo frena
 *     `tests/cron/lecturas-proactivas.test.js`, no esto.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/** Todo INSERT, de cualquier tabla: la campana escrita a mano en `notificaciones` también cuenta. */
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

const { checkSurveyTriggers, TRIGGERS } = require('../../services/survey-triggers');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

/** 10:05 de Lima del primer día barrido: las edades de los fixtures se miden desde acá. */
const A_LAS_DIEZ = new Date('2026-09-14T10:05:00-05:00');
/** El barrido arranca a las 00:05 del MISMO día. Derivado, no escrito: si se separan, las edades
 *  del borde caen en la ventana de un trigger vivo y el caso se pone rojo por un envío legítimo. */
const INICIO_BARRIDO = new Date(A_LAS_DIEZ.getTime() - 10 * 3600000);
const haceDias = (d) => new Date(A_LAS_DIEZ.getTime() - d * 86400000).toISOString();
/** 14-sep → 14-oct: adentro caen el 1-oct y los siete días de la semana. */
const DIAS_BARRIDOS = 31;
/** Tramos de 30 días desde `desde` hasta `hasta`: con el mes que envejecen, se solapan y no dejan huecos. */
const tramos = (desde, hasta) => Array.from({ length: Math.floor((hasta - desde) / 30) + 1 }, (_, i) => desde + 30 * i);

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
  pagado: { plan: 'premium', trial_estado: 'convertido', estado_pago: 'pagado', premium_vence: '2027-01-01' },
};

let secuencia = 0;
function fixture(tag, { edad, dir, plan, alta = true, over = {}, variante = '' }) {
  const id = `u-${tag}-${edad}-${dir}-${plan}${variante ? '-' + variante : ''}`;
  const d = DIRECCIONES[dir];
  secuencia++;
  return {
    id, nombre: 'Persona ' + tag,
    whatsapp: d.whatsapp ? d.whatsapp + String(secuencia).padStart(5, '0') : null,
    bsuid: d.bsuid ? d.bsuid + secuencia : null,
    supabase_auth_id: d.conWeb ? 'auth-' + id : null,
    email: id + '@example.com',
    ...PLANES[plan],
    recordatorios_activos: true, cuenta_borrada_at: null, is_test_user: false,
    onboarding_completado: alta, onboarding_paso: alta ? 0 : 100,
    created_at: haceDias(edad),
    ...over,
  };
}

/**
 * Tres cortes, no un producto (con un producto la corrida se va a varios segundos y no compra
 * más de lo que ya da la lista cerrada): todas las edades con cada plan, todas las direcciones
 * con cada plan a una edad fija, y las variantes a esa misma edad.
 */
function matriz(tag, { edades, edadFija, alta = true, variantes = {} }) {
  const filas = new Map();
  const sumar = (f) => filas.set(f.id, f);
  for (const edad of edades) {
    for (const plan of Object.keys(PLANES)) sumar(fixture(tag, { edad, dir: 'numeroSinWeb', plan, alta }));
  }
  for (const dir of Object.keys(DIRECCIONES)) {
    for (const plan of Object.keys(PLANES)) sumar(fixture(tag, { edad: edadFija, dir, plan, alta }));
  }
  for (const [variante, over] of Object.entries(variantes)) {
    sumar(fixture(tag, { edad: edadFija, dir: 'numeroSinWeb', plan: 'muro', alta, over, variante }));
  }
  return [...filas.values()];
}

// Nunca anotaron nada (la rama "nuevo" del copy viejo).
const INACTIVOS = matriz('inact', { edades: tramos(32, 392), edadFija: 45 });
// Usaron y dejaron de usar (la rama "churn"): sus gastos son del día del alta, o sea de más de 30
// días antes del primer día barrido. `_gastos` lo lee solo este archivo, para sembrarlos.
const CHURN = matriz('churn', {
  edades: [32, 92, 182], edadFija: 60,
  variantes: { gastos5: { _gastos: 5 }, gastos9: { _gastos: 9 } },
});
const TX_CHURN = CHURN.flatMap((u) => Array.from({ length: u._gastos || 1 }, (_, i) => ({
  id: `tx-${u.id}-${i}`, usuario_id: u.id, fecha: u.created_at.split('T')[0], created_at: u.created_at,
})));
const A_MEDIAS = matriz('medias', {
  edades: tramos(9, 189), edadFija: 21, alta: false,
  variantes: {
    paso1: { onboarding_paso: 1 }, paso2: { onboarding_paso: 2 }, paso10: { onboarding_paso: 10 },
    paso101: { onboarding_paso: 101 }, sinNombre: { nombre: null }, sinNombre101: { nombre: null, onboarding_paso: 101 },
  },
});

/** El que la corrida SÍ tiene que alcanzar. Con número y alta cerrada, así califica para d3 y d14. */
const CONTROL = { ...fixture('control', { edad: 3.2, dir: 'numeroConWeb', plan: 'trial' }), id: 'u-control' };

/**
 * Un mes, hora por hora, sobre la MISMA tabla: lo que una corrida escribe lo ve la siguiente,
 * igual que en producción. Mover el gate horario o limitar el aviso a un día del mes o de la
 * semana son formas baratas de "arreglarlo" sin que un caso puntual se entere.
 */
async function barrerUnMes(usuarios, txs = []) {
  tablas = { usuarios, transacciones: txs, survey_events: [], errores: [], nlp_errors: [], notificaciones: [] };
  inserts = [];
  for (const fn of [notificar, enviarWhatsapp, crearNotificacion, enviarEmail, dbMock.supabase.from]) fn.mockClear();
  for (let h = 0; h < DIAS_BARRIDOS * 24; h++) {
    vi.setSystemTime(new Date(INICIO_BARRIDO.getTime() + h * 3600000));
    await checkSurveyTriggers();
  }
}

/** Cuántas corridas pasaron el gate horario: cada una lee la población exactamente una vez. */
const corridasEnHorario = () => dbMock.supabase.from.mock.calls.filter(([t]) => t === 'usuarios').length;
const tiposDe = (userId) => notificar.mock.calls.map((c) => c[0]).filter((a) => a.usuarioId === userId).map((a) => a.tipo);

/** Todo lo que les llegó a estos usuarios, por el chokepoint, por fuera de él, o escrito a mano. */
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
    // Fila por fila: `insert([{…}])` es tan válido como `insert({…})`, y el usuario puede ir en
    // cualquier columna. La primera versión leía solo `patch.usuario_id`, y una campana
    // insertada en forma de array pasaba sin que nadie la viera.
    ...inserts.flatMap((i) => [].concat(i.patch)
      .filter((fila) => fila && typeof fila === 'object' && Object.values(fila).some(deEllos))
      .map((fila) => `insert en ${i.tabla} ${fila.user_id || fila.usuario_id || '?'} ${fila.event_type || fila.tipo || ''}`)),
  ];
}

beforeEach(() => {
  notificar.mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: false } });
  logMock.error.mockClear();
});

describe('los dos wake_up están apagados y no vuelven solos', () => {
  it('la lista de triggers del cron es CERRADA: agregar uno es una decisión, no un commit', () => {
    expect(
      TRIGGERS.map((f) => f.name),
      'entró o salió un trigger de checkSurveyTriggers. Si empuja a quien lleva semanas sin ' +
      'escribirle a Neto, es el apagado del 14-sep (0 entregas en 66 intentos): leé el docblock de ' +
      'este archivo antes de seguir. Si no, agregalo acá y sumale a la matriz lo que lo distinga.',
    ).toEqual([
      'maybeFeedback30', 'maybeWebappInvite',
      'maybeReminderD30', 'maybeReminderD14', 'maybeReminderD7', 'maybeReminderD3',
    ]);
    // Y que nadie la pueda estirar desde afuera: sin el freeze, un `TRIGGERS.push(...)` en otro
    // módulo cargado por `index.js` reintroducía el wake_up entero con este caso en verde, porque
    // acá solo se carga `survey-triggers`.
    expect(Object.isFrozen(TRIGGERS), 'TRIGGERS dejó de estar congelada: se puede estirar desde otro módulo').toBe(true);
  });

  it('la matriz cubre lo que dice cubrir (antivacuidad)', () => {
    // Si alguien achica las listas, lo de abajo sigue verde mirando menos. Cada número es
    // edades × 3 planes + 4 direcciones × 3 planes + variantes.
    expect(INACTIVOS.length).toBe(13 * 3 + 12);
    expect(CHURN.length).toBe(3 * 3 + 12 + 2);
    expect(A_MEDIAS.length).toBe(7 * 3 + 12 + 6);
    // Las edades tienen que cubrir de corrido: cada tramo arranca como mucho donde terminó el
    // anterior (el mes barrido suma 31 días a cada uno).
    for (const edades of [tramos(32, 392), tramos(9, 189)]) {
      edades.slice(1).forEach((e, i) => expect(e - edades[i]).toBeLessThanOrEqual(DIAS_BARRIDOS));
    }
    const todos = [...INACTIVOS, ...CHURN, ...A_MEDIAS];
    expect(new Set(todos.map((u) => u.plan + '/' + u.trial_estado)).size).toBe(3);
    expect(todos.every((u) => u.email)).toBe(true);
    expect(todos.some((u) => u.bsuid && !u.whatsapp)).toBe(true);
    expect(A_MEDIAS.some((u) => u.onboarding_paso === 101 && u.nombre === null)).toBe(true);
    expect(TX_CHURN.length).toBe(CHURN.length - 2 + 5 + 9);
  });

  it('quien lleva 30+ días sin anotar no recibe nada de este cron, por ningún canal', async () => {
    await barrerUnMes([...INACTIVOS, ...CHURN, CONTROL], TX_CHURN);

    expect(corridasEnHorario(), 'el barrido no pasó por los 31 días: lo de abajo miró menos de lo que dice').toBe(DIAS_BARRIDOS);
    expect(tiposDe('u-control'), 'el control no salió: el barrido no ejercitó el runner y este caso no prueba nada')
      .toEqual(expect.arrayContaining(['survey_reminder_d3', 'survey_reminder_d14']));
    expect(loQueLesLlego([...INACTIVOS, ...CHURN]), 'un empuje de reactivación volvió').toEqual([]);
    expect(logMock.error, 'el runner reventó: el silencio de arriba sería un crash, no un apagado').not.toHaveBeenCalled();
  });

  it('quien quedó a medias en el alta no recibe nada de este cron, por ningún canal', async () => {
    await barrerUnMes([...A_MEDIAS, CONTROL]);

    expect(corridasEnHorario()).toBe(DIAS_BARRIDOS);
    expect(tiposDe('u-control'), 'el control no salió: el barrido no ejercitó el runner')
      .toEqual(expect.arrayContaining(['survey_reminder_d3', 'survey_reminder_d14']));
    expect(loQueLesLlego(A_MEDIAS), 'un empuje para terminar el alta volvió').toEqual([]);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
