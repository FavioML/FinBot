import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getNetoUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await serviceClient
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data?.id || null;
}

// POST /api/split/invite — generate invite link for a participant
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { gasto_id, participante_id } = body;

  if (!gasto_id || !participante_id)
    return NextResponse.json({ error: 'gasto_id and participante_id required' }, { status: 400 });

  // Verify ownership of the expense
  const { data: gasto } = await serviceClient
    .from('gastos_compartidos')
    .select('id')
    .eq('id', gasto_id)
    .eq('creador_id', userId)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Verify participant belongs to this expense
  const { data: participante } = await serviceClient
    .from('gasto_participantes')
    .select('id, invite_code')
    .eq('id', participante_id)
    .eq('gasto_id', gasto_id)
    .single();

  if (!participante)
    return NextResponse.json({ error: 'Participant not found' }, { status: 404 });

  // Return existing code if already generated (idempotent)
  let inviteCode = participante.invite_code;
  if (!inviteCode) {
    inviteCode = crypto.randomBytes(4).toString('hex');
    await serviceClient
      .from('gasto_participantes')
      .update({ invite_code: inviteCode })
      .eq('id', participante_id);
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.neto.pe';
  const link = `${baseUrl}/join/gasto/${inviteCode}`;

  return NextResponse.json({ invite_code: inviteCode, link });
}

// GET /api/split/invite?code=xxx — public preview (no auth required)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code)
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });

  const { data: participante } = await serviceClient
    .from('gasto_participantes')
    .select('id, nombre, monto_debe, monto_pagado, pagado, gasto_id, usuario_id')
    .eq('invite_code', code)
    .single();

  if (!participante)
    return NextResponse.json({ error: 'Invitacion invalida o expirada' }, { status: 404 });

  const { data: gasto } = await serviceClient
    .from('gastos_compartidos')
    .select('id, descripcion, monto_total, moneda, fecha_limite, creador_id')
    .eq('id', participante.gasto_id)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 });

  const { data: creador } = await serviceClient
    .from('usuarios')
    .select('nombre')
    .eq('id', gasto.creador_id)
    .single();

  return NextResponse.json({
    creador: creador?.nombre || 'Alguien',
    descripcion: gasto.descripcion,
    monto_total: gasto.monto_total,
    moneda: gasto.moneda,
    fecha_limite: gasto.fecha_limite,
    participante_nombre: participante.nombre,
    monto_debe: participante.monto_debe,
    monto_pagado: participante.monto_pagado,
    pagado: participante.pagado,
    ya_confirmada: !!participante.usuario_id,
  });
}
