import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

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
  settlements: SettlementRow[]
): Record<string, number> {
  const balance: Record<string, number> = {};
  for (const m of members) balance[m.user_id] = 0;

  const totalPct = members.reduce((s, m) => s + (m.split_percentage || 0), 0);

  for (const exp of expenses) {
    const amount = Number(exp.amount);
    balance[exp.paid_by] = (balance[exp.paid_by] || 0) + amount;
    for (const m of members) {
      const pct = totalPct > 0 ? (m.split_percentage || 0) / totalPct : 1 / members.length;
      balance[m.user_id] = (balance[m.user_id] || 0) - amount * pct;
    }
  }

  for (const s of settlements) {
    balance[s.from_user] = (balance[s.from_user] || 0) - Number(s.amount);
    balance[s.to_user] = (balance[s.to_user] || 0) + Number(s.amount);
  }

  return balance;
}

async function getNetoUserId() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await serviceClient
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();
  return data;
}

export async function GET(
  _request: Request,
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

  const { data: space } = await serviceClient.from('shared_spaces').select('*').eq('id', id).single();
  const { data: members } = await serviceClient
    .from('space_members')
    .select('user_id, role, split_percentage, usuarios(nombre)')
    .eq('space_id', id);
  const { data: expenses } = await serviceClient
    .from('space_expenses')
    .select('*, usuarios(nombre)')
    .eq('space_id', id)
    .order('created_at', { ascending: false })
    .limit(20);
  const { data: settlements } = await serviceClient
    .from('space_settlements')
    .select('*, from:usuarios!space_settlements_from_user_fkey(nombre), to:usuarios!space_settlements_to_user_fkey(nombre)')
    .eq('space_id', id)
    .order('settled_at', { ascending: false })
    .limit(10);

  const membersTyped = (members || []) as unknown as MemberRow[];
  const expensesTyped = (expenses || []) as unknown as ExpenseRow[];
  const settlementsTyped = (settlements || []) as unknown as SettlementRow[];
  const balance = computeBalances(membersTyped, expensesTyped, settlementsTyped);

  return NextResponse.json({
    space,
    members: membersTyped,
    expenses: expensesTyped,
    settlements: settlementsTyped,
    balance,
    currentUserId: usuario.id,
    isPro: usuario.plan === 'premium',
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Only owner can rename
  const { data: membership } = await serviceClient
    .from('space_members')
    .select('role')
    .eq('space_id', id)
    .eq('user_id', usuario.id)
    .single();
  if (!membership || membership.role !== 'owner') return NextResponse.json({ error: 'Only owner can edit' }, { status: 403 });

  const body = await request.json();
  const { name } = body;
  if (!name || typeof name !== 'string' || !name.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const { error } = await serviceClient
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
  const usuario = await getNetoUserId();
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Only owner can delete
  const { data: membership } = await serviceClient
    .from('space_members')
    .select('role')
    .eq('space_id', id)
    .eq('user_id', usuario.id)
    .single();
  if (!membership || membership.role !== 'owner') return NextResponse.json({ error: 'Only owner can delete' }, { status: 403 });

  // Delete in order: settlements, expenses, members, space
  await serviceClient.from('space_settlements').delete().eq('space_id', id);
  await serviceClient.from('space_expenses').delete().eq('space_id', id);
  await serviceClient.from('space_members').delete().eq('space_id', id);
  const { error } = await serviceClient.from('shared_spaces').delete().eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
