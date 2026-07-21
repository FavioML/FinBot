import { getServiceClient } from '@/lib/supabase/service';
import { getSessionUser } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const usuario = await getSessionUser();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { code } = body;
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });

  const { data: space } = await getServiceClient()
    .from('shared_spaces')
    .select('id, name, type')
    .eq('invite_code', code.toUpperCase())
    .single();
  if (!space) return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 });

  const { data: existing } = await getServiceClient()
    .from('space_members')
    .select('id')
    .eq('space_id', space.id)
    .eq('user_id', usuario.id)
    .single();
  if (existing) return NextResponse.json({ space_id: space.id, already_member: true });

  // Check member limit
  const limits: Record<string, number> = { pareja: 2, roommates: 6, custom: 6 };
  const maxMembers = limits[space.type] || 6;
  const { count } = await getServiceClient()
    .from('space_members')
    .select('id', { count: 'exact', head: true })
    .eq('space_id', space.id);
  if ((count || 0) >= maxMembers) {
    return NextResponse.json({ error: `Este espacio ya tiene el máximo de ${maxMembers} miembros` }, { status: 400 });
  }

  const { error } = await getServiceClient().from('space_members').insert({
    space_id: space.id,
    user_id: usuario.id,
    role: 'member',
    split_percentage: 50,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ space_id: space.id, name: space.name }, { status: 201 });
}
