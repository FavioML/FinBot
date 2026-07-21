import { getServiceClient } from '@/lib/supabase/service';
import { requireSpaceMember, requireSpaceOwner } from '@/lib/spaces-server';
import { splitFractions, type SplitRule } from '@/lib/spaces-split';
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
  usuarios: { nombre: string } | null;
}

interface SettlementRow {
  id: string;
  from_user: string;
  to_user: string;
  amount: number;
  settled_at: string;
}

function computeBalances(
  members: MemberRow[],
  expenses: ExpenseRow[],
  settlements: SettlementRow[],
  splitRules: SplitRule[]
): Record<string, number> {
  const balance: Record<string, number> = {};
  for (const m of members) balance[m.user_id] = 0;

  // Fractions depend only on the category, so resolve each one once.
  const fractionsByCategory = new Map<string, Record<string, number>>();
  const fractionsFor = (category: string | null) => {
    const key = category ?? '';
    let fractions = fractionsByCategory.get(key);
    if (!fractions) {
      fractions = splitFractions(category, members, splitRules);
      fractionsByCategory.set(key, fractions);
    }
    return fractions;
  };

  for (const exp of expenses) {
    const amount = Number(exp.amount);
    balance[exp.paid_by] = (balance[exp.paid_by] || 0) + amount;
    const fractions = fractionsFor(exp.category);
    for (const m of members) {
      balance[m.user_id] = (balance[m.user_id] || 0) - amount * (fractions[m.user_id] || 0);
    }
  }

  for (const s of settlements) {
    balance[s.from_user] = (balance[s.from_user] || 0) - Number(s.amount);
    balance[s.to_user] = (balance[s.to_user] || 0) + Number(s.amount);
  }

  return balance;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  const { data: space } = await getServiceClient().from('shared_spaces').select('*').eq('id', id).single();
  const { data: members } = await getServiceClient()
    .from('space_members')
    .select('user_id, role, split_percentage, usuarios(nombre)')
    .eq('space_id', id);
  const { data: expenses } = await getServiceClient()
    .from('space_expenses')
    .select('*, usuarios(nombre)')
    .eq('space_id', id)
    .order('created_at', { ascending: false })
    .limit(20);
  const { data: settlements } = await getServiceClient()
    .from('space_settlements')
    .select('*, from:usuarios!space_settlements_from_user_fkey(nombre), to:usuarios!space_settlements_to_user_fkey(nombre)')
    .eq('space_id', id)
    .order('settled_at', { ascending: false })
    .limit(10);

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
  const balance = computeBalances(membersTyped, expensesTyped, settlementsTyped, effectiveRules);

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
