import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'faviomendoza27jl@gmail.com';

async function getAdminEmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email || null;
}

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const email = await getAdminEmail();
  if (email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');

  const { data, error, count } = await getServiceClient()
    .from('nlp_errors')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, total: count || 0, errors: data || [] });
}
