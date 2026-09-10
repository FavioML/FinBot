import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../../middleware';

// Solo lo usan los rebotes que pasan por la sesión (abajo). Las entradas de `/` caen antes del
// cliente de Supabase y no lo tocan.
const sesion = vi.hoisted(() => ({ user: null as { id: string } | null, clientes: 0 }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => {
    sesion.clientes++;
    return { auth: { getUser: async () => ({ data: { user: sesion.user } }) } };
  },
}));

/**
 * P′6: `/` dejó de ser una función serverless.
 *
 * Antes el rebote vivía en `app/page.tsx` — una página `ƒ` que se invocaba en cada visita
 * para hacer un `redirect`, con `X-Vercel-Cache: MISS` siempre. Ahora lo resuelve el
 * middleware, que ya corría en `/` de todas formas para atrapar el `?ref`.
 *
 * **Lo que este test cuida no es la velocidad, es lo que se movió con ella.** `page.tsx`
 * tenía DOS ramas y la segunda es fácil de no ver: si llegan `code` o `token_hash` (el
 * magic link de Supabase, cuando la Site URL del proyecto apunta a la raíz) hay que
 * reenviarlos a `/auth/callback`. Al mover el rebote, esa rama dejó de tener una copia de
 * respaldo en la página: si alguien la borra del middleware, el login por email deja de
 * cerrar el círculo y no hay nada más que lo atrape.
 *
 * Se ejercita el middleware de verdad, no una reimplementación: estas tres entradas caen
 * antes del cliente de Supabase, así que no hace falta sesión ni env vars.
 */

function pedir(url: string) {
  return middleware(new NextRequest(new Request(url), {}));
}

async function destino(url: string) {
  const res = await pedir(url);
  return { status: res.status, location: res.headers.get('location') };
}

describe('P′6 — la raíz rebota desde el middleware', () => {
  it('sin parámetros manda a /login y no arrastra la query', async () => {
    const r = await destino('https://app.neto.pe/');
    expect(r.status).toBe(307);
    expect(new URL(r.location!).pathname).toBe('/login');
    expect(new URL(r.location!).search).toBe('');
  });

  it('con ?code reenvía a /auth/callback conservando el código', async () => {
    const r = await destino('https://app.neto.pe/?code=abc123&next=%2Fdashboard');
    const u = new URL(r.location!);
    expect(u.pathname).toBe('/auth/callback');
    expect(u.searchParams.get('code')).toBe('abc123');
    expect(u.searchParams.get('next')).toBe('/dashboard');
  });

  it('con ?token_hash reenvía a /auth/callback con el type', async () => {
    const r = await destino('https://app.neto.pe/?token_hash=h1&type=magiclink');
    const u = new URL(r.location!);
    expect(u.pathname).toBe('/auth/callback');
    expect(u.searchParams.get('token_hash')).toBe('h1');
    expect(u.searchParams.get('type')).toBe('magiclink');
  });

  it('el ?ref se sigue guardando en la cookie, ahora sobre el redirect', async () => {
    // El motivo por el que el middleware ya corría en `/`. Un rebote que se lleve puesta
    // esta cookie rompe el programa de referidos en silencio: la query se pierde en el
    // viaje a Google y de vuelta, así que este es el único momento en que el código existe.
    const res = await pedir('https://app.neto.pe/?ref=ABCD1234');
    expect(res.headers.get('location')).toContain('/login');
    expect(res.cookies.get('neto_ref')?.value).toBe('ABCD1234');
  });

  it('un ?ref con forma inválida no se guarda', async () => {
    const res = await pedir('https://app.neto.pe/?ref=no-es-un-codigo!!');
    expect(res.cookies.get('neto_ref')).toBeUndefined();
  });

  it('el ?ref viaja también sobre la rama de auth (no solo sobre la de /login)', async () => {
    const res = await pedir('https://app.neto.pe/?code=abc123&ref=ABCD1234');
    expect(res.headers.get('location')).toContain('/auth/callback');
    expect(res.cookies.get('neto_ref')?.value).toBe('ABCD1234');
  });

  it('el primer ?ref gana: no se pisa el que ya está en la cookie', async () => {
    // Anti-farmeo: si se pudiera pisar, alguien cambia el código después de llegar.
    const req = new NextRequest(new Request('https://app.neto.pe/?ref=NUEVO123'), {});
    req.cookies.set('neto_ref', 'VIEJO123');
    const res = await middleware(req);
    expect(res.cookies.get('neto_ref')).toBeUndefined();
  });

  it('el ?utm_source se guarda saneado en la cookie del origen, sobre el rebote', async () => {
    // Mismo motivo que el ?ref: el alta web se escribe en /auth/callback, del otro lado del
    // viaje a Google, donde la query de la entrada ya no existe.
    const res = await pedir('https://app.neto.pe/?utm_source=Instagram&utm_medium=bio');
    const c = res.cookies.get('neto_origen');
    expect(c?.value).toBe('instagram');
    expect(c?.httpOnly).toBe(true);
  });

  it('sin utm_source no se escribe cookie de origen (el callback escribirá directo)', async () => {
    const res = await pedir('https://app.neto.pe/?utm_medium=bio');
    expect(res.cookies.get('neto_origen')).toBeUndefined();
  });

  it('un utm_source que no sobrevive al saneado no escribe cookie', async () => {
    const res = await pedir('https://app.neto.pe/?utm_source=%5B%5D%21');
    expect(res.cookies.get('neto_origen')).toBeUndefined();
  });

  it('primer toque: el origen que ya está en la cookie no se pisa', async () => {
    const req = new NextRequest(new Request('https://app.neto.pe/?utm_source=tiktok'), {});
    req.cookies.set('neto_origen', 'ig');
    const res = await middleware(req);
    expect(res.cookies.get('neto_origen')).toBeUndefined();
  });

  it('el origen viaja también sobre la rama de auth', async () => {
    const res = await pedir('https://app.neto.pe/?code=abc123&utm_source=ig');
    expect(new URL(res.headers.get('location')!).pathname).toBe('/auth/callback');
    expect(res.cookies.get('neto_origen')?.value).toBe('ig');
  });

  it('los atributos de la cookie son los que dejan que vuelva de Google', async () => {
    // `lax` no es estética: el regreso de Google/Supabase a /auth/callback es una navegación
    // cross-site, y con `strict` la cookie no viaja y TODA alta por OAuth sale 'directo'.
    const c = (await pedir('https://app.neto.pe/?utm_source=ig')).cookies.get('neto_origen');
    expect(c?.sameSite).toBe('lax');
    expect(c?.path).toBe('/');
    expect(c?.secure).toBe(true);
    expect(c?.maxAge).toBe(60 * 60 * 24 * 30);
  });

  it('el rebote de la raíz a /login conserva el utm_source (navegador de las apps)', async () => {
    const r = await destino('https://app.neto.pe/?utm_source=IG&utm_medium=bio&fbclid=x');
    const u = new URL(r.location!);
    expect(u.pathname).toBe('/login');
    expect(u.search).toBe('?utm_source=ig');
  });

  it('el CTA Pro de la landing (/dashboard/pro sin sesión) rebota a /login con la cookie', async () => {
    // Otro return del middleware, el que pasa por la sesión. La landing manda aquí el CTA de Pro
    // (`useCtaHrefs(_, 'pro')`), así que si este rebote pierde la cookie, esas altas salen 'directo'.
    const res = await pedir('https://app.neto.pe/dashboard/pro?utm_source=ig');
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(res.cookies.get('neto_origen')?.value).toBe('ig');
  });

  it('/login sin sesión (el return final) guarda la cookie', async () => {
    const res = await pedir('https://app.neto.pe/login?utm_source=ig');
    expect(res.headers.get('location')).toBeNull();
    expect(res.cookies.get('neto_origen')?.value).toBe('ig');
  });

  it('/login con sesión rebota a /dashboard y guarda la cookie igual', async () => {
    sesion.user = { id: 'auth-1' };
    try {
      const res = await pedir('https://app.neto.pe/login?utm_source=ig');
      expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
      expect(res.cookies.get('neto_origen')?.value).toBe('ig');
    } finally {
      sesion.user = null;
    }
  });

  it('una invitación sin UTM deja la cookie del origen = invitacion, sin redirigir', async () => {
    // El alta que nace de una invitación salía 'directo' porque /join/* no pasaba por acá.
    const res = await pedir('https://app.neto.pe/join/space/ABCD1234');
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
    expect(res.cookies.get('neto_origen')?.value).toBe('invitacion');
  });

  it('una invitación sale ANTES del cliente de Supabase: no paga una llamada de auth', async () => {
    // Sin este caso, borrar el return temprano de /join dejaba todo verde (lo midió la revisión
    // adversarial): la cookie se escribe igual en el return final, pero pasando por `getUser()`
    // en cada visita a una invitación, que nunca lo hizo.
    const antes = sesion.clientes;
    await pedir('https://app.neto.pe/join/gasto/ABCD1234');
    expect(sesion.clientes - antes).toBe(0);
    // Control: una ruta que SÍ pasa por la sesión lo crea, o este conteo no mediría nada.
    await pedir('https://app.neto.pe/login');
    expect(sesion.clientes - antes).toBe(1);
  });

  it('una invitación con UTM guarda el UTM, no la ruta', async () => {
    const res = await pedir('https://app.neto.pe/join/meta/ABCD1234?utm_source=ig');
    expect(res.cookies.get('neto_origen')?.value).toBe('ig');
  });

  it('una invitación no pisa el primer toque', async () => {
    const req = new NextRequest(new Request('https://app.neto.pe/join/deuda/ABCD1234'), {});
    req.cookies.set('neto_origen', 'tiktok');
    const res = await middleware(req);
    expect(res.cookies.get('neto_origen')).toBeUndefined();
  });

  it('el matcher incluye /join/:path* (sin eso, lo de arriba no corre nunca en Vercel)', () => {
    // Los tests llaman al middleware a mano, así que no ven el matcher: esta es la única línea que
    // fija que en producción el middleware SÍ se ejecute sobre las invitaciones.
    expect(config.matcher).toContain('/join/:path*');
  });

  it('en demo mode la raíz sigue reenviando el ?code (el corto de demo va DESPUÉS)', async () => {
    // El corto de demo mode saltea los chequeos de AUTH, y este rebote no es uno. Con el
    // corto por delante, `/` caía a `app/page.tsx` —que ya no conserva la rama de `code`—
    // y el magic link se perdía en silencio.
    const previo = process.env.NEXT_PUBLIC_DEMO_MODE;
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    try {
      const r = await destino('https://app.neto.pe/?code=abc123');
      expect(new URL(r.location!).pathname).toBe('/auth/callback');
      expect(new URL(r.location!).searchParams.get('code')).toBe('abc123');

      const sinCodigo = await destino('https://app.neto.pe/');
      expect(new URL(sinCodigo.location!).pathname).toBe('/login');
    } finally {
      if (previo === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
      else process.env.NEXT_PUBLIC_DEMO_MODE = previo;
    }
  });
});
