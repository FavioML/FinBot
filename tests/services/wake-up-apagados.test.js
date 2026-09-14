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
 * ─── Por qué es de COMPORTAMIENTO ───────────────────────────────────────────────────────
 *
 * Un grep sobre `wake_up_inactive` se pondría rojo por su propia documentación: este archivo, el
 * docblock del apagado y `REMINDER_CONV_TYPES` de `cron/checks.js`, que sigue leyendo las filas
 * históricas. Acá se corre el cron: se arma a quien ANTES lo recibía, se barre el día entero hora
 * por hora, y se afirma que no le llega NADA. No solo estos dos tipos: re-agregar el aviso con
 * otro nombre es la forma barata de volver a prenderlo sin tocar este archivo.
 *
 * Con un CONTROL en la misma corrida: `reminder_d3`, el último trigger que queda en la lista,
 * tiene que salir. Sin él, un mock roto o un gate horario mal puesto darían "no salió nada" y
 * todo lo de arriba pasaría en verde sin haber ejercitado el runner.
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
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
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
      // El insert devuelve la fila escrita y la deja en `tablas`: `registrarEvento` corta con
      // `if (!eventoId) return false`, así que un doble que devolviera vacío apagaría los
      // one-shot por su cuenta y este archivo saldría verde sin que el código los apague.
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
stub('lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) });
stub('lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }) });
stub('lib/email.js', { enviarEmail: vi.fn().mockResolvedValue({ ok: false, skipped: 'canal_no_declarado' }) });

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

/** Las 10:05 de Lima: la ventana en que el cron hace algo. Las edades se miden desde acá. */
const A_LAS_DIEZ = new Date('2026-09-14T10:05:00-05:00');
const haceDias = (d) => new Date(A_LAS_DIEZ.getTime() - d * 86400000).toISOString();
const fechaHaceDias = (d) => haceDias(d).split('T')[0];

const BASE = {
  recordatorios_activos: true, onboarding_completado: true, onboarding_paso: 0,
  cuenta_borrada_at: null, bsuid: null,
};

/** El que la corrida SÍ tiene que alcanzar: `reminder_d3` es el último trigger de la lista. */
const CONTROL = {
  ...BASE, id: 'u-control', whatsapp: '51999000009', nombre: 'Cora Control',
  supabase_auth_id: 'auth-9', created_at: haceDias(3.2),
};

/** Los tres perfiles que recibían `wake_up_inactive`, uno por rama del copy y del canal. */
const INACTIVOS = [
  // Usó y dejó de usar: la variante "churn". Con número y con cuenta web, o sea AMBOS.
  { ...BASE, id: 'u-churn', whatsapp: '51999000001', nombre: 'Carla Churn', supabase_auth_id: 'auth-1', created_at: haceDias(45) },
  // Nunca anotó nada: la variante "nuevo". Sin cuenta web, como 16 de los 34 reales.
  { ...BASE, id: 'u-nuevo', whatsapp: '51999000002', nombre: 'Nico Nuevo', supabase_auth_id: null, created_at: haceDias(60) },
  // Web-first sin número: le llegaba solo la campana.
  { ...BASE, id: 'u-web', whatsapp: null, nombre: 'Wanda Web', supabase_auth_id: 'auth-3', created_at: haceDias(45) },
];
const TX_DEL_CHURN = [{ id: 'tx-viejo', usuario_id: 'u-churn', fecha: fechaHaceDias(40), created_at: haceDias(40) }];

/** Los dos perfiles que recibían `wake_up_onboarding`: sin cuenta web (SOLO_WHATSAPP) y con ella (AMBOS). */
const A_MEDIAS = [
  { ...BASE, id: 'u-medias', whatsapp: '51999000004', nombre: null, supabase_auth_id: null,
    onboarding_completado: false, onboarding_paso: 100, created_at: haceDias(20) },
  { ...BASE, id: 'u-medias-web', whatsapp: '51999000005', nombre: 'Mara Medias', supabase_auth_id: 'auth-5',
    onboarding_completado: false, onboarding_paso: 101, created_at: haceDias(20) },
];

/**
 * El día entero, hora por hora, sobre la MISMA tabla: lo que una corrida escribe lo ve la
 * siguiente, igual que en producción. El aviso salía a las 10:05; mover el gate horario es la
 * forma más barata de "arreglarlo" sin que un caso puntual se entere.
 */
async function barrerElDia(usuarios, txs = []) {
  tablas = { usuarios, transacciones: txs, survey_events: [], errores: [], nlp_errors: [] };
  inserts = [];
  notificar.mockClear();
  for (let h = 0; h < 24; h++) {
    vi.setSystemTime(new Date(`2026-09-14T${String(h).padStart(2, '0')}:05:00-05:00`));
    await checkSurveyTriggers();
  }
}

const tiposDe = (userId) => notificar.mock.calls.map((c) => c[0]).filter((a) => a.usuarioId === userId).map((a) => a.tipo);
const eventosWakeUp = () => inserts
  .filter((i) => i.tabla === 'survey_events' && /^wake_up/.test(i.patch.event_type))
  .map((i) => i.patch.user_id + ':' + i.patch.event_type);

beforeEach(() => {
  notificar.mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: false } });
  logMock.error.mockClear();
});

describe('los dos wake_up están apagados y no vuelven solos', () => {
  it('quien lleva 30+ días sin anotar no recibe nada de este cron, por ningún canal', async () => {
    await barrerElDia([...INACTIVOS, CONTROL], TX_DEL_CHURN);

    expect(tiposDe('u-control'), 'el control no salió: el barrido no ejercitó el runner y este caso no prueba nada')
      .toEqual(['survey_reminder_d3']);
    for (const u of INACTIVOS) {
      expect(tiposDe(u.id), `${u.id} recibió un empuje de reactivación: el wake_up volvió`).toEqual([]);
    }
    expect(eventosWakeUp(), 'se reclamó el one-shot de un aviso apagado').toEqual([]);
    expect(logMock.error, 'el runner reventó: el silencio de arriba sería un crash, no un apagado').not.toHaveBeenCalled();
  });

  it('quien quedó a medias en el alta no recibe el wake_up_onboarding, con cuenta web ni sin ella', async () => {
    await barrerElDia([...A_MEDIAS, CONTROL]);

    expect(tiposDe('u-control'), 'el control no salió: el barrido no ejercitó el runner').toEqual(['survey_reminder_d3']);
    for (const u of A_MEDIAS) {
      expect(tiposDe(u.id), `${u.id} recibió un empuje para terminar el alta: el wake_up volvió`).toEqual([]);
    }
    expect(eventosWakeUp(), 'se reclamó el one-shot de un aviso apagado').toEqual([]);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
