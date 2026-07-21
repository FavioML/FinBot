import { getServiceClient } from '@/lib/supabase/service';
import { getSpaceMemberIds, requireSpaceMember } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

// PUT /api/spaces/[id]/default-split — updates each member's split_percentage.
// This is the default (per-member) division applied to categories without a
// custom rule. It is a Free-tier feature (basic 50/50 and adjustments).
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { splits } = body;
  if (!splits || typeof splits !== 'object' || Array.isArray(splits)) {
    return NextResponse.json({ error: 'splits object required' }, { status: 400 });
  }

  // Only touch members that actually belong to this space.
  const memberIds = await getSpaceMemberIds(id);

  const entries = Object.entries(splits as Record<string, unknown>).filter(([uid]) => memberIds.has(uid));
  if (entries.length === 0) {
    return NextResponse.json({ error: 'No valid members in splits' }, { status: 400 });
  }

  for (const [uid, raw] of entries) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
    const { error } = await getServiceClient()
      .from('space_members')
      .update({ split_percentage: pct })
      .eq('space_id', id)
      .eq('user_id', uid);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
