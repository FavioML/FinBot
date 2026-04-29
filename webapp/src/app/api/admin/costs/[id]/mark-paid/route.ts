import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import type { AdminCost, AdminCostPaidEntry } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

function todayIsoLima(): string {
  const now = new Date();
  const lima = new Date(now.getTime() - 5 * 3600 * 1000);
  const y = lima.getUTCFullYear();
  const m = String(lima.getUTCMonth() + 1).padStart(2, '0');
  const d = String(lima.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addMonths(iso: string, months: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, day));
  // If day overflowed (e.g. Jan 31 +1 → Mar 3), clamp to last day of target month
  if (target.getUTCDate() !== day) {
    target.setUTCDate(0);
  }
  return target.toISOString().slice(0, 10);
}

export async function POST(
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

  let body: Record<string, unknown> = {};
  try {
    if (request.headers.get('content-type')?.includes('application/json')) {
      body = await request.json();
    }
  } catch {
    body = {};
  }

  const db = getServiceClient();

  const { data: existing, error: fetchErr } = await db
    .from('admin_costs')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    return NextResponse.json(
      { error: fetchErr?.message || 'Costo no encontrado' },
      { status: 404 },
    );
  }

  const cost = existing as AdminCost;
  const today = todayIsoLima();

  // Custom amount paid (defaults to recurring amount_pen)
  const customAmount =
    body.amount_pen !== undefined && body.amount_pen !== null
      ? Number(body.amount_pen)
      : Number(cost.amount_pen);
  if (!Number.isFinite(customAmount) || customAmount < 0) {
    return NextResponse.json(
      { error: 'amount_pen inválido' },
      { status: 400 },
    );
  }

  const paidEntry: AdminCostPaidEntry = {
    paid_at: today,
    amount_pen: customAmount,
    marked_by: user.id,
  };

  const newHistory = [...(cost.paid_history || []), paidEntry];

  // Advance next_due_date based on frequency
  const referenceDate = cost.next_due_date || today;
  let newNextDue: string | null = null;
  let newActive = cost.active;

  if (cost.frequency === 'monthly') {
    newNextDue = addMonths(referenceDate, 1);
  } else if (cost.frequency === 'yearly') {
    newNextDue = addMonths(referenceDate, 12);
  } else if (cost.frequency === 'one_time') {
    newNextDue = null;
    newActive = false;
  }

  const { data: updated, error: updateErr } = await db
    .from('admin_costs')
    .update({
      paid_history: newHistory,
      next_due_date: newNextDue,
      active: newActive,
      last_reminder_sent_at: null,
    })
    .eq('id', id)
    .select()
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ cost: updated as AdminCost });
}
