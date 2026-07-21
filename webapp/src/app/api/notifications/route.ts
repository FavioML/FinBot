import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

// Las preferencias viven en la MISMA fila `usuarios` que el id y el plan, asi que
// se traen todas de una. El GET hacia 2 round-trips a la misma fila: uno para
// resolver la sesion y otro para releerla por id.
async function getNetoUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id, plan, recordatorios_activos, manos_libres, alertas_transaccion')
    .eq('supabase_auth_id', user.id)
    .single();
  return data;
}

export async function GET() {
  const usuario = await getNetoUser();
  if (!usuario)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return NextResponse.json({
    recordatorios_activos: usuario.recordatorios_activos ?? true,
    manos_libres: usuario.manos_libres ?? false,
    alertas_transaccion: usuario.alertas_transaccion ?? true,
  });
}

export async function PUT(request: Request) {
  const usuario = await getNetoUser();
  if (!usuario)
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
  // Modo Manos Libres es una función Pro: solo premium puede activarlo.
  // Un usuario free siempre puede apagarlo (defensivo), nunca prenderlo.
  if ('manos_libres' in body) {
    if (usuario.plan === 'premium') update.manos_libres = Boolean(body.manos_libres);
    else if (!body.manos_libres) update.manos_libres = false;
  }
  if ('alertas_transaccion' in body)
    update.alertas_transaccion = Boolean(body.alertas_transaccion);

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('usuarios')
    .update(update)
    .eq('id', usuario.id);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true, ...update });
}
