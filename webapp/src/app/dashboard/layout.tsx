import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { createClient } from '@/lib/supabase/server';
import type { Usuario } from '@/lib/types';

// Force dynamic rendering — dashboard requires auth
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fetch the user on the server (the middleware already validated the session,
  // so the auth cookies are present) and pass it down to seed React Query. This
  // removes the two sequential client round-trips of useUser() from the critical
  // path and lets the dashboard's data hooks start right after hydration instead
  // of waiting for auth to resolve in the browser. We reuse the server render we
  // already pay for via force-dynamic (which otherwise only emits an empty shell).
  // `undefined` means "don't seed" (demo mode / unresolved) → client fetches.
  let initialUser: Usuario | null | undefined = undefined;

  if (process.env.NEXT_PUBLIC_DEMO_MODE !== 'true') {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data } = await supabase
        .from('usuarios')
        .select('*')
        .eq('supabase_auth_id', user.id)
        .single();
      initialUser = data ?? null;
    }
  }

  return <DashboardShell initialUser={initialUser}>{children}</DashboardShell>;
}
