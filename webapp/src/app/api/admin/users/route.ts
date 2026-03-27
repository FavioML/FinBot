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

// Update user (plan, status, etc.)
export async function PUT(request: Request) {
  const email = await getAdminEmail();
  if (email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { id, action, ...data } = body;

  if (!id || !action) {
    return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
  }

  switch (action) {
    case 'set_plan': {
      const plan = data.plan === 'premium' ? 'premium' : 'free';
      const updates: Record<string, unknown> = { plan };
      if (plan === 'premium') {
        // Set premium_vence to 30 days from now by default, or use provided date
        const vence = data.premium_vence || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        updates.premium_vence = vence;
        updates.estado_pago = 'pagado';
      } else {
        updates.premium_vence = null;
        updates.estado_pago = null;
      }
      const { error } = await serviceClient.from('usuarios').update(updates).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'set_plan', plan });
    }

    case 'extend_premium': {
      const days = parseInt(data.days) || 30;
      // Get current premium_vence
      const { data: user } = await serviceClient.from('usuarios').select('premium_vence').eq('id', id).single();
      const base = user?.premium_vence ? new Date(user.premium_vence) : new Date();
      const newVence = new Date(base.getTime() + days * 86400000).toISOString().split('T')[0];
      const { error } = await serviceClient.from('usuarios').update({
        premium_vence: newVence, plan: 'premium', estado_pago: 'pagado',
      }).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'extend_premium', premium_vence: newVence });
    }

    case 'deactivate': {
      // Deactivate: set plan to free, clear Gmail token, clear premium
      const { error } = await serviceClient.from('usuarios').update({
        plan: 'free', premium_vence: null, estado_pago: null,
        gmail_access_token: null, gmail_refresh_token: null,
      }).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'deactivate' });
    }

    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}

// Delete user and all their data
export async function DELETE(request: Request) {
  const email = await getAdminEmail();
  if (email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // Delete related data first (cascading)
  await serviceClient.from('transacciones').delete().eq('usuario_id', id);
  await serviceClient.from('presupuestos').delete().eq('usuario_id', id);
  await serviceClient.from('metas_ahorro').delete().eq('usuario_id', id);
  await serviceClient.from('categorias_usuario').delete().eq('usuario_id', id);
  await serviceClient.from('reglas_comercio').delete().eq('usuario_id', id);
  await serviceClient.from('consultas_pendientes').delete().eq('usuario_id', id);
  await serviceClient.from('referidos').delete().eq('usuario_id', id);
  await serviceClient.from('nlp_errors').delete().eq('usuario_id', id);

  // Delete the user
  const { error } = await serviceClient.from('usuarios').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, action: 'deleted' });
}
