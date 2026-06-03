import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { hoyPeru } from '@/lib/dates';

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

// GET /api/split — list shared expenses
export async function GET() {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { data, error } = await getServiceClient()
    .from('gastos_compartidos')
    .select('*, gasto_participantes(*, gasto_participante_abonos(*))')
    .eq('creador_id', userId)
    .order('created_at', { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data || []);
}

// POST /api/split — create a shared expense
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();
  const { descripcion, monto_total, moneda = 'PEN', categoria, fecha_limite, notas, participantes } = body;

  const montoTotalNum = parseFloat(monto_total);
  if (!descripcion || !monto_total || !participantes || participantes.length === 0) {
    return NextResponse.json({ error: 'descripcion, monto_total, and participantes required' }, { status: 400 });
  }
  if (isNaN(montoTotalNum) || !isFinite(montoTotalNum) || montoTotalNum <= 0 || montoTotalNum > 999999.99) {
    return NextResponse.json({ error: 'Monto total inválido' }, { status: 400 });
  }

  // Create shared expense
  const { data: gasto, error: gastoError } = await getServiceClient()
    .from('gastos_compartidos')
    .insert({
      creador_id: userId,
      descripcion,
      monto_total: montoTotalNum,
      moneda,
      fecha: hoyPeru(),
      categoria: categoria || null,
      fecha_limite: fecha_limite || null,
      notas: notas || null,
    })
    .select()
    .single();

  if (gastoError)
    return NextResponse.json({ error: gastoError.message }, { status: 400 });

  // Insert participants
  const participantRows = participantes.map((p: { nombre: string; monto_debe: number; usuario_id?: string }) => ({
    gasto_id: gasto.id,
    nombre: p.nombre,
    usuario_id: p.usuario_id || null,
    monto_debe: parseFloat(String(p.monto_debe)),
    pagado: false,
  }));

  const { error: partError } = await getServiceClient()
    .from('gasto_participantes')
    .insert(participantRows);

  if (partError)
    return NextResponse.json({ error: partError.message }, { status: 400 });

  // Re-fetch with participants
  const { data: full } = await getServiceClient()
    .from('gastos_compartidos')
    .select('*, gasto_participantes(*, gasto_participante_abonos(*))')
    .eq('id', gasto.id)
    .single();

  return NextResponse.json(full);
}

// PATCH /api/split — edit shared expense details (description, fecha_limite, participant names)
export async function PATCH(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();
  const { id, descripcion, fecha_limite, notas, participantes } = body;
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // Verify ownership
  const { data: gasto } = await getServiceClient()
    .from('gastos_compartidos')
    .select('id')
    .eq('id', id)
    .eq('creador_id', userId)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Update expense fields
  const updateFields: Record<string, unknown> = {};
  if (descripcion !== undefined) updateFields.descripcion = descripcion;
  if (fecha_limite !== undefined) updateFields.fecha_limite = fecha_limite || null;
  if (notas !== undefined) updateFields.notas = notas || null;

  if (Object.keys(updateFields).length > 0) {
    await getServiceClient()
      .from('gastos_compartidos')
      .update(updateFields)
      .eq('id', id);
  }

  // Update participant names if provided
  if (participantes && Array.isArray(participantes)) {
    for (const p of participantes) {
      if (p.id && p.nombre) {
        await getServiceClient()
          .from('gasto_participantes')
          .update({ nombre: p.nombre })
          .eq('id', p.id)
          .eq('gasto_id', id);
      }
    }
  }

  // Return updated expense with participants
  const { data: updated } = await getServiceClient()
    .from('gastos_compartidos')
    .select('*, gasto_participantes(*, gasto_participante_abonos(*))')
    .eq('id', id)
    .single();

  return NextResponse.json(updated);
}

// PUT /api/split — mark participant as paid or update expense
export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();
  const { gasto_id, participante_id, pagado, action, monto, nota } = body;

  if (!gasto_id || !participante_id) {
    return NextResponse.json({ error: 'gasto_id and participante_id required' }, { status: 400 });
  }

  // Verify ownership
  const { data: gasto } = await getServiceClient()
    .from('gastos_compartidos')
    .select('id')
    .eq('id', gasto_id)
    .eq('creador_id', userId)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (action === 'abonar') {
    // Partial payment (abono)
    const montoAbono = parseFloat(monto);
    if (!montoAbono || montoAbono <= 0 || !isFinite(montoAbono))
      return NextResponse.json({ error: 'Monto invalido' }, { status: 400 });

    const { data: part } = await getServiceClient()
      .from('gasto_participantes')
      .select('monto_debe, monto_pagado')
      .eq('id', participante_id)
      .eq('gasto_id', gasto_id)
      .single();

    if (!part)
      return NextResponse.json({ error: 'Participant not found' }, { status: 404 });

    const pendiente = parseFloat(String(part.monto_debe)) - parseFloat(String(part.monto_pagado || 0));
    if (montoAbono > pendiente + 0.01)
      return NextResponse.json({ error: 'Monto excede lo pendiente (S/ ' + pendiente.toFixed(2) + ')' }, { status: 400 });

    // Insert abono record
    await getServiceClient().from('gasto_participante_abonos').insert({
      participante_id,
      monto: montoAbono,
      nota: nota || null,
    });

    // Update monto_pagado and check if fully paid
    const nuevoMontoPagado = parseFloat(String(part.monto_pagado || 0)) + montoAbono;
    const fullyPaid = nuevoMontoPagado >= parseFloat(String(part.monto_debe)) - 0.01;

    await getServiceClient()
      .from('gasto_participantes')
      .update({ monto_pagado: nuevoMontoPagado, pagado: fullyPaid })
      .eq('id', participante_id);
  } else {
    // Toggle paid (existing behavior)
    const newPagado = pagado !== false;
    const updateFields: Record<string, unknown> = { pagado: newPagado };

    // When marking fully paid via toggle, set monto_pagado = monto_debe
    if (newPagado) {
      const { data: part } = await getServiceClient()
        .from('gasto_participantes')
        .select('monto_debe')
        .eq('id', participante_id)
        .eq('gasto_id', gasto_id)
        .single();
      if (part) updateFields.monto_pagado = part.monto_debe;
    } else {
      updateFields.monto_pagado = 0;
    }

    const { error } = await getServiceClient()
      .from('gasto_participantes')
      .update(updateFields)
      .eq('id', participante_id)
      .eq('gasto_id', gasto_id);

    if (error)
      return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Check if all participants paid — if so, mark expense as liquidado
  const { data: allParts } = await getServiceClient()
    .from('gasto_participantes')
    .select('pagado')
    .eq('gasto_id', gasto_id);

  const allPaid = (allParts || []).every((p) => p.pagado);
  if (allPaid) {
    await getServiceClient()
      .from('gastos_compartidos')
      .update({ estado: 'liquidado' })
      .eq('id', gasto_id);
  } else {
    await getServiceClient()
      .from('gastos_compartidos')
      .update({ estado: 'activo' })
      .eq('id', gasto_id);
  }

  return NextResponse.json({ success: true, liquidado: allPaid });
}

// DELETE /api/split?id=xxx — delete a shared expense
export async function DELETE(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // Verify ownership
  const { data: gasto } = await getServiceClient()
    .from('gastos_compartidos')
    .select('id')
    .eq('id', id)
    .eq('creador_id', userId)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Delete participants first, then expense
  await getServiceClient()
    .from('gasto_participantes')
    .delete()
    .eq('gasto_id', id);

  const { error } = await getServiceClient()
    .from('gastos_compartidos')
    .delete()
    .eq('id', id);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
