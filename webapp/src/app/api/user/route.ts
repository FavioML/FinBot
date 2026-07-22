import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

export async function PUT(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const body = await request.json();
  const { nombre } = body;

  if (!nombre || typeof nombre !== 'string') {
    return NextResponse.json({ error: 'Nombre requerido' }, { status: 400 });
  }

  const nombreLimpio = nombre.trim();
  if (nombreLimpio.length < 2 || nombreLimpio.length > 50) {
    return NextResponse.json({ error: 'El nombre debe tener entre 2 y 50 caracteres' }, { status: 400 });
  }

  const { error } = await getServiceClient()
    .from('usuarios')
    .update({ nombre: nombreLimpio })
    .eq('id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, nombre: nombreLimpio });
}
