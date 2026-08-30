import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Estas funciones parsean la cookie de sesión de @supabase/ssr en el navegador. Se
 * prueban acá y no en un jsdom porque lo único que tocan del DOM es `document.cookie`,
 * que es un string: alcanza con ponerlo.
 *
 * Lo que hacen falso todos los caminos de fallo es lo mismo — devolver `null` en
 * silencio — y eso no rompe nada visible: el avatar sale con iniciales y el `identify`
 * de PostHog no sale. O sea que si el parser se rompe, **nadie se entera**. Este archivo
 * es el que se entera.
 *
 * El módulo lee `NEXT_PUBLIC_SUPABASE_URL` para derivar el nombre de la cookie, así que
 * se importa con `vi.resetModules()` después de fijar el entorno.
 */

const URL_SUPA = 'https://zvorjqlubmfrjtkbhqcx.supabase.co';
const NOMBRE = 'sb-zvorjqlubmfrjtkbhqcx-auth-token';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function ponerCookie(valor: string | null) {
  if (valor === null) {
    // @ts-expect-error se inyecta un document mínimo a propósito
    delete globalThis.document;
    return;
  }
  // @ts-expect-error idem
  globalThis.document = { cookie: valor };
}

async function cargar() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = URL_SUPA;
  return import('./session');
}

const SESION = {
  access_token: 'a.b.c',
  user: {
    id: 'auth-123',
    email: 'camila@example.com',
    user_metadata: { full_name: 'Camila Rojas', avatar_url: 'https://lh3.googleusercontent.com/x' },
  },
};

afterEach(() => {
  ponerCookie(null);
});

describe('getPerfilSesionSync', () => {
  it('saca authId, email, nombre y avatar de una cookie de una sola parte', async () => {
    const { getPerfilSesionSync } = await cargar();
    ponerCookie(`${NOMBRE}=base64-${b64url(JSON.stringify(SESION))}`);

    expect(getPerfilSesionSync()).toEqual({
      authId: 'auth-123',
      email: 'camila@example.com',
      nombre: 'Camila Rojas',
      avatarUrl: 'https://lh3.googleusercontent.com/x',
    });
  });

  it('reensambla la cookie PARTIDA en varios chunks', async () => {
    // El caso real: la sesión de Google pasa los 3180 bytes y @supabase/ssr la parte en
    // `...auth-token.0`, `.1`, ... Leer solo la primera daría un JSON truncado, o sea
    // null, o sea el fallo silencioso.
    const { getPerfilSesionSync } = await cargar();
    const valor = `base64-${b64url(JSON.stringify(SESION))}`;
    const mitad = Math.ceil(valor.length / 2);
    ponerCookie(`${NOMBRE}.0=${valor.slice(0, mitad)}; ${NOMBRE}.1=${valor.slice(mitad)}`);

    expect(getPerfilSesionSync()?.authId).toBe('auth-123');
    expect(getPerfilSesionSync()?.avatarUrl).toBe('https://lh3.googleusercontent.com/x');
  });

  it('devuelve null sin cookie, con basura, y con otras cookies alrededor no se confunde', async () => {
    const { getPerfilSesionSync } = await cargar();

    ponerCookie('');
    expect(getPerfilSesionSync()).toBeNull();

    ponerCookie(`${NOMBRE}=base64-no-es-base64-valido!!`);
    expect(getPerfilSesionSync()).toBeNull();

    ponerCookie(`otra=1; ${NOMBRE}=base64-${b64url('{"esto":"no tiene user"}')}; mas=2`);
    expect(getPerfilSesionSync()).toBeNull();
  });

  it('sin metadata devuelve el perfil igual, con los campos opcionales en null', async () => {
    // Un usuario que entró por magic link no tiene `avatar_url` ni `full_name`. El
    // avatar cae a iniciales y el identify sale sin nombre: eso es correcto, y NO puede
    // hacer que se pierda el authId.
    const { getPerfilSesionSync } = await cargar();
    ponerCookie(
      `${NOMBRE}=base64-${b64url(JSON.stringify({ user: { id: 'auth-9', email: 'x@y.z' } }))}`,
    );

    expect(getPerfilSesionSync()).toEqual({
      authId: 'auth-9',
      email: 'x@y.z',
      nombre: null,
      avatarUrl: null,
    });
  });

  it('cae al `sub` del JWT cuando la sesión no trae user.id', async () => {
    const { getPerfilSesionSync, getAuthUserIdSync } = await cargar();
    const payload = b64url(JSON.stringify({ sub: 'auth-del-jwt' }));
    ponerCookie(
      `${NOMBRE}=base64-${b64url(JSON.stringify({ access_token: `h.${payload}.f` }))}`,
    );

    expect(getAuthUserIdSync()).toBe('auth-del-jwt');
    expect(getPerfilSesionSync()?.authId).toBe('auth-del-jwt');
  });

  it('en el servidor (sin document) devuelve null y no lanza', async () => {
    // El shell del dashboard se PRERENDERIZA. Si esto lanzara, el build se cae.
    const { getPerfilSesionSync, getAuthUserIdSync } = await cargar();
    ponerCookie(null);

    expect(getPerfilSesionSync()).toBeNull();
    expect(getAuthUserIdSync()).toBeNull();
  });
});
