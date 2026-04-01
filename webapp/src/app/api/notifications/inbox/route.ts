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

// GET /api/notifications/inbox — list last 20 notifications
export async function GET() {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await serviceClient
    .from('notificaciones')
    .select('*')
    .eq('usuario_id', userId)
    .order('fecha', { ascending: false })
    .limit(20);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Also get unread count
  const { count } = await serviceClient
    .from('notificaciones')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', userId)
    .eq('leida', false);

  return NextResponse.json({ notifications: data || [], unreadCount: count || 0 });
}

// PUT /api/notifications/inbox — mark notification(s) as read
export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { ids, markAll } = body as { ids?: string[]; markAll?: boolean };

  if (markAll) {
    const { error } = await serviceClient
      .from('notificaciones')
      .update({ leida: true })
      .eq('usuario_id', userId)
      .eq('leida', false);

    if (error)
      return NextResponse.json({ error: error.message }, { status: 400 });
  } else if (ids && ids.length > 0) {
    const { error } = await serviceClient
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
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await serviceClient
    .from('notificaciones')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
