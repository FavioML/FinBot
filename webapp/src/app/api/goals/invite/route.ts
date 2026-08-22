import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { vistaInvitacionMeta } from '@/lib/invitaciones';
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

// GET — vista publica de la invitacion (sin auth). La resolucion vive en
// `lib/invitaciones.ts` porque el consumidor principal ya no es esta ruta sino la
// pantalla `/join/*`, que la llama en el servidor antes de mandar el HTML. Esto queda
// para los harness de `qa-e2e/`, que la consultan sin navegador.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code)
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });

  const vista = await vistaInvitacionMeta(code);
  if (!vista)
    return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 404 });

  return NextResponse.json(vista);
}
