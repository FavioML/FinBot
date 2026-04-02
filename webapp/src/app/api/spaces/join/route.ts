import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  if (!usuario) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const body = await request.json();
  const { code } = body;
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });

  const { data: space } = await supabase
    .from('shared_spaces')
    .select('id, name')
    .eq('invite_code', code.toUpperCase())
    .single();
  if (!space) return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 });

  // Check already a member
  const { data: existing } = await supabase
    .from('space_members')
    .select('id')
    .eq('space_id', space.id)
    .eq('user_id', usuario.id)
    .single();
  if (existing) return NextResponse.json({ space_id: space.id, already_member: true });

  const { error } = await supabase.from('space_members').insert({
    space_id: space.id,
    user_id: usuario.id,
    role: 'member',
    split_percentage: 50,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ space_id: space.id, name: space.name }, { status: 201 });
}
