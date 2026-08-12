import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * B34 — `poner_limite_gasto` solo matcheaba RAÍCES, y `/categorias` imprime las raíces **y
 * sus subcategorías en línea**. O sea que el usuario veía "Delivery" listado por el propio
 * bot, escribía *"ponme límite en Delivery"* y recibía *"no reconozco la categoría
 * 'Delivery'"*. La tabla `presupuestos` ya soportaba la columna (está en el `onConflict` del
 * upsert); lo único que faltaba era resolverla.
 *
 * Salió de la revisión adversarial del diff de B28.
 */

// El árbol se sirve desde el mock de Supabase y no reemplazando el export, porque
// `resolverCategoriaOSub` llama a `obtenerCategoriasUsuario` por referencia INTERNA del
// módulo: pisar `exports` no intercepta eso. Así además se ejercita el armado real del
// árbol (raíces + subcategorías por `padre_id`), que es parte de lo que este test afirma.
const FILAS = [
  { id: 'c1', nombre: 'Alimentación', padre_id: null, activa: true },
  { id: 'c1a', nombre: 'Delivery', padre_id: 'c1', activa: true },
  { id: 'c1b', nombre: 'Supermercado', padre_id: 'c1', activa: true },
  { id: 'c2', nombre: 'Transporte', padre_id: null, activa: true },
  { id: 'c2a', nombre: 'Taxi', padre_id: 'c2', activa: true },
  { id: 'c3', nombre: 'Comida casera', padre_id: null, activa: true },
];

const upserts = [];
function chainPara(tabla) {
  const c = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'is']) c[m] = vi.fn(() => c);
  c.upsert = vi.fn((row) => { upserts.push(row); return Promise.resolve({ error: null }); });
  c.then = (r) => Promise.resolve({ data: tabla === 'categorias_usuario' ? FILAS : [], error: null }).then(r);
  return c;
}
const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: { from: chainPara } } };

require(path.join(projectRoot, 'helpers/pro-wall.js')).checkProWall = () => ({ blocked: false });

const { handle } = require(path.join(projectRoot, 'handlers/intents/fugas.js'));

const USUARIO = { id: 'u1', plan: 'premium' };
const poner = (categoria, monto = 300) =>
  handle({ intencion: 'poner_limite_gasto', datos: { categoria, monto_limite: monto }, usuario: USUARIO, from: '51999', ctx: {} });

beforeEach(() => { upserts.length = 0; });

describe('B34 — un límite se puede poner sobre una SUBCATEGORÍA', () => {
  it('acepta una subcategoría y la guarda con su raíz', async () => {
    const msg = await poner('Delivery');
    expect(msg).toContain('✅');
    expect(msg).toContain('Delivery');   // el mensaje nombra lo que el usuario pidió
    expect(upserts).toHaveLength(1);
    expect(upserts[0].categoria).toBe('Alimentación');
    expect(upserts[0].subcategoria).toBe('Delivery');
  });

  it('una raíz sigue guardándose sin subcategoría', async () => {
    await poner('Transporte');
    expect(upserts[0].categoria).toBe('Transporte');
    expect(upserts[0].subcategoria).toBeNull();
  });

  it('una categoría CUSTOM del usuario también entra (B28 del lado del límite)', async () => {
    await poner('Comida casera');
    expect(upserts[0].categoria).toBe('Comida casera');
    expect(upserts[0].subcategoria).toBeNull();
  });

  it('el usuario está TIPEANDO: tolera mayúsculas y tildes', async () => {
    await poner('delivery');
    expect(upserts[0].subcategoria).toBe('Delivery');
    upserts.length = 0;
    await poner('ALIMENTACION');
    expect(upserts[0].categoria).toBe('Alimentación');
    expect(upserts[0].subcategoria).toBeNull();
  });

  it('un nombre que no es suyo se guarda tal cual, no como subcategoría inventada', async () => {
    // Desde B28 una categoría que el mapa canónico no resuelve se persiste cruda, y este
    // intent hereda esa regla en vez de tener la suya. Lo que NO puede pasar es que se
    // cuelgue de una raíz que el usuario no pidió.
    const msg = await poner('Criptomonedas');
    expect(upserts[0].categoria).toBe('Criptomonedas');
    expect(upserts[0].subcategoria).toBeNull();
    expect(msg).toContain('✅');
  });

  it('el monto sigue pasando por validarMonto', async () => {
    const msg = await poner('Delivery', -5);
    expect(msg).toContain('no me cuadra');
    expect(upserts).toHaveLength(0);
  });
});
