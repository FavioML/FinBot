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

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: 'id requerido' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (typeof body.label === 'string') {
    const label = body.label.trim();
    if (!label || label.length > 100) {
      return NextResponse.json(
        { error: 'label inválido (1-100 chars)' },
        { status: 400 },
      );
    }
    update.label = label;
  }

  if (body.category !== undefined) {
    if (!VALID_CATEGORIES.includes(body.category as AdminCostCategory)) {
      return NextResponse.json({ error: 'category inválido' }, { status: 400 });
    }
    update.category = body.category;
  }

  if (body.frequency !== undefined) {
    if (!VALID_FREQUENCIES.includes(body.frequency as AdminCostFrequency)) {
      return NextResponse.json({ error: 'frequency inválido' }, { status: 400 });
    }
    update.frequency = body.frequency;
  }

  if (body.currency !== undefined) {
    if (!VALID_CURRENCIES.includes(body.currency as 'PEN' | 'USD')) {
      return NextResponse.json({ error: 'currency inválido' }, { status: 400 });
    }
    update.currency = body.currency;
  }

  if (body.amount_pen !== undefined) {
    const n = Number(body.amount_pen);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json(
        { error: 'amount_pen inválido' },
        { status: 400 },
      );
    }
    update.amount_pen = n;
  }

  if (body.amount_original !== undefined) {
    if (body.amount_original === null) {
      update.amount_original = null;
    } else {
      const n = Number(body.amount_original);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json(
          { error: 'amount_original inválido' },
          { status: 400 },
        );
      }
      update.amount_original = n;
    }
  }

  if (body.next_due_date !== undefined) {
    if (
      body.next_due_date === null ||
      (typeof body.next_due_date === 'string' && body.next_due_date.length === 10)
    ) {
      update.next_due_date = body.next_due_date;
    } else {
      return NextResponse.json(
        { error: 'next_due_date inválido (YYYY-MM-DD o null)' },
        { status: 400 },
      );
    }
  }

  if (body.notes !== undefined) {
    update.notes =
      typeof body.notes === 'string' ? body.notes.trim() || null : null;
  }

  if (body.active !== undefined) {
    update.active = !!body.active;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'sin campos a actualizar' }, { status: 400 });
  }

  const db = getServiceClient();
  const { data, error } = await db
    .from('admin_costs')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ cost: data as AdminCost });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: 'id requerido' }, { status: 400 });
  }

  const db = getServiceClient();
  const { data, error } = await db
    .from('admin_costs')
    .update({ active: false })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ cost: data as AdminCost });
}
