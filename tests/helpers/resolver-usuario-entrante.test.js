import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * `resolverUsuarioEntrante` (12-sep-2026): la fila de quien escribe por WhatsApp, con número o
 * solo con BSUID.
 *
 * Lo que se afirma no es "devuelve una fila" sino QUÉ ESCRIBE en `usuarios`, porque los dos
 * defectos que esto cierra son escrituras: el alta que duplicaba a quien ya tenía fila por BSUID,
 * y el alta a ciegas que ensuciaría el embudo. El doble registra cada operación y responde según
 * reglas por caso, así que "no insertó" es una aserción sobre lo que pasó, no sobre un mock.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const analyticsMock = { capture: vi.fn() };
const errorMonitorMock = { registrarError: vi.fn() };

const ops = [];
let reglas = [];
const NADA = { data: null, error: null };

/** Primera regla cuyo predicado acepta la operación. */
function responder(op) {
  const r = reglas.find(([pred]) => pred(op));
  return r ? (typeof r[1] === 'function' ? r[1](op) : r[1]) : NADA;
}

function cadena(tabla) {
  const op = { tabla, accion: 'select', filtros: {}, is: {}, valores: null };
  const c = {};
  const fin = async () => { ops.push(op); return responder(op); };
  c.select = () => c;
  c.eq = (k, v) => { op.filtros[k] = v; return c; };
  c.is = (k, v) => { op.is[k] = v; return c; };
  c.insert = (v) => { op.accion = 'insert'; op.valores = v; return c; };
  c.update = (v) => { op.accion = 'update'; op.valores = v; return c; };
  c.maybeSingle = fin;
  c.single = fin;
  c.then = (res, rej) => fin().then(res, rej);
  return c;
}

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/analytics.js', analyticsMock],
  ['lib/error-monitor.js', errorMonitorMock],
  ['lib/db.js', { supabase: { from: (t) => cadena(t) } }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { resolverUsuarioEntrante } = require('../../helpers/db-helpers');

const BSUID = 'PE.1049206861029395';
const NUM = '51999000111';

const leePor = (col, val) => (op) => op.tabla === 'usuarios' && op.accion === 'select' && op.filtros[col] === val;
const inserts = () => ops.filter((o) => o.tabla === 'usuarios' && o.accion === 'insert');
const updates = () => ops.filter((o) => o.tabla === 'usuarios' && o.accion === 'update');

beforeEach(() => {
  ops.length = 0;
  reglas = [];
  for (const f of Object.values(logMock)) f.mockReset();
  analyticsMock.capture.mockReset();
  errorMonitorMock.registrarError.mockReset();
});

describe('solo BSUID (quien oculta su número)', () => {
  it('lo reconoce si ya tiene fila, sin crear nada', async () => {
    reglas = [[leePor('bsuid', BSUID), { data: { id: 'u1', bsuid: BSUID, whatsapp: null }, error: null }]];

    const u = await resolverUsuarioEntrante({ numero: null, bsuid: BSUID });

    expect(u.id).toBe('u1');
    expect(inserts()).toHaveLength(0);
  });

  it('si no existe, lo da de alta con el BSUID EN el insert y engancha sus errores previos', async () => {
    reglas = [
      [(op) => op.accion === 'insert', { data: { id: 'nuevo', bsuid: BSUID, whatsapp: null }, error: null }],
    ];

    const u = await resolverUsuarioEntrante({ bsuid: BSUID });

    expect(u.id).toBe('nuevo');
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].valores).toEqual({ whatsapp: null, bsuid: BSUID });
    expect(analyticsMock.capture).toHaveBeenCalledWith('nuevo', 'wa_user_registered',
      expect.objectContaining({ $set: expect.objectContaining({ signup_channel: 'whatsapp_bsuid' }) }));
    const enganche = ops.find((o) => o.tabla === 'errores' && o.accion === 'update');
    expect(enganche, 'sus filas de errores quedarían fuera del borrado de cuenta').toBeTruthy();
    expect(enganche.valores).toEqual({ usuario_id: 'nuevo' });
    expect(enganche.filtros.bsuid).toBe(BSUID);
    expect(enganche.is.usuario_id).toBeNull();
  });

  it('carrera: si otro mensaje creó la fila primero (23505), relee y devuelve esa', async () => {
    let lecturas = 0;
    reglas = [
      [leePor('bsuid', BSUID), () => (++lecturas === 1 ? NADA : { data: { id: 'ganador' }, error: null })],
      [(op) => op.accion === 'insert', { data: null, error: { code: '23505', message: 'duplicate key' } }],
    ];

    const u = await resolverUsuarioEntrante({ bsuid: BSUID });

    expect(u.id).toBe('ganador');
  });

  it('con la lectura caída NO inserta a ciegas: lanza', async () => {
    reglas = [[leePor('bsuid', BSUID), { data: null, error: { message: 'connection terminated' } }]];

    await expect(resolverUsuarioEntrante({ bsuid: BSUID })).rejects.toThrow(/BSUID/);
    expect(inserts()).toHaveLength(0);
  });

  it('sin número ni BSUID lanza sin tocar la base', async () => {
    await expect(resolverUsuarioEntrante({ numero: null, bsuid: null })).rejects.toThrow(/sin número ni BSUID/);
    expect(ops).toHaveLength(0);
  });
});

describe('con número (el camino de siempre, más la adopción)', () => {
  it('si el número ya tiene fila, no mira el BSUID para decidir', async () => {
    reglas = [[leePor('whatsapp', NUM), { data: { id: 'u1', whatsapp: NUM, bsuid: BSUID }, error: null }]];

    const u = await resolverUsuarioEntrante({ numero: NUM, bsuid: BSUID });

    expect(u.id).toBe('u1');
    expect(ops.some(leePor('bsuid', BSUID))).toBe(false);
    expect(inserts()).toHaveLength(0);
  });

  it('ADOPTA la fila sin número de ese BSUID en vez de duplicar a la persona', async () => {
    // El bug latente: la fila que crea el OTP sin número (o el alta por BSUID) tiene whatsapp
    // NULL. Cuando la persona volvía a escribir con número, se creaba una segunda fila.
    reglas = [
      [leePor('bsuid', BSUID), { data: { id: 'solo-bsuid', whatsapp: null, bsuid: BSUID }, error: null }],
      [(op) => op.accion === 'update', { data: [{ id: 'solo-bsuid', whatsapp: NUM, bsuid: BSUID }], error: null }],
    ];

    const u = await resolverUsuarioEntrante({ numero: NUM, bsuid: BSUID });

    expect(u.id).toBe('solo-bsuid');
    expect(u.whatsapp).toBe(NUM);
    expect(inserts(), 'duplicó a la persona').toHaveLength(0);
    const adopcion = updates()[0];
    expect(adopcion.valores).toEqual({ whatsapp: NUM });
    expect(adopcion.filtros.id).toBe('solo-bsuid');
    // La condición va en el UPDATE: dos mensajes seguidos no pueden escribirle dos números.
    expect(adopcion.is.whatsapp).toBeNull();
  });

  it('si la adopción no tocó filas (otro mensaje ganó), relee por número en vez de adivinar', async () => {
    let lecturasNum = 0;
    reglas = [
      [leePor('whatsapp', NUM), () => (++lecturasNum <= 2 ? NADA : { data: { id: 'solo-bsuid', whatsapp: NUM, bsuid: BSUID }, error: null })],
      [leePor('bsuid', BSUID), { data: { id: 'solo-bsuid', whatsapp: null, bsuid: BSUID }, error: null }],
      [(op) => op.accion === 'update', { data: [], error: null }],
    ];

    const u = await resolverUsuarioEntrante({ numero: NUM, bsuid: BSUID });

    expect(u.id).toBe('solo-bsuid');
    expect(inserts()).toHaveLength(0);
  });

  it('una fila del BSUID con OTRO número no se toca (anomalía): sigue el alta de siempre', async () => {
    reglas = [
      [leePor('bsuid', BSUID), { data: { id: 'otro', whatsapp: '51988777666', bsuid: BSUID }, error: null }],
      [(op) => op.accion === 'insert', { data: { id: 'nuevo', whatsapp: NUM }, error: null }],
      [(op) => op.accion === 'update', { data: null, error: { code: '23505', message: 'duplicate key' } }],
    ];

    const u = await resolverUsuarioEntrante({ numero: NUM, bsuid: BSUID });

    expect(u.id).toBe('nuevo');
    expect(updates().some((o) => o.valores && o.valores.whatsapp), 'le pisó el número a otra fila').toBe(false);
    // `persistirBsuid` delata la identidad partida, como antes.
    expect(errorMonitorMock.registrarError).toHaveBeenCalledWith('BSUID_COLISION', expect.any(String), expect.any(Object));
  });

  it('con la lectura por BSUID caída sigue por número (falla abierto, como las demás)', async () => {
    reglas = [
      [leePor('bsuid', BSUID), { data: null, error: { message: 'timeout' } }],
      [(op) => op.accion === 'insert', { data: { id: 'nuevo', whatsapp: NUM }, error: null }],
    ];

    const u = await resolverUsuarioEntrante({ numero: NUM, bsuid: BSUID });

    expect(u.id).toBe('nuevo');
    expect(logMock.error).toHaveBeenCalled();
  });
});
