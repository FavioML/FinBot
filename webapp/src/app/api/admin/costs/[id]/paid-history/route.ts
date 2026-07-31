import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import type { AdminCost, AdminCostPaidEntry } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

const MAX_ENTRIES = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Valida y normaliza una entrada del historial. Devuelve null si es inválida. */
function normalizeEntry(raw: unknown): AdminCostPaidEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;

  const paidAt = typeof e.paid_at === 'string' ? e.paid_at.slice(0, 10) : '';
  if (!DATE_RE.test(paidAt) || Number.isNaN(new Date(paidAt + 'T00:00:00Z').getTime())) return null;

  const amount = Number(e.amount_pen);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const markedBy = typeof e.marked_by === 'string' && e.marked_by ? e.marked_by : 'admin';

  return { paid_at: paidAt, amount_pen: Math.round(amount * 100) / 100, marked_by: markedBy };
}

/**
 * Reemplaza el historial de pagos completo de un costo. El cliente manda el array ya editado
 * (corregir monto/fecha, borrar una entrada) y el servidor valida y persiste. Es la contraparte
 * necesaria del auto-débito, que registra asumiendo que la tarjeta cobró: si un cobro falla o se
 * marca un monto mal, esto permite corregir el paid_history para que el P&L/caja no mientan.
 *
 * Single admin → sin control de concurrencia: la única race sería el cron de auto-débito de las 9am
 * escribiendo el mismo array en el mismo instante (despreciable). NO toca next_due_date: la fecha
 * del próximo cobro se ajusta con "Editar costo", no se acopla a la corrección del historial.
 */
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

  if (!Array.isArray(body.paid_history)) {
    return NextResponse.json({ error: 'paid_history debe ser un array' }, { status: 400 });
  }
  if (body.paid_history.length > MAX_ENTRIES) {
    return NextResponse.json({ error: `máximo ${MAX_ENTRIES} entradas` }, { status: 400 });
  }

  const normalized: AdminCostPaidEntry[] = [];
  for (const raw of body.paid_history) {
    const entry = normalizeEntry(raw);
    if (!entry) {
      return NextResponse.json(
        { error: 'entrada inválida (paid_at YYYY-MM-DD, amount_pen ≥ 0)' },
        { status: 400 },
      );
    }
    normalized.push(entry);
  }

  const db = getServiceClient();
  const { data, error } = await db
    .from('admin_costs')
    .update({ paid_history: normalized })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ cost: data as AdminCost });
}
