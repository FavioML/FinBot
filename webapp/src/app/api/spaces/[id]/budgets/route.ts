import { getServiceClient } from '@/lib/supabase/service';
import { getSpaceOwnerIsPro, requireSpaceMember } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  // Presupuesto conjunto del espacio es Pro (tier del owner del espacio).
  if (!(await getSpaceOwnerIsPro(id))) {
    return NextResponse.json({ error: 'El presupuesto conjunto es una función Pro' }, { status: 403 });
  }

  const body = await request.json();
  const { budgets } = body;
  if (!Array.isArray(budgets)) return NextResponse.json({ error: 'budgets must be an array' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('shared_spaces')
    .update({ budgets })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
