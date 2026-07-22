import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

/**
 * Regresion de services/shared-spaces.js: lecturas que fallaban sin lanzar y producian
 * un saldo creible y falso entre dos personas reales, o congelaban una division
 * equivocada. Ver docs/SESION-escrituras-sobre-lectura-fallida.md.
 *
 * Escenario base: Ana y Beto. Gasto de S/100 pagado por Ana, congelado 70/30. Beto ya
 * le liquido sus S/30, asi que el saldo real es cero para los dos.
 *
 * Los tres fallos que medimos antes del fix:
 *   - sin liquidaciones -> "Beto debe 30 a Ana", plata que Beto YA pago
 *   - sin gastos        -> "Ana debe 30 a Beto", la deuda cambia de dueño
 *   - sin miembros      -> "estan al dia", identico a un espacio sano
 */

let router;
let ops = [];
function makeChain(table, op) {
  const q = { table, op, payload: null, methods: [] };
  const chain = {};
  for (const m of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in']) {
    chain[m] = (...a) => { q.methods.push([m, ...a]); return chain; };
  }
  chain.select = (cols) => { if (!q.op) q.op = 'select'; q.cols = cols; return chain; };
  chain.single = () => { q.single = true; return chain; };
  chain.maybeSingle = () => { q.single = true; return chain; };
  chain.then = (resolve, reject) => {
    ops.push(q);
    return Promise.resolve({ data: null, error: null, ...(router(q) || {}) }).then(resolve, reject);
  };
  return { chain, q };
}
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

for (const [rel, exports] of [['lib/db.js', dbMock], ['lib/logger.js', logMock], ['lib/whatsapp.js', waMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const ss = require('../../services/shared-spaces');

const FALLO = { data: null, error: { message: 'read failure', code: '500' } };
const A = 'user-A', B = 'user-B';
const MIEMBROS = [
  { user_id: A, split_percentage: 50, usuarios: { nombre: 'Ana', whatsapp: '51900000001' } },
  { user_id: B, split_percentage: 50, usuarios: { nombre: 'Beto', whatsapp: '51900000002' } },
];
const GASTOS = [{ paid_by: A, amount: 100, split_snapshot: { shares: [{ user_id: A, cents: 7000 }, { user_id: B, cents: 3000 }] } }];
const LIQUIDACIONES = [{ from_user: B, to_user: A, amount: 30 }];
// Shape real que espera sanitizeSplitRules: { category, splits: { userId: peso } }.
const REGLAS = [{ id: 'r1', category: 'supermercado', splits: { [A]: 70, [B]: 30 } }];

const sano = (q) => {
  if (q.table === 'space_expenses' && q.op === 'select') return { data: GASTOS };
  if (q.table === 'space_settlements' && q.op === 'select') return { data: LIQUIDACIONES };
  if (q.table === 'space_members' && q.op === 'select') return { data: MIEMBROS };
  if (q.table === 'shared_spaces') return { data: { id: 'sp-1', created_by: A, split_rules: REGLAS } };
  if (q.table === 'usuarios') return { data: { plan: 'premium', nombre: 'Ana' } };
  return {};
};
const conFallo = (tabla, extra) => (q) => (q.table === tabla && (!extra || extra(q))) ? FALLO : sano(q);

beforeEach(() => {
  ops = [];
  logMock.error.mockClear();
  waMock.enviarWhatsapp.mockClear();
  router = sano;
});

describe('obtenerBalanceEspacio', () => {
  it('con todas las lecturas sanas, el saldo es cero y no hay deudas', async () => {
    const b = await ss.obtenerBalanceEspacio('sp-1');
    expect(b.debts).toHaveLength(0);
    expect(b.balances.every(x => x.balance === 0)).toBe(true);
  });

  it('corta si no puede leer las liquidaciones (cobraria de nuevo lo ya pagado)', async () => {
    router = conFallo('space_settlements');
    await expect(ss.obtenerBalanceEspacio('sp-1')).rejects.toThrow(/liquidaciones/i);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('corta si no puede leer los gastos (invertiria el dueño de la deuda)', async () => {
    router = conFallo('space_expenses');
    await expect(ss.obtenerBalanceEspacio('sp-1')).rejects.toThrow(/gastos/i);
  });

  it('corta si no puede leer los miembros (diria "estan al dia")', async () => {
    router = conFallo('space_members');
    await expect(ss.obtenerBalanceEspacio('sp-1')).rejects.toThrow(/miembros/i);
  });

  it('un espacio de verdad vacio sigue devolviendo cero sin lanzar', async () => {
    router = (q) => (q.table === 'space_members' && q.op === 'select') ? { data: [] } : sano(q);
    await expect(ss.obtenerBalanceEspacio('sp-1')).resolves.toEqual({ balances: [], debts: [] });
  });
});

describe('registrarGastoCompartido', () => {
  const registrar = () => ss.registrarGastoCompartido(A, 'sp-1', 100, 'Compra del mes', 'supermercado');
  const conInsert = (base) => (q) => (q.table === 'space_expenses' && q.op === 'insert') ? { data: { id: 'e-1' } } : base(q);

  it('congela la division de la regla cuando todo se lee bien', async () => {
    router = conInsert(sano);
    await registrar();
    const ins = ops.find(o => o.op === 'insert' && o.table === 'space_expenses');
    expect(ins.payload.split_snapshot.shares).toEqual([
      { user_id: A, cents: 7000 },
      { user_id: B, cents: 3000 },
    ]);
  });

  it('no guarda el gasto si no pudo leer el espacio (congelaria 50/50)', async () => {
    router = conInsert(conFallo('shared_spaces'));
    await expect(registrar()).rejects.toThrow(/espacio/i);
    expect(ops.find(o => o.op === 'insert' && o.table === 'space_expenses')).toBeUndefined();
  });

  it('no guarda el gasto si no pudo verificar el plan del owner y hay reglas', async () => {
    router = conInsert(conFallo('usuarios', (q) => q.op === 'select'));
    await expect(registrar()).rejects.toThrow(/plan del owner/i);
    expect(ops.find(o => o.op === 'insert' && o.table === 'space_expenses')).toBeUndefined();
  });

  it('sin reglas configuradas, el plan del owner no bloquea el registro', async () => {
    router = conInsert((q) => {
      if (q.table === 'usuarios' && q.op === 'select') return FALLO;
      if (q.table === 'shared_spaces') return { data: { id: 'sp-1', created_by: A, split_rules: [] } };
      return sano(q);
    });
    await registrar();
    const ins = ops.find(o => o.op === 'insert' && o.table === 'space_expenses');
    expect(ins).toBeTruthy();
    expect(ins.payload.split_snapshot.shares).toEqual([
      { user_id: A, cents: 5000 },
      { user_id: B, cents: 5000 },
    ]);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('el gasto queda guardado aunque no se pueda avisar a los miembros', async () => {
    router = (q) => {
      if (q.table === 'space_expenses' && q.op === 'insert') return { data: { id: 'e-1' } };
      // La lectura de miembros para avisar es la segunda: la del contexto de split sí funciona.
      if (q.table === 'space_members' && q.cols && q.cols.includes('whatsapp')) return FALLO;
      return sano(q);
    };
    await registrar();
    expect(ops.find(o => o.op === 'insert' && o.table === 'space_expenses')).toBeTruthy();
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('unirseEspacio', () => {
  const base = (q) => {
    if (q.table === 'shared_spaces') return { data: { id: 'sp-1', created_by: A } };
    if (q.table === 'space_members' && q.op === 'select' && q.single) return { data: null, error: { code: 'PGRST116' } };
    if (q.table === 'space_members' && q.op === 'insert') return { data: { id: 'm-9' } };
    return {};
  };

  it('entra con el promedio real del espacio', async () => {
    router = (q) => (q.table === 'space_members' && q.op === 'select' && !q.single)
      ? { data: [{ user_id: A, split_percentage: 90 }, { user_id: B, split_percentage: 10 }] }
      : base(q);
    await ss.unirseEspacio('user-C', 'CODE1234');
    const ins = ops.find(o => o.op === 'insert' && o.table === 'space_members');
    expect(ins.payload.split_percentage).toBe(50);
  });

  it('no deja entrar con un peso inventado si no pudo leer a los previos', async () => {
    router = (q) => (q.table === 'space_members' && q.op === 'select' && !q.single) ? FALLO : base(q);
    await expect(ss.unirseEspacio('user-C', 'CODE1234')).rejects.toThrow(/tu parte/i);
    expect(ops.find(o => o.op === 'insert' && o.table === 'space_members')).toBeUndefined();
  });

  it('corta si no puede verificar si ya era miembro', async () => {
    router = (q) => (q.table === 'space_members' && q.op === 'select' && q.single) ? FALLO : base(q);
    await expect(ss.unirseEspacio('user-C', 'CODE1234')).rejects.toThrow(/ya eres miembro/i);
    expect(ops.find(o => o.op === 'insert' && o.table === 'space_members')).toBeUndefined();
  });
});

describe('obtenerEspaciosUsuario / obtenerResumenEspacio', () => {
  it('no dice "no tienes espacios" cuando la lectura fallo', async () => {
    router = conFallo('space_members');
    await expect(ss.obtenerEspaciosUsuario('user-A')).rejects.toThrow(/tus espacios/i);
  });

  it('no dice "no tienes acceso" cuando la verificacion de membresia fallo', async () => {
    router = (q) => (q.table === 'space_members' && q.single) ? FALLO : sano(q);
    await expect(ss.obtenerResumenEspacio(A, 'sp-1')).rejects.toThrow(/acceso/i);
  });

  it('devuelve null cuando de verdad no es miembro', async () => {
    router = (q) => (q.table === 'space_members' && q.single) ? { data: null, error: { code: 'PGRST116' } } : sano(q);
    await expect(ss.obtenerResumenEspacio(A, 'sp-1')).resolves.toBeNull();
  });
});
