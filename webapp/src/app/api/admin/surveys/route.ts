import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import type {
  SurveyEvent,
  SurveyEventType,
  SurveyStats,
  SurveyTypeStats,
} from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

const REMINDER_TYPES: SurveyEventType[] = [
  'reminder_d3',
  'reminder_d7',
  'reminder_d14',
  'reminder_d30',
  'inactivity_reminder',
];

// Los unicos event_type que el panel renderiza (5 tabs). El listado y los stats se scopean a
// estos: los wake_up_inactive / wake_up_onboarding (sistema legado, migraciones 010-013) no
// tienen tab ni label en la UI, asi que traerlos era 70 de 180 filas de payload muerto.
const DISPLAY_TYPES: SurveyEventType[] = [
  'reminder_d3',
  'reminder_d7',
  'reminder_d14',
  'reminder_d30',
  'webapp_invite_10tx',
  'feedback_open_30tx',
  'nps_inapp',
  'inactivity_reminder',
  'pro_upsell_d28',
];

// Ventana del listado. PostgREST corta en 1000 filas en esta instancia (db-max-rows=1000), asi
// que pedir mas en una sola request es imposible: el techo es duro. El listado muestra los mas
// recientes; los stats (globales, en SQL) no dependen de esta ventana, y `total`/`hasMore`
// avisan cuando hay mas de lo que cabe. Ver migracion 040.
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const PRO_UPSELL_WINDOW_DAYS = 30;

interface RawSurveyRow {
  id: string;
  user_id: string;
  event_type: SurveyEventType;
  channel: 'whatsapp' | 'webapp';
  triggered_at: string;
  sent_at: string | null;
  responded_at: string | null;
  dismissed_at: string | null;
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
  plan: 'free' | 'premium' | null;
  fecha_pago: string | null;
}

// Fila cruda de admin_survey_stats() (migracion 040). El service client no esta tipado con el
// schema generado, asi que sin esto las filas quedarian en `any`.
interface SurveyStatsRow {
  event_type: string;
  count_sent: number | string;
  count_responded: number | string;
  count_dismissed: number | string;
  count_opted_out: number | string;
  count_conv24: number | string;
  count_conv7: number | string;
  nps_sum_ease: number | string;
  nps_sum_usefulness: number | string;
  nps_sum_recommend: number | string;
  nps_count: number | string;
  upsell_denom: number | string;
  count_converted_to_pro: number | string;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Arma SurveyStats desde los agregados en SQL. Aca solo quedan divisiones sobre conteos ya
// hechos: la rama "que tasa aplica a que tipo" (conv24 para recordatorios, conv7 para invites)
// vive donde es legible, no en un bucle sobre filas crudas.
function buildStats(rows: SurveyStatsRow[]): SurveyStats {
  const byType: Partial<Record<SurveyEventType, SurveyTypeStats>> = {};
  let totalSent = 0;
  let totalResponded = 0;

  for (const r of rows) {
    const t = r.event_type as SurveyEventType;
    const sent = Number(r.count_sent);
    const responded = Number(r.count_responded);
    const dismissed = Number(r.count_dismissed);
    const optedOut = Number(r.count_opted_out);
    const conv24 = Number(r.count_conv24);
    const conv7 = Number(r.count_conv7);
    const npsCount = Number(r.nps_count);
    const upsellDenom = Number(r.upsell_denom);
    const convertedToPro = Number(r.count_converted_to_pro);

    totalSent += sent;
    totalResponded += responded;

    const denom = sent || 1; // evita div-by-zero, igual que la version anterior
    const s: SurveyTypeStats = {
      count_sent: sent,
      count_responded: responded,
      count_dismissed: dismissed,
      response_rate: round1((responded / denom) * 100),
      opt_out_rate: round1((optedOut / denom) * 100),
    };

    if (t === 'webapp_invite_10tx' && sent > 0) {
      s.conversion_rate = round1((conv7 / sent) * 100);
    } else if (REMINDER_TYPES.includes(t) && sent > 0) {
      s.conversion_rate = round1((conv24 / sent) * 100);
    }

    if (t === 'pro_upsell_d28') {
      s.count_converted_to_pro = convertedToPro;
      if (upsellDenom > 0) {
        s.conversion_to_pro_rate = round1((convertedToPro / upsellDenom) * 100);
      }
    }

    if (t === 'nps_inapp' && npsCount > 0) {
      s.nps_avg_ease = round1(Number(r.nps_sum_ease) / npsCount);
      s.nps_avg_usefulness = round1(Number(r.nps_sum_usefulness) / npsCount);
      s.nps_avg_recommend = round1(Number(r.nps_sum_recommend) / npsCount);
    }

    byType[t] = s;
  }

  return { by_event_type: byType, totals: { total_sent: totalSent, total_responded: totalResponded } };
}

export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const eventType = searchParams.get('event_type');
  const from = searchParams.get('from');
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );
  const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0);

  const db = getServiceClient();

  // Listado: ventana acotada y contada. `count: 'exact'` + `.range()` reemplazan el .select()
  // sin limite que dependia del techo implicito de PostgREST y truncaba en silencio.
  let query = db
    .from('survey_events')
    .select(
      'id, user_id, event_type, channel, triggered_at, sent_at, responded_at, dismissed_at, response_data, conversion_within_24h, conversion_within_7d, opted_out_after, created_at',
      { count: 'exact' },
    )
    .in('event_type', eventType ? [eventType] : DISPLAY_TYPES)
    .order('sent_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (from) query = query.gte('sent_at', from);

  // Stats globales en SQL (no dependen de la ventana del listado). Independiente del listado,
  // asi que van en paralelo.
  const [listRes, statsRes] = await Promise.all([
    query,
    db.rpc('admin_survey_stats'),
  ]);

  if (listRes.error) {
    return NextResponse.json(
      { error: 'No se pudieron leer encuestas', detail: listRes.error.message },
      { status: 500 },
    );
  }
  if (statsRes.error) {
    return NextResponse.json(
      { error: 'No se pudieron leer stats de encuestas', detail: statsRes.error.message },
      { status: 500 },
    );
  }

  const events = (listRes.data ?? []) as RawSurveyRow[];
  const total = listRes.count ?? events.length;
  const hasMore = offset + events.length < total;

  // Hidrata info de usuario solo para la pagina devuelta.
  const userIds = Array.from(new Set(events.map((e) => e.user_id)));
  const usuariosById = new Map<string, RawUsuario>();
  if (userIds.length > 0) {
    const { data: usuarios } = await db
      // admin-revenue:no-alimenta-metricas — esta lectura es para PONERLE NOMBRE a quien
      // respondió una encuesta, no para contar plata. No pasa por `computeRevenue` ni por
      // `isRevenueUser`, así que traer `is_test_user`/`cuenta_borrada_at` sería carga muerta.
      .from('usuarios')
      .select('id, nombre, whatsapp, plan, fecha_pago')
      .in('id', userIds);
    for (const u of (usuarios ?? []) as RawUsuario[]) {
      usuariosById.set(u.id, u);
    }
  }

  const enriched: SurveyEvent[] = events.map((e) => {
    const u = usuariosById.get(e.user_id);
    const base: SurveyEvent = {
      ...e,
      user_nombre: u?.nombre ?? null,
      user_whatsapp: u?.whatsapp ?? null,
      user_plan: u?.plan ?? null,
      user_fecha_pago: u?.fecha_pago ?? null,
    };

    // Los campos de conversion a Pro por fila (para la tabla del tab Pro upsell) se derivan
    // aca; el AGREGADO global va por SQL (migracion 040), no se recalcula desde esta pagina.
    if (e.event_type === 'pro_upsell_d28' && e.sent_at) {
      const sentTs = new Date(e.sent_at).getTime();
      const fechaPago = u?.fecha_pago ? new Date(u.fecha_pago).getTime() : null;
      const isPremiumNow = u?.plan === 'premium';
      const wasProAtSend = isPremiumNow && fechaPago !== null && fechaPago < sentTs;
      const windowEnd = sentTs + PRO_UPSELL_WINDOW_DAYS * 86400000;
      const convertedToPro =
        isPremiumNow &&
        fechaPago !== null &&
        fechaPago >= sentTs &&
        fechaPago <= windowEnd;
      const daysToConversion =
        convertedToPro && fechaPago !== null
          ? Math.max(0, Math.round((fechaPago - sentTs) / 86400000))
          : null;
      base.converted_to_pro = convertedToPro;
      base.was_pro_at_send = wasProAtSend;
      base.days_to_conversion = daysToConversion;
    }

    return base;
  });

  const stats = buildStats((statsRes.data ?? []) as SurveyStatsRow[]);

  return NextResponse.json({ events: enriched, stats, total, hasMore });
}
