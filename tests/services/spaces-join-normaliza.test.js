import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `unirseEspacio`: el reintento en MAYÚSCULAS y el `throw` sobre lectura fallida.
 *
 * Este archivo existe porque la segunda revisión adversarial midió que el único cambio de
 * PRODUCCIÓN del commit anterior no tenía ninguna cobertura: los tests que ya tocaban esta
 * función pasan `'CODE1234'`, que ya está en mayúsculas, así que el segundo intento nunca
 * corría, y ninguno hacía fallar la lectura de `shared_spaces`. Revertir el cambio entero
 * los dejaba a todos verdes. El invariante que `docs/DEFECTOS.md` declaraba cerrado
 * viajaba sin control.
 *
 * Lo que se afirma acá se eligió para que MUERA si se revierte el comportamiento:
 *   - un código en minúsculas encuentra el espacio (sin reintento: null)
 *   - se emiten DOS lookups y en ese orden (sin reintento: uno)
 *   - un código ya en mayúsculas emite UNO solo (nadie paga una query de más)
 *   - una lectura fallida LANZA (con la semántica vieja: devolvía null, o sea "tu código
 *     no existe" sobre un fallo de consulta)
 */

let lookups = [];
let filas = [];
let fallaLectura = null;

/**
 * El mock distingue las TRES operaciones que `unirseEspacio` hace sobre `space_members`,
 * porque devolverles lo mismo a todas manda la función por un camino de error que no es
 * el que se está probando: el chequeo de membresía espera `PGRST116` ("todavía no sos
 * miembro", el caso normal), pero la lectura de miembros previos espera una lista, y un
 * error ahí hace throw antes de llegar a lo que este archivo mide.
 */
function makeChain(table) {
  const q = { table, filtros: {}, op: 'select', cols: '' };
  const chain = {};
  for (const m of ['order', 'limit', 'update', 'upsert']) chain[m] = () => chain;
  chain.select = (c) => { q.cols = c || ''; return chain; };
  chain.insert = (p) => { q.op = 'insert'; q.payload = p; return chain; };
  chain.eq = (col, val) => { q.filtros[col] = val; return chain; };
  chain.single = () => chain;
  chain.maybeSingle = () => chain;
  chain.then = (ok, err) => {
    let res = { data: null, error: null };
    if (table === 'shared_spaces') {
      lookups.push(q.filtros.invite_code);
      if (fallaLectura) res = { data: null, error: fallaLectura };
      else res = { data: filas.find((f) => f.invite_code === q.filtros.invite_code) || null, error: null };
    } else if (table === 'space_members') {
      if (q.op === 'insert') res = { data: { id: 'm-nuevo', ...q.payload }, error: null };
      else if (q.cols.includes('split_percentage')) res = { data: [], error: null };
      else res = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    }
    return Promise.resolve(res).then(ok, err);
  };
  return chain;
}

const dbMock = { supabase: { from: (t) => makeChain(t) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue(true) };

for (const [rel, exports] of [['lib/db.js', dbMock], ['lib/logger.js', logMock], ['lib/whatsapp.js', waMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { unirseEspacio } = require('../../services/shared-spaces');

beforeEach(() => {
  lookups = [];
  fallaLectura = null;
  filas = [{ id: 'sp-1', name: 'Casa', invite_code: 'KQ7WX2MH', split_rules: [] }];
});

describe('unirseEspacio normaliza la caja del codigo', () => {
  it('un codigo en minusculas encuentra el espacio', async () => {
    const r = await unirseEspacio('user-1', 'kq7wx2mh');
    expect(r).not.toBeNull();
    expect(r.space.id).toBe('sp-1');
    // El orden importa: exacto primero. Al revés se rompería el código legacy con minúscula.
    expect(lookups).toEqual(['kq7wx2mh', 'KQ7WX2MH']);
  });

  it('con caja mezclada tambien', async () => {
    const r = await unirseEspacio('user-1', 'Kq7Wx2mH');
    expect(r).not.toBeNull();
    expect(lookups).toEqual(['Kq7Wx2mH', 'KQ7WX2MH']);
  });

  it('un codigo ya en mayusculas emite UN solo lookup', async () => {
    const r = await unirseEspacio('user-1', 'KQ7WX2MH');
    expect(r).not.toBeNull();
    expect(lookups).toEqual(['KQ7WX2MH']);
  });

  /**
   * El código legacy con minúscula (emitido antes del cambio de alfabeto) tiene que seguir
   * funcionando tal cual. Es la razón de que la búsqueda exacta vaya PRIMERO en vez de
   * upcasear la entrada de entrada.
   */
  it('el codigo legacy con minuscula sigue entrando por su forma exacta', async () => {
    filas = [{ id: 'sp-legacy', name: 'Viejo', invite_code: 'aB3dEfGh', split_rules: [] }];
    const r = await unirseEspacio('user-1', 'aB3dEfGh');
    expect(r).not.toBeNull();
    expect(r.space.id).toBe('sp-legacy');
    expect(lookups).toEqual(['aB3dEfGh']);
  });

  it('el espacio inexistente sigue devolviendo null, no una excepcion', async () => {
    const r = await unirseEspacio('user-1', 'zzzzzzzz');
    expect(r).toBeNull();
  });

  it('los espacios sobrantes del texto libre no rompen el join', async () => {
    const r = await unirseEspacio('user-1', '  kq7wx2mh  ');
    expect(r).not.toBeNull();
    expect(lookups[0]).toBe('kq7wx2mh');
  });

  it('un codigo vacio o nulo no manda eq.null a PostgREST', async () => {
    for (const v of [null, undefined, '', '   ']) {
      lookups = [];
      const r = await unirseEspacio('user-1', v);
      expect(r).toBeNull();
      expect(lookups).toEqual(['']);
    }
  });
});

describe('unirseEspacio distingue "no existe" de "no pude leer"', () => {
  /**
   * Con `.single()` y `if (eSpace || !space) return null`, un fallo de lectura era
   * indistinguible de un código inválido: al usuario se le decía "no encontré un espacio
   * con ese código" cuando lo que se rompió fue la consulta. Clase `error-no-leido`.
   */
  it('una lectura fallida LANZA en vez de decir que el codigo no existe', async () => {
    fallaLectura = { message: 'connection reset', code: '500' };
    await expect(unirseEspacio('user-1', 'KQ7WX2MH')).rejects.toThrow(/No se pudo buscar el espacio/);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('no sigue al segundo intento si el primero fallo por error', async () => {
    fallaLectura = { message: 'connection reset', code: '500' };
    await expect(unirseEspacio('user-1', 'kq7wx2mh')).rejects.toThrow();
    // Reintentar en mayúsculas ante un error de red solo duplica la carga sobre una base
    // que ya está respondiendo mal, y el resultado sería el mismo error.
    expect(lookups).toEqual(['kq7wx2mh']);
  });
});
