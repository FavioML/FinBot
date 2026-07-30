import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import { EXCLUDED_REVENUE_WHATSAPP } from '@/lib/admin-revenue';
import type { AdminPnlMonth, AdminPnlResponse } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

const PNL_MONTHS = 6;

/**
 * P&L mensual base caja para el panel admin (Rework Costos). Delega toda la agregación al RPC
 * admin_pnl_monthly (migración 044): ingreso = pagos aprobados por mes Lima (excluye cuentas
 * internas, misma definición de caja que economics), costo = paid_history por mes Lima. Se agrega
 * en SQL para no truncar cuando `pagos` pase las 1000 filas de PostgREST.
 */
export async function GET() {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const db = getServiceClient();
  const { data, error } = await db.rpc('admin_pnl_monthly', {
    p_months: PNL_MONTHS,
    p_excluded: Array.from(EXCLUDED_REVENUE_WHATSAPP),
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const months: AdminPnlMonth[] = (data || []).map(
    (r: { month: string; income_pen: number | string; cost_pen: number | string; result_pen: number | string }) => ({
      month: r.month,
      income_pen: Number(r.income_pen),
      cost_pen: Number(r.cost_pen),
      result_pen: Number(r.result_pen),
    }),
  );

  return NextResponse.json({ months } satisfies AdminPnlResponse);
}
