import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

async function getNetoUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data?.id || null;
}

export async function GET() {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await getServiceClient()
    .from('logros')
    .select('*')
    .eq('usuario_id', userId)
    .order('created_at', { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
