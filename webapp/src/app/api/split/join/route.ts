import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

async function getNetoUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data?.id || null;
}

// POST /api/split/join — confirm participation in a shared expense
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { code } = body;

  if (!code)
    return NextResponse.json({ error: 'code required' }, { status: 400 });

  // Find participant by invite code
  const { data: participante } = await getServiceClient()
    .from('gasto_participantes')
    .select('id, nombre, monto_debe, monto_pagado, gasto_id, usuario_id')
    .eq('invite_code', code)
    .single();

  if (!participante)
    return NextResponse.json({ error: 'Invitacion invalida o expirada' }, { status: 404 });

  // Get the expense
  const { data: gasto } = await getServiceClient()
    .from('gastos_compartidos')
    .select('id, creador_id, descripcion, moneda')
    .eq('id', participante.gasto_id)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 });

  // Cannot confirm your own expense
  if (gasto.creador_id === userId)
    return NextResponse.json({ error: 'No puedes confirmar tu propio gasto' }, { status: 400 });

  // Check if already confirmed
  if (participante.usuario_id)
    return NextResponse.json({ error: 'Ya confirmaste esta participacion' }, { status: 409 });

  // Get creator name for contraparte
  const { data: creador } = await getServiceClient()
    .from('usuarios')
    .select('nombre')
    .eq('id', gasto.creador_id)
    .single();

  const montoPendiente = parseFloat(String(participante.monto_debe)) - parseFloat(String(participante.monto_pagado || 0));

  // Create a "debo" debt for the participant
  const { data: nuevaDeuda, error: debtError } = await getServiceClient()
    .from('deudas')
    .insert({
      usuario_id: userId,
      tipo: 'debo',
      contraparte: creador?.nombre || 'Alguien',
      monto_original: participante.monto_debe,
      monto_pendiente: montoPendiente,
      moneda: gasto.moneda,
      descripcion: gasto.descripcion,
      estado: montoPendiente <= 0 ? 'pagada' : 'activa',
    })
    .select()
    .single();

  if (debtError)
    return NextResponse.json({ error: debtError.message }, { status: 400 });

  // Link the participant to this user
  await getServiceClient()
    .from('gasto_participantes')
    .update({ usuario_id: userId })
    .eq('id', participante.id);

  // Notify the expense creator
  try {
    const { data: joiner } = await getServiceClient().from('usuarios').select('nombre').eq('id', userId).single();
    await getServiceClient().from('notificaciones').insert({
      usuario_id: gasto.creador_id,
      tipo: 'sistema',
      titulo: 'Gasto compartido confirmado',
      mensaje: (joiner?.nombre || 'Alguien') + ' confirmo su parte de ' + (gasto.moneda === 'USD' ? '$' : 'S/') + ' ' + parseFloat(String(participante.monto_debe)).toFixed(2) + ' en "' + gasto.descripcion + '"',
      datos: { link: '/dashboard/deudas' },
      leida: false,
      fecha: new Date().toISOString(),
    });
  } catch (e) { console.error('[split-join-notify]', e); }

  return NextResponse.json(nuevaDeuda);
}
