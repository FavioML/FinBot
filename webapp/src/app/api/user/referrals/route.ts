import { requireNetoUser } from '@/lib/supabase/auth';
import { generarCodigoInvitacion, ALFABETO_REF } from '@/lib/codigos-seguros';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Mismo formato Y misma fuente que `generarRefCode` del backend (`lib/formatters.js`): 6
// chars del alfabeto en mayúsculas, desde `crypto.getRandomValues`. `Math.random()
// .toString(36).substring(2, 8)` devolvía menos de 6 chars cuando el float caía corto.
function generarRefCode(): string {
  return generarCodigoInvitacion(ALFABETO_REF, 6);
}

// GET /api/user/referrals — link REAL de referido (ref_code) + progreso dos-lados:
//   invitados     = entraron con el link pero aún no son Pro
//   referidosPro  = convirtieron a Pro pagado
//   meses         = meses ganados (1 conversión = 1 mes)
export async function GET() {
  const auth = await requireNetoUser('id, ref_code');
  if (!auth.ok) return auth.response;
  const svc = getServiceClient();
  const userId = auth.user.id as string;

  // Asegurar ref_code (se genera perezosamente, igual que el backend en /referir). El guard
  // .is('ref_code', null) evita que dos requests del mismo usuario pisen códigos distintos.
  let refCode = (auth.user.ref_code as string | null) || null;
  if (!refCode) {
    const nuevo = generarRefCode();
    const { data: upd } = await svc.from('usuarios').update({ ref_code: nuevo }).eq('id', userId).is('ref_code', null).select('ref_code').maybeSingle();
    if (upd?.ref_code) {
      refCode = upd.ref_code as string;
    } else {
      const { data: re } = await svc.from('usuarios').select('ref_code').eq('id', userId).maybeSingle();
      refCode = (re?.ref_code as string) || nuevo;
    }
  }

  const { data: refs, error } = await svc.from('referidos').select('convertido_pro').eq('referrer_id', userId);
  if (error) {
    return NextResponse.json({ error: 'No se pudo leer tus referidos' }, { status: 500 });
  }
  const total = (refs || []).length;
  const referidosPro = (refs || []).filter((r) => r.convertido_pro).length;

  return NextResponse.json({
    refCode,
    link: `https://neto.pe/r/${refCode}`,
    invitados: total - referidosPro,
    referidosPro,
    meses: referidosPro,
  });
}
