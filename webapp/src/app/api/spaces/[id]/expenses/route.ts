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

async function verifyMembership(spaceId: string, userId: string) {
  const { data } = await serviceClient
    .from('space_members')
    .select('id')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .single();
  return !!data;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await verifyMembership(id, usuario.id))) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

  const body = await request.json();
  const { amount, description, category } = body;
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  const { data, error } = await serviceClient
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

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await verifyMembership(id, usuario.id))) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

  const body = await request.json();
  const { id: expenseId, amount, description, category } = body;
  if (!expenseId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (amount !== undefined) update.amount = Number(amount);
  if (description !== undefined) update.description = description;
  if (category !== undefined) update.category = category;

  const { error } = await serviceClient
    .from('space_expenses')
    .update(update)
    .eq('id', expenseId)
    .eq('space_id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await verifyMembership(id, usuario.id))) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

  const url = new URL(request.url);
  const expenseId = url.searchParams.get('id');
  if (!expenseId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await serviceClient
    .from('space_expenses')
    .delete()
    .eq('id', expenseId)
    .eq('space_id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
