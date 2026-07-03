import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import {
  computeRevenue,
  cajaDelMes,
  isRevenueUser,
  monthlyValuePen,
  EXCLUDED_REVENUE_WHATSAPP,
} from '@/lib/admin-revenue';

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
  const todayStr = now.toISOString().split('T')[0];

  // 7 days ago
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  // 30 days ago
  const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

  // Fetch all users
  const { data: usuarios } = await db
    .from('usuarios')
    .select('id, whatsapp, plan, tipo_plan, onboarding_completado, created_at, premium_vence, supabase_auth_id');

  const allUsers = usuarios || [];
  const totalUsers = allUsers.length;
  const proUsers = allUsers.filter((u) => u.plan === 'premium');
  const totalPro = proUsers.length;

  // --- Revenue KPIs (solo usuarios reales: excluye fundador + QA) ---
  // MRR normalizado (anual = S/99÷12), ARR, y desglose anual/mensual. Ver admin-revenue.ts.
  const rev = computeRevenue(allUsers);
  const mrr = rev.mrr;
  const arr = rev.arr;
  const realUsers = allUsers.filter(isRevenueUser);
  const conversionRate =
    realUsers.length > 0 ? Math.round((rev.proCount / realUsers.length) * 1000) / 10 : 0;

  // Caja real cobrada este mes (pagos aprobados), distinta del MRR recurrente.
  const startMonthIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const excludedIds = new Set(
    allUsers.filter((u) => u.whatsapp && EXCLUDED_REVENUE_WHATSAPP.has(u.whatsapp)).map((u) => u.id),
  );
  const { data: pagosMes } = await db
    .from('pagos')
    .select('monto, estado, aprobado_at, created_at, usuario_id')
    .gte('created_at', startMonthIso);
  const cajaMes = cajaDelMes(pagosMes || [], excludedIds, startMonthIso);

  // Churn: users whose premium_vence expired in last 30 days and are now free
  const churnedUsers = allUsers.filter((u) => {
    if (u.plan !== 'free' || !u.premium_vence) return false;
    const vence = new Date(u.premium_vence);
    const daysAgo30 = new Date(now.getTime() - 30 * 86400000);
    return vence >= daysAgo30 && vence < now;
  });
  // Churn rate = churned / (churned + current pro) * 100
  const churnBase = churnedUsers.length + totalPro;
  const churnRate = churnBase > 0 ? Math.round((churnedUsers.length / churnBase) * 1000) / 10 : 0;

  // DAU: users with transactions today
  const { count: dauCount } = await db
    .from('transacciones')
    .select('usuario_id', { count: 'exact', head: true })
    .gte('created_at', todayStr);
  const dau = dauCount || 0;

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
    const weekStart = new Date(now.getTime() - (i + 1) * 7 * 86400000);
    const weekEnd = new Date(now.getTime() - i * 7 * 86400000);
    const weekLabel = `${weekStart.getDate().toString().padStart(2, '0')}/${(weekStart.getMonth() + 1).toString().padStart(2, '0')}`;

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
  const registered = totalUsers;
  const onboardingComplete = allUsers.filter((u) => u.onboarding_completado).length;
  const withFirstTx = Object.keys(firstTxByUser).length;
  const magicLink = allUsers.filter((u) => !!u.supabase_auth_id).length;
  const pro = totalPro;

  const funnel = { registered, onboardingComplete, firstTransaction: withFirstTx, magicLink, pro };

  // --- NLP Errors per day (last 30 days) ---
  const { data: nlpRaw } = await db
    .from('nlp_errors')
    .select('created_at')
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

    // Pro users at end of month = users whose premium_vence >= end of month OR currently pro and registered before month end
    const proAtMonth = allUsers.filter((u) => {
      if (u.plan === 'premium') {
        return new Date(u.created_at) <= mEnd;
      }
      // Was pro but churned: premium_vence is after month start
      if (u.premium_vence) {
        const vence = new Date(u.premium_vence);
        return vence >= mDate && vence <= mEnd;
      }
      return false;
    });

    const newProInMonth = allUsers.filter((u) => {
      // Approximate: users that became pro during this month
      if (u.plan === 'premium' && u.premium_vence) {
        // premium_vence ~30 days after activation, so activation ≈ vence - 30
        const activated = new Date(new Date(u.premium_vence).getTime() - 30 * 86400000);
        return activated >= mDate && activated <= mEnd;
      }
      return false;
    });

    const churnedInMonth = allUsers.filter((u) => {
      if (u.plan !== 'free' || !u.premium_vence) return false;
      const vence = new Date(u.premium_vence);
      return vence >= mDate && vence <= mEnd;
    });

    revenue.push({
      month: monthLabel,
      // MRR normalizado por tipo de plan, solo usuarios reales (excluye internos).
      mrr: Math.round(
        proAtMonth.filter(isRevenueUser).reduce((s, u) => s + monthlyValuePen(u), 0) * 100,
      ) / 100,
      newPro: newProInMonth.length,
      churned: churnedInMonth.length,
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
    nlpActivity,
    revenue,
  });
}
