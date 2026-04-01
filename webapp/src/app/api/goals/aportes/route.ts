import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

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

// GET /api/goals/aportes?meta_id=xxx — list contributions for a goal
export async function GET(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const metaId = searchParams.get('meta_id');
  if (!metaId)
    return NextResponse.json({ error: 'Missing meta_id' }, { status: 400 });

  // Verify meta belongs to user
  const { data: meta } = await serviceClient
    .from('metas_ahorro')
    .select('id')
    .eq('id', metaId)
    .eq('usuario_id', userId)
    .single();
  if (!meta)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data, error } = await serviceClient
    .from('meta_aportes')
    .select('*')
    .eq('meta_id', metaId)
    .order('created_at', { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

// POST /api/goals/aportes — create a contribution
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { meta_id, monto, tipo = 'aporte', nota } = body;

  if (!meta_id || !monto || monto <= 0)
    return NextResponse.json({ error: 'meta_id and monto required' }, { status: 400 });

  if (!['aporte', 'retiro'].includes(tipo))
    return NextResponse.json({ error: 'tipo must be aporte or retiro' }, { status: 400 });

  // Verify meta belongs to user
  const { data: meta } = await serviceClient
    .from('metas_ahorro')
    .select('*')
    .eq('id', meta_id)
    .eq('usuario_id', userId)
    .single();
  if (!meta)
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 });

  // Insert aporte
  const { data: aporte, error: aporteError } = await serviceClient
    .from('meta_aportes')
    .insert({
      meta_id,
      monto: parseFloat(monto),
      tipo,
      fecha: new Date().toISOString().split('T')[0],
      nota: nota || null,
    })
    .select()
    .single();

  if (aporteError)
    return NextResponse.json({ error: aporteError.message }, { status: 400 });

  // Update meta monto_actual
  const actualAntes = parseFloat(meta.monto_actual || '0');
  const montoNum = parseFloat(monto);
  const nuevoActual = tipo === 'retiro'
    ? Math.max(0, actualAntes - montoNum)
    : actualAntes + montoNum;
  const completada = nuevoActual >= parseFloat(meta.monto_objetivo) && tipo === 'aporte';

  const updates: Record<string, unknown> = {
    monto_actual: nuevoActual,
    updated_at: new Date().toISOString(),
  };
  if (completada) updates.completada = true;

  const { error: updateError } = await serviceClient
    .from('metas_ahorro')
    .update(updates)
    .eq('id', meta_id);

  if (updateError)
    return NextResponse.json({ error: updateError.message }, { status: 400 });

  // Detect milestone
  const objetivo = parseFloat(meta.monto_objetivo);
  const pctAntes = objetivo > 0 ? (actualAntes / objetivo) * 100 : 0;
  const pctDespues = objetivo > 0 ? (nuevoActual / objetivo) * 100 : 0;
  let milestone: number | null = null;
  for (const ms of [25, 50, 75, 100]) {
    if (pctAntes < ms && pctDespues >= ms) milestone = ms;
  }

  // Register logro if milestone
  if (milestone) {
    const logroTipo = milestone === 100 ? 'meta_cumplida' : `milestone_${milestone}`;
    try {
      await serviceClient.from('logros').upsert({
        usuario_id: userId,
        tipo: logroTipo,
        meta_id,
        fecha: new Date().toISOString().split('T')[0],
      }, { onConflict: 'usuario_id,tipo,meta_id', ignoreDuplicates: true });
    } catch { /* silent */ }
  }

  return NextResponse.json({
    aporte,
    meta: { ...meta, monto_actual: nuevoActual, completada: completada || meta.completada },
    porcentaje: Math.min(100, Math.round(pctDespues)),
    milestone,
  });
}

// DELETE /api/goals/aportes?id=xxx — delete a contribution and recalculate meta
export async function DELETE(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // Fetch aporte + verify ownership via meta
  const { data: aporte } = await serviceClient
    .from('meta_aportes')
    .select('*, metas_ahorro!inner(id, usuario_id, monto_actual, monto_objetivo)')
    .eq('id', id)
    .single();

  if (!aporte || aporte.metas_ahorro.usuario_id !== userId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Delete the aporte
  const { error } = await serviceClient
    .from('meta_aportes')
    .delete()
    .eq('id', id);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Recalculate meta monto_actual (reverse the contribution)
  const montoAporte = parseFloat(aporte.monto);
  const actualAntes = parseFloat(aporte.metas_ahorro.monto_actual || '0');
  const objetivo = parseFloat(aporte.metas_ahorro.monto_objetivo || '0');
  const nuevoActual = aporte.tipo === 'retiro'
    ? actualAntes + montoAporte
    : Math.max(0, actualAntes - montoAporte);

  await serviceClient
    .from('metas_ahorro')
    .update({
      monto_actual: nuevoActual,
      completada: nuevoActual >= objetivo,
      updated_at: new Date().toISOString(),
    })
    .eq('id', aporte.meta_id);

  return NextResponse.json({ success: true });
}
