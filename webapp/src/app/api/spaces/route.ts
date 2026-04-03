import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

async function getNetoUserId() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();
  return data;
}

export async function GET() {
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: memberships } = await getServiceClient()
    .from('space_members')
    .select('space_id, role, shared_spaces(id, name, type, invite_code, created_at)')
    .eq('user_id', usuario.id);

  return NextResponse.json({
    spaces: (memberships || []).map((m: Record<string, unknown>) => ({ ...(m.shared_spaces as object), role: m.role })),
    isPro: usuario.plan === 'premium',
  });
}

export async function POST(request: Request) {
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, type = 'custom' } = body;
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const invite_code = Math.random().toString(36).slice(2, 9).toUpperCase();

  const { data: space, error } = await getServiceClient()
    .from('shared_spaces')
    .insert({ name, type, invite_code, created_by: usuario.id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await getServiceClient().from('space_members').insert({
    space_id: space.id,
    user_id: usuario.id,
    role: 'owner',
    split_percentage: 50,
  });

  return NextResponse.json(space, { status: 201 });
}
