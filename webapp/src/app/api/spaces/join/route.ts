import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getNetoUserId() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await serviceClient
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data;
}

export async function POST(request: Request) {
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { code } = body;
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });

  const { data: space } = await serviceClient
    .from('shared_spaces')
    .select('id, name, type')
    .eq('invite_code', code.toUpperCase())
    .single();
  if (!space) return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 });

  const { data: existing } = await serviceClient
    .from('space_members')
    .select('id')
    .eq('space_id', space.id)
    .eq('user_id', usuario.id)
    .single();
  if (existing) return NextResponse.json({ space_id: space.id, already_member: true });

  // Check member limit
  const limits: Record<string, number> = { pareja: 2, roommates: 6, custom: 6 };
  const maxMembers = limits[space.type] || 6;
  const { count } = await serviceClient
    .from('space_members')
    .select('id', { count: 'exact', head: true })
    .eq('space_id', space.id);
  if ((count || 0) >= maxMembers) {
    return NextResponse.json({ error: `Este espacio ya tiene el máximo de ${maxMembers} miembros` }, { status: 400 });
  }

  const { error } = await serviceClient.from('space_members').insert({
    space_id: space.id,
    user_id: usuario.id,
    role: 'member',
    split_percentage: 50,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ space_id: space.id, name: space.name }, { status: 201 });
}
