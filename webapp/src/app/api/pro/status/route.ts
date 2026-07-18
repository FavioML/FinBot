import { getNetoUser } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// GET /api/pro/status — estado del plan + última solicitud (para el polling de /dashboard/pro)
export async function GET() {
  const user = await getNetoUser('id, plan, pago_pendiente, premium_vence, tipo_plan');
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { data: pago } = await getServiceClient()
    .from('pagos')
    .select('estado, tipo_plan, created_at')
    .eq('usuario_id', user.id as string)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    plan: (user.plan as string) || 'free',
    isPremium: user.plan === 'premium',
    pagoPendiente: !!user.pago_pendiente,
    premiumVence: (user.premium_vence as string) || null,
    ultimoPago: pago ? { estado: pago.estado, tipoPlan: pago.tipo_plan } : null,
  });
}
