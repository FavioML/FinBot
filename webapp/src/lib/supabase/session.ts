/**
 * Reads the currently authenticated Supabase user id from the browser cookie,
 * SYNCHRONOUSLY. This is used as the React Query persistence `buster`: a cache
 * persisted in localStorage is only ever restored when it belongs to the same
 * authenticated user, so financial data can never surface for a different user
 * on a shared device.
 *
 * @supabase/ssr stores the session in the `sb-<ref>-auth-token` cookie (not
 * httpOnly, so JS can read it). Large sessions are split across chunked cookies
 * (`...auth-token.0`, `.1`, ...) and the value is `base64-`-prefixed JSON.
 *
 * Fail-safe by design: any parsing problem returns null. A null buster falls
 * back to '', which — combined with the identity guard in DashboardShell — makes
 * a mismatched cache get discarded rather than shown to the wrong user. We trade
 * the perf optimization for safety whenever we can't be certain who is logged in.
 */

function decodeBase64ToUtf8(b64: string): string {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface SesionCookie {
  user?: { id?: string; email?: string; user_metadata?: Record<string, unknown> };
  access_token?: unknown;
}

/** La sesión cruda de la cookie, o null si no se pudo leer/parsear. */
function leerSesionCookie(): SesionCookie | null {
  if (typeof document === 'undefined') return null;
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) return null;
    const ref = new URL(url).hostname.split('.')[0];
    const base = `sb-${ref}-auth-token`;

    const jar = new Map<string, string>();
    for (const part of document.cookie ? document.cookie.split('; ') : []) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      jar.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
    }

    // Reassemble the (possibly chunked) cookie value.
    let raw = jar.get(base) ?? '';
    if (!raw) {
      let i = 0;
      while (jar.has(`${base}.${i}`)) {
        raw += jar.get(`${base}.${i}`)!;
        i += 1;
      }
    }
    if (!raw) return null;

    const json = raw.startsWith('base64-')
      ? decodeBase64ToUtf8(raw.slice('base64-'.length))
      : raw;
    return JSON.parse(json) as SesionCookie;
  } catch {
    return null;
  }
}

function authIdDe(session: SesionCookie): string | null {
  try {
    if (session.user?.id) return session.user.id;

    // Fallback: decode the access token JWT and read its `sub` claim.
    const token: unknown = session.access_token;
    if (typeof token === 'string' && token.split('.').length === 3) {
      const payload = JSON.parse(decodeBase64ToUtf8(token.split('.')[1]));
      return typeof payload?.sub === 'string' ? payload.sub : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function getAuthUserIdSync(): string | null {
  const session = leerSesionCookie();
  return session ? authIdDe(session) : null;
}

/** Lo que la cookie sabe del usuario autenticado, sin tocar la red. */
export interface PerfilSesion {
  authId: string;
  email: string | null;
  nombre: string | null;
  avatarUrl: string | null;
}

/**
 * Perfil de la sesión leído de la cookie, SIN ir a la red.
 *
 * Existe para sacar `supabase.auth.getUser()` —una ida y vuelta a Supabase en
 * `sa-east-1`, medida entre 130 y 1500 ms— de dos consumidores que compiten con el
 * arranque del dashboard y no necesitan verificación: el avatar del menú y la
 * identificación de analytics. Con cuatro `getUser()` por carga, ese era el mayor
 * bloque de ruido del cliente en el ítem 16 del backlog de confiabilidad.
 *
 * **Este dato NO está verificado contra el servidor y no puede decidir accesos.**
 * `getUser()` valida el JWT contra Supabase; esto solo parsea una cookie que el dueño
 * del navegador puede editar. La diferencia importa para autorización y no importa
 * para pintar una foto de perfil o mandar un `identify` a PostHog: en los dos casos
 * lo único que alguien puede falsear es lo que ve o reporta de su propia sesión.
 *
 * Quien decida permisos sigue yendo por `requireNetoUser` / `requireLectura` en el
 * servidor, que es donde vive la autorización de verdad. Y `CacheIdentityGuard`
 * conserva su `getUser()` de red a propósito: ahí la verificación ES el punto —
 * necesita una fuente INDEPENDIENTE de esta misma cookie para detectar que el
 * `buster` de la caché persistida quedó mal.
 */
export function getPerfilSesionSync(): PerfilSesion | null {
  const session = leerSesionCookie();
  if (!session) return null;
  const authId = authIdDe(session);
  if (!authId) return null;

  const meta = session.user?.user_metadata ?? {};
  const texto = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

  return {
    authId,
    email: texto(session.user?.email),
    nombre: texto(meta.full_name) ?? texto(meta.name),
    avatarUrl: texto(meta.avatar_url) ?? texto(meta.picture),
  };
}
