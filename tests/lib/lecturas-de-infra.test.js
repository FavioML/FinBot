import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * Los dos sitios de `lib/` que NO son de soporte (ítem 20), por COMPORTAMIENTO.
 *
 * Van juntos y separados de `lecturas-de-soporte.test.js` por un motivo mecánico: aquel archivo
 * MOCKEA `lib/whatsapp.js` entero, y acá hace falta el real. Dos perímetros de mocks
 * incompatibles en el mismo archivo terminan midiendo el doble en vez del código.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * `error-monitor.js` ESTÁ ACÁ Y NO EN LA LISTA DE EXENCIONES, QUE ES LO CONTRARIO DE LO
 * QUE EL BACKLOG ESPERABA
 *
 * El ítem 20 nació apostando a que el `insert` a `errores` sería una exención con motivo, como
 * las tres de `nlp_errors` del guard del ítem 19. Al leerlo, el argumento no sobrevivió:
 *
 *   · la **recursión** que justificaría eximirlo no existe: el log es pino a stdout y no vuelve
 *     a `registrarError`;
 *   · el insert **ya se `await`ea**, así que leer el error no agrega ninguna espera;
 *   · y lo que se pierde en silencio no es "un error sin registrar" sino la tabla donde se
 *     cruzan los stacks de producción por timestamp. Un insert rechazado en silencio no deja
 *     un hueco visible: deja una tabla que afirma que no pasó nada.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const entregasMock = { registrarEntrega: vi.fn(async () => {}) };
const adminMock = { notificarAdmin: vi.fn(async () => {}) };

const db = { resp: {}, inserts: [], consultas: [] };

function cadena(tabla) {
  const c = {};
  let op = 'select';
  const resultado = () => {
    const k = tabla + ':' + op;
    db.consultas.push(k);
    const v = db.resp[k];
    if (Array.isArray(v)) return v.length ? v.shift() : { data: null, error: null };
    if (v) return v;
    return { data: null, error: null };
  };
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = () => c;
  c.insert = (fila) => { op = 'insert'; db.inserts.push({ tabla, fila }); return c; };
  c.update = () => { op = 'update'; return c; };
  c.maybeSingle = async () => resultado();
  c.then = (res, rej) => Promise.resolve(resultado()).then(res, rej);
  return c;
}

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/notification-deliveries.js', entregasMock],
  ['lib/admin-notify.js', adminMock],
  ['lib/db.js', { supabase: { from: (t) => cadena(t) } }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { enviarWhatsapp } = require('../../lib/whatsapp');
const { registrarError } = require('../../lib/error-monitor');

const CAIDA = { data: null, error: { message: 'connection terminated unexpectedly' } };

let fetchOriginal;

beforeEach(() => {
  db.resp = {};
  db.inserts = [];
  db.consultas = [];
  for (const f of Object.values(logMock)) f.mockReset();
  entregasMock.registrarEntrega.mockClear();
  adminMock.notificarAdmin.mockClear();
  process.env.META_PHONE_NUMBER_ID = 'pid';
  process.env.META_ACCESS_TOKEN = 'tok';
  fetchOriginal = global.fetch;
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.x' }] }),
    text: async () => '{}',
  }));
});

afterEach(() => { global.fetch = fetchOriginal; });

/** Cuántas veces se consultó `usuarios` (o sea, cuántas veces NO alcanzó el cache). */
const lecturasDeUsuarios = () => db.consultas.filter((k) => k === 'usuarios:select').length;

describe('isTestUser · el fail-open se respeta, pero la duda ya no queda CACHEADA', () => {
  // Se ejercita a través de `enviarWhatsapp` porque `isTestUser` no se exporta — y de paso el
  // test afirma la consecuencia real (¿el mensaje sale a Meta o no?) en vez de un booleano.
  // Cada caso usa un número distinto: el cache es de módulo y vive entre tests.

  it('CONTROL: con la lectura sana, el flag se respeta y se cachea', async () => {
    db.resp['usuarios:select'] = { data: { is_test_user: true }, error: null };

    const a = await enviarWhatsapp('51900000001', 'hola');
    const b = await enviarWhatsapp('51900000001', 'de nuevo');

    expect(a.skipped).toBe('test_user');
    expect(b.skipped).toBe('test_user');
    expect(global.fetch, 'un usuario de prueba llegó a Meta').not.toHaveBeenCalled();
    expect(lecturasDeUsuarios(), 'el cache dejó de funcionar: dos lecturas para el mismo número').toBe(1);
  });

  it('con la lectura caída trata el número como real —eso NO cambia— y no envenena el cache', async () => {
    // El fail-open es deliberado y está declarado: ante la duda nunca se silencia a un usuario
    // real. Lo que estaba mal era que ese `false` fabricado se guardaba 5 minutos, así que un
    // hipo de la base convertía a un usuario de PRUEBA en uno real para toda la ventana
    // siguiente — y el síntoma es indistinguible de un flag apagado a propósito.
    db.resp['usuarios:select'] = [CAIDA, { data: { is_test_user: true }, error: null }];

    const primero = await enviarWhatsapp('51900000002', 'hola');
    const segundo = await enviarWhatsapp('51900000002', 'de nuevo');

    // 1) El fail-open: con la lectura caída el mensaje SÍ sale.
    expect(primero.skipped).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledOnce();
    // 2) Y el arreglo: el segundo envío vuelve a preguntar en vez de creerle al false cacheado.
    expect(lecturasDeUsuarios(), 'el `false` de la lectura caída quedó cacheado').toBe(2);
    expect(segundo.skipped, 'el usuario de prueba siguió tratado como real por el cache').toBe('test_user');
    expect(logMock.warn).toHaveBeenCalled();
  });
});

describe('registrarError · la tabla de diagnóstico dejó de poder mentir en silencio', () => {
  it('CONTROL: el insert entra y no se grita', async () => {
    db.resp['errores:insert'] = { data: null, error: null };

    await registrarError('WEBHOOK', 'algo se rompió');

    expect(db.inserts.map((i) => i.tabla)).toEqual(['errores']);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('el insert es rechazado → queda en el log en vez de perderse', async () => {
    // `errores` es de donde salen los stacks completos cuando algo se rompe en producción. Sin
    // esto, una tanda de inserts rechazados se lee exactamente igual que una tarde sin errores.
    db.resp['errores:insert'] = CAIDA;

    await registrarError('WEBHOOK', 'algo se rompió');

    expect(logMock.error).toHaveBeenCalled();
    const [, mensaje] = logMock.error.mock.calls[0];
    expect(String(mensaje)).toMatch(/tabla errores/i);
  });

  it('un insert rechazado NO se lleva puesta la detección de patrones', async () => {
    // La guarda nueva loguea y sigue: el contador en memoria es lo que dispara la alerta al
    // admin cuando el mismo error se repite, y es justamente cuando la base está mal que esa
    // alerta importa. Un `return` temprano acá habría apagado el aviso en el peor momento.
    db.resp['errores:insert'] = CAIDA;

    for (let i = 0; i < 5; i++) await registrarError('WEBHOOK', 'el mismo error');

    expect(adminMock.notificarAdmin, 'la alerta crítica no salió con la tabla caída').toHaveBeenCalled();
  });
});
