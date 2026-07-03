import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import {
  CAC_REFERIDOS_PEN,
  COST_PER_PRO_USER_PEN,
  PRO_PRICE_MONTHLY_PEN,
} from '@/lib/constants';
import {
  computeRevenue,
  cajaDelMes,
  isRevenueUser,
  monthlyValuePen,
  EXCLUDED_REVENUE_WHATSAPP,
} from '@/lib/admin-revenue';
import type {
  AdminCost,
  AdminCostDueSoon,
  AdminEconomics,
} from '@/lib/types-admin';

export const dynamic = 'force-dynamic';

interface UsuarioRow {
  id: string;
  whatsapp: string | null;
  plan: string | null;
  tipo_plan: string | null;
  premium_vence: string | null;
  created_at: string;
}

function startOfDayLima(date: Date): Date {
  // Lima is UTC-5, no DST. Convert to Lima local Y/M/D, then back to UTC midnight.
  const d = new Date(date.getTime() - 5 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  return new Date(Date.UTC(y, m, day, 5, 0, 0));
}

function todayIsoLima(): string {
  const now = new Date();
  const lima = new Date(now.getTime() - 5 * 3600 * 1000);
  const y = lima.getUTCFullYear();
  const m = String(lima.getUTCMonth() + 1).padStart(2, '0');
  const d = String(lima.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function diffDaysUTC(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + 'T00:00:00Z').getTime();
  const b = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

export async function GET() {
  const user = await requireAdminUser();
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const db = getServiceClient();
  const now = new Date();
  const todayIso = todayIsoLima();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthAgoIso = new Date(now.getTime() - 30 * 86400000).toISOString();

  // --- Users ---
  const { data: usuariosRaw } = await db
    .from('usuarios')
    .select('id, whatsapp, plan, tipo_plan, premium_vence, created_at');

  const usuarios = (usuariosRaw || []) as UsuarioRow[];
  const totalUsers = usuarios.length;
  const freeUsers = usuarios.filter((u) => u.plan !== 'premium');

  // Ingreso: solo negocio real (excluye fundador + QA). Fuente única: admin-revenue.ts.
  const rev = computeRevenue(usuarios);
  const realUsers = usuarios.filter(isRevenueUser);
  const proCountReal = rev.proCount;
  const proMonthly = rev.proMonthly;
  const proYearly = rev.proYearly;
  const mrr = rev.mrr;
  const arr = rev.arr;

  const newUsersThisMonth = usuarios.filter(
    (u) => new Date(u.created_at) >= startMonth,
  ).length;

  const conversionRate =
    realUsers.length > 0 ? Math.round((proCountReal / realUsers.length) * 1000) / 10 : 0;

  // Churn 30d: users currently free whose premium_vence expired in last 30d
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const churned30d = usuarios.filter((u) => {
    if (u.plan === 'premium' || !u.premium_vence) return false;
    const vence = new Date(u.premium_vence);
    return vence >= thirtyDaysAgo && vence < now;
  }).length;
  const churnBase = churned30d + proCountReal;
  const churnRate30d =
    churnBase > 0 ? Math.round((churned30d / churnBase) * 1000) / 10 : 0;

  // --- Costs ---
  const { data: costsRaw } = await db
    .from('admin_costs')
    .select('*')
    .order('next_due_date', { ascending: true });

  const costs = (costsRaw || []) as AdminCost[];
  const activeCosts = costs.filter((c) => c.active);

  let totalMonthlyCostsPen = 0;
  for (const c of activeCosts) {
    if (c.frequency === 'monthly') totalMonthlyCostsPen += Number(c.amount_pen);
    else if (c.frequency === 'yearly')
      totalMonthlyCostsPen += Number(c.amount_pen) / 12;
  }
  totalMonthlyCostsPen = Math.round(totalMonthlyCostsPen * 100) / 100;
  const totalYearlyCostsPen = Math.round(totalMonthlyCostsPen * 12 * 100) / 100;

  const inSevenDaysIso = (() => {
    const d = new Date(todayIso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const costsDueThisWeek: AdminCostDueSoon[] = activeCosts
    .filter(
      (c) =>
        c.next_due_date !== null &&
        c.next_due_date >= todayIso &&
        c.next_due_date <= inSevenDaysIso,
    )
    .map((c) => ({
      id: c.id,
      label: c.label,
      amount_pen: Number(c.amount_pen),
      currency: c.currency,
      amount_original: c.amount_original !== null ? Number(c.amount_original) : null,
      next_due_date: c.next_due_date as string,
      days_until: diffDaysUTC(todayIso, c.next_due_date as string),
    }))
    .sort((a, b) => a.days_until - b.days_until);

  const costsDueToday = activeCosts.filter(
    (c) => c.next_due_date === todayIso,
  ).length;
  const costsOverdue = activeCosts.filter(
    (c) => c.next_due_date !== null && c.next_due_date < todayIso,
  ).length;

  // --- Unit economics ---
  const grossMarginProPen =
    Math.round((PRO_PRICE_MONTHLY_PEN - COST_PER_PRO_USER_PEN) * 100) / 100;
  const breakevenProUsers =
    grossMarginProPen > 0
      ? Math.ceil(totalMonthlyCostsPen / grossMarginProPen)
      : 0;
  const breakevenGap = breakevenProUsers - proCountReal;

  // LTV = margin / churn_rate_monthly. churn_rate_30d already monthly approx.
  // If churn = 0 → fallback to S/100 (10 meses × margen).
  const churnMonthly = churnRate30d / 100;
  const ltvProPen =
    churnMonthly > 0
      ? Math.round((grossMarginProPen / churnMonthly) * 100) / 100
      : Math.round(grossMarginProPen * 10 * 100) / 100;

  // Revenue this month = caja real cobrada: suma de pagos aprobados este mes
  // (excluye cuentas internas). Ya existe la tabla `pagos`, así que es dinero de verdad,
  // no una aproximación al MRR.
  const excludedIds = new Set(
    usuarios.filter((u) => u.whatsapp && EXCLUDED_REVENUE_WHATSAPP.has(u.whatsapp)).map((u) => u.id),
  );
  const startMonthIso = startMonth.toISOString();
  const { data: pagosMes } = await db
    .from('pagos')
    .select('monto, estado, aprobado_at, created_at, usuario_id')
    .gte('created_at', startMonthIso);
  const revenueThisMonth = cajaDelMes(pagosMes || [], excludedIds, startMonthIso);

  // --- Activity ---
  const { count: txTotalCount } = await db
    .from('transacciones')
    .select('id', { count: 'exact', head: true });
  const transactionsTotal = txTotalCount || 0;

  const { data: txMonthData } = await db
    .from('transacciones')
    .select('usuario_id, created_at')
    .gte('created_at', startMonth.toISOString());
  const transactionsThisMonth = (txMonthData || []).length;

  const { data: txMauData } = await db
    .from('transacciones')
    .select('usuario_id')
    .gte('created_at', monthAgoIso);
  const activeUsers30d = new Set((txMauData || []).map((t) => t.usuario_id))
    .size;

  // --- MRR history (last 6 months) ---
  const mrrHistory: AdminEconomics['mrr_history'] = [];
  for (let i = 5; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(
      now.getFullYear(),
      now.getMonth() - i + 1,
      0,
      23,
      59,
      59,
    );
    const monthLabel = monthStart.toLocaleDateString('es-PE', {
      month: 'short',
      year: '2-digit',
      timeZone: 'America/Lima',
    });

    const proAtEnd = usuarios.filter((u) => {
      if (u.plan === 'premium') {
        return new Date(u.created_at) <= monthEnd;
      }
      if (u.premium_vence) {
        const vence = new Date(u.premium_vence);
        return vence >= monthStart && vence <= monthEnd;
      }
      return false;
    });

    const newProInMonth = usuarios.filter((u) => {
      if (u.plan === 'premium' && u.premium_vence) {
        const activated = new Date(
          new Date(u.premium_vence).getTime() - 30 * 86400000,
        );
        return activated >= monthStart && activated <= monthEnd;
      }
      return false;
    }).length;

    const churnedInMonth = usuarios.filter((u) => {
      if (u.plan === 'premium' || !u.premium_vence) return false;
      const vence = new Date(u.premium_vence);
      return vence >= monthStart && vence <= monthEnd;
    }).length;

    mrrHistory.push({
      month: monthLabel,
      // MRR normalizado por tipo de plan, solo usuarios reales (excluye internos).
      mrr: Math.round(
        proAtEnd.filter(isRevenueUser).reduce((s, u) => s + monthlyValuePen(u), 0) * 100,
      ) / 100,
      new_pro: newProInMonth,
      churned: churnedInMonth,
    });
  }

  // --- User growth (12 weeks) ---
  const userGrowth12w: AdminEconomics['user_growth_12w'] = [];
  for (let i = 11; i >= 0; i--) {
    const weekStart = startOfDayLima(
      new Date(now.getTime() - (i + 1) * 7 * 86400000),
    );
    const weekEnd = startOfDayLima(new Date(now.getTime() - i * 7 * 86400000));
    const newInWeek = usuarios.filter((u) => {
      const d = new Date(u.created_at);
      return d >= weekStart && d < weekEnd;
    });
    const weekLabel = `${String(weekStart.getUTCDate()).padStart(2, '0')}/${String(
      weekStart.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    userGrowth12w.push({
      week: weekLabel,
      free: newInWeek.filter((u) => u.plan !== 'premium').length,
      pro: newInWeek.filter((u) => u.plan === 'premium').length,
      total: newInWeek.length,
    });
  }

  const economics: AdminEconomics = {
    mrr: Math.round(mrr * 100) / 100,
    arr: Math.round(arr * 100) / 100,
    revenue_this_month: revenueThisMonth,
    total_users: totalUsers,
    free_users: freeUsers.length,
    pro_users: proCountReal,
    conversion_rate: conversionRate,
    new_users_this_month: newUsersThisMonth,
    churn_rate_30d: churnRate30d,
    total_monthly_costs_pen: totalMonthlyCostsPen,
    total_yearly_costs_pen: totalYearlyCostsPen,
    costs_due_this_week: costsDueThisWeek,
    costs_due_today: costsDueToday,
    costs_overdue: costsOverdue,
    gross_margin_pro_pen: grossMarginProPen,
    breakeven_pro_users: breakevenProUsers,
    breakeven_gap: breakevenGap,
    ltv_pro_pen: ltvProPen,
    cac_referidos_pen: CAC_REFERIDOS_PEN,
    runway_months: null,
    transactions_total: transactionsTotal,
    transactions_this_month: transactionsThisMonth,
    active_users_30d: activeUsers30d,
    mrr_history: mrrHistory,
    user_growth_12w: userGrowth12w,
  };

  return NextResponse.json(economics);
}
