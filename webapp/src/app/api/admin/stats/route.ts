import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import {
  computeRevenue,
  cajaDelMes,
  isRevenueUser,
  computeChurn,
  mrrAtMonthEnd,
  newProInMonth,
  churnedInMonth,
  EXCLUDED_REVENUE_WHATSAPP,
} from '@/lib/admin-revenue';
import { startOfDayLima, startOfMonthLima } from '@/lib/date-lima';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'faviomendoza27jl@gmail.com';

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

  const db = getServiceClient();
  const now = new Date();
  // "Hoy" en día Lima (UTC-5): Lima 00:00 = UTC 05:00. Ver lib/date-lima.ts.
  const todayLimaIso = startOfDayLima(now).toISOString();

  // 7 days ago
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  // 30 days ago
  const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

  // Fetch all users
  const { data: usuarios } = await db
    .from('usuarios')
    .select('id, whatsapp, plan, tipo_plan, onboarding_completado, created_at, premium_desde, premium_vence, supabase_auth_id');

  const allUsers = usuarios || [];
  const totalUsers = allUsers.length;

  // --- Revenue KPIs (solo usuarios reales: excluye fundador + QA) ---
  // MRR normalizado (anual = S/99÷12), ARR, y desglose anual/mensual. Ver admin-revenue.ts.
  const rev = computeRevenue(allUsers);
  const mrr = rev.mrr;
  const arr = rev.arr;
  const realUsers = allUsers.filter(isRevenueUser);
  const conversionRate =
    realUsers.length > 0 ? Math.round((rev.proCount / realUsers.length) * 1000) / 10 : 0;

  // Caja real cobrada este mes (pagos aprobados), distinta del MRR recurrente.
  const startMonthIso = startOfMonthLima(now).toISOString(); // inicio de mes día Lima
  const excludedIds = new Set(
    allUsers.filter((u) => u.whatsapp && EXCLUDED_REVENUE_WHATSAPP.has(u.whatsapp)).map((u) => u.id),
  );
  const { data: pagosMes } = await db
    .from('pagos')
    .select('monto, estado, aprobado_at, created_at, usuario_id')
    .gte('created_at', startMonthIso);
  const cajaMes = cajaDelMes(pagosMes || [], excludedIds, startMonthIso);

  // Churn 30d (fuente única: computeChurn, excluye internos, base = churned + pro reales).
  // Idéntico a economics para que no diverjan las dos rutas.
  const churnRate = computeChurn(allUsers, now).rate;

  // DAU: distinct users with transactions today.
  // Bug previo: usaba count:'exact' que cuenta FILAS (transacciones), no usuarios distintos,
  // así que DAU podía salir mayor que WAU (un user con 15 tx hoy daba DAU=15). Debe contar
  // usuarios distintos como WAU/MAU para respetar el invariante DAU <= WAU <= MAU.
  const { data: dauData } = await db
    .from('transacciones')
    .select('usuario_id')
    .gte('created_at', todayLimaIso);
  const dau = new Set((dauData || []).map((t) => t.usuario_id)).size;

  // WAU: distinct users with transactions this week
  const { data: wauData } = await db
    .from('transacciones')
    .select('usuario_id')
    .gte('created_at', weekAgo);
  const wau = new Set((wauData || []).map((t) => t.usuario_id)).size;

  // MAU: distinct users with transactions this month
  const { data: mauData } = await db
    .from('transacciones')
    .select('usuario_id')
    .gte('created_at', monthAgo);
  const mau = new Set((mauData || []).map((t) => t.usuario_id)).size;

  // Txs per active user this month
  const totalTxMonth = (mauData || []).length;
  const txPerActiveUser = mau > 0 ? Math.round((totalTxMonth / mau) * 10) / 10 : 0;

  // Avg time to first transaction (days)
  const { data: firstTxData } = await db
    .from('transacciones')
    .select('usuario_id, created_at')
    .order('created_at', { ascending: true });

  const firstTxByUser: Record<string, string> = {};
  for (const tx of firstTxData || []) {
    if (!firstTxByUser[tx.usuario_id]) {
      firstTxByUser[tx.usuario_id] = tx.created_at;
    }
  }

  let totalDaysToFirstTx = 0;
  let usersWithTx = 0;
  for (const u of allUsers) {
    const firstTx = firstTxByUser[u.id];
    if (firstTx) {
      const days = (new Date(firstTx).getTime() - new Date(u.created_at).getTime()) / 86400000;
      totalDaysToFirstTx += Math.max(0, days);
      usersWithTx++;
    }
  }
  const avgTimeToFirstTx = usersWithTx > 0 ? Math.round((totalDaysToFirstTx / usersWithTx) * 10) / 10 : 0;

  // --- User Growth (last 12 weeks) ---
  const userGrowth: { week: string; free: number; pro: number; total: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    // Semanas alineadas a día Lima (igual que economics) para que ambos charts coincidan.
    const weekStart = startOfDayLima(new Date(now.getTime() - (i + 1) * 7 * 86400000));
    const weekEnd = startOfDayLima(new Date(now.getTime() - i * 7 * 86400000));
    const weekLabel = `${String(weekStart.getUTCDate()).padStart(2, '0')}/${String(weekStart.getUTCMonth() + 1).padStart(2, '0')}`;

    const newUsers = allUsers.filter((u) => {
      const d = new Date(u.created_at);
      return d >= weekStart && d < weekEnd;
    });

    userGrowth.push({
      week: weekLabel,
      free: newUsers.filter((u) => u.plan !== 'premium').length,
      pro: newUsers.filter((u) => u.plan === 'premium').length,
      total: newUsers.length,
    });
  }

  // --- Onboarding Funnel ---
  // Solo pasos anidados y monotónicos: registro → onboarding → 1a tx → Pro.
  // "Webapp" NO va en el embudo (no es downstream de 1a tx: un user puede tener webapp
  // sin transacción), va aparte como métrica de cobertura para no simular un embudo falso.
  const registered = totalUsers;
  const onboardingComplete = allUsers.filter((u) => u.onboarding_completado).length;
  const withFirstTx = Object.keys(firstTxByUser).length;

  const funnel = {
    registered,
    onboardingComplete,
    firstTransaction: withFirstTx,
    pro: rev.proCount, // Pro reales (excluye internos), coherente con MRR
  };
  // Cobertura webapp (Google OAuth + Magic Link): transversal, fuera del embudo.
  const webappCoverage = allUsers.filter((u) => !!u.supabase_auth_id).length;

  // --- NLP Errors per day (last 30 days) ---
  const { data: nlpRaw } = await db
    .from('nlp_errors')
    .select('created_at')
    .neq('error_tipo', 'rate_limit') // 429 de OpenAI es infra, no NLP: fuera del chart
    .gte('created_at', monthAgo)
    .order('created_at', { ascending: true });

  const nlpByDay: Record<string, number> = {};
  // Initialize all 30 days
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
    nlpByDay[key] = 0;
  }
  for (const err of nlpRaw || []) {
    const d = new Date(err.created_at);
    const key = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
    if (key in nlpByDay) nlpByDay[key]++;
  }

  const nlpActivity = Object.entries(nlpByDay).map(([date, errors]) => ({ date, errors }));

  // --- Revenue (last 6 months) ---
  const revenue: { month: string; mrr: number; newPro: number; churned: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const mDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    const monthLabel = mDate.toLocaleDateString('es-PE', { month: 'short', year: '2-digit' });

    revenue.push({
      month: monthLabel,
      // Mes en curso (i=0): MRR vivo (headline) para que el último punto == KPI MRR.
      // Meses pasados: reconstruido desde premium_desde/premium_vence (no created_at ni
      // la heurística vence−30d). Solo negocio real (excluye internos). Idéntico a economics.
      mrr: i === 0 ? mrr : mrrAtMonthEnd(allUsers, mEnd),
      newPro: newProInMonth(allUsers, mDate, mEnd),
      churned: churnedInMonth(allUsers, mDate, mEnd),
    });
  }

  return NextResponse.json({
    ok: true,
    kpis: {
      mrr,
      arr,
      cajaMes,
      proReal: rev.proCount,
      proMonthly: rev.proMonthly,
      proYearly: rev.proYearly,
      churnRate,
      dau,
      wau,
      mau,
      conversionRate,
      avgTimeToFirstTx,
      txPerActiveUser,
    },
    userGrowth,
    funnel,
    webappCoverage,
    nlpActivity,
    revenue,
  });
}
