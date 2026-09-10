import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createWebUser } from './create-web-user';
import { atribucionDelAlta } from './atribucion';

/**
 * El alta web escribe el canal EN el INSERT que crea la fila, no en un UPDATE posterior. No es
 * estética: un UPDATE aparte es una segunda escritura que puede fallar sola y dejar una cuenta sin
 * origen para siempre (el dato de la cookie ya se consumió), indistinguible de un alta anterior a
 * la medición. En el INSERT, o se escriben las dos cosas o no se crea nada.
 */

type Insert = { table: string; payload: unknown };

function svcFalso(): { svc: SupabaseClient; inserts: Insert[] } {
  const inserts: Insert[] = [];
  const ok = (data: unknown) => ({ data, error: null });
  const svc = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          inserts.push({ table, payload });
          return Object.assign(Promise.resolve(ok(null)), {
            select: () =>
              Object.assign(Promise.resolve(ok([])), {
                single: async () => ok({ id: 'usuario-nuevo' }),
              }),
          });
        },
      };
    },
  };
  return { svc: svc as unknown as SupabaseClient, inserts };
}

const filaDeUsuarios = (inserts: Insert[]) =>
  inserts.find((i) => i.table === 'usuarios')?.payload as Record<string, unknown>;

describe('createWebUser escribe el canal del alta', () => {
  it('con el origen de la cookie y la puerta web', async () => {
    const { svc, inserts } = svcFalso();
    const id = await createWebUser(svc, {
      authId: 'auth-1',
      email: 'a@b.pe',
      nombre: null,
      atribucion: atribucionDelAlta('ig'),
    });
    expect(id).toBe('usuario-nuevo');
    const fila = filaDeUsuarios(inserts);
    expect(fila.origen).toBe('ig');
    expect(fila.origen_cta).toBe('web');
  });

  it('sin pista escribe directo, y la columna nunca queda en null', async () => {
    const { svc, inserts } = svcFalso();
    await createWebUser(svc, {
      authId: 'auth-2',
      email: null,
      nombre: null,
      atribucion: atribucionDelAlta(undefined),
    });
    const fila = filaDeUsuarios(inserts);
    expect(fila.origen).toBe('directo');
    expect(fila.origen).not.toBeNull();
    expect(fila.origen_cta).toBe('web');
  });
});
