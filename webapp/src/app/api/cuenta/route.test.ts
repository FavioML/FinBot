import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireNetoUser = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));

const { DELETE } = await import('./route');

const SENTINEL = { marca: 'respuesta-de-requireNetoUser' } as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.INTERNAL_API_KEY = 'clave-de-prueba';
  process.env.NETO_BACKEND_URL = 'https://api.test';
  requireNetoUser.mockResolvedValue({ ok: true, user: { id: 'neto-1' }, authId: 'auth-1' });
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
});

describe('DELETE /api/cuenta', () => {
  it('sin sesion valida devuelve la respuesta de requireNetoUser y no llama al backend', async () => {
    requireNetoUser.mockResolvedValue({ ok: false, response: SENTINEL });
    const res = await DELETE();
    expect(res).toBe(SENTINEL);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // El id sale del chokepoint, nunca de la entrada: es lo que hace que no haya IDOR.
  it('manda al backend el id de la SESION, con el secreto por header', async () => {
    await DELETE();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test/internal/cuenta/borrar',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-internal-key': 'clave-de-prueba' }),
        body: JSON.stringify({ usuario_id: 'neto-1' }),
      }),
    );
  });

  // El resto de las llamadas servidor-a-servidor de este repo son avisos best-effort y hacen
  // `if (!key) return;`. Aca eso seria decirle "listo" a alguien cuyos datos siguen enteros.
  it('sin INTERNAL_API_KEY falla DURO, no en silencio', async () => {
    delete process.env.INTERNAL_API_KEY;
    const res = await DELETE();
    expect(res.status).toBe(500);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('si el backend responde error, no dice que se borro', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    const res = await DELETE();
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/No pudimos completar/) }),
    );
  });

  // Un fetch que revienta NO prueba que no se haya borrado: el backend pudo commitear la
  // transaccion y morirse al responder. Por eso el texto no promete que la cuenta sigue igual.
  it('si el backend no responde, no afirma que la cuenta sigue igual', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    const res = await DELETE();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/sigue igual/i);
  });

  it('el camino feliz devuelve success', async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
  });
});
