import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../middleware';

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
