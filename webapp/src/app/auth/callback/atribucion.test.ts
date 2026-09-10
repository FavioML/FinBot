import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * El cable entre la captura (middleware → cookie `neto_origen`) y la escritura (`createWebUser`).
 *
 * Se ejercita la route de verdad con Supabase mockeado en su borde. Lo que interesa acá son tres
 * decisiones del callback que ningún test de las piezas sueltas ve:
 *   · lee la cookie SOLO en la rama que crea la fila (las otras devuelven una fila existente);
 *   · sin cookie escribe 'directo', no null;
 *   · la cookie se consume solo si la cuenta se creó, para que el reintento siga atribuido.
 */

// `lecturas` se sirven en orden: la primera es la búsqueda por auth_id, la segunda por email.
// `updates` espía toda escritura sobre una fila existente, que es donde se violaría el primer toque.
const h = vi.hoisted(() => ({
  createWebUser: vi.fn(),
  lecturas: [] as Array<Record<string, unknown> | null>,
  updates: [] as unknown[],
}));

vi.mock('@/lib/create-web-user', () => ({ createWebUser: h.createWebUser }));
vi.mock('@/lib/link-web-referral', () => ({ linkWebReferral: vi.fn() }));
vi.mock('@/lib/activacion-token', () => ({ verificarTokenActivacion: vi.fn(() => null) }));
vi.mock('@/lib/bind-activation', () => ({ bindActivacion: vi.fn(), notificarBackendActivacion: vi.fn() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      verifyOtp: async () => ({ error: null }),
      getUser: async () => ({ data: { user: { id: 'auth-1', email: 'qa@qa.neto.pe', user_metadata: {} } } }),
    },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.lecturas.shift() ?? null, error: null }) }) }),
      update: (patch: unknown) => {
        h.updates.push(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

const { GET } = await import('./route');

function pedir(cookie?: string) {
  const req = new NextRequest(new Request('https://app.neto.pe/auth/callback?token_hash=h1&type=magiclink'));
  if (cookie !== undefined) req.cookies.set('neto_origen', cookie);
  return GET(req);
}

beforeEach(() => {
  h.createWebUser.mockReset();
  h.lecturas = [];
  h.updates = [];
});

describe('/auth/callback — el alta web guarda su canal', () => {
  it('con cookie: la cuenta nace con ese origen y la cookie se consume', async () => {
    h.createWebUser.mockResolvedValue('usuario-nuevo');
    const res = await pedir('ig');
    expect(h.createWebUser).toHaveBeenCalledOnce();
    expect(h.createWebUser.mock.calls[0][1].atribucion).toEqual({ origen: 'ig', origen_cta: 'web' });
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
    const borrada = res.cookies.get('neto_origen');
    expect(borrada?.value).toBe('');
    expect(borrada?.maxAge).toBe(0);
  });

  it('sin cookie: directo, no null', async () => {
    h.createWebUser.mockResolvedValue('usuario-nuevo');
    await pedir();
    expect(h.createWebUser.mock.calls[0][1].atribucion).toEqual({ origen: 'directo', origen_cta: 'web' });
  });

  it('si la cuenta no se pudo crear, la cookie queda para el reintento', async () => {
    h.createWebUser.mockResolvedValue(null);
    const res = await pedir('ig');
    expect(new URL(res.headers.get('location')!).pathname).toBe('/onboarding');
    expect(res.cookies.get('neto_origen')).toBeUndefined();
  });

  it('una fila que ya existe (por auth_id) no se toca y la cookie se descarta', async () => {
    h.lecturas = [{ id: 'usuario-viejo' }];
    const res = await pedir('ig');
    expect(h.createWebUser).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
    expect(res.cookies.get('neto_origen')?.maxAge).toBe(0);
  });

  it('la fila de WhatsApp que se vincula por email conserva SU origen', async () => {
    // Primer toque: el canal de esa persona lo decidió su primer mensaje de WhatsApp. La rama
    // byEmail solo puede escribir el auth_id, nunca el origen.
    h.lecturas = [null, { id: 'usuario-wa', supabase_auth_id: null }];
    const res = await pedir('ig');
    expect(h.createWebUser).not.toHaveBeenCalled();
    expect(h.updates).toEqual([{ supabase_auth_id: 'auth-1' }]);
    expect(res.cookies.get('neto_origen')?.maxAge).toBe(0);
  });
});
