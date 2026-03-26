import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getNetoUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await serviceClient
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();
  return data || null;
}

const FREE_GOAL_LIMIT = 1;

export async function GET() {
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = netoUser.id;

  const { data, error } = await serviceClient
    .from('metas_ahorro')
    .select('*')
    .eq('usuario_id', userId)
    .order('created_at', { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = netoUser.id;

  // Free plan: limit to 1 goal
  if (netoUser.plan !== 'premium') {
    const { count } = await serviceClient
      .from('metas_ahorro')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', userId);
    if ((count ?? 0) >= FREE_GOAL_LIMIT) {
      return NextResponse.json(
        { error: 'Límite de metas alcanzado. Activa Pro para crear ilimitadas.', upgrade: true },
        { status: 403 },
      );
    }
  }

  const body = await request.json();

  const { data, error } = await serviceClient
    .from('metas_ahorro')
    .insert({
      usuario_id: userId,
      nombre: body.nombre,
      monto_objetivo: parseFloat(body.monto_objetivo) || 0,
      monto_actual: parseFloat(body.monto_actual) || 0,
      icono: body.icono || '🎯',
      fecha_limite: body.fecha_limite || null,
    })
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function PUT(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = netoUser.id;

  const body = await request.json();

  const { data, error } = await serviceClient
    .from('metas_ahorro')
    .update({
      nombre: body.nombre,
      monto_objetivo: parseFloat(body.monto_objetivo) || 0,
      monto_actual: parseFloat(body.monto_actual) || 0,
      icono: body.icono || '🎯',
      fecha_limite: body.fecha_limite || null,
      completada: body.completada || false,
      updated_at: new Date().toISOString(),
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
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = netoUser.id;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await serviceClient
    .from('metas_ahorro')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
