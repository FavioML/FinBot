import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getNetoUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await serviceClient
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();
  return data || null;
}

// GET /api/debts — lista todas las deudas activas
export async function GET() {
  const netoUser = await getNetoUser();
  if (!netoUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await serviceClient
    .from('deudas')
    .select('*, deuda_abonos(id, monto, fecha, nota, created_at)')
    .eq('usuario_id', netoUser.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

// POST /api/debts — crear deuda
export async function POST(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { tipo, contraparte, monto_original, moneda, descripcion, fecha_vencimiento } = body;

  if (!tipo || !contraparte || !monto_original) {
    return NextResponse.json({ error: 'Faltan campos requeridos' }, { status: 400 });
  }

  const monto = parseFloat(monto_original);
  if (isNaN(monto) || monto <= 0) {
    return NextResponse.json({ error: 'Monto inválido' }, { status: 400 });
  }

  const { data, error } = await serviceClient
    .from('deudas')
    .insert({
      usuario_id: netoUser.id,
      tipo,
      contraparte: contraparte.trim(),
      monto_original: monto,
      monto_pendiente: monto,
      moneda: moneda || 'PEN',
      descripcion: descripcion?.trim() || null,
      fecha_vencimiento: fecha_vencimiento || null,
      estado: 'activa',
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

// PUT /api/debts — actualizar deuda (editar campos o registrar abono)
export async function PUT(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { id, action, ...fields } = body;

  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // Verificar que la deuda pertenece al usuario
  const { data: deuda } = await serviceClient
    .from('deudas')
    .select('*')
    .eq('id', id)
    .eq('usuario_id', netoUser.id)
    .single();

  if (!deuda) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // action=abonar → registrar abono + actualizar monto_pendiente
  if (action === 'abonar') {
    const montoAbono = parseFloat(fields.monto);
    if (isNaN(montoAbono) || montoAbono <= 0) {
      return NextResponse.json({ error: 'Monto de abono inválido' }, { status: 400 });
    }

    const nuevoPendiente = Math.max(0, parseFloat(deuda.monto_pendiente) - montoAbono);
    const completada = nuevoPendiente === 0;

    // Insertar abono
    await serviceClient.from('deuda_abonos').insert({
      deuda_id: id,
      monto: montoAbono,
      fecha: fields.fecha || new Date().toISOString().split('T')[0],
      nota: fields.nota || null,
    });

    // Actualizar deuda
    const { data: updated, error } = await serviceClient
      .from('deudas')
      .update({
        monto_pendiente: nuevoPendiente,
        estado: completada ? 'pagada' : 'activa',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ...updated, completada });
  }

  // action=marcar_pagada → poner monto_pendiente=0 y estado=pagada
  if (action === 'marcar_pagada') {
    const { data: updated, error } = await serviceClient
      .from('deudas')
      .update({
        monto_pendiente: 0,
        estado: 'pagada',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(updated);
  }

  // Edición general
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.contraparte !== undefined) updateData.contraparte = fields.contraparte.trim();
  if (fields.descripcion !== undefined) updateData.descripcion = fields.descripcion?.trim() || null;
  if (fields.fecha_vencimiento !== undefined) updateData.fecha_vencimiento = fields.fecha_vencimiento || null;
  if (fields.estado !== undefined) updateData.estado = fields.estado;

  const { data: updated, error } = await serviceClient
    .from('deudas')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(updated);
}

// DELETE /api/debts?id=xxx — eliminar deuda
export async function DELETE(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await serviceClient
    .from('deudas')
    .delete()
    .eq('id', id)
    .eq('usuario_id', netoUser.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
