import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Retencion de `conversaciones` (helpers/db-helpers.js). La purga vieja dejaba solo
// los 10 turnos mas recientes, lo que borraba el alta apenas el usuario tenia algo de
// actividad. Ahora el head (primeros turnos = onboarding) queda protegido para
// siempre y el tail retenido subio a 40.
//
// Mock de Supabase: la cadena devuelve datos distintos segun el ultimo metodo
// terminal llamado (range = candidatos a purga, limit = head protegido), que es lo
// que distingue las dos consultas de guardarMensaje.
function makeConvChain({ viejos = [], head = [] } = {}) {
  const calls = { inserted: null, deleted: null, pidioHead: false };
  const chain = {};
  let modo = null;
  for (const m of ['select', 'eq', 'order', 'delete']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.insert = vi.fn((payload) => { calls.inserted = payload; modo = 'insert'; return chain; });
  chain.range = vi.fn(() => { modo = 'range'; return chain; });
  chain.limit = vi.fn(() => { modo = 'limit'; calls.pidioHead = true; return chain; });
  chain.in = vi.fn((_col, ids) => { calls.deleted = ids; modo = 'delete'; return chain; });
  chain.then = (onF, onR) => {
    const data = modo === 'range' ? viejos : modo === 'limit' ? head : [];
    return Promise.resolve({ data, error: null }).then(onF, onR);
  };
  return { chain, calls };
}

const db = require('../../lib/db');
let convChain;
let convCalls;
db.supabase.from = vi.fn(() => convChain);

const { guardarMensaje } = require('../../helpers/db-helpers');

const USER = '11111111-1111-1111-1111-111111111111';

describe('guardarMensaje — retencion de conversaciones', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserta el turno y no purga nada cuando el usuario esta por debajo del tail', async () => {
    ({ chain: convChain, calls: convCalls } = makeConvChain({ viejos: [] }));

    await guardarMensaje(USER, 'usuario', 'gaste 50 en taxi');

    expect(convCalls.inserted).toMatchObject({ usuario_id: USER, rol: 'usuario', mensaje: 'gaste 50 en taxi' });
    expect(convCalls.deleted).toBeNull();
    // El caso comun no debe pagar la query extra del head.
    expect(convCalls.pidioHead).toBe(false);
  });

  it('protege el head (el alta) y borra solo lo que quedo en el medio', async () => {
    ({ chain: convChain, calls: convCalls } = makeConvChain({
      // Candidatos por posicion: incluyen turnos del alta (1 y 2) que NO deben morir.
      viejos: [{ id: 1 }, { id: 2 }, { id: 77 }, { id: 78 }],
      head: [{ id: 1 }, { id: 2 }, { id: 3 }],
    }));

    await guardarMensaje(USER, 'neto', 'respuesta');

    expect(convCalls.pidioHead).toBe(true);
    expect(convCalls.deleted).toEqual([77, 78]);
  });

  it('no llama a delete si todos los candidatos estan protegidos', async () => {
    ({ chain: convChain, calls: convCalls } = makeConvChain({
      viejos: [{ id: 1 }, { id: 2 }],
      head: [{ id: 1 }, { id: 2 }, { id: 3 }],
    }));

    await guardarMensaje(USER, 'neto', 'respuesta');

    expect(convCalls.deleted).toBeNull();
  });

  it('nunca propaga un error de supabase (el historial no debe romper el bot)', async () => {
    convChain = { insert: vi.fn(() => { throw new Error('boom'); }) };

    await expect(guardarMensaje(USER, 'usuario', 'hola')).resolves.toBeUndefined();
  });
});
