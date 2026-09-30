import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import { EXCLUDED_REVENUE_WHATSAPP } from '@/lib/admin-revenue';
import { TIPOS_AVISO, adjuntarEntregas, inicioVentanaEntregas } from '@/lib/admin-avisos-renovacion';
import type { AdminAvisoEntrega, AdminRenovacion, AdminRenovacionesResponse } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

/** "Vence pronto" = los próximos 14 días; "venció sin renovar" = los últimos 90. */
const DIAS = 14;
const DIAS_VENCIDO = 90;
const TECHO_POSTGREST = 1000;

type Fila = Omit<AdminRenovacion, 'ultimo_monto' | 'dias' | 'n_pagos' | 'recordatorios_activos' | 'entregas'> & {
  ultimo_monto: number | string;
  dias: number | string;
  n_pagos: number | string;
};
type FilaEntrega = AdminAvisoEntrega & { usuario_id: string };

/**
 * GET /api/admin/payments/renewals → bloque de Renovaciones de /admin/pagos.
 *
 * Quién entra lo decide la RPC 089. Encima se leen las entregas de los avisos de vencimiento de
 * cada persona (`notification_deliveries`, que escribe `cron/checks.js`) para mostrar si le
 * llegaron. La premisa con que nació la 089 —"los avisos no llegan, así que Favio escribe a
 * mano"— dejó de valer el 30-sep-2026, cuando esos avisos empezaron a salir también por correo
 * (`6bedcb8`); el bloque pasó de lista de contactos a monitor.
 *
 * Cualquier error es 500: una lista vacía por caída se lee igual que "nadie tiene que renovar", y
 * unas entregas vacías, igual que "ningún aviso salió".
 */
export async function GET() {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const svc = getServiceClient();
  const { data, error } = await svc.rpc('admin_renovaciones', {
    p_excluded: Array.from(EXCLUDED_REVENUE_WHATSAPP),
    p_dias: DIAS,
    p_dias_vencido: DIAS_VENCIDO,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const filas: Fila[] = data || [];
  if (filas.length >= TECHO_POSTGREST) {
    return NextResponse.json(
      { error: 'La lista de renovaciones vino truncada por el techo de 1000 filas.' },
      { status: 500 },
    );
  }

  let entregas: FilaEntrega[] = [];
  const recordatorios = new Map<string, boolean>();
  if (filas.length > 0) {
    const ids = filas.map((r) => r.usuario_id);
    // Una sola lectura desde el vencimiento más viejo; abajo cada persona se queda con su ventana.
    const desde = filas.map((r) => inicioVentanaEntregas(r.premium_vence)).sort()[0];
    const [ent, usu] = await Promise.all([
      svc
        .from('notification_deliveries')
        .select('usuario_id, tipo, canal, estado, created_at, delivered_at, failed_at, read_at, fail_code, error')
        .in('usuario_id', ids)
        .in('tipo', [...TIPOS_AVISO])
        .in('canal', ['whatsapp', 'email'])
        .gte('created_at', desde)
        .order('created_at', { ascending: true })
        .limit(TECHO_POSTGREST),
      svc
        // admin-revenue:no-alimenta-metricas — solo lee si la persona apagó los recordatorios
        // (decide si se espera el correo del aviso), con la misma regla que el cron: solo `false` apaga. Quién entra y con qué plan lo dijo la RPC.
        .from('usuarios')
        .select('id, recordatorios_activos')
        .in('id', ids),
    ]);
    if (ent.error || usu.error) {
      return NextResponse.json({ error: (ent.error || usu.error)!.message }, { status: 500 });
    }
    if ((ent.data || []).length >= TECHO_POSTGREST) {
      return NextResponse.json(
        { error: 'Las entregas de los avisos vinieron truncadas por el techo de 1000 filas.' },
        { status: 500 },
      );
    }
    entregas = (ent.data || []) as FilaEntrega[];
    for (const u of usu.data || []) recordatorios.set(u.id, u.recordatorios_activos !== false);
  }

  // NUMERIC llega como string desde PostgREST.
  const renovaciones: AdminRenovacion[] = adjuntarEntregas(
    filas.map((r) => ({ ...r, dias: Number(r.dias), n_pagos: Number(r.n_pagos), ultimo_monto: Number(r.ultimo_monto) })),
    entregas,
    recordatorios,
  );

  return NextResponse.json({
    renovaciones,
    dias: DIAS,
    dias_vencido: DIAS_VENCIDO,
    ahora: new Date().toISOString(),
  } satisfies AdminRenovacionesResponse);
}
