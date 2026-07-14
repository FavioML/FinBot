import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

async function getNetoUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data?.id || null;
}

export async function GET() {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await getServiceClient()
    .from('usuarios')
    .select('recordatorios_activos, manos_libres, alertas_transaccion')
    .eq('id', userId)
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({
    recordatorios_activos: data?.recordatorios_activos ?? true,
    manos_libres: data?.manos_libres ?? false,
    alertas_transaccion: data?.alertas_transaccion ?? true,
  });
}

export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();

  // Actualización parcial: solo los campos presentes en el body.
  const update: {
    recordatorios_activos?: boolean;
    manos_libres?: boolean;
    alertas_transaccion?: boolean;
  } = {};
  if ('recordatorios_activos' in body)
    update.recordatorios_activos = Boolean(body.recordatorios_activos);
  if ('manos_libres' in body) update.manos_libres = Boolean(body.manos_libres);
  if ('alertas_transaccion' in body)
    update.alertas_transaccion = Boolean(body.alertas_transaccion);

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('usuarios')
    .update(update)
    .eq('id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true, ...update });
}
