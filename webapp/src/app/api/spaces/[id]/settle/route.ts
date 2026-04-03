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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: membership } = await serviceClient
    .from('space_members')
    .select('id')
    .eq('space_id', id)
    .eq('user_id', usuario.id)
    .single();
  if (!membership) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

  const body = await request.json();
  const { to_user, amount } = body;
  if (!to_user || !amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ error: 'to_user and amount required' }, { status: 400 });
  }

  const { data, error } = await serviceClient
    .from('space_settlements')
    .insert({
      space_id: id,
      from_user: usuario.id,
      to_user,
      amount: Number(amount),
      settled_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}
