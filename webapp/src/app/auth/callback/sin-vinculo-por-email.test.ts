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
 * Tres decisiones del test, las tres pagadas por la revisión adversarial del 15-sep-2026:
 *   · `createWebUser` y `bindActivacion` corren DE VERDAD. Con los dos mockeados, una búsqueda por
 *     correo movida adentro de cualquiera de ellos —o envuelta en try/catch— dejaba todo verde.
 *   · El doble de Supabase es SEMÁNTICO: aplica los filtros sobre tablas en memoria (la fila de
 *     WhatsApp y un `gmail_cuentas` con su mismo correo) e impone los dos índices únicos de
 *     `usuarios` (`supabase_auth_id` y `lower(email)`), así que una búsqueda reintroducida por
 *     cualquier operador o por cualquier tabla ENCUENTRA a la víctima, y la escritura queda anotada.
 *   · Un método que el doble no conoce no filtra: devuelve todas las filas, el lado seguro acá.
 */

type Fila = Record<string, unknown>;

const h = vi.hoisted(() => ({
  email: '',
  usuarios: [] as Record<string, unknown>[],
  gmail: [] as Record<string, unknown>[],
  categorias: [] as Record<string, unknown>[],
  filtrosPorEmail: [] as string[],
  escrituras: [] as Array<{ tabla: string; op: string; payload: unknown; ids: unknown[] }>,
  rpcs: [] as unknown[],
  seq: 0,
}));

vi.mock('@/lib/link-web-referral', () => ({ linkWebReferral: vi.fn() }));
vi.mock('@/lib/activacion-token', () => ({ verificarTokenActivacion: vi.fn(() => null) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: null }),
      verifyOtp: async () => ({ error: null }),
      getUser: async () => ({ data: { user: { id: 'auth-1', email: h.email, user_metadata: {} } } }),
    },
  }),
}));

const tablaDe = (t: string): Fila[] =>
  t === 'usuarios' ? h.usuarios : t === 'gmail_cuentas' ? h.gmail : t === 'categorias_usuario' ? h.categorias : [];

/** Los dos índices únicos de `usuarios`, medidos en la base viva el 15-sep-2026. */
function choca(fila: Fila): boolean {
  const mail = (v: unknown) => (typeof v === 'string' && v !== '' ? v.toLowerCase() : null);
  return h.usuarios.some(
    (r) =>
      (fila.supabase_auth_id != null && r.supabase_auth_id === fila.supabase_auth_id) ||
      (mail(fila.email) !== null && mail(r.email) === mail(fila.email)),
  );
}

function consulta(tabla: string) {
  const filtros: Array<(r: Fila) => boolean> = [];
  let op = 'select';
  let payload: unknown;
  let resultado: { data: Fila[] | null; error: { code: string; message: string } | null } | null = null;
  const anotarCorreo = (col: unknown) => {
    if (typeof col === 'string' && /email/i.test(col)) h.filtrosPorEmail.push(`${tabla}.${col}`);
  };
  const filtrar = (col: string, pred: (r: Fila) => boolean) => { anotarCorreo(col); filtros.push(pred); };
  const correr = () => {
    if (resultado) return resultado;
    const tabla_ = tablaDe(tabla);
    if (op === 'insert') {
      const filas = (Array.isArray(payload) ? payload : [payload]) as Fila[];
      if (tabla === 'usuarios' && filas.some(choca)) {
        return (resultado = { data: null, error: { code: '23505', message: 'duplicate key value' } });
      }
      const nuevas = filas.map((f) => ({ ...f, id: `nuevo-${++h.seq}` }));
      tabla_.push(...nuevas);
      h.escrituras.push({ tabla, op, payload, ids: nuevas.map((r) => r.id) });
      return (resultado = { data: nuevas, error: null });
    }
    const filas = tabla_.filter((r) => filtros.every((f) => f(r)));
    if (op === 'update') for (const r of filas) Object.assign(r, payload as Fila);
    if (op === 'delete') for (const r of filas) tabla_.splice(tabla_.indexOf(r), 1);
    if (op !== 'select') h.escrituras.push({ tabla, op, payload, ids: filas.map((r) => r.id) });
    return (resultado = { data: filas, error: null });
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
    maybeSingle: async () => { const { data, error } = correr(); return { data: data?.[0] ?? null, error }; },
    single: async () => {
      const { data, error } = correr();
      if (error) return { data: null, error };
      return data?.[0] ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    },
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(correr()).then(ok, ko),
  };
  const b: unknown = new Proxy({}, {
    get: (_t, prop: string) =>
      prop in conocidos
        ? conocidos[prop]
        // Método desconocido (`or`, `filter`, `in`, `textSearch`...): se anota si nombra el correo y
        // NO filtra — devolver todas las filas es lo que hace visible una escritura sobre la víctima.
        : (...args: unknown[]) => { args.forEach(anotarCorreo); return b; },
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

const VICTIMA = 'victima@gmail.com';
const FILA_WA: Fila = { id: 'usuario-wa', supabase_auth_id: null, whatsapp: '51900000001', cuenta_borrada_at: null, nombre: 'WA' };

function login(via: 'oauth' | 'magiclink') {
  const qs = via === 'oauth' ? 'code=c1' : 'token_hash=h1&type=magiclink';
  return GET(new NextRequest(new Request(`https://app.neto.pe/auth/callback?${qs}`)));
}

function sembrar(emailFila: string) {
  h.usuarios = [{ ...FILA_WA, email: emailFila }];
  // El correo de la víctima también está en su Gmail conectado: una búsqueda que entre por esta
  // tabla y después escriba `usuarios` por id tiene que encontrarla igual.
  h.gmail = [{ usuario_id: 'usuario-wa', email: emailFila.toLowerCase(), activa: true }];
  return structuredClone(h.usuarios[0]);
}

function laFilaDeWhatsappNoSeToco(antes: Fila) {
  expect(h.usuarios.find((r) => r.id === 'usuario-wa')).toEqual(antes);
  expect(h.escrituras.filter((e) => e.tabla === 'usuarios' && e.op !== 'insert')).toEqual([]);
  expect(h.escrituras.filter((e) => e.tabla !== 'usuarios' && e.tabla !== 'categorias_usuario')).toEqual([]);
  expect(h.rpcs).toEqual([]);
  expect(h.filtrosPorEmail).toEqual([]);
}

const altasWeb = () => h.usuarios.filter((r) => r.id !== 'usuario-wa');

beforeEach(() => {
  h.categorias = [];
  h.filtrosPorEmail = [];
  h.escrituras = [];
  h.rpcs = [];
  h.seq = 0;
});

describe('/auth/callback — un correo igual NO es prueba de identidad', () => {
  const casos = [
    { nombre: 'correo idéntico', filaEmail: VICTIMA },
    { nombre: 'correo que difiere en mayúsculas', filaEmail: 'Victima@Gmail.com' },
  ];

  for (const via of ['oauth', 'magiclink'] as const) {
    for (const c of casos) {
      it(`${via}, ${c.nombre}: la fila de WhatsApp queda intacta y nace un alta web SIN correo`, async () => {
        h.email = VICTIMA;
        const antes = sembrar(c.filaEmail);

        const res = await login(via);

        laFilaDeWhatsappNoSeToco(antes);
        expect(altasWeb()).toHaveLength(1);
        expect(altasWeb()[0]).toMatchObject({ supabase_auth_id: 'auth-1', email: null, origen_cta: 'web' });
        expect(altasWeb()[0].whatsapp).toBeUndefined();
        expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
      });
    }
  }

  it('control: un correo que no es de nadie nace CON su correo', async () => {
    h.email = 'libre@gmail.com';
    const antes = sembrar(VICTIMA);
    const res = await login('oauth');
    laFilaDeWhatsappNoSeToco(antes);
    expect(altasWeb()).toHaveLength(1);
    expect(altasWeb()[0]).toMatchObject({ supabase_auth_id: 'auth-1', email: 'libre@gmail.com' });
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
  });

  it('control: la cuenta que ya es suya (por auth_id) entra sin crear nada', async () => {
    h.email = VICTIMA;
    h.usuarios = [{ ...FILA_WA, email: VICTIMA, supabase_auth_id: 'auth-1' }];
    h.gmail = [];
    const res = await login('oauth');
    expect(altasWeb()).toEqual([]);
    expect(h.escrituras).toEqual([]);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
  });
});
