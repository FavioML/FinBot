import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

/**
 * El login con Google NUNCA adopta una fila existente por coincidencia de correo.
 *
 * Una fila nacida en WhatsApp puede traer un correo DICTADO en el alta vieja (paso 101), sin
 * verificar. Si un error de tipeo cae en el Gmail real de otra persona, vincular por correo le
 * entrega esa cuenta —y sus finanzas— la primera vez que entre a app.neto.pe. Vincular una cuenta
 * existente exige probar el NÚMERO: el link de activación firmado o el OTP inverso.
 *
 * Lo que sostiene a este test, pagado por DOS revisiones adversariales del 15-sep-2026 que lo
 * evadieron siete veces con la suite entera en verde. Las siete tenían la misma raíz: **el fixture
 * no se parecía a producción**, así que la rama reintroducida nunca se ejercitaba. Por eso:
 *   · `createWebUser`, `bindActivacion` y `verificarTokenActivacion` corren DE VERDAD, y hay un
 *     control positivo: un token válido SÍ vincula. Sin él, "corre de verdad" era una afirmación.
 *   · El doble de Supabase es SEMÁNTICO: aplica los filtros sobre tablas en memoria, impone los dos
 *     índices únicos de `usuarios` y devuelve el MENSAJE REAL de Postgres, con el nombre del índice.
 *   · El usuario de Google trae nombre (igual al de la víctima), una cookie `neto_act` que no
 *     verifica, un `gmail_cuentas` con el correo de la víctima, y existe el caso del SEGUNDO login
 *     (ya con su alta web), que es donde una "fusión automática por correo" viviría.
 *   · Un método que el doble no conoce no filtra: devuelve todas las filas, el lado seguro acá.
 *
 * LÍMITES DECLARADOS, medidos y fuera de este test: un vínculo delegado al backend por `fetch`, y uno
 * escrito en código que el callback no importa (`requireNetoUser`, el middleware, otra route). Lo
 * desplegado lo cubre `qa-e2e/qa-login-sin-vinculo-email.mjs` contra producción.
 */

type Fila = Record<string, unknown>;

const h = vi.hoisted(() => ({
  email: '',
  nombreGoogle: 'Víctima WA',
  usuarios: [] as Record<string, unknown>[],
  gmail: [] as Record<string, unknown>[],
  categorias: [] as Record<string, unknown>[],
  filtrosPorEmail: [] as string[],
  escrituras: [] as Array<{ tabla: string; op: string; payload: unknown; ids: unknown[] }>,
  rpcs: [] as unknown[],
  seq: 0,
}));

vi.mock('@/lib/link-web-referral', () => ({ linkWebReferral: vi.fn() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: null }),
      verifyOtp: async () => ({ error: null }),
      getUser: async () => ({
        data: { user: { id: 'auth-1', email: h.email, user_metadata: { full_name: h.nombreGoogle, name: h.nombreGoogle } } },
      }),
    },
  }),
}));

const tablaDe = (t: string): Fila[] =>
  t === 'usuarios' ? h.usuarios : t === 'gmail_cuentas' ? h.gmail : t === 'categorias_usuario' ? h.categorias : [];

/** Los dos índices únicos de `usuarios` que un alta puede tocar (medidos en la base el 15-sep-2026). */
function indiceQueChoca(fila: Fila): string | null {
  const mail = (v: unknown) => (typeof v === 'string' && v !== '' ? v.toLowerCase() : null);
  for (const r of h.usuarios) {
    if (fila.supabase_auth_id != null && r.supabase_auth_id === fila.supabase_auth_id) return 'usuarios_supabase_auth_id_key';
    if (mail(fila.email) !== null && mail(r.email) === mail(fila.email)) return 'usuarios_email_lower_unique';
  }
  return null;
}

function consulta(tabla: string) {
  const filtros: Array<(r: Fila) => boolean> = [];
  let op = 'select';
  let payload: unknown;
  let resultado: { data: Fila[] | null; error: { code: string; message: string; details: string } | null } | null = null;
  const anotarCorreo = (col: unknown) => {
    if (typeof col === 'string' && /email/i.test(col)) h.filtrosPorEmail.push(`${tabla}.${col}`);
  };
  const filtrar = (col: string, pred: (r: Fila) => boolean) => { anotarCorreo(col); filtros.push(pred); };
  const correr = () => {
    if (resultado) return resultado;
    const tabla_ = tablaDe(tabla);
    if (op === 'insert') {
      const filas = (Array.isArray(payload) ? payload : [payload]) as Fila[];
      const indice = tabla === 'usuarios' ? filas.map(indiceQueChoca).find(Boolean) : null;
      if (indice) {
        // El mensaje REAL: una rama que distinga por el nombre del índice tiene que correr acá también.
        return (resultado = {
          data: null,
          error: { code: '23505', message: `duplicate key value violates unique constraint "${indice}"`, details: 'Key already exists.' },
        });
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

const SECRETO = 'secreto-de-test';
process.env.ACTIVATION_TOKEN_SECRET = SECRETO;
delete process.env.INTERNAL_API_KEY; // `notificarBackendActivacion` no sale por fetch

const { GET } = await import('./route');

/** Token de activación con el MISMO formato que `lib/activacion.js`: payload base64url + HMAC. */
function tokenActivacion(uid: string) {
  const payload = Buffer.from(JSON.stringify({ uid, ts: Date.now() })).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRETO).update(payload).digest('base64url')}`;
}

const VICTIMA = 'victima@gmail.com';
const FILA_WA: Fila = { id: 'usuario-wa', supabase_auth_id: null, whatsapp: '51900000001', cuenta_borrada_at: null, nombre: 'Víctima WA' };

function login(via: 'oauth' | 'magiclink', netoAct = 'token-que-no-verifica') {
  const qs = via === 'oauth' ? 'code=c1' : 'token_hash=h1&type=magiclink';
  const req = new NextRequest(new Request(`https://app.neto.pe/auth/callback?${qs}`));
  req.cookies.set('neto_act', netoAct);
  return GET(req);
}

/** Siembra a la víctima (y opcionalmente filas previas) y devuelve la foto de su fila. */
function sembrar(emailFila: string, previas: Fila[] = []) {
  h.usuarios = [{ ...FILA_WA, email: emailFila }, ...previas];
  // El correo de la víctima también está en su Gmail conectado: una búsqueda que entre por esta
  // tabla y después escriba `usuarios` por id tiene que encontrarla igual.
  h.gmail = [{ usuario_id: 'usuario-wa', email: emailFila.toLowerCase(), activa: true }];
  return structuredClone(h.usuarios[0]);
}

function laFilaDeWhatsappNoSeToco(antes: Fila) {
  expect(h.usuarios.find((r) => r.id === 'usuario-wa')).toEqual(antes);
  expect(h.escrituras.filter((e) => e.tabla === 'usuarios' && e.op !== 'insert')).toEqual([]);
  expect(h.escrituras.filter((e) => e.tabla !== 'usuarios' && !(e.tabla === 'categorias_usuario' && e.op === 'insert'))).toEqual([]);
  expect(h.rpcs).toEqual([]);
  expect(h.filtrosPorEmail).toEqual([]);
}

const altasWeb = () => h.usuarios.filter((r) => r.id !== 'usuario-wa');

beforeEach(() => {
  h.email = VICTIMA;
  h.nombreGoogle = 'Víctima WA';
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

  it('segundo login (ya tiene su alta web): tampoco se fusiona con la fila del mismo correo', async () => {
    const antes = sembrar(VICTIMA, [{ id: 'web-propia', supabase_auth_id: 'auth-1', email: null, nombre: 'Víctima WA' }]);
    const res = await login('oauth');
    laFilaDeWhatsappNoSeToco(antes);
    expect(altasWeb()).toEqual([{ id: 'web-propia', supabase_auth_id: 'auth-1', email: null, nombre: 'Víctima WA' }]);
    expect(h.escrituras).toEqual([]);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
  });

  it('control: un correo que no es de nadie nace CON su correo', async () => {
    h.email = 'libre@gmail.com';
    const antes = sembrar(VICTIMA);
    const res = await login('oauth');
    laFilaDeWhatsappNoSeToco(antes);
    expect(altasWeb()).toHaveLength(1);
    expect(altasWeb()[0]).toMatchObject({ supabase_auth_id: 'auth-1', email: 'libre@gmail.com' });
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
  });

  it('control POSITIVO: con el token firmado de esa fila SÍ se vincula (el camino real corre)', async () => {
    // Si este test deja de vincular, el doble o el mock se volvieron ciegos y los de arriba pasan
    // por vacuidad. Es la prueba de que `bindActivacion` corre de verdad contra este doble.
    sembrar(VICTIMA);
    const res = await login('oauth', tokenActivacion('usuario-wa'));
    expect(h.usuarios.find((r) => r.id === 'usuario-wa')?.supabase_auth_id).toBe('auth-1');
    expect(altasWeb()).toEqual([]);
    const destino = new URL(res.headers.get('location')!);
    expect(destino.pathname).toBe('/dashboard');
    expect(destino.searchParams.get('activado')).toBe('1');
  });
});
