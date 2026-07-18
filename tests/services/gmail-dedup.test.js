import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

// C3 (CTO audit 2026-07-18): la race de doble barrido Gmail (sweep 30d + cron 15min) se
// cierra con el índice único parcial (usuario_id, gmail_msg_id) de la migración 031.
// guardarTransaccion debe tratar el 23505 de ese índice como DEDUP (devolver la fila que
// ganó), no como error. Estos tests fijan ese contrato sin tocar la DB.
//
// Patrón de mocking: inyección vía require.cache (igual que subscriptions.test.js).

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

// Estado mutable que cada test configura antes de llamar al servicio.
const state = { insertResult: null, conflictRow: null };

// Chain de Supabase configurable. Distingue:
//   - insert()...single()  en 'transacciones' -> state.insertResult (data o error 23505)
//   - select()...maybeSingle() en 'transacciones' -> state.conflictRow (lookup post-conflicto)
//   - select()...single() en 'reglas_comercio' -> sin regla
//   - await del chain (window dedup / count) -> vacío
function makeChain(table) {
  const ctx = { table, inserted: false };
  const chain = {};
  chain.select = () => chain;
  chain.insert = () => { ctx.inserted = true; return chain; };
  chain.eq = () => chain;
  chain.gte = () => chain;
  chain.limit = () => chain;
  chain.single = () => {
    if (ctx.table === 'transacciones' && ctx.inserted) return Promise.resolve(state.insertResult);
    return Promise.resolve({ data: null }); // reglas_comercio: sin regla que pise la categoría
  };
  chain.maybeSingle = () => Promise.resolve({ data: state.conflictRow });
  chain.then = (resolve) => resolve({ data: [], count: 0 }); // window dedup / count activación
  return chain;
}

const dbMock = { supabase: { from: (t) => makeChain(t) } };

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

const { guardarTransaccion } = require('../../services/transactions');

function baseDatos(extra = {}) {
  return { monto: 20, moneda: 'PEN', comercio: 'Netflix', tipo: 'gasto', banco: 'BCP', ...extra };
}

describe('guardarTransaccion — dedup por gmail_msg_id (C3)', () => {
  beforeEach(() => { state.insertResult = null; state.conflictRow = null; });

  it('insert exitoso de un correo Gmail devuelve la fila insertada', async () => {
    const NEW_ROW = { id: 'tx-new', comercio: 'Netflix', gmail_msg_id: 'gmail-abc' };
    state.insertResult = { data: NEW_ROW, error: null };

    const r = await guardarTransaccion('u1', baseDatos({
      descripcion_original: 'gmail-abc', gmail_msg_id: 'gmail-abc', esGmail: true,
    }));

    expect(r).toEqual(NEW_ROW);
  });

  it('23505 del índice único con gmail_msg_id -> devuelve la fila existente (no lanza)', async () => {
    const EXISTING = { id: 'tx-existing', comercio: 'Netflix', gmail_msg_id: 'gmail-123' };
    state.insertResult = { data: null, error: { code: '23505' } };
    state.conflictRow = EXISTING;

    const r = await guardarTransaccion('u1', baseDatos({
      descripcion_original: 'gmail-123', gmail_msg_id: 'gmail-123', esGmail: true,
    }));

    // El barrido concurrente ya insertó el correo; recibimos esa fila como dedup.
    expect(r).toEqual(EXISTING);
  });

  it('23505 SIN gmail_msg_id (registro manual) se propaga como error', async () => {
    // Sin gmail_msg_id no es la race de Gmail: un 23505 aquí es un error real que debe lanzar.
    state.insertResult = { data: null, error: { code: '23505' } };

    await expect(
      guardarTransaccion('u1', baseDatos({ descripcion_original: 'gasto manual' }))
    ).rejects.toBeTruthy();
  });
});
