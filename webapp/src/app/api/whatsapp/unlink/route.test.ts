import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Ruta self-serve para desvincular el número de WhatsApp ("cambiar número").
 *
 * Lo que se afirma:
 *  - sin sesión válida, devuelve tal cual la respuesta de `requireNetoUser`
 *    (401/404/500) y NO toca la DB;
 *  - si ya no hay número, es idempotente (no hace UPDATE);
 *  - el UPDATE pone `whatsapp: null` y filtra por `auth.user.id` (la fila de la
 *    sesión) — nunca por un id de entrada, así que no hay superficie de IDOR;
 *  - un fallo de la DB se traduce a 500 con mensaje genérico, no se filtra.
 */

const requireNetoUser = vi.fn();
const eqCall = vi.fn();
const update = vi.fn(() => ({ eq: eqCall }));
const from = vi.fn(() => ({ update }));

vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ from }),
}));

const { POST } = await import('./route');

const SENTINEL = { marca: 'respuesta-de-requireNetoUser' } as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  eqCall.mockResolvedValue({ error: null });
});

describe('POST /api/whatsapp/unlink', () => {
  it('sin sesión válida devuelve la respuesta de requireNetoUser y no toca la DB', async () => {
    requireNetoUser.mockResolvedValue({ ok: false, response: SENTINEL });

    const res = await POST();

    expect(res).toBe(SENTINEL);
    expect(from).not.toHaveBeenCalled();
  });

  it('es idempotente: si ya no hay número, no hace UPDATE', async () => {
    requireNetoUser.mockResolvedValue({
      ok: true,
      user: { id: 'neto-1', whatsapp: null },
      authId: 'auth-1',
    });

    const res = await POST();

    expect(from).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, alreadyUnlinked: true });
  });

  it('pone whatsapp=null en la fila de la sesión (por id, no por input)', async () => {
    requireNetoUser.mockResolvedValue({
      ok: true,
      user: { id: 'neto-1', whatsapp: '51999888777' },
      authId: 'auth-1',
    });

    const res = await POST();

    expect(update).toHaveBeenCalledWith({ whatsapp: null });
    expect(eqCall).toHaveBeenCalledWith('id', 'neto-1');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
  });

  it('un fallo de la DB se traduce a 500 genérico (no se filtra el mensaje)', async () => {
    requireNetoUser.mockResolvedValue({
      ok: true,
      user: { id: 'neto-1', whatsapp: '51999888777' },
      authId: 'auth-1',
    });
    eqCall.mockResolvedValue({ error: { code: '57014', message: 'statement timeout' } });

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Error temporal, intenta de nuevo' });
  });
});
