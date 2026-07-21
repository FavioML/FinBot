import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { getSpaceOwnerIsPro } from '@/lib/spaces-server';
import { sanitizeSplitRules } from '@/lib/spaces-split';
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
  return data?.id ?? null;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userId = await getNetoUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: membership } = await getServiceClient()
    .from('space_members')
    .select('id')
    .eq('space_id', id)
    .eq('user_id', userId)
    .single();
  if (!membership) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

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
  const { data: memberRows } = await getServiceClient()
    .from('space_members')
    .select('user_id')
    .eq('space_id', id);
  const memberIds = new Set((memberRows ?? []).map((m) => m.user_id as string));
  const cleanRules = sanitizeSplitRules(rules, memberIds);

  const { error } = await getServiceClient()
    .from('shared_spaces')
    .update({ split_rules: cleanRules })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
