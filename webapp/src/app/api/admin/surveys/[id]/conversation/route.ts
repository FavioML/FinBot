import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import type { SurveyConversationMessage } from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: Params) {
  const admin = await requireAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const { id } = await params;
  const db = getServiceClient();

  const { data: event, error: eventErr } = await db
    .from('survey_events')
    .select('id, user_id, sent_at, responded_at')
    .eq('id', id)
    .maybeSingle();

  if (eventErr) {
    return NextResponse.json({ error: eventErr.message }, { status: 500 });
  }
  if (!event) {
    return NextResponse.json({ error: 'Evento no encontrado' }, { status: 404 });
  }

  const since = event.sent_at ?? event.responded_at;
  if (!since) {
    return NextResponse.json({ messages: [], event });
  }

  const { data: messages, error } = await db
    .from('conversaciones')
    .select('id, rol, mensaje, created_at')
    .eq('usuario_id', event.user_id)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    messages: (messages ?? []) as SurveyConversationMessage[],
    event,
  });
}
