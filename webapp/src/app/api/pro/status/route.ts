import { requireNetoUser } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { esProPagado } from '@/lib/plan';
import { indexarGmail } from '@/lib/gmail-conectado';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// GET /api/pro/status — estado del plan + última solicitud (para el polling de /dashboard/pro)
export async function GET() {
  const auth = await requireNetoUser('id, plan, trial_estado, trial_vence, pago_pendiente, premium_vence, tipo_plan, bancos_seleccionados, gmail_access_token, referido_dscto_pct, referido_dscto_vence');
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
    .select('email, auth_error_at')
    .eq('usuario_id', userId)
    .eq('activa', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // La unión sale de `indexarGmail`, no se rehace acá. Era la TERCERA reimplementación de la
  // misma pregunta (el panel admin, el Neto Score y esta), y las otras dos estaban mal: leían
  // solo el almacén legacy. Escribirla a mano es cómo empezó esa divergencia.
  const gmail = indexarGmail(
    [{ id: userId, gmail_access_token: user.gmail_access_token as string | null }],
    cuentaGmail ? [{ usuario_id: userId, activa: true, auth_error_at: cuentaGmail.auth_error_at as string | null }] : [],
  );
  const gmailConectado = gmail.conectados.has(userId);
  const gmailEmail = (cuentaGmail?.email as string) || null;

  // Conectado y CAÍDO es un estado propio, no una variante de desconectado: la fila sigue en
  // activa=true (el cupo de Google está tomado y el correo vinculado manda el login_hint),
  // pero Google dejó de aceptar el refresh token. Sin esto la tarjeta de /dashboard/pro decía
  // "Gmail conectado" mientras no leía un solo correo, y por eso el enlace de reconexión tenía
  // que estar siempre visible contradiciéndola.
  //
  // El fallback legacy (`user.gmail_access_token` sin fila) no puede necesitar reconexión: de
  // esos tokens no sabemos nada, y afirmar que están rotos sería inventar.
  const gmailAuthErrorAt = (cuentaGmail?.auth_error_at as string | null) ?? null;
  const gmailNecesitaReconexion = !!gmailAuthErrorAt;

  // Descuento de referido (50% off primer mes). Se calcula server-side en fecha Lima para
  // no depender de la zona del navegador.
  //
  // Lo que descalifica es ser Pro **pagado**, no `plan === 'premium'`: durante el trial esa
  // columna vale 'premium', así que cortar por ella escondía el descuento justo durante los
  // 14 días en que el usuario lo tiene. Y no es un detalle de borde — la ventana del 50% se
  // ancla al FIN del trial a propósito (`anclarDescuentoAFinDeTrial`), o sea que el único
  // momento en que existe es el que quedaba tapado. Mismo criterio que
  // `esProPagado` en services/referrals.js.
  const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const dPct = (user.referido_dscto_pct as number | null) || null;
  const dVence = user.referido_dscto_vence ? String(user.referido_dscto_vence).slice(0, 10) : null;
  const descuentoActivo = !!dPct && !!dVence && dVence >= hoyLima
    && !esProPagado(user.plan as string | undefined, user.trial_estado as string | null);
  let descuento = null as null | { pct: number; vence: string; diasRestantes: number };
  if (descuentoActivo && dPct && dVence) {
    const ms = new Date(dVence + 'T12:00:00-05:00').getTime() - new Date(hoyLima + 'T12:00:00-05:00').getTime();
    descuento = { pct: dPct, vence: dVence, diasRestantes: Math.max(0, Math.round(ms / 86400000)) };
  }

  return NextResponse.json({
    plan: (user.plan as string) || 'free',
    // `isPremium` responde "¿tiene Pro ahora?", que durante el trial también es true.
    // Quien necesite saber si PAGA tiene que cruzarlo con `trialEstado` (helpers en
    // `@/lib/plan`): colapsar las dos preguntas es lo que hacía que /dashboard/pro le
    // dijera "Eres Neto Pro ⭐" a quien estaba probando, escondiéndole el precio.
    isPremium: user.plan === 'premium',
    trialEstado: (user.trial_estado as string | null) ?? null,
    trialVence: (user.trial_vence as string | null) ?? null,
    pagoPendiente: !!user.pago_pendiente,
    premiumVence: (user.premium_vence as string) || null,
    bancosSeleccionados: (user.bancos_seleccionados as string[] | null) ?? null,
    gmailConectado,
    gmailEmail,
    gmailNecesitaReconexion,
    gmailAuthErrorAt,
    ultimoPago: pago ? { estado: pago.estado, tipoPlan: pago.tipo_plan } : null,
    descuento,
  });
}
