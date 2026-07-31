import { requireNetoUser } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// POST /api/user/tour-visto — marca que el usuario ya vio el tour de onboarding del dashboard.
// Lo llama OnboardingTour al cerrarlo/terminarlo. Idempotente (setear true dos veces no hace
// daño). El gate del tour vive en la cuenta (usuarios.tour_visto) para que sea 1 vez POR
// USUARIO, no por navegador.
export async function POST() {
  const auth = await requireNetoUser('id');
  if (!auth.ok) return auth.response;
  const svc = getServiceClient();
  const { error } = await svc.from('usuarios').update({ tour_visto: true }).eq('id', auth.user.id);
  if (error) {
    return NextResponse.json({ error: 'No se pudo guardar el estado del tour' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
