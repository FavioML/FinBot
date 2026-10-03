import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

// Una etiqueta de "sin nombre" ('Sin comercio', 'sin_descripcion'...) no es un comercio, y una
// regla sobre ella agarra TODOS los gastos sin nombre de la persona. Lo encontró la revisión
// adversarial del 01-oct: desde ese día el parser guarda 'Sin comercio' cuando no puede nombrar un
// gasto, y "cámbialo a Salud" sobre uno guardaba la regla 'sin comercio' → Salud y la retroaplicaba
// con `ilike '%Sin comercio%'`.
//
// El doble de Supabase REGISTRA todo acceso y responde a cualquier método. No alcanza con uno que
// sólo sepa `upsert`: `retroaplicarRegla` envuelve el update en un try que devuelve 0, así que un
// doble sin `update` lanzaría adentro y el test daría 0 con o sin el freno.

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

const accesos = [];
function cadena(tabla) {
  const c = {};
  let escribe = false;
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'ilike', 'filter', 'in', 'order', 'range', 'single', 'maybeSingle', 'limit']) {
    c[m] = (...args) => { accesos.push({ tabla, m, args }); if (m === 'update') escribe = true; return c; };
  }
  // La LECTURA de `retroaplicarRegla` (desde el 02-oct busca por palabra entera antes de escribir)
  // necesita filas; el resto de las llamadas recibe lo de siempre.
  c.then = (f, r) => Promise.resolve(tabla === 'transacciones' && !escribe
    ? { data: [{ id: 't-1', comercio: 'Tambo' }], error: null, count: 1 }
    : { data: { categoria: 'Salud', subcategoria: null }, error: null, count: 7 }).then(f, r);
  return c;
}
const dbMock = { supabase: { from: (tabla) => { accesos.push({ tabla, m: 'from' }); return cadena(tabla); } } };
const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

const { guardarReglaComercio, retroaplicarRegla, buscarReglaComercio } = require('../../services/transactions');
const { esComercioCentinela, COMERCIO_SIN_DESCRIPCION } = require('../../services/parsers');

// 'Sin  comercio' con doble espacio: `retroaplicarRegla` mira el centinela ANTES de canonizar, y la
// canonización lo colapsaba a 'Sin comercio' dentro del ilike (segunda revisión, 01-oct).
const CENTINELAS = [COMERCIO_SIN_DESCRIPCION, 'sin comercio', '  Sin Comercio ', 'Sin  comercio', 'sin_descripcion', 'Sin descripción', 'Sin especificar'];

beforeEach(() => { accesos.length = 0; });

describe('esComercioCentinela', () => {
  it('reconoce la etiqueta del parser y las otras formas de "sin nombre"', () => {
    for (const c of CENTINELAS) expect(esComercioCentinela(c), c).toBe(true);
  });
  it('no confunde un comercio real que empieza parecido', () => {
    for (const c of ['Sinba', 'Sin Gluten Bakery', 'Comercio', 'Descripción', 'Tambo', '', 'Sin comercio SAC', 'Tienda sin comercio']) expect(esComercioCentinela(c), c).toBe(false);
  });
});

describe('las reglas de comercio no se arman sobre una etiqueta de "sin nombre"', () => {
  it('guardarReglaComercio la rechaza como "sin-comercio" y no escribe nada', async () => {
    for (const c of CENTINELAS) {
      accesos.length = 0;
      const r = await guardarReglaComercio('u-1', c, 'Salud', null);
      expect(r, c).toEqual({ ok: false, motivo: 'sin-comercio' });
      expect(accesos, c).toEqual([]);
    }
  });

  it('retroaplicarRegla no mueve ninguna fila', async () => {
    for (const c of CENTINELAS) {
      accesos.length = 0;
      expect(await retroaplicarRegla('u-1', c, 'Salud', null), c).toBe(0);
      expect(accesos, c).toEqual([]);
    }
  });

  it('buscarReglaComercio no le aplica a una fila sin nombre la regla de nadie', async () => {
    for (const c of CENTINELAS) {
      accesos.length = 0;
      expect(await buscarReglaComercio('u-1', c), c).toBeNull();
      expect(accesos, c).toEqual([]);
    }
  });

  it('control: con un comercio real las tres SÍ van a la base (el doble no es ciego)', async () => {
    expect((await guardarReglaComercio('u-1', 'Tambo', 'Alimentación', null)).ok).toBe(true);
    expect(accesos.some((a) => a.tabla === 'reglas_comercio' && a.m === 'upsert')).toBe(true);
    accesos.length = 0;
    expect(await retroaplicarRegla('u-1', 'Tambo', 'Alimentación', null)).toBe(7);
    expect(accesos.some((a) => a.m === 'filter' && a.args[1] === 'imatch')).toBe(true);
    expect(accesos.some((a) => a.m === 'in' && a.args[0] === 'comercio' && a.args[1].includes('Tambo'))).toBe(true);
    accesos.length = 0;
    expect(await buscarReglaComercio('u-1', 'Tambo')).toEqual({ categoria: 'Salud', subcategoria: null });
  });
});
