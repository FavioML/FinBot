import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  if (!usuario) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { data: membership } = await supabase
    .from('space_members')
    .select('id')
    .eq('space_id', id)
    .eq('user_id', usuario.id)
    .single();
  if (!membership) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

  const body = await request.json();
  const { amount, description, category } = body;
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('space_expenses')
    .insert({
      space_id: id,
      paid_by: usuario.id,
      amount: Number(amount),
      description: description || null,
      category: category || null,
    })
    .select('*, usuarios(nombre)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}
