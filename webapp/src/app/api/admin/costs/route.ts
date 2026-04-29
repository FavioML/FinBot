import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import type { AdminCost, AdminCostCategory, AdminCostFrequency } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

const VALID_CATEGORIES: AdminCostCategory[] = [
  'infra',
  'domain',
  'comms',
  'ai',
  'compliance',
  'tooling',
  'other',
];
const VALID_FREQUENCIES: AdminCostFrequency[] = ['monthly', 'yearly', 'one_time'];
const VALID_CURRENCIES = ['PEN', 'USD'] as const;

export async function GET(request: Request) {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const url = new URL(request.url);
  const activeFilter = url.searchParams.get('active');
  const categoryFilter = url.searchParams.get('category');

  const db = getServiceClient();
  let query = db
    .from('admin_costs')
    .select('*')
    .order('next_due_date', { ascending: true, nullsFirst: false });

  if (activeFilter === 'true') query = query.eq('active', true);
  else if (activeFilter === 'false') query = query.eq('active', false);

  if (categoryFilter && VALID_CATEGORIES.includes(categoryFilter as AdminCostCategory)) {
    query = query.eq('category', categoryFilter);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ costs: (data || []) as AdminCost[] });
}

export async function POST(request: Request) {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || label.length > 100) {
    return NextResponse.json(
      { error: 'label requerido (1-100 chars)' },
      { status: 400 },
    );
  }

  const category = body.category as AdminCostCategory;
  if (!VALID_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: 'category inválido' }, { status: 400 });
  }

  const frequency = body.frequency as AdminCostFrequency;
  if (!VALID_FREQUENCIES.includes(frequency)) {
    return NextResponse.json({ error: 'frequency inválido' }, { status: 400 });
  }

  const currency = body.currency as 'PEN' | 'USD';
  if (!VALID_CURRENCIES.includes(currency)) {
    return NextResponse.json({ error: 'currency inválido' }, { status: 400 });
  }

  const amountPen = Number(body.amount_pen);
  if (!Number.isFinite(amountPen) || amountPen < 0) {
    return NextResponse.json(
      { error: 'amount_pen debe ser un número ≥ 0' },
      { status: 400 },
    );
  }

  const amountOriginal =
    body.amount_original !== undefined && body.amount_original !== null
      ? Number(body.amount_original)
      : null;
  if (amountOriginal !== null && (!Number.isFinite(amountOriginal) || amountOriginal < 0)) {
    return NextResponse.json(
      { error: 'amount_original inválido' },
      { status: 400 },
    );
  }

  const nextDueDate =
    typeof body.next_due_date === 'string' && body.next_due_date.length === 10
      ? body.next_due_date
      : null;

  const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;

  const insertRow = {
    label,
    category,
    frequency,
    currency,
    amount_pen: amountPen,
    amount_original: amountOriginal,
    next_due_date: nextDueDate,
    notes,
    active: body.active === false ? false : true,
    paid_history: [],
  };

  const db = getServiceClient();
  const { data, error } = await db
    .from('admin_costs')
    .insert(insertRow)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ cost: data as AdminCost });
}
