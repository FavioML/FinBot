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

export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const body = await request.json();
  const { nombre } = body;

  if (!nombre || typeof nombre !== 'string') {
    return NextResponse.json({ error: 'Nombre requerido' }, { status: 400 });
  }

  const nombreLimpio = nombre.trim();
  if (nombreLimpio.length < 2 || nombreLimpio.length > 50) {
    return NextResponse.json({ error: 'El nombre debe tener entre 2 y 50 caracteres' }, { status: 400 });
  }

  const { error } = await serviceClient
    .from('usuarios')
    .update({ nombre: nombreLimpio })
    .eq('id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, nombre: nombreLimpio });
}
