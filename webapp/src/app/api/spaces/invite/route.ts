import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

// GET /api/spaces/invite?code=xxx — public preview (no auth required)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code)
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });

  const { data: space } = await getServiceClient()
    .from('shared_spaces')
    .select('id, name, type, created_by')
    .eq('invite_code', code.toUpperCase())
    .single();

  if (!space)
    return NextResponse.json({ error: 'Código inválido' }, { status: 404 });

  // Get creator name
  const { data: creator } = await getServiceClient()
    .from('usuarios')
    .select('nombre')
    .eq('id', space.created_by)
    .single();

  // Count members
  const { count } = await getServiceClient()
    .from('space_members')
    .select('id', { count: 'exact', head: true })
    .eq('space_id', space.id);

  return NextResponse.json({
    id: space.id,
    name: space.name,
    type: space.type,
    creator: creator?.nombre || 'Alguien',
    members_count: count || 0,
  });
}
