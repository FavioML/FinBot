import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

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

// POST /api/debts/invite — generate invite link for a "me_deben" debt
export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { deuda_id } = body;

  if (!deuda_id)
    return NextResponse.json({ error: 'deuda_id required' }, { status: 400 });

  // Verify ownership and type
  const { data: deuda } = await serviceClient
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
    inviteCode = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    await serviceClient
      .from('deudas')
      .update({ invite_code: inviteCode })
      .eq('id', deuda_id);
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.neto.pe';
  const link = `${baseUrl}/join/deuda/${inviteCode}`;

  return NextResponse.json({ invite_code: inviteCode, link });
}

// GET /api/debts/invite?code=xxx — public preview (no auth required)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code)
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });

  const { data: deuda } = await serviceClient
    .from('deudas')
    .select('id, contraparte, monto_original, monto_pendiente, moneda, descripcion, usuario_id, estado')
    .eq('invite_code', code)
    .single();

  if (!deuda)
    return NextResponse.json({ error: 'Invitacion invalida o expirada' }, { status: 404 });

  // Get creditor name
  const { data: acreedor } = await serviceClient
    .from('usuarios')
    .select('nombre')
    .eq('id', deuda.usuario_id)
    .single();

  // Check if already linked (someone already confirmed)
  const { count } = await serviceClient
    .from('deudas')
    .select('id', { count: 'exact', head: true })
    .eq('deuda_vinculada_id', deuda.id);

  return NextResponse.json({
    acreedor: acreedor?.nombre || 'Alguien',
    contraparte: deuda.contraparte,
    monto_original: deuda.monto_original,
    monto_pendiente: deuda.monto_pendiente,
    moneda: deuda.moneda,
    descripcion: deuda.descripcion,
    estado: deuda.estado,
    ya_confirmada: (count || 0) > 0,
  });
}
