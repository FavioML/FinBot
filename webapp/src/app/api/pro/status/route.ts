import { getNetoUser } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// GET /api/pro/status — estado del plan + última solicitud (para el polling de /dashboard/pro)
export async function GET() {
  const user = await getNetoUser('id, plan, pago_pendiente, premium_vence, tipo_plan, bancos_seleccionados, gmail_access_token');
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const svc = getServiceClient();
  const userId = user.id as string;

  const { data: pago } = await svc
    .from('pagos')
    .select('estado, tipo_plan, created_at')
    .eq('usuario_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Gmail conectado: la fuente real es gmail_cuentas (multi-cuenta). El campo
  // usuarios.gmail_access_token es legacy y puede estar vacío aunque haya cuenta activa.
  const { data: cuentaGmail } = await svc
    .from('gmail_cuentas')
    .select('email')
    .eq('usuario_id', userId)
    .eq('activa', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const gmailConectado = !!cuentaGmail || !!user.gmail_access_token;
  const gmailEmail = (cuentaGmail?.email as string) || null;

  return NextResponse.json({
    plan: (user.plan as string) || 'free',
    isPremium: user.plan === 'premium',
    pagoPendiente: !!user.pago_pendiente,
    premiumVence: (user.premium_vence as string) || null,
    bancosSeleccionados: (user.bancos_seleccionados as string[] | null) ?? null,
    gmailConectado,
    gmailEmail,
    ultimoPago: pago ? { estado: pago.estado, tipoPlan: pago.tipo_plan } : null,
  });
}
