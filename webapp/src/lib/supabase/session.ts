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

export function getAuthUserIdSync(): string | null {
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
    const session = JSON.parse(json);

    if (session?.user?.id) return session.user.id as string;

    // Fallback: decode the access token JWT and read its `sub` claim.
    const token: unknown = session?.access_token;
    if (typeof token === 'string' && token.split('.').length === 3) {
      const payload = JSON.parse(decodeBase64ToUtf8(token.split('.')[1]));
      return typeof payload?.sub === 'string' ? payload.sub : null;
    }
    return null;
  } catch {
    return null;
  }
}
