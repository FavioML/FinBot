import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import type {
  SurveyEvent,
  SurveyEventType,
  SurveyStats,
  SurveyTypeStats,
  NpsResponseData,
} from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

const REMINDER_TYPES: SurveyEventType[] = [
  'reminder_d3',
  'reminder_d7',
  'reminder_d14',
  'reminder_d30',
];

interface RawSurveyRow {
  id: string;
  user_id: string;
  event_type: SurveyEventType;
  channel: 'whatsapp' | 'webapp';
  triggered_at: string;
  sent_at: string | null;
  responded_at: string | null;
  dismissed_at: string | null;
  message_sent: string | null;
  response_data: SurveyEvent['response_data'];
  conversion_within_24h: boolean;
  conversion_within_7d: boolean;
  opted_out_after: boolean;
  created_at: string;
}

interface RawUsuario {
  id: string;
  nombre: string | null;
  whatsapp: string | null;
}

function emptyTypeStats(): SurveyTypeStats {
  return {
    count_sent: 0,
    count_responded: 0,
    count_dismissed: 0,
    response_rate: 0,
    opt_out_rate: 0,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const eventType = searchParams.get('event_type');
  const from = searchParams.get('from');

  const db = getServiceClient();

  let query = db
    .from('survey_events')
    .select(
      'id, user_id, event_type, channel, triggered_at, sent_at, responded_at, dismissed_at, message_sent, response_data, conversion_within_24h, conversion_within_7d, opted_out_after, created_at',
    )
    .order('sent_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (eventType) query = query.eq('event_type', eventType);
  if (from) query = query.gte('sent_at', from);

  const { data: rawEvents, error } = await query;
  if (error) {
    return NextResponse.json(
      { error: 'No se pudieron leer encuestas', detail: error.message },
      { status: 500 },
    );
  }

  const events = (rawEvents ?? []) as RawSurveyRow[];

  // Hydrate user info
  const userIds = Array.from(new Set(events.map((e) => e.user_id)));
  const usuariosById = new Map<string, RawUsuario>();
  if (userIds.length > 0) {
    const { data: usuarios } = await db
      .from('usuarios')
      .select('id, nombre, whatsapp')
      .in('id', userIds);
    for (const u of (usuarios ?? []) as RawUsuario[]) {
      usuariosById.set(u.id, u);
    }
  }

  const enriched: SurveyEvent[] = events.map((e) => {
    const u = usuariosById.get(e.user_id);
    return {
      ...e,
      user_nombre: u?.nombre ?? null,
      user_whatsapp: u?.whatsapp ?? null,
    };
  });

  // Compute stats — always over the full table (not just filtered slice) so the
  // KPI row stays meaningful even when the user filters the table.
  const { data: statsRows } = await db
    .from('survey_events')
    .select(
      'event_type, sent_at, responded_at, dismissed_at, conversion_within_24h, conversion_within_7d, opted_out_after, response_data',
    );

  const all = (statsRows ?? []) as Array<
    Pick<
      RawSurveyRow,
      | 'event_type'
      | 'sent_at'
      | 'responded_at'
      | 'dismissed_at'
      | 'conversion_within_24h'
      | 'conversion_within_7d'
      | 'opted_out_after'
      | 'response_data'
    >
  >;

  const byType: Partial<Record<SurveyEventType, SurveyTypeStats>> = {};
  const npsAccum = { ease: 0, usefulness: 0, recommend: 0, count: 0 };

  for (const row of all) {
    const t = row.event_type;
    if (!byType[t]) byType[t] = emptyTypeStats();
    const s = byType[t]!;

    if (row.sent_at) s.count_sent += 1;
    if (row.responded_at) s.count_responded += 1;
    if (row.dismissed_at) s.count_dismissed += 1;
    if (row.opted_out_after) {
      // count opted_out separately via opt_out_rate calc below
    }

    if (t === 'nps_inapp' && row.responded_at && row.response_data) {
      const d = row.response_data as Partial<NpsResponseData>;
      if (
        typeof d.ease === 'number' &&
        typeof d.usefulness === 'number' &&
        typeof d.recommend === 'number'
      ) {
        npsAccum.ease += d.ease;
        npsAccum.usefulness += d.usefulness;
        npsAccum.recommend += d.recommend;
        npsAccum.count += 1;
      }
    }
  }

  // opt_out and conversion rates need a second pass (need totals first)
  for (const t of Object.keys(byType) as SurveyEventType[]) {
    const s = byType[t]!;
    const sent = s.count_sent || 1; // avoid div-by-zero
    s.response_rate = round1((s.count_responded / sent) * 100);

    let optOut = 0;
    let conv24 = 0;
    let conv7 = 0;
    let convDenom = 0;
    for (const row of all) {
      if (row.event_type !== t) continue;
      if (row.opted_out_after) optOut += 1;
      if (row.sent_at) {
        convDenom += 1;
        if (row.conversion_within_24h) conv24 += 1;
        if (row.conversion_within_7d) conv7 += 1;
      }
    }
    s.opt_out_rate = round1((optOut / sent) * 100);

    if (t === 'webapp_invite_10tx' && convDenom > 0) {
      s.conversion_rate = round1((conv7 / convDenom) * 100);
    } else if (REMINDER_TYPES.includes(t) && convDenom > 0) {
      s.conversion_rate = round1((conv24 / convDenom) * 100);
    }

    if (t === 'nps_inapp' && npsAccum.count > 0) {
      s.nps_avg_ease = round1(npsAccum.ease / npsAccum.count);
      s.nps_avg_usefulness = round1(npsAccum.usefulness / npsAccum.count);
      s.nps_avg_recommend = round1(npsAccum.recommend / npsAccum.count);
    }
  }

  const totals = {
    total_sent: all.filter((r) => !!r.sent_at).length,
    total_responded: all.filter((r) => !!r.responded_at).length,
  };

  const stats: SurveyStats = { by_event_type: byType, totals };

  return NextResponse.json({ events: enriched, stats });
}
