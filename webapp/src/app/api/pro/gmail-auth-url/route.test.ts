import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La puerta web a la conexión de Gmail.
 *
 * Conectar Gmail consume uno de los 100 cupos de Google que tenemos hasta la certificación
 * CASA, así que se reserva para quien PAGA. El punto fino: durante el trial `plan` ya vale
 * `'premium'` (migración 052), o sea que un gate escrito como `plan === 'premium'` —o su
 * equivalente `isPremium`— deja pasar al que prueba. Por eso se afirma explícitamente el caso
 * trial, que es el único que distingue el gate correcto del incorrecto.
 *
 * También se afirma que el 403 corta ANTES del fetch al backend: si sale la llamada, el
 * backend tiene su propio gate y respondería 403 igual, pero acá se estaría gastando un
 * round-trip y —peor— confiando en que el de allá nunca se caiga.
 */

const requireNetoUser = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => true }));

vi.stubGlobal('fetch', fetchMock);
process.env.INTERNAL_API_KEY = 'test-key';

const { GET } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, url: 'https://oauth.example/start' }) });
});

function sesion(plan: string | null, trial_estado: string | null) {
  requireNetoUser.mockResolvedValue({ ok: true, user: { id: 'u1', plan, trial_estado }, authId: 'a1' });
}

describe('GET /api/pro/gmail-auth-url', () => {
  it('pide plan y trial_estado: una fila parcial decidiría con undefined y abriría el gate', async () => {
    sesion('premium', 'convertido');
    await GET();
    expect(requireNetoUser).toHaveBeenCalledWith(expect.stringContaining('trial_estado'));
    expect(requireNetoUser).toHaveBeenCalledWith(expect.stringContaining('plan'));
  });

  it('403 al usuario en trial, y sin llamar al backend', async () => {
    sesion('premium', 'activo');
    const res = await GET();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ motivo: 'pro_pagado_requerido' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 al usuario en el muro', async () => {
    sesion('free', 'vencido');
    const res = await GET();
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Sin este caso, un gate que niegue SIEMPRE (o una ruta rota) se vería idéntico a uno bueno.
  it('deja pasar al Pro pagado y devuelve la URL del backend', async () => {
    sesion('premium', 'convertido');
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, url: 'https://oauth.example/start' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('sin sesión válida devuelve la respuesta de requireNetoUser y no llama al backend', async () => {
    const SENTINEL = { marca: 'respuesta-de-requireNetoUser' } as unknown as Response;
    requireNetoUser.mockResolvedValue({ ok: false, response: SENTINEL });
    expect(await GET()).toBe(SENTINEL);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
