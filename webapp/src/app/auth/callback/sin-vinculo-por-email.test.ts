import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * El login con Google NUNCA adopta una fila existente por coincidencia de correo.
 *
 * Una fila nacida en WhatsApp puede traer un correo DICTADO en el alta vieja (paso 101), sin
 * verificar. Si un error de tipeo cae en el Gmail real de otra persona, vincular por correo le
 * entrega esa cuenta —y sus finanzas— la primera vez que entre a app.neto.pe. Vincular una cuenta
 * existente exige probar el NÚMERO: el link de activación firmado o el OTP inverso.
 *
 * El doble de Supabase es SEMÁNTICO a propósito: aplica los filtros sobre una tabla en memoria que
 * contiene la fila de WhatsApp, así que cualquier búsqueda que se reintroduzca —por `eq`, `ilike`,
 * `match`, un `select` sin filtro y un filtro en JS— la ENCUENTRA, y cualquier escritura sobre ella
 * queda registrada. Un método que el doble no conoce no filtra nada: devuelve todas las filas, que
 * es el lado seguro para este test.
 */

type Fila = Record<string, unknown>;

const h = vi.hoisted(() => ({
  createWebUser: vi.fn(),
  email: '',
  usuarios: [] as Fila[],
  filtrosPorEmail: [] as string[],
  escrituras: [] as Array<{ op: string; payload: unknown; ids: unknown[] }>,
  rpcs: [] as unknown[],
}));

vi.mock('@/lib/create-web-user', () => ({ createWebUser: h.createWebUser }));
vi.mock('@/lib/link-web-referral', () => ({ linkWebReferral: vi.fn() }));
vi.mock('@/lib/activacion-token', () => ({ verificarTokenActivacion: vi.fn(() => null) }));
vi.mock('@/lib/bind-activation', () => ({ bindActivacion: vi.fn(), notificarBackendActivacion: vi.fn() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: null }),
      verifyOtp: async () => ({ error: null }),
      getUser: async () => ({ data: { user: { id: 'auth-1', email: h.email, user_metadata: {} } } }),
    },
  }),
}));

function consulta(tabla: string) {
  const filtros: Array<(r: Fila) => boolean> = [];
  let op = 'select';
  let payload: unknown;
  const filtrar = (col: string, pred: (r: Fila) => boolean) => {
    if (tabla === 'usuarios' && /email/i.test(col)) h.filtrosPorEmail.push(col);
    filtros.push(pred);
  };
  const correr = () => {
    const filas = (tabla === 'usuarios' ? h.usuarios : []).filter((r) => filtros.every((f) => f(r)));
    if (op !== 'select') h.escrituras.push({ op, payload, ids: filas.map((r) => r.id) });
    return { data: filas, error: null };
  };
  const minus = (v: unknown) => String(v ?? '').toLowerCase().replace(/[%*]/g, '');
  const conocidos: Record<string, (...a: never[]) => unknown> = {
    select: () => b,
    update: (p: unknown) => { op = 'update'; payload = p; return b; },
    upsert: (p: unknown) => { op = 'upsert'; payload = p; return b; },
    insert: (p: unknown) => { op = 'insert'; payload = p; return b; },
    delete: () => { op = 'delete'; return b; },
    eq: (c: string, v: unknown) => { filtrar(c, (r) => r[c] === v); return b; },
    is: (c: string, v: unknown) => { filtrar(c, (r) => (r[c] ?? null) === v); return b; },
    ilike: (c: string, v: unknown) => { filtrar(c, (r) => minus(r[c]) === minus(v)); return b; },
    like: (c: string, v: unknown) => { filtrar(c, (r) => String(r[c] ?? '') === String(v).replace(/[%*]/g, '')); return b; },
    match: (o: Fila) => { for (const [c, v] of Object.entries(o)) filtrar(c, (r) => r[c] === v); return b; },
    maybeSingle: async () => { const { data } = correr(); return { data: data[0] ?? null, error: null }; },
    single: async () => { const { data } = correr(); return { data: data[0] ?? null, error: data[0] ? null : { code: 'PGRST116' } }; },
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(correr()).then(ok, ko),
  };
  const b: unknown = new Proxy({}, {
    get: (_t, prop: string) =>
      prop in conocidos
        ? conocidos[prop]
        // Método desconocido (`or`, `filter`, `in`, `limit`...): se anota si nombra el correo y NO
        // filtra — devolver todas las filas es lo que hace visible una escritura sobre la de WhatsApp.
        : (col?: unknown) => { if (typeof col === 'string' && /email/i.test(col) && tabla === 'usuarios') h.filtrosPorEmail.push(col); return b; },
  });
  return b;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (tabla: string) => consulta(tabla),
    rpc: async (...args: unknown[]) => { h.rpcs.push(args); return { data: null, error: null }; },
  }),
}));

const { GET } = await import('./route');

const FILA_WA = { id: 'usuario-wa', supabase_auth_id: null, whatsapp: '51900000001', cuenta_borrada_at: null };

function login(via: 'oauth' | 'magiclink') {
  const qs = via === 'oauth' ? 'code=c1' : 'token_hash=h1&type=magiclink';
  return GET(new NextRequest(new Request(`https://app.neto.pe/auth/callback?${qs}`)));
}

beforeEach(() => {
  h.createWebUser.mockReset();
  h.createWebUser.mockResolvedValue('usuario-web-nuevo');
  h.filtrosPorEmail = [];
  h.escrituras = [];
  h.rpcs = [];
});

describe('/auth/callback — un correo igual NO es prueba de identidad', () => {
  const casos = [
    { nombre: 'correo idéntico', filaEmail: 'victima@gmail.com', googleEmail: 'victima@gmail.com' },
    { nombre: 'correo que difiere en mayúsculas', filaEmail: 'Victima@Gmail.com', googleEmail: 'victima@gmail.com' },
  ];

  for (const via of ['oauth', 'magiclink'] as const) {
    for (const c of casos) {
      it(`${via}, ${c.nombre}: la fila de WhatsApp queda intacta y el login es un alta web`, async () => {
        h.email = c.googleEmail;
        h.usuarios = [{ ...FILA_WA, email: c.filaEmail }];

        const res = await login(via);

        expect(h.escrituras).toEqual([]);
        expect(h.rpcs).toEqual([]);
        expect(h.filtrosPorEmail).toEqual([]);
        expect(h.usuarios[0].supabase_auth_id).toBeNull();
        expect(h.createWebUser).toHaveBeenCalledOnce();
        expect(h.createWebUser.mock.calls[0][1]).toMatchObject({ authId: 'auth-1', email: c.googleEmail });
        expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
      });
    }
  }

  it('control: la cuenta que ya es suya (por auth_id) entra sin crear nada', async () => {
    h.email = 'victima@gmail.com';
    h.usuarios = [{ ...FILA_WA, email: 'victima@gmail.com', supabase_auth_id: 'auth-1' }];
    const res = await login('oauth');
    expect(h.createWebUser).not.toHaveBeenCalled();
    expect(h.escrituras).toEqual([]);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
  });
});
