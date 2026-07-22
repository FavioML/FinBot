import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Espejo cliente del test de `requireNetoUser`.
 *
 * Aca no hay codigos HTTP, asi que el bug se veia distinto y por eso se me paso
 * en el primer barrido: la queryFn se tragaba el `error` y TERMINABA BIEN con
 * `null`. React Query cachea eso como resultado valido (`retry` solo cubre
 * promesas rechazadas) y lo persiste 24h en localStorage. Ese `null` hace que un
 * usuario Pro vea el producto Free y que el shell lo expulse a /onboarding.
 */

const getUser = vi.fn();
const maybeSingle = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle }),
      }),
    }),
  }),
}));

const { fetchNetoUser, decidirRedirectAuth } = await import('./use-user');

const CON_SESION = { data: { user: { id: 'auth-uuid-1' } } };

beforeEach(() => vi.clearAllMocks());

describe('fetchNetoUser', () => {
  it('lanza si la lectura se cae, para que React Query reintente en vez de cachear un null falso', async () => {
    getUser.mockResolvedValue(CON_SESION);
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });

    await expect(fetchNetoUser()).rejects.toThrow(/statement timeout/);
  });

  it('devuelve null cuando de verdad no hay fila', async () => {
    getUser.mockResolvedValue(CON_SESION);
    maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(fetchNetoUser()).resolves.toBeNull();
  });

  it('devuelve null sin sesion, sin tocar la tabla', async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    await expect(fetchNetoUser()).resolves.toBeNull();
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it('devuelve la fila cuando la lectura funciona', async () => {
    getUser.mockResolvedValue(CON_SESION);
    maybeSingle.mockResolvedValue({ data: { id: 'neto-1', plan: 'premium' }, error: null });

    await expect(fetchNetoUser()).resolves.toEqual({ id: 'neto-1', plan: 'premium' });
  });
});

describe('decidirRedirectAuth', () => {
  const base = { isRestoring: false, isPending: false, isError: false, user: null };

  it('NO expulsa cuando la lectura se cayo', () => {
    // El corazon del fix: con `isError` no sabemos si el usuario tiene fila.
    // Tratarlo como "no tiene" lo manda a /onboarding a re-registrarse por OTP
    // teniendo cuenta — el mismo bug que /auth/callback tenia en el server.
    expect(decidirRedirectAuth({ ...base, isError: true })).toBe('esperar');
  });

  it('espera mientras la cache restaura o la query esta en vuelo', () => {
    expect(decidirRedirectAuth({ ...base, isRestoring: true })).toBe('esperar');
    expect(decidirRedirectAuth({ ...base, isPending: true })).toBe('esperar');
  });

  it('deja quedarse a quien tiene fila', () => {
    expect(decidirRedirectAuth({ ...base, user: { id: 'neto-1' } as never })).toBe('quedarse');
  });

  it('manda a revisar la sesion solo con una lectura BUENA que no encontro fila', () => {
    expect(decidirRedirectAuth(base)).toBe('revisar-sesion');
  });
});
