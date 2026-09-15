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

/**
 * El 23505 del INSERT tiene DOS causas y hasta el 15-sep-2026 se leía como una sola.
 *
 *   · carrera de pestañas: otra sesión ya creó la fila de este auth_id → se recupera por auth_id;
 *   · el correo ya es de OTRA fila (`usuarios_email_lower_unique`, migración 022): típicamente la
 *     de WhatsApp de la misma persona, o la de alguien que dictó ese correo por error.
 *
 * La segunda caía en la rama de la primera, no encontraba nada por auth_id y devolvía null: el
 * callback mandaba a /onboarding, que para una sesión sin fila no tiene salida. Ahora el alta nace
 * SIN correo — la fila dueña del correo no se toca, y si es la misma persona, `merge_and_link` le
 * pasa el correo al fusionar.
 */
type Lectura = { id: string } | null | 'error';

function svcConColision(erroresInsert: Array<{ code: string } | null>, porAuthId: Lectura[]) {
  const usuariosInsertados: Record<string, unknown>[] = [];
  let lecturasPorAuthId = 0;
  const svc = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          if (table !== 'usuarios') {
            return Object.assign(Promise.resolve({ data: null, error: null }), {
              select: () => Promise.resolve({ data: [], error: null }),
            });
          }
          usuariosInsertados.push(payload);
          const error = erroresInsert.shift() ?? null;
          return {
            select: () => ({
              single: async () => ({ data: error ? null : { id: 'usuario-nuevo' }, error }),
            }),
          };
        },
        select: () => ({
          eq: (col: string) => ({
            maybeSingle: async () => {
              expect(col).toBe('supabase_auth_id');
              lecturasPorAuthId++;
              const v = porAuthId.shift() ?? null;
              if (v === 'error') return { data: null, error: { message: 'timeout' } };
              return { data: v, error: null };
            },
          }),
        }),
      };
    },
  };
  return { svc: svc as unknown as SupabaseClient, usuariosInsertados, lecturas: () => lecturasPorAuthId };
}

const ALTA = { authId: 'auth-9', email: 'victima@gmail.com', nombre: 'V', atribucion: atribucionDelAlta('ig') };

describe('createWebUser ante un 23505', () => {
  it('correo tomado por otra fila: reintenta UNA vez sin correo y devuelve la cuenta nueva', async () => {
    const { svc, usuariosInsertados } = svcConColision([{ code: '23505' }, null], [null]);
    expect(await createWebUser(svc, ALTA)).toBe('usuario-nuevo');
    expect(usuariosInsertados).toHaveLength(2);
    expect(usuariosInsertados[0].email).toBe('victima@gmail.com');
    expect(usuariosInsertados[1].email).toBeNull();
    // El reintento es la MISMA alta: mismo auth_id y mismo canal.
    expect(usuariosInsertados[1]).toMatchObject({ supabase_auth_id: 'auth-9', origen: 'ig', origen_cta: 'web' });
  });

  it('carrera de pestañas: la fila ya existe por auth_id, se devuelve y no se reintenta', async () => {
    const { svc, usuariosInsertados } = svcConColision([{ code: '23505' }], [{ id: 'ya-existia' }]);
    expect(await createWebUser(svc, ALTA)).toBe('ya-existia');
    expect(usuariosInsertados).toHaveLength(1);
  });

  it('carrera DURANTE el reintento: se recupera por auth_id', async () => {
    const { svc, usuariosInsertados } = svcConColision([{ code: '23505' }, { code: '23505' }], [null, { id: 'la-otra-pestana' }]);
    expect(await createWebUser(svc, ALTA)).toBe('la-otra-pestana');
    expect(usuariosInsertados).toHaveLength(2);
  });

  it('23505 también sin correo: null, sin bucle', async () => {
    const { svc, usuariosInsertados, lecturas } = svcConColision([{ code: '23505' }, { code: '23505' }, { code: '23505' }], [null, null, null]);
    expect(await createWebUser(svc, ALTA)).toBeNull();
    expect(usuariosInsertados).toHaveLength(2);
    expect(lecturas()).toBe(2);
  });

  it('sin correo desde el principio no hay nada que soltar: un solo intento', async () => {
    const { svc, usuariosInsertados } = svcConColision([{ code: '23505' }, null], [null]);
    expect(await createWebUser(svc, { ...ALTA, email: null })).toBeNull();
    expect(usuariosInsertados).toHaveLength(1);
  });

  it('la lectura por auth_id se cae: null, NO se reintenta a ciegas', async () => {
    // Leída como "no hay fila", el reintento correría sobre una carrera real. null es recuperable.
    const { svc, usuariosInsertados } = svcConColision([{ code: '23505' }, null], ['error']);
    expect(await createWebUser(svc, ALTA)).toBeNull();
    expect(usuariosInsertados).toHaveLength(1);
  });

  it('un error que NO es 23505 no dispara el reintento ni la lectura', async () => {
    const { svc, usuariosInsertados, lecturas } = svcConColision([{ code: '23502' }, null], [null]);
    expect(await createWebUser(svc, ALTA)).toBeNull();
    expect(usuariosInsertados).toHaveLength(1);
    expect(lecturas()).toBe(0);
  });
});
