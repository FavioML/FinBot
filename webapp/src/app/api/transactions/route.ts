import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getExchangeRate } from '@/lib/exchange-rate';

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

// Sync categoría y subcategoría custom a categorias_usuario
async function syncCategoriasUsuario(userId: string, categoria: string, subcategoria: string | null) {
  if (!categoria) return;

  // Buscar si la categoría padre existe en categorias_usuario
  const { data: padre } = await serviceClient
    .from('categorias_usuario')
    .select('id')
    .eq('usuario_id', userId)
    .eq('nombre', categoria)
    .is('padre_id', null)
    .maybeSingle();

  // Si la categoría no existe, crearla
  let padreId = padre?.id;
  if (!padreId) {
    const { data: nuevoPadre } = await serviceClient
      .from('categorias_usuario')
      .insert({ usuario_id: userId, nombre: categoria, activa: true })
      .select('id')
      .single();
    padreId = nuevoPadre?.id;
  }

  // Si hay subcategoría custom, crearla si no existe
  if (subcategoria && subcategoria !== 'sin_categoria' && padreId) {
    const { data: existeSub } = await serviceClient
      .from('categorias_usuario')
      .select('id')
      .eq('usuario_id', userId)
      .eq('padre_id', padreId)
      .ilike('nombre', subcategoria)
      .maybeSingle();

    if (!existeSub) {
      await serviceClient.from('categorias_usuario').insert({
        usuario_id: userId,
        nombre: subcategoria,
        padre_id: padreId,
        activa: true,
      });
    }
  }
}

export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();

  // Calculate monto_pen based on moneda — use live exchange rate
  const monto = parseFloat(body.monto) || 0;
  const tc = body.moneda === 'USD' ? await getExchangeRate() : 1;
  const montoPen = body.moneda === 'USD' ? monto * tc : monto;

  const subcategoria = body.subcategoria || 'sin_categoria';

  const { data, error } = await serviceClient
    .from('transacciones')
    .insert({
      usuario_id: userId,
      tipo: body.tipo || 'gasto',
      monto,
      monto_pen: montoPen,
      moneda: body.moneda || 'PEN',
      tipo_cambio: body.moneda === 'USD' ? tc : null,
      comercio: body.comercio || null,
      categoria: body.categoria,
      subcategoria,
      fecha: body.fecha,
      metodo_pago: body.metodo_pago || null,
    })
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Sync categoría/subcategoría a categorias_usuario (fire-and-forget)
  syncCategoriasUsuario(userId, body.categoria, body.subcategoria).catch(() => {});

  return NextResponse.json(data);
}

export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const monto = parseFloat(body.monto) || 0;
  const tc = body.moneda === 'USD' ? await getExchangeRate() : 1;
  const montoPen = body.moneda === 'USD' ? monto * tc : monto;

  const subcategoria = body.subcategoria || 'sin_categoria';

  const { data, error } = await serviceClient
    .from('transacciones')
    .update({
      tipo: body.tipo,
      monto,
      monto_pen: montoPen,
      moneda: body.moneda || 'PEN',
      comercio: body.comercio || null,
      categoria: body.categoria,
      subcategoria,
      fecha: body.fecha,
      metodo_pago: body.metodo_pago || null,
    })
    .eq('id', body.id)
    .eq('usuario_id', userId)
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Sync categoría/subcategoría a categorias_usuario (fire-and-forget)
  syncCategoriasUsuario(userId, body.categoria, body.subcategoria).catch(() => {});

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
