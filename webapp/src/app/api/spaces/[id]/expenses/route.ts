import { getServiceClient } from '@/lib/supabase/service';
import { getSpaceSplitContext, parseSpaceAmount, requireSpaceMember } from '@/lib/spaces-server';
import { buildSplitSnapshot } from '@/lib/spaces-split';
import { NextResponse } from 'next/server';

/**
 * Resuelve la division con la que se registra (o se re-registra) un gasto.
 *
 * Se guarda congelada en `split_snapshot`: las reglas aplican a gastos FUTUROS,
 * nunca reescriben el pasado. Si no hay a quien cobrarle, falla ruidosamente en
 * vez de guardar un gasto que nadie debe (el balance del grupo dejaria de sumar
 * cero y ningun settlement lo reconciliaria).
 */
async function resolveSnapshot(spaceId: string, amount: number, category: string | null) {
  const { members, effectiveRules } = await getSpaceSplitContext(spaceId);
  return buildSplitSnapshot(amount, category, members, effectiveRules);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { amount, description, category } = body;
  const monto = parseSpaceAmount(amount);
  if (monto === null) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  const snapshot = await resolveSnapshot(id, monto, category || null);
  if (!snapshot) {
    return NextResponse.json({ error: 'El espacio no tiene miembros a quienes dividir el gasto' }, { status: 409 });
  }

  const { data, error } = await getServiceClient()
    .from('space_expenses')
    .insert({
      space_id: id,
      paid_by: auth.user.id,
      amount: monto,
      description: description || null,
      category: category || null,
      split_snapshot: snapshot,
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
    // Mismo guard que el POST: un monto negativo, no finito o absurdo invierte o
    // descuadra los balances del grupo en silencio.
    const parsed = parseSpaceAmount(amount);
    if (parsed === null) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    update.amount = parsed;
  }
  if (description !== undefined) update.description = description;
  if (category !== undefined) update.category = category;

  // Editar un gasto SI re-resuelve la division con las reglas de hoy. Editar es un
  // acto explicito de un miembro sobre ESE gasto, cosa distinta de cambiar una
  // regla (que no debe tocar historia). Asi, corregir una categoria mal puesta
  // aplica la regla que corresponde, con un solo camino de codigo.
  if (update.amount !== undefined || update.category !== undefined) {
    const { data: actual } = await getServiceClient()
      .from('space_expenses')
      .select('amount, category')
      .eq('id', expenseId)
      .eq('space_id', id)
      .single();
    if (!actual) return NextResponse.json({ error: 'Gasto no encontrado' }, { status: 404 });

    const montoFinal = update.amount !== undefined ? (update.amount as number) : Number(actual.amount);
    const categoriaFinal =
      update.category !== undefined ? ((update.category as string) || null) : (actual.category as string | null);

    const snapshot = await resolveSnapshot(id, montoFinal, categoriaFinal);
    if (!snapshot) {
      return NextResponse.json({ error: 'El espacio no tiene miembros a quienes dividir el gasto' }, { status: 409 });
    }
    update.split_snapshot = snapshot;
  }

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
