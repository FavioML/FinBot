import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { generarCodigoInvitacion } from '@/lib/codigos-seguros';

const ALFABETO_INVITE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateInviteCode(): string {
  // Fuente criptográfica: el código ES la credencial para entrar a la meta de otro.
  return generarCodigoInvitacion(ALFABETO_INVITE, 8);
}

// POST /api/goals/invite — generate invite link for a goal
export async function POST(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const body = await request.json();
  const { meta_id } = body;

  if (!meta_id)
    return NextResponse.json({ error: 'meta_id required' }, { status: 400 });

  // Verify ownership
  const { data: meta } = await getServiceClient()
    .from('metas_ahorro')
    .select('id, invite_code, colaborativa')
    .eq('id', meta_id)
    .eq('usuario_id', userId)
    .single();

  if (!meta)
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 });

  // Generate invite code if not exists
  let inviteCode = meta.invite_code;
  if (!inviteCode) {
    inviteCode = generateInviteCode();
    await getServiceClient()
      .from('metas_ahorro')
      .update({ invite_code: inviteCode, colaborativa: true })
      .eq('id', meta_id);
  }

  // Ensure creator is in meta_participantes
  const { data: existingParticipant } = await getServiceClient()
    .from('meta_participantes')
    .select('id')
    .eq('meta_id', meta_id)
    .eq('usuario_id', userId)
    .single();

  if (!existingParticipant) {
    await getServiceClient()
      .from('meta_participantes')
      .insert({ meta_id, usuario_id: userId, rol: 'creador' });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.neto.pe';
  const link = `${baseUrl}/join/meta/${inviteCode}`;

  return NextResponse.json({ invite_code: inviteCode, link });
}

// GET /api/goals/invite?code=xxx — public preview of a goal (no auth required)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code)
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });

  const { data: meta } = await getServiceClient()
    .from('metas_ahorro')
    .select('id, nombre, icono, monto_objetivo, monto_actual, colaborativa, usuario_id')
    .eq('invite_code', code)
    .eq('colaborativa', true)
    .single();

  if (!meta)
    return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 404 });

  // Get creator name
  const { data: creator } = await getServiceClient()
    .from('usuarios')
    .select('nombre')
    .eq('id', meta.usuario_id)
    .single();

  // Get participant count
  const { count } = await getServiceClient()
    .from('meta_participantes')
    .select('id', { count: 'exact', head: true })
    .eq('meta_id', meta.id);

  const pct = meta.monto_objetivo > 0
    ? Math.round((meta.monto_actual / meta.monto_objetivo) * 100)
    : 0;

  return NextResponse.json({
    nombre: meta.nombre,
    icono: meta.icono,
    monto_objetivo: meta.monto_objetivo,
    monto_actual: meta.monto_actual,
    porcentaje: pct,
    creador: creator?.nombre || 'Anonimo',
    participantes: count || 0,
  });
}
