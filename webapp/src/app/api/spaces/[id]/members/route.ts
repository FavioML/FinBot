import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

async function getNetoUserId() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data;
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Only owner can remove members
  const { data: membership } = await getServiceClient()
    .from('space_members')
    .select('role')
    .eq('space_id', id)
    .eq('user_id', usuario.id)
    .single();
  if (!membership || membership.role !== 'owner') return NextResponse.json({ error: 'Only owner can remove members' }, { status: 403 });

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  // Can't remove yourself
  if (userId === usuario.id) return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('space_members')
    .delete()
    .eq('space_id', id)
    .eq('user_id', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
