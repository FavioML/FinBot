import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Get the authenticated user
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        // Use service role client to check/update usuarios table
        // (anon key + RLS won't allow queries before supabase_auth_id is set)
        const serviceClient = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        // Check if user exists by supabase_auth_id
        const { data: byAuthId } = await serviceClient
          .from('usuarios')
          .select('id')
          .eq('supabase_auth_id', user.id)
          .maybeSingle();

        if (byAuthId) {
          // User already linked — go to dashboard
          return NextResponse.redirect(`${origin}${next}`);
        }

        // Check if user exists by email (registered via WhatsApp with same email)
        if (user.email) {
          const { data: byEmail } = await serviceClient
            .from('usuarios')
            .select('id, supabase_auth_id')
            .eq('email', user.email)
            .maybeSingle();

          if (byEmail) {
            // Link the accounts if not yet linked
            if (!byEmail.supabase_auth_id) {
              await serviceClient
                .from('usuarios')
                .update({ supabase_auth_id: user.id })
                .eq('id', byEmail.id);
            }
            return NextResponse.redirect(`${origin}${next}`);
          }
        }

        // User not found — redirect to onboarding
        return NextResponse.redirect(`${origin}/onboarding`);
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
