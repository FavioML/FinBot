import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const DEMO = () => process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export async function middleware(request: NextRequest) {
  // Captura del código de referido (?ref=CODE de la mini-landing neto.pe/r/CODE, que
  // apunta a app.neto.pe/?ref=CODE). La query se pierde en el roundtrip a Google y de
  // vuelta, así que lo persistimos apenas se ve, en una cookie que /auth/callback consume
  // al crear la cuenta web-first. sameSite=lax basta: el regreso a /auth/callback es
  // navegación same-site. El primer link gana (no se pisa) para no farmear cambiando el code.
  const refParam = request.nextUrl.searchParams.get('ref');
  const refCode = refParam && /^[A-Za-z0-9]{4,12}$/.test(refParam) ? refParam.toUpperCase() : null;
  const withRef = (res: NextResponse): NextResponse => {
    if (refCode && !request.cookies.has('neto_ref')) {
      res.cookies.set('neto_ref', refCode, {
        maxAge: 60 * 60 * 24 * 7, // 7 días = ventana del descuento del referido
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
      });
    }
    return res;
  };

  // Captura del token de activación (?t= del link que Neto manda por WhatsApp).
  // Mismo problema y misma solución que el ?ref de arriba: la query se pierde en
  // el roundtrip a Google, así que se persiste apenas se ve y /auth/callback la
  // consume para vincular la cuenta. Acá NO se verifica la firma — el middleware
  // corre en el Edge y no tiene node:crypto; la cookie es solo transporte y la
  // verificación real ocurre en /activar, en el callback y en la confirmación.
  const actParam = request.nextUrl.searchParams.get('t');
  const actToken =
    request.nextUrl.pathname === '/activar' && actParam && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(actParam)
      ? actParam
      : null;
  const withAct = (res: NextResponse): NextResponse => {
    if (actToken) {
      res.cookies.set('neto_act', actToken, {
        maxAge: 60 * 60, // 1h: el login pasa ahora o no pasa. El token dura 7 días aparte.
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
      });
    }
    return res;
  };

  // La raíz solo rebota, y rebota ACÁ. El middleware ya corría en `/` para atrapar el
  // ?ref, así que resolver el redirect también acá sale gratis y evita invocar la función
  // serverless de `app/page.tsx` — que era `ƒ` y devolvía `X-Vercel-Cache: MISS` siempre
  // sobre la primera pantalla que ve cualquiera (hallazgo P′6). Nada de auth: el gate de
  // sesión sigue viviendo abajo, para las rutas que sí lo necesitan.
  //
  // Las dos ramas son las mismas que tenía `page.tsx`, y la de `code`/`token_hash` no es
  // decorativa: es por donde entra el magic link de Supabase cuando el proyecto tiene la
  // Site URL apuntando a la raíz. Perderla dejaría el login por email sin retorno.
  //
  // **Este bloque va ANTES del corto de demo mode, y ese orden importa.** El corto existe
  // para saltear los chequeos de AUTH, y acá no hay ninguno: son dos redirects que miran
  // la query. Con el corto arriba, en demo mode `/` caía a `app/page.tsx` — que ya no
  // conserva la rama de `code` — y un magic link aterrizaba en `/login` con el código
  // descartado en silencio.
  if (request.nextUrl.pathname === '/') {
    const q = request.nextUrl.searchParams;
    const code = q.get('code');
    const tokenHash = q.get('token_hash');
    const url = request.nextUrl.clone();
    if (code || tokenHash) {
      const qs = new URLSearchParams();
      if (code) qs.set('code', code);
      if (tokenHash) qs.set('token_hash', tokenHash);
      const type = q.get('type');
      if (type) qs.set('type', type);
      const next = q.get('next');
      if (next) qs.set('next', next);
      url.pathname = '/auth/callback';
      url.search = qs.toString();
    } else {
      url.pathname = '/login';
      url.search = '';
    }
    return withRef(NextResponse.redirect(url));
  }

  // Demo mode: skip auth checks entirely
  if (DEMO()) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // If not logged in and trying to access protected pages, redirect to login
  if (
    !user &&
    (request.nextUrl.pathname.startsWith('/dashboard') ||
      request.nextUrl.pathname === '/onboarding')
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return withRef(NextResponse.redirect(url));
  }

  // Admin gate — block /admin/* for non-allowlisted users
  if (request.nextUrl.pathname.startsWith('/admin')) {
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
    const adminIds = (process.env.ADMIN_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!adminIds.includes(user.id)) {
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard';
      return NextResponse.redirect(url);
    }
  }

  // If logged in and on login page, redirect to dashboard
  if (user && request.nextUrl.pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return withRef(NextResponse.redirect(url));
  }

  return withAct(withRef(supabaseResponse));
}

export const config = {
  // /activar y /activar/confirmar pasan por acá SOLO para refrescar la sesión
  // (ninguna regla de redirect los toca). Sin ese refresco, un access token
  // vencido con refresh válido haría que /activar leyera "no hay sesión", mandara
  // al login, y el middleware rebotara a /dashboard sin consumir el token: un
  // link de activación que no activa nada.
  matcher: ['/', '/dashboard/:path*', '/admin/:path*', '/login', '/onboarding', '/activar', '/activar/:path*'],
};
