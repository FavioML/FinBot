import { getServiceClient } from '@/lib/supabase/service';
import { requireSpaceMember, requireSpaceOwner } from '@/lib/spaces-server';
import {
  computeBalancesFromSnapshots,
  type SplitRule,
  type SplitSnapshot,
  type SnapshotSettlement,
} from '@/lib/spaces-split';
import { NextResponse } from 'next/server';

interface MemberRow {
  user_id: string;
  role: string;
  split_percentage: number;
  usuarios: { nombre: string } | null;
}

interface ExpenseRow {
  id: string;
  paid_by: string;
  amount: number;
  description: string | null;
  category: string | null;
  created_at: string;
  split_snapshot: SplitSnapshot | null;
  usuarios: { nombre: string } | null;
}

interface SettlementRow {
  id: string;
  from_user: string;
  to_user: string;
  amount: number;
  settled_at: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  // Las consultas son independientes entre si: en serie eran round-trips
  // encadenados en cada carga del detalle. Solo el plan del owner depende de
  // `space`, asi que queda como segunda ola.
  //
  // Las listas de gastos/liquidaciones vienen capadas para la UI (20 y 10), pero
  // el BALANCE necesita el historial completo: calcularlo sobre la lista capada
  // borraba del saldo todo lo anterior a los ultimos 20 movimientos. Por eso las
  // dos consultas "all" (solo las columnas que el balance necesita).
  const [
    { data: space },
    { data: members },
    { data: expenses },
    { data: settlements },
    { data: allExpenses },
    { data: allSettlements },
  ] = await Promise.all([
    getServiceClient().from('shared_spaces').select('*').eq('id', id).single(),
    getServiceClient()
      .from('space_members')
      .select('user_id, role, split_percentage, usuarios(nombre)')
      .eq('space_id', id),
    getServiceClient()
      .from('space_expenses')
      .select('*, usuarios(nombre)')
      .eq('space_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
    getServiceClient()
      .from('space_settlements')
      .select('*, from:usuarios!space_settlements_from_user_fkey(nombre), to:usuarios!space_settlements_to_user_fkey(nombre)')
      .eq('space_id', id)
      .order('settled_at', { ascending: false })
      .limit(10),
    getServiceClient()
      .from('space_expenses')
      .select('paid_by, amount, split_snapshot')
      .eq('space_id', id),
    getServiceClient()
      .from('space_settlements')
      .select('from_user, to_user, amount')
      .eq('space_id', id),
  ]);

  // "host pays": the space's Pro tier is the OWNER's plan, not the viewer's.
  const ownerId = (space as Record<string, unknown>)?.created_by as string | undefined;
  let ownerIsPro = false;
  if (ownerId === usuario.id) {
    ownerIsPro = usuario.plan === 'premium';
  } else if (ownerId) {
    const { data: owner } = await getServiceClient()
      .from('usuarios')
      .select('plan')
      .eq('id', ownerId)
      .single();
    ownerIsPro = owner?.plan === 'premium';
  }

  // Custom split rules only exist / apply on Pro-tier spaces. If the space is
  // Free-tier (e.g. after a downgrade), ignore any stale rules so balances and
  // display fall back cleanly to the default split.
  const rawRules = ((space as Record<string, unknown>)?.split_rules ?? []) as SplitRule[];
  const effectiveRules = ownerIsPro ? rawRules : [];

  const membersTyped = (members || []) as unknown as MemberRow[];
  const expensesTyped = (expenses || []) as unknown as ExpenseRow[];
  const settlementsTyped = (settlements || []) as unknown as SettlementRow[];

  // Los balances se leen de la division CONGELADA de cada gasto; no se recalculan
  // desde las reglas de hoy. Cambiar una regla ya no reescribe el pasado.
  const balance = computeBalancesFromSnapshots(
    (allExpenses || []) as unknown as ExpenseRow[],
    (allSettlements || []) as unknown as SnapshotSettlement[],
    membersTyped.map((m) => m.user_id)
  );

  return NextResponse.json({
    space,
    members: membersTyped,
    expenses: expensesTyped,
    settlements: settlementsTyped,
    balance,
    splitRules: effectiveRules,
    budgets: ownerIsPro ? ((space as Record<string, unknown>)?.budgets ?? []) : [],
    currentUserId: usuario.id,
    isPro: ownerIsPro,
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Only owner can rename
  const auth = await requireSpaceOwner(id);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { name } = body;
  if (!name || typeof name !== 'string' || !name.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('shared_spaces')
    .update({ name: name.trim() })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Only owner can delete
  const auth = await requireSpaceOwner(id);
  if (!auth.ok) return auth.response;

  // Delete in order: metas vinculadas, settlements, expenses, members, space.
  //
  // `metas_ahorro.space_id` referencia shared_spaces con NO ACTION (no cascade), asi
  // que si el espacio tiene una meta compartida el DELETE final fallaba por FK...
  // pero para entonces settlements/expenses/members YA estaban borrados, dejando un
  // espacio zombie sin miembros. Como el re-DELETE valida owner leyendo space_members
  // (ahora vacio), respondia 403 para siempre: el espacio quedaba imborrable.
  // Se desvincula primero (la meta sobrevive como meta personal del creador).
  const { error: unlinkError } = await getServiceClient()
    .from('metas_ahorro')
    .update({ space_id: null })
    .eq('space_id', id);
  if (unlinkError) return NextResponse.json({ error: unlinkError.message }, { status: 400 });

  await getServiceClient().from('space_settlements').delete().eq('space_id', id);
  await getServiceClient().from('space_expenses').delete().eq('space_id', id);
  await getServiceClient().from('space_members').delete().eq('space_id', id);
  const { error } = await getServiceClient().from('shared_spaces').delete().eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
