import { getServiceClient } from '@/lib/supabase/service';
import { avisarBackendEspacio } from '@/lib/spaces-server';
import { requireNetoUser } from '@/lib/supabase/auth';
import { joinSplitWeight } from '@/lib/spaces-split';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  const body = await request.json();
  const { code } = body;
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });

  const { data: space } = await getServiceClient()
    .from('shared_spaces')
    .select('id, name, type')
    .eq('invite_code', code.toUpperCase())
    .single();
  if (!space) return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 });

  const { data: existing } = await getServiceClient()
    .from('space_members')
    .select('id')
    .eq('space_id', space.id)
    .eq('user_id', usuario.id)
    .single();
  if (existing) return NextResponse.json({ space_id: space.id, already_member: true });

  // Check member limit
  const limits: Record<string, number> = { pareja: 2, roommates: 6, custom: 6 };
  const maxMembers = limits[space.type] || 6;
  const { data: previos } = await getServiceClient()
    .from('space_members')
    .select('user_id, split_percentage')
    .eq('space_id', space.id);
  const miembrosPrevios = previos || [];
  if (miembrosPrevios.length >= maxMembers) {
    return NextResponse.json({ error: `Este espacio ya tiene el máximo de ${maxMembers} miembros` }, { status: 400 });
  }

  // Mismo peso de entrada que el camino de WhatsApp (`services/shared-spaces.js`).
  // Antes esta ruta metia un 50 fijo sin mirar al resto: sobre un 70/30 acordado
  // quedaba 70/30/50, o sea 46.7/20/33.3 al normalizar, mientras el otro camino
  // reescribia todo a partes iguales. El mismo espacio dividia distinto segun la
  // puerta por la que se hubiera entrado.
  const { error } = await getServiceClient().from('space_members').insert({
    space_id: space.id,
    user_id: usuario.id,
    role: 'member',
    split_percentage: joinSplitWeight(miembrosPrevios),
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await avisarBackendEspacio('espacio-nuevo-miembro', { space_id: space.id, user_id: usuario.id });
  return NextResponse.json({ space_id: space.id, name: space.name }, { status: 201 });
}
