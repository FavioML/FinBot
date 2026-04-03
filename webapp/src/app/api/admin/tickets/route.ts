import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'faviomendoza27jl@gmail.com';

async function getAdminEmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email || null;
}

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const email = await getAdminEmail();
  if (email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');
  const estado = searchParams.get('estado') || null;
  const search = searchParams.get('search') || null;

  let query = getServiceClient()
    .from('tickets_soporte')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (estado && estado !== 'todos') {
    query = query.eq('estado', estado);
  }

  if (search) {
    query = query.or(`mensaje.ilike.%${search}%,whatsapp.ilike.%${search}%`);
  }

  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, total: count || 0, tickets: data || [] });
}

export async function PUT(request: Request) {
  const email = await getAdminEmail();
  if (email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { id, action, ...data } = body;

  if (!id || !action) {
    return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
  }

  switch (action) {
    case 'respond': {
      const respuesta = data.respuesta;
      if (!respuesta) {
        return NextResponse.json({ error: 'Missing respuesta' }, { status: 400 });
      }
      const { error } = await getServiceClient()
        .from('tickets_soporte')
        .update({
          respuesta_admin: respuesta,
          estado: 'respondido',
          respondido_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'respond' });
    }

    case 'set_estado': {
      const estado = data.estado;
      if (!estado) {
        return NextResponse.json({ error: 'Missing estado' }, { status: 400 });
      }
      const { error } = await getServiceClient()
        .from('tickets_soporte')
        .update({ estado })
        .eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'set_estado', estado });
    }

    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}
