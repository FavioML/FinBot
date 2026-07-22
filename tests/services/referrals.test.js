import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Regresion de services/referrals.js. Dos clases de bug cubiertas aqui:
//
// 1. NO IDEMPOTENCIA (el caro). verificarProReferidos sumaba floor(activos/3) meses a
//    premium_vence en cada invocacion, tomando como base el propio premium_vence. Tras
//    el primer otorgamiento la base ya era futura, asi que el guard `venceStr !== venceActual`
//    nunca frenaba: 5 llamadas con los mismos 3 referidos = 5 meses de Pro. Y se invoca
//    por CADA correo bancario procesado de un referido (gmail-scanner).
// 2. ESCRITURA SOBRE LECTURA FALLIDA. Un SELECT que falla devuelve { data: null, error }
//    sin lanzar; el codigo lo leia como "no existe" y escribia igual.
//
// Ver docs/SESION-escrituras-sobre-lectura-fallida.md.

let router;
function makeChain(table, op) {
  const q = { table, op, payload: null, methods: [] };
  const chain = {};
  for (const m of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in']) {
    chain[m] = (...a) => { q.methods.push([m, ...a]); return chain; };
  }
  // .update().select('id') sigue siendo escritura: no pisar q.op.
  chain.select = (cols, opts) => { if (!q.op) q.op = 'select'; if (opts && opts.head) q.head = true; return chain; };
  chain.single = () => { q.single = true; return chain; };
  chain.maybeSingle = () => { q.single = true; return chain; };
  chain.then = (resolve, reject) => {
    ops.push(q);
    return Promise.resolve({ data: null, error: null, count: null, ...(router(q) || {}) }).then(resolve, reject);
  };
  return { chain, q };
}

let ops = [];
const dbMock = {
  supabase: {
    from: (t) => ({
      select: (...a) => makeChain(t).chain.select(...a),
      insert: (p) => { const { chain, q } = makeChain(t, 'insert'); q.payload = p; return chain; },
      update: (p) => { const { chain, q } = makeChain(t, 'update'); q.payload = p; return chain; },
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue(true) };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { registrarReferido, verificarProReferidos } = require('../../services/referrals');

const FALLO = { data: null, error: { message: 'read failure', code: '500' } };
const SIN_FILA = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
const TRES_ACTIVOS = [
  { referido_id: 'a', activo: true },
  { referido_id: 'b', activo: true },
  { referido_id: 'c', activo: true },
];
const escrituras = (tabla) => ops.filter(o => (o.op === 'insert' || o.op === 'update') && (!tabla || o.table === tabla));

beforeEach(() => {
  ops = [];
  logMock.error.mockClear();
  logMock.warn.mockClear();
  waMock.enviarWhatsapp.mockClear();
});

describe('registrarReferido', () => {
  it('no inserta cuando el SELECT de dedup falla (no puede saber si ya existe)', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return FALLO;
      if (q.table === 'usuarios') return { data: { ref_code: 'ABCD1234' } };
      return {};
    };
    await registrarReferido('r1', 'u1');
    expect(escrituras()).toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('inserta cuando el SELECT confirma que no existe', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return SIN_FILA;
      if (q.table === 'usuarios') return { data: { ref_code: 'ABCD1234' } };
      return {};
    };
    await registrarReferido('r1', 'u1');
    const ins = escrituras('referidos');
    expect(ins).toHaveLength(1);
    expect(ins[0].payload).toEqual({ ref_code: 'ABCD1234', referrer_id: 'r1', referido_id: 'u1' });
  });

  it('no loguea error cuando el insert choca con el unique index (ya existia)', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return SIN_FILA;
      if (q.table === 'usuarios') return { data: { ref_code: 'ABCD1234' } };
      if (q.op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key' } };
      return {};
    };
    await registrarReferido('r1', 'u1');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('loguea cuando el insert falla por cualquier otro motivo', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return SIN_FILA;
      if (q.table === 'usuarios') return { data: { ref_code: 'ABCD1234' } };
      if (q.op === 'insert') return { data: null, error: { code: '23502', message: 'null value in column ref_code' } };
      return {};
    };
    await registrarReferido('r1', 'u1');
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('verificarProReferidos: idempotencia', () => {
  // DB simulada con el contador de meses ya otorgados y claim atomico en el UPDATE.
  function montarDb(activos, filaInicial) {
    const estado = { fila: { plan: 'free', whatsapp: '51999', premium_vence: null, referidos_meses_otorgados: 0, ...filaInicial } };
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return { data: activos() };
      if (q.table === 'usuarios' && q.op === 'select') return { data: { ...estado.fila } };
      if (q.table === 'usuarios' && q.op === 'update') {
        const claim = q.methods.find(m => m[0] === 'eq' && m[1] === 'referidos_meses_otorgados');
        if (claim && claim[2] !== estado.fila.referidos_meses_otorgados) return { data: [] };
        estado.fila = { ...estado.fila, ...q.payload };
        return { data: [{ id: 'r1' }] };
      }
      return {};
    };
    return estado;
  }

  it('otorga 1 mes con 3 referidos activos', async () => {
    const db = montarDb(() => TRES_ACTIVOS);
    await verificarProReferidos('r1');
    expect(db.fila.plan).toBe('premium');
    expect(db.fila.referidos_meses_otorgados).toBe(1);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
  });

  it('5 invocaciones con los mismos 3 referidos otorgan 1 mes, no 5', async () => {
    const db = montarDb(() => TRES_ACTIVOS);
    await verificarProReferidos('r1');
    const venceTrasElPrimero = db.fila.premium_vence;
    for (let i = 0; i < 4; i++) await verificarProReferidos('r1');
    expect(db.fila.premium_vence).toBe(venceTrasElPrimero);
    expect(db.fila.referidos_meses_otorgados).toBe(1);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(escrituras('usuarios')).toHaveLength(1);
  });

  it('otorga el mes adicional cuando llega el 6to referido activo', async () => {
    let activos = TRES_ACTIVOS;
    const db = montarDb(() => activos);
    await verificarProReferidos('r1');
    const venceCon3 = db.fila.premium_vence;
    activos = TRES_ACTIVOS.concat([
      { referido_id: 'd', activo: true },
      { referido_id: 'e', activo: true },
      { referido_id: 'f', activo: true },
    ]);
    await verificarProReferidos('r1');
    await verificarProReferidos('r1');
    expect(db.fila.referidos_meses_otorgados).toBe(2);
    expect(new Date(db.fila.premium_vence) > new Date(venceCon3)).toBe(true);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(2);
  });

  // Regresion (2026-07-22): el vencimiento se calculaba con `setMonth`, que desborda al mes
  // siguiente cuando el dia no existe en el destino. Un referrer con Pro hasta el 31-ene
  // recibia hasta el 3-mar: casi tres dias de yapa por cada mes otorgado.
  it('un vencimiento el 31 avanza al ultimo dia del mes destino, no al mes siguiente', async () => {
    const db = montarDb(() => TRES_ACTIVOS, { plan: 'premium', premium_vence: '2099-01-31' });
    await verificarProReferidos('r1');
    expect(db.fila.premium_vence).toBe('2099-02-28');
  });

  it('con el Pro ya vencido la base es hoy, no la fecha vieja', async () => {
    const db = montarDb(() => TRES_ACTIVOS, { plan: 'free', premium_vence: '2020-01-15' });
    await verificarProReferidos('r1');
    // No puede tomar 2020 como base: eso daria un vencimiento en el pasado y Pro nunca activo.
    expect(db.fila.premium_vence > new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it('dos ejecuciones concurrentes otorgan un solo mes (claim atomico)', async () => {
    const db = montarDb(() => TRES_ACTIVOS);
    await Promise.all([verificarProReferidos('r1'), verificarProReferidos('r1')]);
    expect(db.fila.referidos_meses_otorgados).toBe(1);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
  });

  it('el UPDATE lleva el claim sobre el contador leido', async () => {
    montarDb(() => TRES_ACTIVOS);
    await verificarProReferidos('r1');
    const upd = escrituras('usuarios')[0];
    expect(upd.methods).toContainEqual(['eq', 'referidos_meses_otorgados', 0]);
    expect(upd.payload.referidos_meses_otorgados).toBe(1);
  });
});

describe('verificarProReferidos: lecturas fallidas', () => {
  it('no activa referidos cuando el count de transacciones falla', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return { data: [{ referido_id: 'a', activo: false }] };
      if (q.table === 'transacciones') return FALLO;
      return {};
    };
    await verificarProReferidos('r1');
    expect(escrituras('referidos')).toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('no otorga Pro cuando no puede leer el plan del referrer', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return { data: TRES_ACTIVOS };
      if (q.table === 'usuarios' && q.op === 'select') return FALLO;
      return {};
    };
    await verificarProReferidos('r1');
    expect(escrituras('usuarios')).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('no avisa por WhatsApp si el UPDATE del otorgamiento falla', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return { data: TRES_ACTIVOS };
      if (q.table === 'usuarios' && q.op === 'select') return { data: { plan: 'free', whatsapp: '51999', premium_vence: null, referidos_meses_otorgados: 0 } };
      if (q.table === 'usuarios' && q.op === 'update') return FALLO;
      return {};
    };
    await verificarProReferidos('r1');
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('no avisa por WhatsApp si otra ejecucion ya se llevo el claim', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return { data: TRES_ACTIVOS };
      if (q.table === 'usuarios' && q.op === 'select') return { data: { plan: 'free', whatsapp: '51999', premium_vence: null, referidos_meses_otorgados: 0 } };
      if (q.table === 'usuarios' && q.op === 'update') return { data: [] };
      return {};
    };
    await verificarProReferidos('r1');
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('no otorga nada cuando la lista de referidos no se puede leer', async () => {
    router = (q) => (q.table === 'referidos' && q.op === 'select') ? FALLO : {};
    await verificarProReferidos('r1');
    expect(escrituras()).toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
  });
});
