import { createServerClient } from '@supabase/ssr';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  if (code) {
    // Create the redirect response first so we can write session cookies directly onto it.
    // Using NextResponse.redirect + explicit cookie writes ensures Samsung Internet and
    // other mobile browsers that don't process Set-Cookie on 302 redirects work correctly.
    const response = NextResponse.redirect(`${origin}${next}`);

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options);
            });
          },
        },
      }
    );

    const cookieNames = request.cookies.getAll().map(c => c.name);
    console.log('[auth/callback] cookies present:', cookieNames);

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const serviceClient = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        // Check if user is already linked by supabase_auth_id
        const { data: byAuthId } = await serviceClient
          .from('usuarios')
          .select('id')
          .eq('supabase_auth_id', user.id)
          .maybeSingle();

        if (byAuthId) {
          return response;
        }

        // Check if user exists by email (registered via WhatsApp)
        if (user.email) {
          const { data: byEmail } = await serviceClient
            .from('usuarios')
            .select('id, supabase_auth_id')
            .eq('email', user.email)
            .maybeSingle();

          if (byEmail) {
            if (!byEmail.supabase_auth_id) {
              await serviceClient
                .from('usuarios')
                .update({ supabase_auth_id: user.id })
                .eq('id', byEmail.id);
            }
            return response;
          }
        }

        // User not found in usuarios — send to onboarding with session cookies
        const onboardingResponse = NextResponse.redirect(`${origin}/onboarding`);
        response.cookies.getAll().forEach(({ name, value, ...rest }) => {
          onboardingResponse.cookies.set(name, value, rest);
        });
        return onboardingResponse;
      }

      return response;
    }

    console.error('[auth/callback] exchangeCodeForSession failed:', error.message, error.status, error.code);
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
