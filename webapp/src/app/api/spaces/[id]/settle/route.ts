import { getServiceClient } from '@/lib/supabase/service';
import { getSpaceMemberIds, parseSpaceAmount, requireSpaceMember } from '@/lib/spaces-server';
import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireSpaceMember(id);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { to_user, amount } = body;
  const montoNum = parseSpaceAmount(amount);
  if (!to_user || montoNum === null) {
    return NextResponse.json({ error: 'to_user and amount required' }, { status: 400 });
  }

  // El destinatario tiene que ser miembro del espacio: sin este check se podia
  // registrar una liquidacion contra un user_id arbitrario, descuadrando el
  // ledger del grupo (el saldo salia del espacio hacia alguien que no esta).
  const memberIds = await getSpaceMemberIds(id);
  if (!memberIds.has(to_user)) {
    return NextResponse.json({ error: 'to_user no es miembro del espacio' }, { status: 400 });
  }
  if (to_user === auth.user.id) {
    return NextResponse.json({ error: 'No puedes saldar contigo mismo' }, { status: 400 });
  }

  const { data, error } = await getServiceClient()
    .from('space_settlements')
    .insert({
      space_id: id,
      from_user: auth.user.id,
      to_user,
      amount: montoNum,
      settled_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}
