import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import Module from 'module';

// vitest no intercepta el `require('../lib/db')` CJS transitivo de admin-commands, así que
// cargamos el módulo con CJS puro (como config-plan.test.js) y sustituimos `db` por un fake
// controlable vía Module.prototype.require durante la carga. `single` lee state.pagoData.
const require = createRequire(import.meta.url);
const state = { pagoData: null };
// Fake de Supabase que modela el CLAIM ATÓMICO: un `UPDATE ... WHERE estado='pendiente'`
// devuelve la fila solo si seguía pendiente (como Postgres); un SELECT devuelve la fila actual.
function makeBuilder() {
  let isUpdate = false;
  let filtraPendiente = false;
  const b = new Proxy({}, {
    get(_t, p) {
      if (p === 'update') return () => { isUpdate = true; return b; };
      if (p === 'eq') return (col, val) => { if (col === 'estado' && val === 'pendiente') filtraPendiente = true; return b; };
      if (p === 'single') return async () => ({ data: state.pagoData });
      if (p === 'maybeSingle') return async () => {
        if (isUpdate && filtraPendiente) {
          return { data: state.pagoData && state.pagoData.estado === 'pendiente' ? state.pagoData : null };
        }
        return { data: state.pagoData };
      };
      return () => b;
    },
  });
  return b;
}
const fakeDb = {
  supabase: {
    from: () => makeBuilder(),
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null }) }) },
  },
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './db' || id === '../lib/db' || String(id).replace(/\\/g, '/').endsWith('/lib/db')) return fakeDb;
  return origRequire.apply(this, arguments);
};
const { procesarCallbackAdmin } = require('../../handlers/admin-commands');
Module.prototype.require = origRequire; // restaurar: admin-commands ya capturó el fake en carga

beforeEach(() => { state.pagoData = null; });

describe('procesarCallbackAdmin (botones inline Telegram)', () => {
  it('ignora callbacks que no son de Pro', async () => {
    expect(await procesarCallbackAdmin('otra:cosa')).toBeNull();
    expect(await procesarCallbackAdmin('')).toBeNull();
    expect(await procesarCallbackAdmin(undefined)).toBeNull();
  });

  it('responde "no encontrada" si el pago no existe', async () => {
    state.pagoData = null;
    const r = await procesarCallbackAdmin('pro:approve:mensual:abc-123');
    expect(r.answer).toMatch(/no encontrada/i);
    expect(r.edit).toBeUndefined();
  });

  it('es idempotente al aprobar: no re-actúa si el pago ya no está pendiente (anti doble-tap)', async () => {
    state.pagoData = { id: 'abc', estado: 'aprobado', usuario_id: 'u1' };
    const r = await procesarCallbackAdmin('pro:approve:mensual:abc');
    expect(r.answer).toMatch(/ya procesado/i);
    expect(r.edit).toBeUndefined();
  });

  it('es idempotente al rechazar', async () => {
    state.pagoData = { id: 'abc', estado: 'rechazado', usuario_id: 'u1' };
    const r = await procesarCallbackAdmin('pro:reject:abc');
    expect(r.answer).toMatch(/ya procesado/i);
  });
});
