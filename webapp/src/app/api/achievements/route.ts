import { getServiceClient } from '@/lib/supabase/service';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

export async function GET() {
  const auth = await requireLectura();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const { data, error } = await getServiceClient()
    .from('logros')
    .select('*')
    .eq('usuario_id', userId)
    .order('created_at', { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
