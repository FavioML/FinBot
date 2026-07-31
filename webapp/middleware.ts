import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // Demo mode: skip auth checks entirely
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    return NextResponse.next({ request });
  }

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

  // La raíz solo rebota a /login (page.tsx); no necesita el gate de auth. Pasa por el
  // middleware solo para atrapar el ?ref, así evitamos el getUser() en la home.
  if (request.nextUrl.pathname === '/') {
    return withRef(NextResponse.next({ request }));
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

  return withRef(supabaseResponse);
}

export const config = {
  matcher: ['/', '/dashboard/:path*', '/admin/:path*', '/login', '/onboarding'],
};
