import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import { EXCLUDED_REVENUE_WHATSAPP } from '@/lib/admin-revenue';
import { resolverMes, primerDiaDelMes } from '@/lib/admin-pagos';
import type { AdminPagoFila, AdminPagosMes, AdminPagosResponse } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

/** Techo de PostgREST: una respuesta de este largo puede venir cortada sin ningún error. */
const TECHO_POSTGREST = 1000;

type Num = number | string | null;

/**
 * GET /api/admin/payments/history?mes=YYYY-MM → pagos recibidos (/admin/pagos).
 *
 * `meses` es el resumen de toda la historia y `pagos` el detalle del mes pedido. Los dos salen de
 * RPC (migración 088) que copian la definición de caja de `admin_pnl_monthly`, así que el total
 * de cada mes es el mismo número que "Ingresos" en Costos. La exclusión de cuentas internas usa
 * la misma lista que el P&L.
 *
 * Si cualquiera de las dos lecturas falla, 500. Una lista vacía por caída se lee igual que "este
 * mes nadie pagó", que es justo la pregunta que esta pantalla existe para responder.
 */
export async function GET(request: Request) {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const mes = resolverMes(new URL(request.url).searchParams.get('mes'));
  if (!mes) {
    return NextResponse.json({ error: 'Parámetro mes inválido: usa YYYY-MM' }, { status: 400 });
  }

  const db = getServiceClient();
  const excluded = Array.from(EXCLUDED_REVENUE_WHATSAPP);
  const [resumen, detalle] = await Promise.all([
    db.rpc('admin_pagos_resumen_mensual', { p_excluded: excluded }),
    db.rpc('admin_pagos_del_mes', { p_mes: primerDiaDelMes(mes), p_excluded: excluded }),
  ]);

  if (resumen.error || detalle.error) {
    return NextResponse.json(
      { error: resumen.error?.message || detalle.error?.message || 'No se pudieron leer los pagos' },
      { status: 500 },
    );
  }
  if ((detalle.data || []).length >= TECHO_POSTGREST || (resumen.data || []).length >= TECHO_POSTGREST) {
    return NextResponse.json(
      { error: 'La lista de pagos vino truncada por el techo de 1000 filas. Hay que paginar.' },
      { status: 500 },
    );
  }

  // NUMERIC llega como string desde PostgREST.
  const meses: AdminPagosMes[] = (resumen.data || []).map(
    (r: Record<keyof AdminPagosMes, Num>) => ({
      mes: String(r.mes),
      total_pen: Number(r.total_pen),
      n_pagos: Number(r.n_pagos),
      n_primer_pago: Number(r.n_primer_pago),
      n_renovacion: Number(r.n_renovacion),
      n_mensual: Number(r.n_mensual),
      n_anual: Number(r.n_anual),
      total_mensual: Number(r.total_mensual),
      total_anual: Number(r.total_anual),
      n_cortesia: Number(r.n_cortesia),
      n_pendiente: Number(r.n_pendiente),
      n_rechazado: Number(r.n_rechazado),
    }),
  );

  const pagos: AdminPagoFila[] = (detalle.data || []).map(
    (r: Omit<AdminPagoFila, 'monto'> & { monto: Num }) => ({
      ...r,
      monto: r.monto == null ? null : Number(r.monto),
    }),
  );

  return NextResponse.json({ meses, mes, pagos } satisfies AdminPagosResponse);
}
