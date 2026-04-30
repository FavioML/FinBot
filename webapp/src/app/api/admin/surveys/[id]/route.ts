import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

// Admin-only: mark a survey event as read (responded_at) and persist who acked it.
// The marker lives inside response_data.acked_by so we don't need a column migration.
export async function PATCH(request: Request, { params }: Params) {
  const admin = await requireAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: 'mark_read';
  };

  if (body.action !== 'mark_read') {
    return NextResponse.json({ error: 'Acción no soportada' }, { status: 400 });
  }

  const db = getServiceClient();
  const { data: existing, error: readErr } = await db
    .from('survey_events')
    .select('id, response_data')
    .eq('id', id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
  }

  const now = new Date().toISOString();
  const prev =
    existing.response_data && typeof existing.response_data === 'object'
      ? (existing.response_data as Record<string, unknown>)
      : {};
  const merged = { ...prev, acked_by: admin.id, acked_at: now };

  const { error: updErr } = await db
    .from('survey_events')
    .update({ responded_at: now, response_data: merged })
    .eq('id', id);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
