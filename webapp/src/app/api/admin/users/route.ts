import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const ADMIN_EMAIL = 'faviomendoza27jl@gmail.com';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getAdminEmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email || null;
}

export const dynamic = 'force-dynamic';

export async function GET() {
  const email = await getAdminEmail();
  if (email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Fetch all users
  const { data: usuarios, error } = await serviceClient
    .from('usuarios')
    .select(
      'id, whatsapp, nombre, email, plan, onboarding_completado, gmail_access_token, created_at, premium_vence, supabase_auth_id, estado_pago, tipo_plan, fecha_pago',
    )
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Get transaction counts per user
  const userIds = (usuarios || []).map((u) => u.id);
  const { data: txCounts } = await serviceClient.rpc('count_transactions_by_user', {
    user_ids: userIds,
  });

  // Fallback: count manually if RPC doesn't exist
  let countMap: Record<string, number> = {};
  if (txCounts) {
    for (const row of txCounts) {
      countMap[row.usuario_id] = row.count;
    }
  } else {
    // Simple fallback — count per user
    for (const u of usuarios || []) {
      const { count } = await serviceClient
        .from('transacciones')
        .select('*', { count: 'exact', head: true })
        .eq('usuario_id', u.id);
      countMap[u.id] = count || 0;
    }
  }

  const result = (usuarios || []).map((u) => ({
    id: u.id,
    whatsapp: u.whatsapp,
    nombre: u.nombre,
    email: u.email,
    plan: u.plan || 'free',
    estado_pago: u.estado_pago,
    tipo_plan: u.tipo_plan,
    fecha_pago: u.fecha_pago,
    premium_vence: u.premium_vence,
    onboarding_completado: u.onboarding_completado,
    tiene_gmail: !!u.gmail_access_token,
    tiene_webapp: !!u.supabase_auth_id,
    transacciones: countMap[u.id] || 0,
    created_at: u.created_at,
  }));

  return NextResponse.json({ ok: true, total: result.length, usuarios: result });
}
