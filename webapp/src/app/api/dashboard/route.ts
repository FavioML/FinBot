import { requireLectura } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { isAdminAuthId } from '@/lib/admin';
import { NextResponse } from 'next/server';

/**
 * Fast-path de arranque del dashboard. Consolida en UN solo request serverless
 * lo que el overview antes pedía a ~8 API routes separadas (cada una un cold
 * start + su propia re-autenticación). Autentica una vez, corre todas las
 * queries en paralelo con el service client, y devuelve un JSON keyed por
 * dominio que el cliente usa para sembrar React Query.
 *
 * NO reemplaza los routes individuales (siguen sirviendo el refetch tras
 * mutaciones vía invalidateQueries). Este endpoint es solo el seed inicial.
 */

const HISTORY_MONTHS = 4;

// --- Alerts: mismo dedup + ventana "mes en curso" (zona Lima) que /api/alerts ---
interface AlertRow {
  id: string;
  type: 'spike' | 'ant' | 'recurring' | 'projection';
  category: string | null;
  amount: number;
  comparison_amount: number;
  message: string | null;
  action_taken: boolean;
  limit_set: number | null;
  created_at: string;
}

function inicioMesLimaISO(): string {
  const nowLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const y = nowLima.getFullYear();
  const m = String(nowLima.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01T00:00:00-05:00`;
}

function alertKey(a: AlertRow): string {
  if (a.type === 'ant') return 'ant';
  if (a.type === 'recurring') {
    const m = a.message?.match(/Compraste en (.+?) \d+ veces/);
    return `recurring:${m ? m[1] : a.message ?? a.id}`;
  }
  return `${a.type}:${a.category ?? ''}`;
}

function dedupeAlerts(rows: AlertRow[], limit: number): AlertRow[] {
  const seen = new Set<string>();
  const out: AlertRow[] = [];
  for (const a of rows) {
    const key = alertKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.slice(0, limit);
}

const SCORE_COLS =
  'score, factor_consistency, factor_budget, factor_savings, factor_goals, factor_debts, factor_visibility, period';

interface ScoreRow {
  score: number | null;
  factor_consistency: number | null;
  factor_budget: number | null;
  factor_savings: number | null;
  factor_goals: number | null;
  factor_debts: number | null;
  factor_visibility: number | null;
  period: string;
}

function factorsFromRow(row: ScoreRow) {
  return {
    consistency: row.factor_consistency ?? 0,
    budget: row.factor_budget ?? 0,
    savings: row.factor_savings ?? 0,
    goals: row.factor_goals ?? 0,
    debts: row.factor_debts ?? 0,
    visibility: row.factor_visibility ?? 0,
  };
}

export async function GET(request: Request) {
  // Keep-warm ping del cron del backend (Railway, ver cron/index.js → keepWarmWebapp):
  // arranca el lambda de Vercel sin pagar auth ni queries, para que la primera
  // visita real de un usuario no coma el cold start (~900ms). Retorno barato.
  if (new URL(request.url).searchParams.has('warm')) {
    return NextResponse.json({ warm: true });
  }

  const auth = await requireLectura('*');
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  const svc = getServiceClient();

  const userId = usuario.id as string;
  const isPro = usuario.plan === 'premium';

  const historySince = new Date();
  historySince.setMonth(historySince.getMonth() - HISTORY_MONTHS);
  const historySinceISO = historySince.toISOString().split('T')[0];

  const [
    txsRes,
    ownGoalsRes,
    participationsRes,
    debtsRes,
    achievementsRes,
    notifsRes,
    unreadRes,
    scoreRowRes,
    historyRes,
    alertsRes,
    gmailRes,
  ] = await Promise.all([
    svc.from('transacciones').select('*').eq('usuario_id', userId).order('fecha', { ascending: false }),
    svc.from('metas_ahorro').select('*, meta_aportes(*)').eq('usuario_id', userId).order('created_at', { ascending: false }),
    svc.from('meta_participantes').select('meta_id').eq('usuario_id', userId),
    svc.from('deudas').select('*, deuda_abonos(id, monto, fecha, nota, created_at)').eq('usuario_id', userId).order('created_at', { ascending: false }),
    svc.from('logros').select('*').eq('usuario_id', userId).order('created_at', { ascending: false }),
    svc.from('notificaciones').select('*').eq('usuario_id', userId).order('fecha', { ascending: false }).limit(20),
    svc.from('notificaciones').select('id', { count: 'exact', head: true }).eq('usuario_id', userId).eq('leida', false),
    svc.from('neto_scores').select(SCORE_COLS).eq('user_id', userId).order('period', { ascending: false }).limit(1),
    svc.from('neto_scores').select(SCORE_COLS).eq('user_id', userId).gte('period', historySinceISO).order('period', { ascending: true }),
    svc.from('spending_alerts').select('*').eq('user_id', userId).gte('created_at', inicioMesLimaISO()).order('created_at', { ascending: false }).limit(100),
    // Estado de la conexión de Gmail. Viaja acá y no en un fetch propio del banner a
    // /api/pro/status a propósito: ese fan-out de requests es justo lo que este endpoint
    // existe para matar, y el aviso de "tu Gmail se cayó" tiene que estar disponible en el
    // primer paint de CUALQUIER pantalla del dashboard, no solo de /dashboard/pro.
    svc.from('gmail_cuentas').select('auth_error_at').eq('usuario_id', userId).eq('activa', true).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  // Goals: incluir metas colaborativas en las que participo (paridad con /api/goals)
  const ownGoals = ownGoalsRes.data || [];
  const participatedIds = (participationsRes.data || [])
    .map((p) => p.meta_id)
    .filter((id) => !ownGoals.some((g) => g.id === id));
  let participatedGoals: typeof ownGoals = [];
  if (participatedIds.length > 0) {
    const { data: pGoals } = await svc
      .from('metas_ahorro')
      .select('*, meta_aportes(*)')
      .in('id', participatedIds)
      .order('created_at', { ascending: false });
    participatedGoals = pGoals || [];
  }

  // Score actual: servir la fila persistida (el cron 6am es la fuente de verdad).
  // Si no hay fila (usuario nuevo), score=null y el cliente cae a /api/score.
  const scoreRow = (scoreRowRes.data?.[0] as ScoreRow | undefined) ?? null;
  const score =
    scoreRow && scoreRow.score != null
      ? { score: scoreRow.score, period: scoreRow.period, ...(isPro ? { factors: factorsFromRow(scoreRow) } : {}) }
      : null;

  // Historial: dedup a la última fila por mes (YYYY-MM), igual que /api/score.
  const latestByMonth = new Map<string, ScoreRow>();
  for (const h of (historyRes.data as ScoreRow[] | null) || []) {
    const ym = (h.period || '').slice(0, 7);
    if (!ym) continue;
    latestByMonth.set(ym, h);
  }
  const dedupedHistory = Array.from(latestByMonth.values());
  const history = isPro
    ? dedupedHistory.map((h) => ({
        score: h.score,
        period: h.period,
        factor_consistency: h.factor_consistency,
        factor_budget: h.factor_budget,
        factor_savings: h.factor_savings,
        factor_goals: h.factor_goals,
        factor_debts: h.factor_debts,
        factor_visibility: h.factor_visibility,
      }))
    : dedupedHistory.map((h) => ({ score: h.score, period: h.period }));

  const alerts = dedupeAlerts((alertsRes.data || []) as AlertRow[], 10);

  return NextResponse.json({
    user: usuario,
    transactions: txsRes.data || [],
    goals: [...ownGoals, ...participatedGoals],
    debts: debtsRes.data || [],
    achievements: achievementsRes.data || [],
    notifications: { notifications: notifsRes.data || [], unreadCount: unreadRes.count || 0 },
    score,
    scoreHistory: { history },
    alerts: { alerts, isPro },
    gmail: { authErrorAt: (gmailRes.data?.auth_error_at as string | null) ?? null },
    isAdmin: isAdminAuthId(auth.authId),
  });
}
