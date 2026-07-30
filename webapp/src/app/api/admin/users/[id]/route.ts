import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import type { AdminUserFeatures, AdminUserNps } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

// Ficha individual de un usuario para el drill-down de admin/users (Ola 4 Fase 2).
// features viene del RPC admin_user_features (043, conteos + LTV agregados en SQL). nps es la
// última respuesta NPS in-app del usuario, si respondió.
export async function GET(_request: Request, { params }: Params) {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const db = getServiceClient();
  const [{ data: features, error: fErr }, { data: nps }] = await Promise.all([
    db.rpc('admin_user_features', { p_user_id: id }),
    db
      .from('survey_events')
      .select('response_data, responded_at')
      .eq('user_id', id)
      .eq('event_type', 'nps_inapp')
      .not('responded_at', 'is', null)
      .order('responded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (fErr) {
    return NextResponse.json({ error: fErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    features: (features as AdminUserFeatures | null) ?? null,
    nps: (nps as AdminUserNps | null) ?? null,
  });
}
