import { createClient } from '@/lib/supabase/server';
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
  settlements: SettlementRow[]
): Record<string, number> {
  const balance: Record<string, number> = {};
  for (const m of members) balance[m.user_id] = 0;

  const totalPct = members.reduce((s, m) => s + (m.split_percentage || 0), 0);

  for (const exp of expenses) {
    const amount = Number(exp.amount);
    // Payer gets credited the full amount
    balance[exp.paid_by] = (balance[exp.paid_by] || 0) + amount;
    // Each member gets debited their share
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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('id, plan')
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

  const { data: space } = await supabase.from('shared_spaces').select('*').eq('id', id).single();
  const { data: members } = await supabase
    .from('space_members')
    .select('user_id, role, split_percentage, usuarios(nombre)')
    .eq('space_id', id);
  const { data: expenses } = await supabase
    .from('space_expenses')
    .select('*, usuarios(nombre)')
    .eq('space_id', id)
    .order('created_at', { ascending: false })
    .limit(20);
  const { data: settlements } = await supabase
    .from('space_settlements')
    .select('*, from:usuarios!space_settlements_from_user_fkey(nombre), to:usuarios!space_settlements_to_user_fkey(nombre)')
    .eq('space_id', id)
    .order('settled_at', { ascending: false })
    .limit(10);

  const membersTyped = (members || []) as MemberRow[];
  const expensesTyped = (expenses || []) as ExpenseRow[];
  const settlementsTyped = (settlements || []) as SettlementRow[];
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
