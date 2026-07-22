import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

export async function GET() {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  const { data: memberships } = await getServiceClient()
    .from('space_members')
    .select('space_id, role, shared_spaces(id, name, type, invite_code, created_at)')
    .eq('user_id', usuario.id);

  return NextResponse.json({
    spaces: (memberships || []).map((m: Record<string, unknown>) => ({ ...(m.shared_spaces as object), role: m.role })),
    isPro: usuario.plan === 'premium',
  });
}

export async function POST(request: Request) {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  const body = await request.json();
  const { name, type = 'custom' } = body;
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  // Plan Free puede crear (ser owner de) 1 espacio. Ser invitado a otros no cuenta.
  if (usuario.plan !== 'premium') {
    const { count } = await getServiceClient()
      .from('shared_spaces')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', usuario.id);
    if ((count || 0) >= 1) {
      return NextResponse.json(
        { error: 'El plan Free permite 1 espacio. Pasa a Pro para crear más.' },
        { status: 403 }
      );
    }
  }

  const invite_code = Math.random().toString(36).slice(2, 9).toUpperCase();

  const { data: space, error } = await getServiceClient()
    .from('shared_spaces')
    .insert({ name, type, invite_code, created_by: usuario.id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await getServiceClient().from('space_members').insert({
    space_id: space.id,
    user_id: usuario.id,
    role: 'owner',
    split_percentage: 50,
  });

  return NextResponse.json(space, { status: 201 });
}
