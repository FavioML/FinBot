import { createServerClient } from '@supabase/ssr';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = searchParams.get('next') ?? '/dashboard';

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

  let authError = null;

  if (code) {
    // OAuth PKCE flow
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error('[auth/callback] exchangeCodeForSession failed:', error.message, error.status, error.code);
    }
    authError = error;
  } else if (token_hash && type) {
    // Email invite / magic link / OTP flow
    const { error } = await supabase.auth.verifyOtp({ token_hash, type });
    if (error) {
      console.error('[auth/callback] verifyOtp failed:', error.message, error.status);
    }
    authError = error;
  } else {
    // Neither code nor token_hash — likely an OAuth error response from Supabase
    const oauthError = searchParams.get('error');
    console.error('[auth/callback] no code or token_hash. error param:', oauthError, searchParams.get('error_description'));
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  if (!authError) {
    const { data: { user } } = await supabase.auth.getUser();

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

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
