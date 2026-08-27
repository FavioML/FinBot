import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { resumenNotificaciones } from '@/lib/notificaciones-resumen';
import { NextResponse } from 'next/server';

// GET /api/notifications/inbox — list last 20 notifications
export async function GET() {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const svc = getServiceClient();
  // Las tres en paralelo: antes eran dos `await` encadenados, y la funcion corre en iad1
  // contra una base en sa-east-1 (~350ms por ida y vuelta). Agregar el resumen sin
  // paralelizar habria sumado un tercer viaje al camino critico de la campana.
  const [listaRes, unreadRes, resumenRes] = await Promise.all([
    svc.from('notificaciones').select('*').eq('usuario_id', userId).order('fecha', { ascending: false }).limit(20),
    svc.from('notificaciones').select('id', { count: 'exact', head: true }).eq('usuario_id', userId).eq('leida', false),
    resumenNotificaciones(svc, userId),
  ]);

  if (listaRes.error)
    return NextResponse.json({ error: listaRes.error.message }, { status: 400 });

  return NextResponse.json({
    notifications: listaRes.data || [],
    unreadCount: unreadRes.count || 0,
    ...resumenRes,
  });
}

// PUT /api/notifications/inbox — mark notification(s) as read
export async function PUT(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const body = await request.json();
  const { ids, markAll } = body as { ids?: string[]; markAll?: boolean };

  if (markAll) {
    const { error } = await getServiceClient()
      .from('notificaciones')
      .update({ leida: true })
      .eq('usuario_id', userId)
      .eq('leida', false);

    if (error)
      return NextResponse.json({ error: error.message }, { status: 400 });
  } else if (ids && ids.length > 0) {
    const { error } = await getServiceClient()
      .from('notificaciones')
      .update({ leida: true })
      .eq('usuario_id', userId)
      .in('id', ids);

    if (error)
      return NextResponse.json({ error: error.message }, { status: 400 });
  } else {
    return NextResponse.json({ error: 'ids or markAll required' }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}

// DELETE /api/notifications/inbox?id=xxx — delete a notification
export async function DELETE(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('notificaciones')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
