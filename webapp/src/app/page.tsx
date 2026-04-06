import { redirect } from 'next/navigation';

// Root page: forward any auth params (from Supabase invite/magic-link redirects) to /auth/callback
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;

  if (params.code || params.token_hash) {
    const qs = new URLSearchParams();
    if (params.code) qs.set('code', params.code);
    if (params.token_hash) qs.set('token_hash', params.token_hash);
    if (params.type) qs.set('type', params.type);
    if (params.next) qs.set('next', params.next);
    redirect(`/auth/callback?${qs.toString()}`);
  }

  redirect('/login');
}
