import { getServiceClient } from '@/lib/supabase/service';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

// GET /api/goals/participants?meta_id=xxx — list participants with their contribution totals
export async function GET(request: Request) {
  const auth = await requireLectura();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const { searchParams } = new URL(request.url);
  const metaId = searchParams.get('meta_id');
  if (!metaId)
    return NextResponse.json({ error: 'Missing meta_id' }, { status: 400 });

  // Verify access: must be owner or participant
  const { data: meta } = await getServiceClient()
    .from('metas_ahorro')
    .select('id, usuario_id')
    .eq('id', metaId)
    .single();

  if (!meta) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isOwner = meta.usuario_id === userId;
  if (!isOwner) {
    const { data: participation } = await getServiceClient()
      .from('meta_participantes')
      .select('id')
      .eq('meta_id', metaId)
      .eq('usuario_id', userId)
      .single();
    if (!participation)
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  // Get participants with user info
  const { data: participants, error } = await getServiceClient()
    .from('meta_participantes')
    .select('id, usuario_id, rol, fecha_union')
    .eq('meta_id', metaId)
    .order('fecha_union', { ascending: true });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Get user details for each participant
  const userIds = (participants || []).map((p) => p.usuario_id).filter(Boolean);
  const { data: users } = await getServiceClient()
    .from('usuarios')
    .select('id, nombre, whatsapp')
    .in('id', userIds);

  const userMap = new Map((users || []).map((u) => [u.id, u]));

  // Get contribution totals per user for this meta
  const { data: aportes } = await getServiceClient()
    .from('meta_aportes')
    .select('usuario_id, monto, tipo')
    .eq('meta_id', metaId);

  const contribMap = new Map<string, number>();
  for (const a of aportes || []) {
    const uid = a.usuario_id || meta.usuario_id; // old aportes without usuario_id belong to owner
    const prev = contribMap.get(uid) || 0;
    const delta = a.tipo === 'retiro' ? -parseFloat(a.monto) : parseFloat(a.monto);
    contribMap.set(uid, prev + delta);
  }

  const result = (participants || []).map((p) => {
    const userInfo = userMap.get(p.usuario_id);
    return {
      id: p.id,
      usuario_id: p.usuario_id,
      rol: p.rol,
      fecha_union: p.fecha_union,
      nombre: userInfo?.nombre || 'Desconocido',
      whatsapp: userInfo?.whatsapp || null,
      total_aportado: Math.max(0, contribMap.get(p.usuario_id) || 0),
    };
  });

  return NextResponse.json(result);
}

// DELETE /api/goals/participants — disable collaborative mode (owner only)
export async function DELETE(request: Request) {
  const auth = await requireLectura();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const { searchParams } = new URL(request.url);
  const metaId = searchParams.get('meta_id');
  if (!metaId)
    return NextResponse.json({ error: 'Missing meta_id' }, { status: 400 });

  // Verify ownership
  const { data: meta } = await getServiceClient()
    .from('metas_ahorro')
    .select('id, usuario_id')
    .eq('id', metaId)
    .eq('usuario_id', userId)
    .single();

  if (!meta)
    return NextResponse.json({ error: 'Not found or not owner' }, { status: 404 });

  // Remove all participants except owner
  await getServiceClient()
    .from('meta_participantes')
    .delete()
    .eq('meta_id', metaId);

  // Disable collaborative mode and remove invite code
  await getServiceClient()
    .from('metas_ahorro')
    .update({ colaborativa: false, invite_code: null })
    .eq('id', metaId);

  return NextResponse.json({ success: true });
}
