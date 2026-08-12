import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * B33 — una subcategoría ACTIVA colgando de un padre INACTIVO es data huérfana.
 *
 * `asegurarCategoriaUsuario` devuelve `'inactiva'` desde B26(b) cuando la raíz existe pero el
 * usuario la borró. `crearSubcategoriaLibreUsuario` solo ramificaba por `'sin-arbol'`, así que
 * con ese veredicto seguía de largo e insertaba la subcategoría igual. Esa fila no aparece ni
 * en `/categorias` ni en `obtenerCategoriasUsuario` —las dos filtran por la raíz activa— o
 * sea que el usuario no la ve, no la puede borrar, y ocupa el índice único.
 *
 * La raíz NO se reactiva: es la decisión de B26(b) (Favio, 11-ago). Lo que cambia es que ya
 * no se le cuelga nada encima.
 */

let filas = [];
const inserts = [];

function chainPara(tabla) {
  const filtros = {};
  const c = {};
  for (const m of ['select', 'order', 'limit', 'ilike']) c[m] = vi.fn(() => c);
  c.is = vi.fn(() => c);
  c.eq = vi.fn((col, val) => { filtros[col] = val; return c; });
  c.insert = vi.fn((row) => { inserts.push(row); return Promise.resolve({ error: null }); });
  c.then = (r) => {
    const data = filas.filter((f) =>
      (filtros.usuario_id === undefined || f.usuario_id === filtros.usuario_id) &&
      (filtros.nombre === undefined || f.nombre === filtros.nombre) &&
      (filtros.activa === undefined || f.activa === filtros.activa) &&
      (filtros.padre_id === undefined || f.padre_id === filtros.padre_id));
    return Promise.resolve({ data, error: null }).then(r);
  };
  return c;
}
const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: { from: chainPara } } };

const { crearSubcategoriaLibreUsuario } = require(path.join(projectRoot, 'services/categories.js'));

const U = 'u1';
const raiz = (nombre, activa) => ({ id: 'r-' + nombre, usuario_id: U, nombre, padre_id: null, activa });

beforeEach(() => { filas = []; inserts.length = 0; });

describe('B33 — no se cuelga una subcategoría de una raíz borrada', () => {
  it('con la raíz BORRADA no inserta nada', async () => {
    filas = [raiz('Transporte', false), raiz('Alimentación', true)];
    await crearSubcategoriaLibreUsuario(U, 'Transporte', 'Taxi');
    expect(inserts).toEqual([]);
  });

  it('control: con la raíz ACTIVA sí inserta la subcategoría', async () => {
    // Sin este control, el negativo de arriba pasaría igual si la función se rompiera
    // entera y dejara de insertar nunca.
    filas = [raiz('Transporte', true)];
    await crearSubcategoriaLibreUsuario(U, 'Transporte', 'Taxi');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].nombre).toBe('Taxi');
    expect(inserts[0].padre_id).toBe('r-Transporte');
    expect(inserts[0].activa).toBe(true);
  });

  it('la raíz borrada tampoco se reactiva de paso', async () => {
    filas = [raiz('Transporte', false), raiz('Alimentación', true)];
    await crearSubcategoriaLibreUsuario(U, 'Transporte', 'Taxi');
    // Ningún insert, y ningún update: la decisión de B26(b) es no resucitarla.
    expect(inserts).toEqual([]);
    expect(filas.find((f) => f.nombre === 'Transporte').activa).toBe(false);
  });

  it('sin árbol propio sigue sin inventarle uno (la rama que ya existía)', async () => {
    filas = [];
    await crearSubcategoriaLibreUsuario(U, 'Transporte', 'Taxi');
    expect(inserts).toEqual([]);
  });
});
