import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { generarCodigoInvitacion, ALFABETO_ESPACIO } from '@/lib/codigos-seguros';
import { hasReachedLimit } from '@/lib/plan';

export async function GET() {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  const { data: memberships } = await getServiceClient()
    .from('space_members')
    .select('space_id, role, shared_spaces(id, name, type, invite_code, created_at)')
    .eq('user_id', usuario.id);

  return NextResponse.json({
    spaces: (memberships || []).map((m: Record<string, unknown>) => ({ ...(m.shared_spaces as object), role: m.role })),
    isPro: usuario.plan === 'premium',
  });
}

export async function POST(request: Request) {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  const body = await request.json();
  const { name, type = 'custom' } = body;
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  // El tope sale de `FREE_LIMITS`, espejo de `PLAN_CONFIG` del backend, no de un número
  // escrito acá: el `>= 1` a mano era M14 — la webapp concedía un espacio que WhatsApp
  // nunca dio. Ser invitado a otros no cuenta; esto mira solo lo que uno CREA.
  {
    const { count } = await getServiceClient()
      .from('shared_spaces')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', usuario.id);
    if (hasReachedLimit(usuario.plan as string | undefined, 'spaces', count || 0)) {
      return NextResponse.json(
        { error: 'Crear espacios compartidos es parte de Neto Pro.' },
        { status: 403 }
      );
    }
  }

  // Fuente criptográfica: el invite_code ES la credencial para entrar al espacio de otro.
  // Antes salía de `Math.random().toString(36).slice(2,9)`, que además podía devolver menos
  // de 7 chars cuando el float caía corto. Mismo alfabeto que el otro generador de espacios.
  const invite_code = generarCodigoInvitacion(ALFABETO_ESPACIO, 8);

  const { data: space, error } = await getServiceClient()
    .from('shared_spaces')
    .insert({ name, type, invite_code, created_by: usuario.id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await getServiceClient().from('space_members').insert({
    space_id: space.id,
    user_id: usuario.id,
    role: 'owner',
    split_percentage: 50,
  });

  return NextResponse.json(space, { status: 201 });
}
