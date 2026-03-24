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

export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();

  // Calculate monto_pen based on moneda
  const monto = parseFloat(body.monto) || 0;
  const montoPen = body.moneda === 'USD' ? monto * 3.7 : monto;

  const { data, error } = await serviceClient
    .from('transacciones')
    .insert({
      usuario_id: userId,
      tipo: body.tipo || 'gasto',
      monto,
      monto_pen: montoPen,
      moneda: body.moneda || 'PEN',
      comercio: body.comercio || null,
      categoria: body.categoria,
      subcategoria: body.subcategoria || null,
      fecha: body.fecha,
      metodo_pago: body.metodo_pago || null,
    })
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const monto = parseFloat(body.monto) || 0;
  const montoPen = body.moneda === 'USD' ? monto * 3.7 : monto;

  const { data, error } = await serviceClient
    .from('transacciones')
    .update({
      tipo: body.tipo,
      monto,
      monto_pen: montoPen,
      moneda: body.moneda || 'PEN',
      comercio: body.comercio || null,
      categoria: body.categoria,
      subcategoria: body.subcategoria || null,
      fecha: body.fecha,
      metodo_pago: body.metodo_pago || null,
    })
    .eq('id', body.id)
    .eq('usuario_id', userId)
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await serviceClient
    .from('transacciones')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
