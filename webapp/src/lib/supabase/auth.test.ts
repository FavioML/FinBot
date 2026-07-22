import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El unico test que cubre las ~36 rutas autenticadas de la webapp.
 *
 * Antes, el mapeo sesion -> `usuarios` estaba copiado a mano en cada ruta y
 * ninguna copia capturaba el `error` de Supabase: una lectura caida se le
 * presentaba al usuario como 401 "no eres tu" o 404 "no existes". Como ahora
 * todas pasan por `requireNetoUser`, la decision vive en un solo sitio y se
 * prueba una sola vez.
 *
 * Lo que se afirma es que los TRES casos se distinguen. Si alguien colapsa el
 * `if (error)` de vuelta a un `if (!data) return null`, el caso del medio falla.
 */

const getUser = vi.fn();
const maybeSingle = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle }),
      }),
    }),
  }),
}));

const { requireNetoUser, findNetoUser } = await import('./auth');

const CON_SESION = { data: { user: { id: 'auth-uuid-1' } } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('requireNetoUser', () => {
  it('401 cuando no hay sesion Supabase', async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await requireNetoUser();

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.response.status).toBe(401);
    // Sin sesion ni siquiera se intenta la lectura.
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it('500 cuando la lectura de `usuarios` se cae — NO 401 ni 404', async () => {
    getUser.mockResolvedValue(CON_SESION);
    maybeSingle.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    });

    const res = await requireNetoUser('id, plan');

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // El corazon del fix: la sesion es valida, el usuario existe, y lo unico que
    // paso es que la DB se cayo. Decirle 401 lo manda al login (y en /join/* le
    // come la invitacion); decirle 404 le dice que su cuenta no existe.
    expect(res.response.status).toBe(500);
    // El mensaje de Postgres se queda en los logs, no sale al cliente.
    await expect(res.response.json()).resolves.toEqual({
      error: 'Error temporal, intenta de nuevo',
    });
  });

  it('404 cuando hay sesion pero todavia no hay fila en `usuarios`', async () => {
    getUser.mockResolvedValue(CON_SESION);
    maybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await requireNetoUser();

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.response.status).toBe(404);
  });

  it('devuelve la fila cuando la lectura funciona', async () => {
    getUser.mockResolvedValue(CON_SESION);
    maybeSingle.mockResolvedValue({ data: { id: 'neto-1', plan: 'premium' }, error: null });

    const res = await requireNetoUser('id, plan');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.user).toEqual({ id: 'neto-1', plan: 'premium' });
  });
});

describe('findNetoUser', () => {
  // La variante para el onboarding, donde "no hay fila" es el caso NORMAL: no
  // puede responder 404, pero tampoco puede confundirlo con una lectura caida.
  it('lanza si la lectura se cae', async () => {
    getUser.mockResolvedValue(CON_SESION);
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    await expect(findNetoUser()).rejects.toThrow(/connection reset/);
  });

  it('devuelve null si no hay fila (sin lanzar)', async () => {
    getUser.mockResolvedValue(CON_SESION);
    maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(findNetoUser()).resolves.toBeNull();
  });
});
