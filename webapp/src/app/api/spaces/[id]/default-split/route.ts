import { getServiceClient } from '@/lib/supabase/service';
import { avisarBackendEspacio, getSpaceMemberIds, requireSpaceMember } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

// PUT /api/spaces/[id]/default-split — updates each member's split_percentage.
// This is the default (per-member) division applied to categories without a
// custom rule. It is a Free-tier feature (basic 50/50 and adjustments).
//
// CUALQUIER miembro puede editarlo, no solo el owner, y es deliberado: el reparto
// es un acuerdo entre las partes, no una configuracion de administrador. En un
// espacio de pareja, gatearlo al que creo el espacio dejaria al otro sin poder
// ajustar su propio porcentaje. Lo que hace que sea seguro no es el permiso sino
// el aviso: owner-only no cerraria el hueco, solo elegiria quien puede abrirlo en
// silencio. La linea del modulo es esa: quien ESTA en el espacio es del owner
// (members DELETE), como se REPARTE es de cualquier miembro.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { splits } = body;
  if (!splits || typeof splits !== 'object' || Array.isArray(splits)) {
    return NextResponse.json({ error: 'splits object required' }, { status: 400 });
  }

  // Only touch members that actually belong to this space.
  const memberIds = await getSpaceMemberIds(id);

  const entries = Object.entries(splits as Record<string, unknown>).filter(([uid]) => memberIds.has(uid));
  if (entries.length === 0) {
    return NextResponse.json({ error: 'No valid members in splits' }, { status: 400 });
  }

  // Los pesos de ANTES, leidos previo a escribir: son el "de X%" del aviso. Si se
  // leyeran despues, el mensaje diria que nadie cambio.
  const { data: antes } = await getServiceClient()
    .from('space_members')
    .select('user_id, split_percentage')
    .eq('space_id', id);

  for (const [uid, raw] of entries) {
    // 2 decimales, no enteros: la UI prefilla con el porcentaje EFECTIVO (46.7,
    // 33.3), asi que redondear a entero hacia que abrir el dialogo y guardar sin
    // tocar nada corriera el reparto un poco cada vez. NUMERIC(5,2) los aguanta.
    const pct = Math.max(0, Math.min(100, Math.round((Number(raw) || 0) * 100) / 100));
    const { error } = await getServiceClient()
      .from('space_members')
      .update({ split_percentage: pct })
      .eq('space_id', id)
      .eq('user_id', uid);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await avisarBackendEspacio('espacio-reparto-cambiado', {
    space_id: id,
    actor_id: auth.user.id,
    antes: antes || [],
  });

  return NextResponse.json({ ok: true });
}
