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

// POST /api/debts/join — accept a shared debt (creates mirror "debo" debt)
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { code } = body;

  if (!code)
    return NextResponse.json({ error: 'code required' }, { status: 400 });

  // Find the original debt by invite code
  const { data: deudaOriginal } = await serviceClient
    .from('deudas')
    .select('id, usuario_id, contraparte, monto_original, monto_pendiente, moneda, descripcion, fecha_vencimiento')
    .eq('invite_code', code)
    .single();

  if (!deudaOriginal)
    return NextResponse.json({ error: 'Invitacion invalida o expirada' }, { status: 404 });

  // Cannot confirm your own debt
  if (deudaOriginal.usuario_id === userId)
    return NextResponse.json({ error: 'No puedes confirmar tu propia deuda' }, { status: 400 });

  // Check if already confirmed by this user
  const { data: existing } = await serviceClient
    .from('deudas')
    .select('id')
    .eq('usuario_id', userId)
    .eq('deuda_vinculada_id', deudaOriginal.id)
    .maybeSingle();

  if (existing)
    return NextResponse.json({ error: 'Ya confirmaste esta deuda' }, { status: 409 });

  // Get creditor name to use as contraparte
  const { data: acreedor } = await serviceClient
    .from('usuarios')
    .select('nombre')
    .eq('id', deudaOriginal.usuario_id)
    .single();

  // Create mirror "debo" debt
  const { data: nuevaDeuda, error } = await serviceClient
    .from('deudas')
    .insert({
      usuario_id: userId,
      tipo: 'debo',
      contraparte: acreedor?.nombre || deudaOriginal.contraparte,
      monto_original: deudaOriginal.monto_original,
      monto_pendiente: deudaOriginal.monto_pendiente,
      moneda: deudaOriginal.moneda,
      descripcion: deudaOriginal.descripcion,
      fecha_vencimiento: deudaOriginal.fecha_vencimiento,
      estado: 'activa',
      deuda_vinculada_id: deudaOriginal.id,
    })
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Notify creditor that debt was confirmed
  try {
    const { data: joiner } = await serviceClient.from('usuarios').select('nombre').eq('id', userId).single();
    await serviceClient.from('notificaciones').insert({
      usuario_id: deudaOriginal.usuario_id,
      tipo: 'sistema',
      titulo: 'Deuda confirmada',
      mensaje: (joiner?.nombre || 'Alguien') + ' confirmó la deuda de ' + (deudaOriginal.moneda === 'USD' ? '$' : 'S/') + ' ' + parseFloat(deudaOriginal.monto_original as unknown as string).toFixed(2),
      datos: { link: '/dashboard/deudas', deuda_id: deudaOriginal.id },
      leida: false,
      fecha: new Date().toISOString(),
    });
  } catch (e) { console.error('[debt-join-notify]', e); }

  return NextResponse.json(nuevaDeuda);
}
