import { getServiceClient } from '@/lib/supabase/service';
import { requireSpaceMember } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { amount, description, category } = body;
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  const { data, error } = await getServiceClient()
    .from('space_expenses')
    .insert({
      space_id: id,
      paid_by: auth.user.id,
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
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { id: expenseId, amount, description, category } = body;
  if (!expenseId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (amount !== undefined) {
    // Same guard as POST: a negative or non-finite amount here would silently
    // invert the group's balances (turning a debt into a credit).
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    update.amount = parsed;
  }
  if (description !== undefined) update.description = description;
  if (category !== undefined) update.category = category;

  const { error } = await getServiceClient()
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
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const expenseId = url.searchParams.get('id');
  if (!expenseId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('space_expenses')
    .delete()
    .eq('id', expenseId)
    .eq('space_id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
