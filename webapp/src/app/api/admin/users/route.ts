import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { requireAdminUser, type UserTxStatsRow } from '@/lib/admin';
import { isRevenueUser } from '@/lib/admin-revenue';

export const dynamic = 'force-dynamic';

interface UserActivityRow {
  user_id: string;
  tx_14d: number;
  tx_30d: number;
  first_tx_at: string | null;
  last_tx_at: string | null;
  last_activity_at: string | null;
}

export async function GET() {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getServiceClient();

  // Las tres lecturas son independientes, así que van juntas.
  //
  // La de counts era el cuello de botella real del panel: llamaba a
  // `count_transactions_by_user`, una RPC que NUNCA existió en esta base (verificado contra
  // pg_proc), así que el fallback "por si acaso" no era un fallback, era el único camino:
  // una query por usuario, 84 roundtrips secuenciales por cada carga de pantalla. Ahora es
  // una sola RPC agregada (migración 039), que además no puede truncarse a 1000 filas
  // porque devuelve una fila por usuario, no una por transacción.
  const [{ data: usuarios, error }, { data: txStats }, { data: activity }, { data: authList }] = await Promise.all([
    db
      .from('usuarios')
      .select(
        'id, whatsapp, is_test_user, cuenta_borrada_at, nombre, email, plan, trial_estado, trial_vence, onboarding_completado, gmail_access_token, created_at, premium_vence, premium_desde, supabase_auth_id, estado_pago, tipo_plan, fecha_pago, pago_pendiente',
      )
      .order('created_at', { ascending: false }),
    db.rpc('admin_user_tx_stats'),
    // Ventanas de actividad (14d/30d) + primera/ultima tx por usuario (migracion 042). Agrega en
    // SQL, una fila por usuario. Alimenta los segmentos de la pagina admin/users.
    db.rpc('admin_user_activity'),
    db.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const countMap: Record<string, number> = {};
  for (const row of (txStats as UserTxStatsRow[] | null) || []) {
    countMap[row.usuario_id] = Number(row.tx_count);
  }

  const activityMap: Record<string, UserActivityRow> = {};
  for (const row of (activity as UserActivityRow[] | null) || []) {
    activityMap[row.user_id] = row;
  }

  // Auth provider (google / magic link) para los usuarios que llegaron por la webapp.
  const providerMap: Record<string, string> = {};
  for (const au of authList?.users || []) {
    providerMap[au.id] = au.app_metadata?.provider || au.app_metadata?.providers?.[0] || 'unknown';
  }

  const result = (usuarios || []).map((u) => {
    // Determine canal: whatsapp (no webapp), google, magic_link (email)
    let canal: 'whatsapp' | 'google' | 'magic_link' = 'whatsapp';
    if (u.supabase_auth_id) {
      const provider = providerMap[u.supabase_auth_id] || 'unknown';
      canal = provider === 'google' ? 'google' : 'magic_link';
    }

    const act = activityMap[u.id];

    return {
      id: u.id,
      whatsapp: u.whatsapp,
      nombre: u.nombre,
      email: u.email,
      plan: u.plan || 'free',
      estado_pago: u.estado_pago,
      tipo_plan: u.tipo_plan,
      fecha_pago: u.fecha_pago,
      premium_vence: u.premium_vence,
      premium_desde: u.premium_desde,
      pago_pendiente: u.pago_pendiente,
      onboarding_completado: u.onboarding_completado,
      tiene_gmail: !!u.gmail_access_token,
      tiene_webapp: !!u.supabase_auth_id,
      canal,
      transacciones: countMap[u.id] || 0,
      created_at: u.created_at,
      // Actividad (migracion 042) para segmentar en la pagina admin/users. Operacion los ignora.
      tx_14d: act ? Number(act.tx_14d) : 0,
      tx_30d: act ? Number(act.tx_30d) : 0,
      first_tx_at: act?.first_tx_at ?? null,
      last_tx_at: act?.last_tx_at ?? null,
      last_activity_at: act?.last_activity_at ?? null,
      // Cuenta interna (fundador / QA / harness): la pagina de analisis la excluye de los
      // segmentos. Misma definicion que isRevenueUser, para que la lista y el MRR no marquen
      // distinto al mismo usuario.
      is_internal: !isRevenueUser(u),
      // Se traía en el select y no salía en la respuesta, así que la pantalla de operación
      // mostraba a quien pidió borrar su cuenta como cliente activo con `premium_vence` en
      // 2027. El plan NO se toca (quien pagó conserva su Pro si vuelve): lo que se arregla es
      // que la lista lo diga.
      cuenta_borrada_at: u.cuenta_borrada_at ?? null,
    };
  });

  return NextResponse.json({ ok: true, total: result.length, usuarios: result });
}

// Update user (plan, status, etc.)
export async function PUT(request: Request) {
  if (!(await requireAdminUser())) {
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
      const { error } = await getServiceClient().from('usuarios').update(updates).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'set_plan', plan });
    }

    case 'extend_premium': {
      const days = parseInt(data.days) || 30;
      // Get current premium_vence
      // admin-revenue:no-alimenta-metricas — lee UNA fila para sumarle días al vencimiento.
      // No es una métrica de ingreso: es la acción de extender Pro sobre un usuario puntual.
      const { data: user } = await getServiceClient().from('usuarios').select('premium_vence').eq('id', id).single();
      const base = user?.premium_vence ? new Date(user.premium_vence) : new Date();
      const newVence = new Date(base.getTime() + days * 86400000).toISOString().split('T')[0];
      const { error } = await getServiceClient().from('usuarios').update({
        premium_vence: newVence, plan: 'premium', estado_pago: 'pagado',
      }).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'extend_premium', premium_vence: newVence });
    }

    case 'deactivate': {
      // Deactivate: set plan to free, clear Gmail token, clear premium
      const { error } = await getServiceClient().from('usuarios').update({
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
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const db = getServiceClient();

  // Protección de pagadores: no borrar por accidente un cliente que ya pagó.
  // Los bots/free se borran sin fricción; para forzar un pagador, pasar ?force=1.
  const force = searchParams.get('force') === '1';
  if (!force) {
    const { data: pagoAprobado } = await db
      .from('pagos')
      .select('id')
      .eq('usuario_id', id)
      .eq('estado', 'aprobado')
      .limit(1)
      .maybeSingle();
    if (pagoAprobado) {
      return NextResponse.json(
        {
          error: 'protected',
          message: 'Este usuario tiene un pago aprobado. Confirma para borrarlo de todas formas.',
          requiresForce: true,
        },
        { status: 409 },
      );
    }
  }

  // El borrado en cascada lo maneja la base (FK ON DELETE CASCADE, migración
  // cascade_delete_usuarios_fks). Antes esto se hacía a mano tabla por tabla y la lista
  // quedaba incompleta (errores, neto_scores, meta_aportes, espacios...), lo que reventaba
  // el borrado con "error al eliminar". Ahora basta con borrar el usuario.
  const { error } = await db.from('usuarios').delete().eq('id', id);
  if (error) {
    return NextResponse.json(
      { error: error.message, message: 'No se pudo eliminar. Revisa dependencias en la base.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, action: 'deleted' });
}
