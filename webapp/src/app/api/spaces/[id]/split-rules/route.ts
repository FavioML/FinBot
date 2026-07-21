import { getServiceClient } from '@/lib/supabase/service';
import {
  avisarBackendEspacio,
  getSpaceMemberIds,
  getSpaceOwnerIsPro,
  requireSpaceMember,
} from '@/lib/spaces-server';
import { sanitizeSplitRules } from '@/lib/spaces-split';
import { NextResponse } from 'next/server';

// PUT /api/spaces/[id]/split-rules — reglas de division por categoria (Pro).
//
// Cualquier miembro puede editarlas, igual que el reparto por defecto y por la
// misma razon: el reparto es un acuerdo entre las partes, no una configuracion de
// administrador. Lo que hace que sea seguro no es el permiso sino el aviso — ver
// `default-split/route.ts` y webapp/CLAUDE.md.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  // Reglas de división personalizadas son Pro (tier del owner del espacio).
  if (!(await getSpaceOwnerIsPro(id))) {
    return NextResponse.json({ error: 'Las reglas por categoría son una función Pro' }, { status: 403 });
  }

  const body = await request.json();
  const { rules } = body;
  if (!Array.isArray(rules)) return NextResponse.json({ error: 'rules must be an array' }, { status: 400 });

  // Rules apply retroactively to every past expense, so never persist them raw:
  // a weight keyed to a non-member would inflate the denominator (dropping the
  // author's own share toward 0 across the whole history) and an Infinity/NaN
  // weight would break the group's balance outright.
  const memberIds = await getSpaceMemberIds(id);
  const cleanRules = sanitizeSplitRules(rules, memberIds);

  // Las reglas de ANTES, leidas previo a escribir: son el "de X%" del aviso. Si se
  // leyeran despues, el mensaje diria que nadie cambio.
  const { data: previo } = await getServiceClient()
    .from('shared_spaces')
    .select('split_rules')
    .eq('id', id)
    .single();

  const { error } = await getServiceClient()
    .from('shared_spaces')
    .update({ split_rules: cleanRules })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Cambiar una regla mueve lo que paga cada uno en los gastos FUTUROS de esa
  // categoria. Mismo compromiso que el reparto por defecto: no pasa en silencio.
  await avisarBackendEspacio('espacio-reglas-cambiadas', {
    space_id: id,
    actor_id: auth.user.id,
    antes: previo?.split_rules ?? [],
  });

  return NextResponse.json({ ok: true });
}
