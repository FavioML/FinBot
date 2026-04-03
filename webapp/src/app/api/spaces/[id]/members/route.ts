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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Only owner can remove members
  const { data: membership } = await serviceClient
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

  const { error } = await serviceClient
    .from('space_members')
    .delete()
    .eq('space_id', id)
    .eq('user_id', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
