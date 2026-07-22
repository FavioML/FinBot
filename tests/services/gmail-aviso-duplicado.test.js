import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Cuando el banco manda DOS correos para el MISMO cargo, cada uno trae su propio
// gmail_msg_id, asi que el indice unico no los ve como duplicados, y el dedup por hash
// esta desactivado para Gmail (`if (!datos.esGmail)`). Resultado en produccion:
// Smart Fit S/119.90 el 20-jul-2026 entro dos veces con 1 segundo de diferencia.
// Un SELECT-antes-de-INSERT no sirve: el sweep procesa 5 correos en paralelo.
// Ver docs/SESION-fallos-silenciosos.md.

const inserts = [];

function makeChain(table) {
  let esSingle = false;
  let filaInsertada = null;
  const chain = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in']) {
    chain[m] = () => chain;
  }
  chain.insert = (fila) => { filaInsertada = fila; inserts.push(fila); return chain; };
  chain.single = () => { esSingle = true; return chain; };
  chain.maybeSingle = () => { esSingle = true; return chain; };
  chain.then = (resolve) => {
    if (filaInsertada) return resolve({ data: { id: 'tx-' + inserts.length, ...filaInsertada }, error: null });
    return resolve({ data: esSingle ? null : [], error: null, count: 0 });
  };
  return chain;
}

const dbMock = { supabase: { from: vi.fn((t) => makeChain(t)) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const analyticsMock = { capture: vi.fn() };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/analytics.js', analyticsMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { guardarTransaccion } = require('../../services/transactions');

const T0 = 1784600000000;

// Cada test usa su propio usuario para no compartir el Map de dedup entre casos.
function aviso(usuarioId, recibidoEnMs, extra = {}) {
  return [usuarioId, {
    monto: 119.9, comercio: 'Smart Fit Peru', tipo: 'gasto', categoria: 'Salud',
    fecha: '2026-07-20', banco: 'BCP', esGmail: true,
    gmail_msg_id: 'msg-' + recibidoEnMs, descripcion_original: 'msg-' + recibidoEnMs,
    dedupAvisoGmail: true, recibidoEnMs,
    ...extra,
  }];
}

beforeEach(() => { inserts.length = 0; logMock.warn.mockClear(); });

describe('dos avisos del mismo cargo por Gmail', () => {
  it('ignora el segundo aviso si los correos llegaron con 1 segundo de diferencia', async () => {
    const u = 'u-mismo-cargo';
    const primera = await guardarTransaccion(...aviso(u, T0));
    const segunda = await guardarTransaccion(...aviso(u, T0 + 1000));

    expect(primera).toBeTruthy();
    expect(segunda).toBeNull();
    expect(inserts).toHaveLength(1);
    const tags = logMock.warn.mock.calls.map(c => c[0].tag);
    expect(tags).toContain('DEDUP_GMAIL_AVISO');
  });

  it('guarda las dos si los correos llegaron separados (compras reales repetidas)', async () => {
    const u = 'u-compras-reales';
    const primera = await guardarTransaccion(...aviso(u, T0));
    const segunda = await guardarTransaccion(...aviso(u, T0 + 10 * 60 * 1000));

    expect(primera).toBeTruthy();
    expect(segunda).toBeTruthy();
    expect(inserts).toHaveLength(2);
  });

  it('NO deduplica en el barrido historico, donde dos compras iguales del mismo dia se procesan juntas', async () => {
    const u = 'u-historico';
    await guardarTransaccion(...aviso(u, T0, { dedupAvisoGmail: false }));
    await guardarTransaccion(...aviso(u, T0 + 1000, { dedupAvisoGmail: false }));
    expect(inserts).toHaveLength(2);
  });

  it('si el correo no trae hora de llegada, guarda igual (degradacion segura)', async () => {
    const u = 'u-sin-hora';
    await guardarTransaccion(...aviso(u, T0, { recibidoEnMs: undefined }));
    await guardarTransaccion(...aviso(u, T0, { recibidoEnMs: undefined }));
    expect(inserts).toHaveLength(2);
  });

  it('cargos distintos del mismo comercio no se pisan aunque lleguen juntos', async () => {
    const u = 'u-montos-distintos';
    await guardarTransaccion(...aviso(u, T0));
    await guardarTransaccion(...aviso(u, T0 + 1000, { monto: 45.5 }));
    expect(inserts).toHaveLength(2);
  });
});
