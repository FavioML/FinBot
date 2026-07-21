import { getServiceClient } from '@/lib/supabase/service';
import { getSpaceMemberIds, getSpaceOwnerIsPro, requireSpaceMember } from '@/lib/spaces-server';
import { sanitizeSplitRules } from '@/lib/spaces-split';
import { NextResponse } from 'next/server';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  // Reglas de división personalizadas son Pro (tier del owner del espacio).
  if (!(await getSpaceOwnerIsPro(id))) {
    return NextResponse.json({ error: 'Las reglas por categoría son una función Pro' }, { status: 403 });
  }

  const body = await request.json();
  const { rules } = body;
  if (!Array.isArray(rules)) return NextResponse.json({ error: 'rules must be an array' }, { status: 400 });

  // Rules apply retroactively to every past expense, so never persist them raw:
  // a weight keyed to a non-member would inflate the denominator (dropping the
  // author's own share toward 0 across the whole history) and an Infinity/NaN
  // weight would break the group's balance outright.
  const memberIds = await getSpaceMemberIds(id);
  const cleanRules = sanitizeSplitRules(rules, memberIds);

  const { error } = await getServiceClient()
    .from('shared_spaces')
    .update({ split_rules: cleanRules })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
