import { NextResponse } from 'next/server';
import { requireAdminUser, type ActivityRow } from '@/lib/admin';
import { getServiceClient } from '@/lib/supabase/service';
import {
  CAC_REFERIDOS_PEN,
  COST_PER_PRO_USER_PEN,
  PRO_PRICE_MONTHLY_PEN,
} from '@/lib/constants';
import {
  computeRevenue,
  cajaDelMes,
  esProPagado,
  isRevenueUser,
  computeChurn,
  mrrAtMonthEnd,
  newProInMonth,
  churnedInMonth,
  EXCLUDED_REVENUE_WHATSAPP,
} from '@/lib/admin-revenue';
import { startOfDayLima, startOfMonthLima, todayIsoLima } from '@/lib/date-lima';
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
  // Va declarada aunque acá no se lea directo: es la columna que decide si un `plan:'premium'`
  // cuenta como ingreso (esProPagado). El select ya la traía, pero la interfaz no la nombraba,
  // así que el compilador no veía el dato del que depende todo lo de abajo.
  trial_estado: string | null;
  premium_desde: string | null;
  premium_vence: string | null;
  created_at: string;
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
  const todayIso = todayIsoLima(now);
  const startMonth = startOfMonthLima(now); // inicio de mes en día Lima
  const monthAgoIso = new Date(now.getTime() - 30 * 86400000).toISOString();

  // Las seis lecturas son independientes entre sí y antes iban encadenadas.
  //
  // Las dos llamadas a admin_activity_counts (migración 039) reemplazan selects de
  // `transacciones` que contaban filas en JS. Todavía no truncaban porque el mes iba en
  // menos de 1000 filas, pero era el mismo bug que en /api/admin/stats esperando volumen:
  // PostgREST corta en 1000 y el conteo se congela sin devolver ningún error.
  //
  // Se llama dos veces porque son dos ventanas distintas para dos métricas distintas:
  // transacciones del mes CALENDARIO, y usuarios activos de los últimos 30 DÍAS. Pasar los
  // tres parámetros iguales es la forma de pedir una sola ventana.
  const startMonthIso = startMonth.toISOString();
  const [
    { data: usuariosRaw },
    { data: costsRaw },
    { data: pagosMes },
    { count: txTotalCount },
    { data: mesRows },
    { data: treintaRows },
    { data: pnlTotalsRows },
  ] = await Promise.all([
    db
      .from('usuarios')
      .select('id, whatsapp, plan, tipo_plan, trial_estado, premium_desde, premium_vence, created_at'),
    db.from('admin_costs').select('*').order('next_due_date', { ascending: true }),
    db
      .from('pagos')
      .select('monto, estado, aprobado_at, created_at, usuario_id')
      .gte('created_at', startMonthIso),
    db.from('transacciones').select('id', { count: 'exact', head: true }),
    db.rpc('admin_activity_counts', {
      p_day: startMonthIso,
      p_week: startMonthIso,
      p_month: startMonthIso,
    }),
    db.rpc('admin_activity_counts', {
      p_day: monthAgoIso,
      p_week: monthAgoIso,
      p_month: monthAgoIso,
    }),
    db.rpc('admin_pnl_totals', {
      p_excluded: Array.from(EXCLUDED_REVENUE_WHATSAPP),
    }),
  ]);

  // --- Users ---
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

  // Cuánto del MRR es humo: Pro que cuentan como ingreso y no tienen ni un pago aprobado con
  // monto > 0. Hoy eso solo puede ser un comp (Pro regalado por POST /admin/activar, que se
  // registra en `pagos` con monto 0 justamente para no inflar la caja). Sale acá, pegado al
  // MRR, en vez de con una columna nueva en `usuarios`: el eje del plan ya tiene dos columnas
  // y mirar una sola ya costó seis huecos. Cuando este número deje de ser 0 de forma estable,
  // ahí sí conviene modelar el comp como estado propio.
  // La query va filtrada por los ids Pro (hoy ~7) y no por toda la tabla: PostgREST corta en
  // 1000 filas sin avisar, y así el techo es "1000 / Pro pagados" pagos por usuario, no 1000
  // pagos en total.
  const proIds = realUsers.filter(esProPagado).map((u) => u.id);
  const { data: pagosDePro } = proIds.length
    ? await db
        .from('pagos')
        .select('usuario_id')
        .eq('estado', 'aprobado')
        .gt('monto', 0)
        .in('usuario_id', proIds)
    : { data: [] as Array<{ usuario_id: string | null }> };
  const conPagoReal = new Set((pagosDePro || []).map((p) => p.usuario_id));
  const proSinPagoRegistrado = proIds.filter((id) => !conPagoReal.has(id)).length;

  const newUsersThisMonth = usuarios.filter(
    (u) => new Date(u.created_at) >= startMonth,
  ).length;

  const conversionRate =
    realUsers.length > 0 ? Math.round((proCountReal / realUsers.length) * 1000) / 10 : 0;

  // Churn 30d (fuente única: computeChurn, excluye internos, base = churned + pro reales)
  const churnRate30d = computeChurn(usuarios, now).rate;

  // --- Costs ---
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
  const revenueThisMonth = cajaDelMes(pagosMes || [], excludedIds, startMonthIso);

  // --- Activity ---
  // Agregados en SQL. `transactions_this_month` cuenta filas y `active_users_30d` cuenta
  // usuarios distintos: las dos cosas se rompían al pasar las 1000 filas de PostgREST.
  const transactionsTotal = txTotalCount || 0;
  const transactionsThisMonth = Number((mesRows as ActivityRow[] | null)?.[0]?.tx_month ?? 0);
  const activeUsers30d = Number((treintaRows as ActivityRow[] | null)?.[0]?.mau ?? 0);

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

    mrrHistory.push({
      month: monthLabel,
      // Mes en curso (i=0): MRR vivo (headline) para que el último punto == KPI MRR.
      // Meses pasados: reconstruido desde premium_desde/premium_vence (no created_at ni
      // la heurística vence−30d). Solo negocio real (excluye internos).
      mrr: i === 0 ? mrr : mrrAtMonthEnd(usuarios, monthEnd),
      new_pro: newProInMonth(usuarios, monthStart, monthEnd),
      churned: churnedInMonth(usuarios, monthStart, monthEnd),
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

  // Margen operativo mensual = MRR − costos mensuales (lo que Neto genera limpio al mes). Caja
  // generada acumulada = result_total del RPC admin_pnl_totals (045): suma histórica de la caja neta.
  const operatingMarginMonthlyPen =
    Math.round((mrr - totalMonthlyCostsPen) * 100) / 100;
  const pnlTotals = (pnlTotalsRows as Array<{ result_total: number | string }> | null)?.[0];
  const cashGeneratedPen = pnlTotals ? Number(pnlTotals.result_total) : 0;

  const economics: AdminEconomics = {
    mrr: Math.round(mrr * 100) / 100,
    arr: Math.round(arr * 100) / 100,
    revenue_this_month: revenueThisMonth,
    total_users: totalUsers,
    free_users: freeUsers.length,
    pro_users: proCountReal,
    pro_sin_pago_registrado: proSinPagoRegistrado,
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
    operating_margin_monthly_pen: operatingMarginMonthlyPen,
    cash_generated_pen: cashGeneratedPen,
    transactions_total: transactionsTotal,
    transactions_this_month: transactionsThisMonth,
    active_users_30d: activeUsers30d,
    mrr_history: mrrHistory,
    user_growth_12w: userGrowth12w,
  };

  return NextResponse.json(economics);
}
