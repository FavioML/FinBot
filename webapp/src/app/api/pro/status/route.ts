import { requireNetoUser } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// GET /api/pro/status — estado del plan + última solicitud (para el polling de /dashboard/pro)
export async function GET() {
  const auth = await requireNetoUser('id, plan, pago_pendiente, premium_vence, tipo_plan, bancos_seleccionados, gmail_access_token, referido_dscto_pct, referido_dscto_vence');
  if (!auth.ok) return auth.response;
  const user = auth.user;

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

  // Descuento de referido (50% off primer mes). Se calcula server-side en fecha Lima para
  // no depender de la zona del navegador. Solo aplica si NO es premium y no venció.
  const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const dPct = (user.referido_dscto_pct as number | null) || null;
  const dVence = user.referido_dscto_vence ? String(user.referido_dscto_vence).slice(0, 10) : null;
  const descuentoActivo = !!dPct && !!dVence && dVence >= hoyLima && user.plan !== 'premium';
  let descuento = null as null | { pct: number; vence: string; diasRestantes: number };
  if (descuentoActivo && dPct && dVence) {
    const ms = new Date(dVence + 'T12:00:00-05:00').getTime() - new Date(hoyLima + 'T12:00:00-05:00').getTime();
    descuento = { pct: dPct, vence: dVence, diasRestantes: Math.max(0, Math.round(ms / 86400000)) };
  }

  return NextResponse.json({
    plan: (user.plan as string) || 'free',
    isPremium: user.plan === 'premium',
    pagoPendiente: !!user.pago_pendiente,
    premiumVence: (user.premium_vence as string) || null,
    bancosSeleccionados: (user.bancos_seleccionados as string[] | null) ?? null,
    gmailConectado,
    gmailEmail,
    ultimoPago: pago ? { estado: pago.estado, tipoPlan: pago.tipo_plan } : null,
    descuento,
  });
}
