import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { vistaInvitacionDeuda } from '@/lib/invitaciones';
import { generarCodigoEnlace } from '@/lib/codigos-seguros';

// POST /api/debts/invite — generate invite link for a "me_deben" debt
export async function POST(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  const body = await request.json();
  const { deuda_id } = body;

  if (!deuda_id)
    return NextResponse.json({ error: 'deuda_id required' }, { status: 400 });

  // Verify ownership and type
  const { data: deuda } = await getServiceClient()
    .from('deudas')
    .select('id, invite_code, tipo, estado')
    .eq('id', deuda_id)
    .eq('usuario_id', userId)
    .single();

  if (!deuda)
    return NextResponse.json({ error: 'Debt not found' }, { status: 404 });

  if (deuda.tipo !== 'me_deben')
    return NextResponse.json({ error: 'Solo puedes compartir deudas tipo "me deben"' }, { status: 400 });

  // Return existing code if already generated (idempotent)
  let inviteCode = deuda.invite_code;
  if (!inviteCode) {
    inviteCode = generarCodigoEnlace();
    // El `error` del UPDATE NO se puede descartar, y es la mitad que faltaba del hallazgo:
    // si la escritura falla (largo, colisión del índice único, Supabase caído) la fila
    // queda sin código y esta ruta devolvía **200 con un link que no resuelve nunca** —
    // el deudor lo abre y ve "Invitación inválida o expirada", para siempre, sin que
    // nadie se entere. Y la rama idempotente de arriba no lo repara: cada intento acuña
    // otro código que tampoco se guarda.
    const { error } = await getServiceClient()
      .from('deudas')
      .update({ invite_code: inviteCode })
      .eq('id', deuda_id);
    if (error) {
      console.error('[debts-invite]', error.message);
      return NextResponse.json({ error: 'No se pudo generar el link' }, { status: 500 });
    }
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.neto.pe';
  const link = `${baseUrl}/join/deuda/${inviteCode}`;

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

  const vista = await vistaInvitacionDeuda(code);
  if (!vista)
    return NextResponse.json({ error: 'Invitacion invalida o expirada' }, { status: 404 });

  return NextResponse.json(vista);
}
