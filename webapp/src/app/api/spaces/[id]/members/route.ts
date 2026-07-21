import { getServiceClient } from '@/lib/supabase/service';
import { requireSpaceOwner } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Only owner can remove members
  const auth = await requireSpaceOwner(id);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  // Can't remove yourself
  if (userId === auth.user.id) return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('space_members')
    .delete()
    .eq('space_id', id)
    .eq('user_id', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
