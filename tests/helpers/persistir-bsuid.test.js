import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// El BSUID (migración 065) es lo único que conectará a un usuario con su cuenta el día que
// active un username de WhatsApp y `from` deje de venir. Se aprende en el camino caliente del
// webhook, así que las dos propiedades que importan no son "lo guarda" sino:
//   1. NUNCA borra lo aprendido (los call-sites que no vienen del webhook pasan null)
//   2. NUNCA rompe el flujo del mensaje (es enriquecimiento, no parte del alta)

const updates = [];
let respuestaUpdate = { error: null };
let lanzar = null;

const chain = {
  update: vi.fn((patch) => { updates.push(patch); return chain; }),
  eq: vi.fn(() => {
    if (lanzar) throw lanzar;
    return Promise.resolve(respuestaUpdate);
  }),
};
require('../../lib/db').supabase.from = vi.fn(() => chain);

const { persistirBsuid } = require('../../helpers/db-helpers');

describe('persistirBsuid', () => {
  beforeEach(() => {
    updates.length = 0;
    respuestaUpdate = { error: null };
    lanzar = null;
    chain.update.mockClear();
  });

  it('guarda el BSUID y lo refleja en el objeto en memoria', async () => {
    const usuario = { id: 'u1', bsuid: null };
    const out = await persistirBsuid(usuario, 'PE.123');
    expect(updates).toEqual([{ bsuid: 'PE.123' }]);
    expect(out.bsuid).toBe('PE.123');
  });

  it('NO escribe cuando el call-site no trae BSUID (no debe borrar lo aprendido)', async () => {
    const usuario = { id: 'u1', bsuid: 'PE.123' };
    const out = await persistirBsuid(usuario, null);
    expect(chain.update).not.toHaveBeenCalled();
    expect(out.bsuid).toBe('PE.123');
  });

  it('NO reescribe cuando ya es el mismo (el caso común: una query por mensaje)', async () => {
    await persistirBsuid({ id: 'u1', bsuid: 'PE.123' }, 'PE.123');
    expect(chain.update).not.toHaveBeenCalled();
  });

  it('actualiza si el BSUID cambió', async () => {
    await persistirBsuid({ id: 'u1', bsuid: 'PE.viejo' }, 'PE.nuevo');
    expect(updates).toEqual([{ bsuid: 'PE.nuevo' }]);
  });

  // Las dos ramas de fallo. Importa que el usuario siga su curso: perder la columna es
  // barato, perder el mensaje de quien está escribiendo no.
  it('devuelve el usuario intacto si el UPDATE falla (ej. choque del índice único)', async () => {
    respuestaUpdate = { error: { message: 'duplicate key value violates unique constraint' } };
    const usuario = { id: 'u1', bsuid: null };
    const out = await persistirBsuid(usuario, 'PE.123');
    expect(out).toBe(usuario);
    expect(out.bsuid).toBeNull();
  });

  it('no propaga si el cliente LANZA en vez de devolver error', async () => {
    lanzar = new Error('socket hang up');
    const usuario = { id: 'u1', bsuid: null };
    await expect(persistirBsuid(usuario, 'PE.123')).resolves.toBe(usuario);
  });

  it('tolera un usuario sin id sin tocar la DB', async () => {
    await persistirBsuid({}, 'PE.123');
    await persistirBsuid(null, 'PE.123');
    expect(chain.update).not.toHaveBeenCalled();
  });
});
