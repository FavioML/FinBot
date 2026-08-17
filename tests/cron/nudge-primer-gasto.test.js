import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * `checkRecordatorioOnboarding` le escribe a quien se dio de alta y **no anotó nada**.
 *
 * Este archivo existe por un bug que ningún test podía ver: hasta el 17-ago-2026 el cron
 * seleccionaba con `onboarding_completado.eq.false`, y desde el alta reordenada del 31-jul
 * (`3c992bb`) esa columna pasa a **true** en el primer o segundo turno. O sea que la población
 * del cron se vació **en silencio** — corría, no lanzaba, no logueaba error, y su último envío
 * real fue el 5-ago con 22 altas posteriores. De los 8 usuarios de agosto sin una sola
 * transacción, ninguno lo recibió.
 *
 * Por eso el caso 1 es el que manda: **un usuario con el alta CERRADA y cero transacciones
 * tiene que recibirlo**. Es la contraprueba exacta del bug, y contra el código viejo falla.
 *
 * Los mocks siguen el patrón de `comprobante-solo-si-llego.test.js`: se corre el cron de
 * verdad y se afirma el EFECTO (a quién se notifica), no la forma de la query.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

let usuariosData = [];
let transaccionesData = [];
let deliveriesData = [];
let errores = {};
/** Toda escritura sobre `usuarios`, para probar que el cron NO pisa `onboarding_paso`. */
let updatesUsuarios = [];
const notificar = vi.fn();

/**
 * El mock FILTRA de verdad sobre `eq`/`neq`/`or`, y eso no es adorno: la primera
 * versión de este archivo tenía todos los métodos de la cadena como no-op, así que
 * los 9 casos pasaban **en verde con el bug reintroducido**. Un mock que ignora los
 * filtros no puede ver un bug que ES un filtro.
 *
 * Sólo se implementa lo que hace falta para distinguir el bug: los rangos de fecha
 * (`gte`/`lte` sobre created_at) siguen siendo no-op porque el fixture ya
 * representa "se dio de alta dentro de la ventana", y simularlos no separaría
 * ninguna hipótesis.
 */
function aplicaOr(fila, expr) {
  // PostgREST: 'col.is.null,col.eq.false' = OR de condiciones simples.
  return String(expr).split(',').some((cond) => {
    const [col, op, val] = cond.split('.');
    if (op === 'is' && val === 'null') return fila[col] === null || fila[col] === undefined;
    if (op === 'eq') return String(fila[col]) === val;
    return false;
  });
}

function makeChain(table) {
  const filtros = [];
  const chain = {};
  for (const m of ['gte', 'lte', 'lt', 'gt', 'limit', 'order', 'not', 'is', 'ilike']) {
    chain[m] = () => chain;
  }
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => f[col] !== val); return chain; };
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.or = (expr) => { filtros.push((f) => aplicaOr(f, expr)); return chain; };
  chain.select = () => chain;
  chain.single = () => Promise.resolve({ data: null, error: null });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.then = (resolve) => {
    const fuente = table === 'usuarios' ? usuariosData
      : table === 'transacciones' ? transaccionesData
      : table === 'notification_deliveries' ? deliveriesData
      : [];
    const error = table === 'usuarios' ? errores.usuarios
      : table === 'transacciones' ? errores.transacciones
      : table === 'notification_deliveries' ? errores.deliveries
      : null;
    if (error) return resolve({ data: null, error });
    return resolve({ data: fuente.filter((f) => filtros.every((p) => p(f))), error: null });
  };
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => {
      const base = makeChain(t);
      return {
        ...base,
        update: (patch) => { if (t === 'usuarios') updatesUsuarios.push(patch); return makeChain(t); },
        insert: () => makeChain(t),
      };
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
  ['lib/pro-payment.js', { solicitarComprobante: vi.fn(), esperaComprobante: vi.fn() }],
  ['gmail.js', { revocarAccesoGmail: vi.fn().mockResolvedValue({ revocadas: 0 }) }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// Preservando CANALES: el cron lo desestructura al cargar el módulo.
const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};

const { checkRecordatorioOnboarding } = require('../../cron/checks');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

// 10am Lima = 15:00Z. Dentro del gate horario (9am-9pm).
const MEDIA_MANANA = '2026-08-17T15:00:00Z';

/**
 * El usuario del alta NUEVA: dio su nombre, el alta se cerró, no anotó nada.
 *
 * `onboarding_completado: true` es el corazón del fixture, no un detalle de relleno:
 * es lo que hace que el filtro viejo lo descarte y el nuevo lo alcance. Con `false`
 * acá, este archivo volvería a pasar en verde contra el bug.
 */
const RECIEN_LLEGADO = {
  id: 'u-sin-gastos',
  whatsapp: '51900000001',
  nombre: 'María Quispe',
  onboarding_paso: 0,
  onboarding_completado: true,
  is_test_user: false,
};

beforeEach(() => {
  notificar.mockClear();
  notificar.mockResolvedValue({ wa: { ok: true, msgId: 'wamid.1' }, inApp: false });
  logMock.error.mockClear();
  usuariosData = [RECIEN_LLEGADO];
  transaccionesData = [];
  deliveriesData = [];
  errores = {};
  updatesUsuarios = [];
  vi.setSystemTime(new Date(MEDIA_MANANA));
});

describe('nudge de primer gasto', () => {
  it('LE LLEGA a quien cerró el alta y no anotó nada (la contraprueba del bug)', async () => {
    // Con el filtro viejo (`onboarding_completado.eq.false`) esta persona quedaba fuera,
    // porque `completarAlta()` la deja en true apenas da su nombre.
    await checkRecordatorioOnboarding();
    expect(notificar).toHaveBeenCalledTimes(1);
    const arg = notificar.mock.calls[0][0];
    expect(arg.usuarioId).toBe('u-sin-gastos');
    expect(arg.tipo).toBe('onboarding');
    expect(arg.mensaje).toMatch(/an[óo]tame un gasto/i);
    // El nombre se usa, y sólo el primero.
    expect(arg.mensaje).toContain('María');
    expect(arg.mensaje).not.toContain('Quispe');
  });

  it('NO le llega a quien ya registró una transacción', async () => {
    transaccionesData = [{ usuario_id: 'u-sin-gastos' }];
    await checkRecordatorioOnboarding();
    expect(notificar).not.toHaveBeenCalled();
  });

  it('NO se repite: una fila previa en notification_deliveries lo descarta', async () => {
    // El `tipo` es parte del fixture a propósito: la query filtra por él, y sin la
    // columna esta fila no representa el envío que dice representar. (Lo destapó el
    // mock cuando empezó a filtrar de verdad; con el mock no-op el caso pasaba
    // "bien" por el motivo equivocado.)
    deliveriesData = [{ usuario_id: 'u-sin-gastos', tipo: 'onboarding' }];
    await checkRecordatorioOnboarding();
    expect(notificar).not.toHaveBeenCalled();
  });

  it('un aviso de OTRO tipo no lo descarta: el ledger es por tipo', async () => {
    deliveriesData = [{ usuario_id: 'u-sin-gastos', tipo: 'score_semanal' }];
    await checkRecordatorioOnboarding();
    expect(notificar).toHaveBeenCalledTimes(1);
  });

  it('NO toca onboarding_paso, porque eso mandaría su próximo gasto al parser de NOMBRES', async () => {
    await checkRecordatorioOnboarding();
    expect(notificar).toHaveBeenCalledTimes(1);
    expect(updatesUsuarios).toEqual([]);
  });

  it('si la lectura de transacciones falla, NO manda nada', async () => {
    // supabase-js no lanza: sin leer el error, `data: null` se lee como "no tiene
    // transacciones" y el cron le escribiría justo a quien ya está usando Neto.
    errores.transacciones = { message: 'timeout' };
    await checkRecordatorioOnboarding();
    expect(notificar).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('si la lectura de deliveries falla, NO manda nada (podría duplicar)', async () => {
    errores.deliveries = { message: 'timeout' };
    await checkRecordatorioOnboarding();
    expect(notificar).not.toHaveBeenCalled();
  });

  it('si falla la lectura de usuarios, NO manda nada y lo loguea', async () => {
    errores.usuarios = { message: 'caída' };
    await checkRecordatorioOnboarding();
    expect(notificar).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('respeta el gate horario: a las 3am no escribe', async () => {
    vi.setSystemTime(new Date('2026-08-17T08:00:00Z')); // 3am Lima
    await checkRecordatorioOnboarding();
    expect(notificar).not.toHaveBeenCalled();
  });

  it('sale por WhatsApp y con motivo, que es lo que exige el chokepoint de canal único', async () => {
    await checkRecordatorioOnboarding();
    const arg = notificar.mock.calls[0][0];
    expect(arg.canales).toBe(notifyReal.CANALES.SOLO_WHATSAPP);
    expect(typeof arg.motivo).toBe('string');
    expect(arg.motivo.length).toBeGreaterThan(20);
  });
});
