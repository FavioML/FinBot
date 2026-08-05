import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import path from 'path';

const require = createRequire(import.meta.url);
// Ver la nota en tests/codigos-seguros.test.js sobre por que no se usa el pathname crudo.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * El wiring de `crearEspacio`, que es lo unico que ni el barrido estatico ni el unit del
 * helper pueden probar.
 *
 * `tests/codigos-seguros.test.js` prueba dos cosas por separado: que el helper genera bien,
 * y que ningun archivo del backend usa `Math.random()` cerca de una credencial. Ninguna de
 * las dos prueba que `crearEspacio` **efectivamente escriba** el codigo del helper: podria
 * llamarlo y despues insertar otra cosa, y las dos seguirian verdes. Esto mira el payload
 * que llega al insert.
 *
 * Contexto: S4 quedo abierto en el backend diez meses porque el guard vivia en la webapp
 * y barria `webapp/src`. Ver `lib/codigos-seguros.js`.
 */

let ops = [];
function makeChain(table, op) {
  const q = { table, op, payload: null };
  const chain = {};
  for (const m of ['eq', 'neq', 'limit', 'order', 'in']) chain[m] = () => chain;
  chain.select = () => chain;
  chain.single = () => chain;
  chain.maybeSingle = () => chain;
  chain.then = (resolve, reject) => {
    ops.push(q);
    const data = q.table === 'shared_spaces' && q.op === 'insert'
      ? { id: 'space-1', ...q.payload }
      : null;
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  };
  return { chain, q };
}
const dbMock = {
  supabase: {
    from: (t) => ({
      select: () => makeChain(t, 'select').chain,
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

const { crearEspacio } = require('../../services/shared-spaces');

function codigosDe(n) {
  return Promise.all(Array.from({ length: n }, (_, i) => crearEspacio('u-1', 'Espacio ' + i, 'pareja')))
    .then(() => ops.filter((o) => o.table === 'shared_spaces' && o.op === 'insert').map((o) => o.payload.invite_code));
}

describe('crearEspacio escribe el codigo del helper criptografico', () => {
  it('el codigo insertado tiene 8 chars del alfabeto de espacios', async () => {
    ops = [];
    const [code] = await codigosDe(1);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  /**
   * La webapp normaliza al buscar (`code.toUpperCase()` en api/spaces/join). Un codigo con
   * minuscula emitido aca es un espacio que NUNCA se va a poder unir desde la web — es el
   * bug de canal que este cambio cerro, y lo unico que lo impide es el alfabeto.
   */
  it('no emite minusculas, que la webapp perderia al normalizar', async () => {
    ops = [];
    const codes = await codigosDe(30);
    expect(codes.filter((c) => c !== c.toUpperCase())).toEqual([]);
  });

  /** LA prueba del hallazgo: con el PRNG de V8 congelado, la version vieja repetia codigo. */
  it('no depende de Math.random', async () => {
    ops = [];
    vi.spyOn(Math, 'random').mockReturnValue(0.42);
    const codes = await codigosDe(30);
    vi.restoreAllMocks();
    expect(new Set(codes).size).toBeGreaterThan(1);
  });
});
