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

// POST /api/goals/join — join a collaborative goal via invite code
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { code } = body;

  if (!code)
    return NextResponse.json({ error: 'code required' }, { status: 400 });

  // Find the goal
  const { data: meta } = await serviceClient
    .from('metas_ahorro')
    .select('id, nombre, usuario_id, max_participantes, colaborativa')
    .eq('invite_code', code)
    .eq('colaborativa', true)
    .single();

  if (!meta)
    return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 404 });

  // Can't join own goal
  if (meta.usuario_id === userId)
    return NextResponse.json({ error: 'No puedes unirte a tu propia meta' }, { status: 400 });

  // Check if already joined
  const { data: existing } = await serviceClient
    .from('meta_participantes')
    .select('id')
    .eq('meta_id', meta.id)
    .eq('usuario_id', userId)
    .single();

  if (existing)
    return NextResponse.json({ error: 'Ya eres participante de esta meta' }, { status: 400 });

  // Check max participants
  const { count } = await serviceClient
    .from('meta_participantes')
    .select('id', { count: 'exact', head: true })
    .eq('meta_id', meta.id);

  const maxP = meta.max_participantes || 10;
  if ((count || 0) >= maxP)
    return NextResponse.json({ error: 'Meta llena, no se pueden unir mas participantes' }, { status: 400 });

  // Join
  const { error } = await serviceClient
    .from('meta_participantes')
    .insert({
      meta_id: meta.id,
      usuario_id: userId,
      rol: 'participante',
    });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Create notification for the goal creator
  try {
    const { data: joiner } = await serviceClient
      .from('usuarios')
      .select('nombre')
      .eq('id', userId)
      .single();

    await serviceClient.from('notificaciones').insert({
      usuario_id: meta.usuario_id,
      tipo: 'sistema',
      titulo: 'Nuevo participante',
      mensaje: `${joiner?.nombre || 'Alguien'} se unio a tu meta "${meta.nombre}"`,
      datos: { meta_id: meta.id, usuario_id: userId },
    });
  } catch { /* silent */ }

  return NextResponse.json({ success: true, meta_id: meta.id, nombre: meta.nombre });
}
