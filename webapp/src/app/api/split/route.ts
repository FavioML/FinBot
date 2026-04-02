import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

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

// GET /api/split — list shared expenses
export async function GET() {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { data, error } = await serviceClient
    .from('gastos_compartidos')
    .select('*, gasto_participantes(*)')
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
  const { data: gasto, error: gastoError } = await serviceClient
    .from('gastos_compartidos')
    .insert({
      creador_id: userId,
      descripcion,
      monto_total: montoTotalNum,
      moneda,
      fecha: new Date().toISOString().split('T')[0],
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

  const { error: partError } = await serviceClient
    .from('gasto_participantes')
    .insert(participantRows);

  if (partError)
    return NextResponse.json({ error: partError.message }, { status: 400 });

  // Re-fetch with participants
  const { data: full } = await serviceClient
    .from('gastos_compartidos')
    .select('*, gasto_participantes(*)')
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
  const { data: gasto } = await serviceClient
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
    await serviceClient
      .from('gastos_compartidos')
      .update(updateFields)
      .eq('id', id);
  }

  // Update participant names if provided
  if (participantes && Array.isArray(participantes)) {
    for (const p of participantes) {
      if (p.id && p.nombre) {
        await serviceClient
          .from('gasto_participantes')
          .update({ nombre: p.nombre })
          .eq('id', p.id)
          .eq('gasto_id', id);
      }
    }
  }

  // Return updated expense with participants
  const { data: updated } = await serviceClient
    .from('gastos_compartidos')
    .select('*, gasto_participantes(*)')
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
  const { gasto_id, participante_id, pagado } = body;

  if (!gasto_id || !participante_id) {
    return NextResponse.json({ error: 'gasto_id and participante_id required' }, { status: 400 });
  }

  // Verify ownership
  const { data: gasto } = await serviceClient
    .from('gastos_compartidos')
    .select('id')
    .eq('id', gasto_id)
    .eq('creador_id', userId)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Update participant
  const { error } = await serviceClient
    .from('gasto_participantes')
    .update({ pagado: pagado !== false })
    .eq('id', participante_id)
    .eq('gasto_id', gasto_id);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Check if all participants paid — if so, mark expense as liquidado
  const { data: allParts } = await serviceClient
    .from('gasto_participantes')
    .select('pagado')
    .eq('gasto_id', gasto_id);

  const allPaid = (allParts || []).every((p) => p.pagado);
  if (allPaid) {
    await serviceClient
      .from('gastos_compartidos')
      .update({ estado: 'liquidado' })
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
  const { data: gasto } = await serviceClient
    .from('gastos_compartidos')
    .select('id')
    .eq('id', id)
    .eq('creador_id', userId)
    .single();

  if (!gasto)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Delete participants first, then expense
  await serviceClient
    .from('gasto_participantes')
    .delete()
    .eq('gasto_id', id);

  const { error } = await serviceClient
    .from('gastos_compartidos')
    .delete()
    .eq('id', id);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
