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
    .from('usuarios')
    .select('recordatorios_activos')
    .eq('id', userId)
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ recordatorios_activos: data?.recordatorios_activos ?? true });
}

export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const recordatorios_activos = Boolean(body.recordatorios_activos);

  const { error } = await getServiceClient()
    .from('usuarios')
    .update({ recordatorios_activos })
    .eq('id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ recordatorios_activos });
}
