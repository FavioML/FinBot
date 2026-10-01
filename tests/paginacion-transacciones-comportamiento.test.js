import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * EL GUARD MIRA LA FORMA; ESTO MIRA QUE LA FORMA TRAIGA LAS FILAS.
 *
 * `tests/transacciones-paginacion-callsites.test.js` prueba que cada lectura de `transacciones`
 * esté acotada o paginada. Lo que un guard de forma no puede decir es que la paginación, montada
 * en un call-site real, de verdad devuelva más de 1000 filas. Este doble se porta como PostgREST
 * con `max_rows = 1000`: sin `.range` corta en 1000 sin avisar, con `.range` devuelve esa
 * ventana, y `count: 'exact'` trae el total. Contra el código anterior al barrido (01-oct-2026)
 * los tres casos dan 1000.
 */
const MAX_ROWS = 1000;
let filas = [];

function postgrest() {
  let ventana = null;
  let conteo = false;
  const b = {};
  for (const op of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'is', 'not', 'in', 'order']) b[op] = () => b;
  b.select = (_c, opts) => { conteo = !!(opts && opts.count); return b; };
  b.range = (a, h) => { ventana = [a, h]; return b; };
  b.then = (ok, ko) => {
    const pedidas = ventana ? filas.slice(ventana[0], ventana[1] + 1) : filas;
    return Promise.resolve({ data: pedidas.slice(0, MAX_ROWS), error: null, count: conteo ? filas.length : null }).then(ok, ko);
  };
  return b;
}

const db = require('../lib/db');
db.supabase.from = () => postgrest();

const { totalGastadoMes } = require('../lib/trial');
const { obtenerGastosMes, obtenerGastosSemana } = require('../services/transactions');

describe('las lecturas migradas traen más de 1000 filas', () => {
  beforeEach(() => {
    filas = Array.from({ length: 1500 }, (_, i) => ({ id: 'tx-' + i, monto: 1, monto_pen: 1, tipo: 'gasto', fecha: '2026-10-01' }));
  });

  it('el doble corta en 1000 sin .range, como PostgREST (si no, los de abajo no prueban nada)', async () => {
    const { data } = await postgrest().select('*');
    expect(data).toHaveLength(1000);
  });

  it('totalGastadoMes suma las 1500', async () => {
    expect(await totalGastadoMes('u-1')).toBe(1500);
  });

  it('obtenerGastosMes devuelve las 1500', async () => {
    expect(await obtenerGastosMes('u-1')).toHaveLength(1500);
  });

  it('obtenerGastosSemana devuelve las 1500, con y sin tope', async () => {
    expect(await obtenerGastosSemana('u-1')).toHaveLength(1500);
    expect(await obtenerGastosSemana('u-1', null, '2026-10-06')).toHaveLength(1500);
  });
});
