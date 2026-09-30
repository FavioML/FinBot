import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import { EXCLUDED_REVENUE_WHATSAPP } from '@/lib/admin-revenue';
import type { AdminRenovacion, AdminRenovacionesResponse } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

/** "Vence pronto" = los próximos 14 días; "venció sin renovar" = los últimos 90. */
const DIAS = 14;
const DIAS_VENCIDO = 90;
const TECHO_POSTGREST = 1000;

type Fila = Omit<AdminRenovacion, 'ultimo_monto' | 'dias' | 'n_pagos'> & {
  ultimo_monto: number | string;
  dias: number | string;
  n_pagos: number | string;
};

/**
 * GET /api/admin/payments/renewals → bloque de Renovaciones de /admin/pagos (RPC 089).
 *
 * Si la RPC falla, 500: una lista vacía por caída se lee igual que "nadie tiene que renovar", y
 * esa es justo la pregunta que el bloque responde.
 */
export async function GET() {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const { data, error } = await getServiceClient().rpc('admin_renovaciones', {
    p_excluded: Array.from(EXCLUDED_REVENUE_WHATSAPP),
    p_dias: DIAS,
    p_dias_vencido: DIAS_VENCIDO,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if ((data || []).length >= TECHO_POSTGREST) {
    return NextResponse.json(
      { error: 'La lista de renovaciones vino truncada por el techo de 1000 filas.' },
      { status: 500 },
    );
  }

  // NUMERIC llega como string desde PostgREST.
  const renovaciones: AdminRenovacion[] = (data || []).map((r: Fila) => ({
    ...r,
    dias: Number(r.dias),
    n_pagos: Number(r.n_pagos),
    ultimo_monto: Number(r.ultimo_monto),
  }));

  return NextResponse.json({
    renovaciones,
    dias: DIAS,
    dias_vencido: DIAS_VENCIDO,
  } satisfies AdminRenovacionesResponse);
}
