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

      if (user?.email) {
        // Use service role client to update usuarios table
        // (anon key + RLS won't allow UPDATE before supabase_auth_id is set)
        const serviceClient = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        // Link this Supabase Auth user to the NETO user by email
        const { data: existingUser } = await serviceClient
          .from('usuarios')
          .select('id, supabase_auth_id')
          .eq('email', user.email)
          .single();

        if (existingUser && !existingUser.supabase_auth_id) {
          // First login — link the accounts
          await serviceClient
            .from('usuarios')
            .update({ supabase_auth_id: user.id })
            .eq('id', existingUser.id);
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
