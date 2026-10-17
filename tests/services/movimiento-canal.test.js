import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// `wa_movimiento_canal`: por qué canal entró cada movimiento que escribe el backend (texto, audio,
// imagen, archivo). Existe porque el audio se transcribe y se reinyecta como texto, y después de
// eso ninguna fila lo distingue. Lo lee la skill `neto-usuarios` (bloque D) desde PostHog.
//
// Lo que este archivo fija, y por qué cada caso:
//   · sale con el canal del contexto del mensaje y SIN monto ni comercio;
//   · no sale fuera de un mensaje (crons, Gmail): ahí no hay canal que contar;
//   · no sale por una fila del dedup: contaría dos veces el mismo gasto.

const inserts = [];
let filasDedup = null;

function makeChain() {
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
    if (!esSingle && filasDedup) return resolve({ data: filasDedup, error: null });
    return resolve({ data: esSingle ? null : [], error: null, count: 3 });
  };
  return chain;
}

const dbMock = { supabase: { from: vi.fn(() => makeChain()) } };
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
const { conContextoDeMensaje, fijarCanal } = require('../../lib/canal-entrada');

const GASTO = { monto: 20, comercio: 'Pollería El Rancho', tipo: 'gasto', categoria: 'Alimentación', fecha: '2026-10-17' };

function enMensaje(tipoMensaje, fn) {
  return conContextoDeMensaje(async () => { fijarCanal(tipoMensaje); return fn(); });
}

function eventosCanal() {
  return analyticsMock.capture.mock.calls.filter(([, ev]) => ev === 'wa_movimiento_canal');
}

beforeEach(() => { inserts.length = 0; filasDedup = null; analyticsMock.capture.mockClear(); });

describe('wa_movimiento_canal', () => {
  it.each([['audio', 'audio'], ['text', 'texto'], ['image', 'imagen'], ['document', 'archivo']])(
    'un movimiento escrito desde un mensaje %s sale con canal %s', async (tipoMensaje, canal) => {
      await enMensaje(tipoMensaje, () => guardarTransaccion('u-1', { ...GASTO }));
      expect(eventosCanal()).toEqual([['u-1', 'wa_movimiento_canal', { canal, tipo: 'gasto' }]]);
    });

  it('no lleva monto, comercio ni categoría', async () => {
    await enMensaje('audio', () => guardarTransaccion('u-1', { ...GASTO }));
    const [[, , props]] = eventosCanal();
    expect(Object.keys(props).sort()).toEqual(['canal', 'tipo']);
  });

  it('fuera de un mensaje (cron, script) no sale', async () => {
    await guardarTransaccion('u-1', { ...GASTO });
    expect(inserts).toHaveLength(1);
    expect(eventosCanal()).toEqual([]);
  });

  it('el barrido de Gmail no sale aunque corra dentro de un mensaje (/escanear)', async () => {
    await enMensaje('text', () => guardarTransaccion('u-1', { ...GASTO, esGmail: true, gmail_msg_id: 'm-1', descripcion_original: 'm-1' }));
    expect(inserts).toHaveLength(1);
    expect(eventosCanal()).toEqual([]);
  });

  it('una fila devuelta por el dedup no cuenta otra vez', async () => {
    filasDedup = [{ id: 'tx-viejo', tarjeta_last4: null }];
    const tx = await enMensaje('audio', () => guardarTransaccion('u-1', { ...GASTO }));
    expect(tx.id).toBe('tx-viejo');
    expect(inserts).toHaveLength(0);
    expect(eventosCanal()).toEqual([]);
  });

  it('dos mensajes concurrentes no se pisan el canal', async () => {
    let soltar;
    const espera = new Promise((r) => { soltar = r; });
    const lento = enMensaje('audio', async () => { await espera; return guardarTransaccion('u-a', { ...GASTO }); });
    await enMensaje('text', () => guardarTransaccion('u-t', { ...GASTO, comercio: 'Taxi' }));
    soltar();
    await lento;
    const porUsuario = Object.fromEntries(eventosCanal().map(([u, , p]) => [u, p.canal]));
    expect(porUsuario).toEqual({ 'u-a': 'audio', 'u-t': 'texto' });
  });
});
