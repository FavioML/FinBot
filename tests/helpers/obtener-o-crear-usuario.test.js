import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// La guarda de `obtenerOCrearUsuario` contra un número vacío, probada sobre la función REAL
// (va en su propio archivo justo por eso: webhook-sin-from.test.js la parchea con un spy,
// así que ahí no se puede ejercer la de verdad).
//
// Lo que protege no es el `.replace` que reventaba, es el INSERT del final: `whatsapp` es
// NULLABLE por la identidad dual web-first (migr 046), así que un valor vacío NO hace fallar
// el insert — crea un usuario fantasma sin número, imposible de vincular a nadie, y que entra
// al embudo como un alta real. Ver la memoria project_user_identity_model.

// Si la guarda se cae, el flujo llega hasta acá: el espía lo delata sin tocar la DB real.
const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) }));
require('../../lib/db').supabase.from = vi.fn(() => ({
  select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
  insert,
}));

const { obtenerOCrearUsuario } = require('../../helpers/db-helpers');

describe('obtenerOCrearUsuario: número vacío o inválido', () => {
  it.each([[undefined], [null], [''], [0], [123], [{}]])(
    'lanza con %p en vez de crear un usuario fantasma', async (valor) => {
      insert.mockClear();
      await expect(obtenerOCrearUsuario(valor)).rejects.toThrow(/vacío o inválido/);
      // La aserción que importa: nunca se intentó insertar.
      expect(insert).not.toHaveBeenCalled();
    });

  it('el mensaje del error dice qué llegó (diagnosticable, no un TypeError opaco)', async () => {
    await expect(obtenerOCrearUsuario(undefined)).rejects.toThrow(/obtenerOCrearUsuario/);
  });
});
