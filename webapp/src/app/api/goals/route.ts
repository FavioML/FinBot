import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

async function getNetoUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();
  return data || null;
}



export async function GET() {
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;

  // Get own goals
  const { data: ownGoals, error } = await getServiceClient()
    .from('metas_ahorro')
    .select('*, meta_aportes(*)')
    .eq('usuario_id', userId)
    .order('created_at', { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Get participated collaborative goals
  const { data: participations } = await getServiceClient()
    .from('meta_participantes')
    .select('meta_id')
    .eq('usuario_id', userId);

  const participatedIds = (participations || [])
    .map((p) => p.meta_id)
    .filter((id) => !(ownGoals || []).some((g) => g.id === id));

  let participatedGoals: typeof ownGoals = [];
  if (participatedIds.length > 0) {
    const { data: pGoals } = await getServiceClient()
      .from('metas_ahorro')
      .select('*, meta_aportes(*)')
      .in('id', participatedIds)
      .order('created_at', { ascending: false });
    participatedGoals = pGoals || [];
  }

  return NextResponse.json([...(ownGoals || []), ...participatedGoals]);
}

export async function POST(request: Request) {
  const netoUser = await getNetoUser();
  if (!netoUser)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;

  // Metas ilimitadas para todos los planes (Free + Pro)

  const body = await request.json();

  // Validate monto_objetivo
  const montoObjetivo = parseFloat(body.monto_objetivo);
  if (!montoObjetivo || isNaN(montoObjetivo) || montoObjetivo <= 0 || montoObjetivo > 999999.99) {
    return NextResponse.json({ error: 'Monto objetivo inválido' }, { status: 400 });
  }

  const { data, error } = await getServiceClient()
    .from('metas_ahorro')
    .insert({
      usuario_id: userId,
      nombre: body.nombre,
      monto_objetivo: montoObjetivo,
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

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;

  const body = await request.json();

  const { data, error } = await getServiceClient()
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

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('metas_ahorro')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
