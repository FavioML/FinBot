import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { goalsFactor, debtsFactor } from '@/lib/score-factors';

const WEIGHTS = {
  consistency: 0.20,
  budget: 0.25,
  savings: 0.20,
  goals: 0.15,
  debts: 0.10,
  visibility: 0.10,
};

/**
 * POST /api/score/backfill
 * Calculates and stores historical Neto Scores for months that have
 * transactions but no score entry yet. Uses a simplified 6-factor formula
 * with direct Supabase queries.
 */
export async function POST() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('id, plan, gmail_access_token, recordatorios_activos')
    .eq('supabase_auth_id', user.id)
    .single();

  if (!usuario) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Get all transactions to find months with activity
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const sinceDate = sixMonthsAgo.toISOString().split('T')[0];

  const [txResult, existingScores, budgetResult, goalsResult, debtsResult] = await Promise.all([
    supabase.from('transacciones').select('fecha, tipo, monto_pen, categoria').eq('usuario_id', usuario.id).gte('fecha', sinceDate),
    supabase.from('neto_scores').select('period').eq('user_id', usuario.id).gte('period', sinceDate),
    supabase.from('presupuestos').select('categoria, monto_limite, mes, anio').eq('usuario_id', usuario.id),
    supabase.from('metas_ahorro').select('id, completada, monto_objetivo, monto_actual, fecha_limite, created_at').eq('usuario_id', usuario.id).eq('completada', false),
    supabase.from('deudas').select('id, tipo, monto_original, monto_pendiente, estado, fecha_vencimiento').eq('usuario_id', usuario.id).eq('tipo', 'debo'),
  ]);

  const transactions = txResult.data || [];
  const existingPeriods = new Set((existingScores.data || []).map(s => s.period));
  const budgets = budgetResult.data || [];
  const activeGoals = goalsResult.data || [];
  const debts = debtsResult.data || [];

  // Find months with transactions
  const monthsWithTx = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    const period = tx.fecha.slice(0, 7) + '-01'; // YYYY-MM-01
    if (!monthsWithTx.has(period)) monthsWithTx.set(period, []);
    monthsWithTx.get(period)!.push(tx);
  }

  // Skip current month and future months (handled by daily cron)
  const now = new Date();
  const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Normalize existing periods to YYYY-MM for comparison (cron stores exact dates like 2026-04-03)
  const existingYearMonths = new Set(
    Array.from(existingPeriods).map(p => p.slice(0, 7))
  );

  let backfilled = 0;

  for (const [period, monthTxs] of monthsWithTx) {
    const periodYearMonth = period.slice(0, 7);
    if (periodYearMonth >= currentYearMonth) continue; // skip current + future months
    if (existingYearMonths.has(periodYearMonth)) continue; // skip already scored months
    if (monthTxs.length < 5) continue; // skip months with too few transactions

    // Factor 1: Consistency — unique days with transactions in this month
    const uniqueDays = new Set(monthTxs.map(t => t.fecha)).size;
    const daysPerWeek = uniqueDays / 4.3;
    const consistency = daysPerWeek >= 5 ? 100 : daysPerWeek >= 4 ? 85 : daysPerWeek >= 3 ? 70 : daysPerWeek >= 2 ? 50 : daysPerWeek >= 1 ? 30 : 10;

    // Factor 2: Budget — presupuestos de ESE mes (no aplanar todos los meses, que
    // contaría cada categoría varias veces). Si el mes no tenía presupuestos → 50 neutral.
    const periodMes = parseInt(period.slice(5, 7), 10);
    const periodAnio = parseInt(period.slice(0, 4), 10);
    const monthBudgets = budgets.filter(b => b.anio === periodAnio && b.mes === periodMes);
    let budget = 50; // neutral if no budgets
    if (monthBudgets.length > 0) {
      let totalBudgetScore = 0;
      for (const b of monthBudgets) {
        const spent = monthTxs
          .filter(t => t.tipo === 'gasto' && t.categoria?.toLowerCase() === b.categoria?.toLowerCase())
          .reduce((s: number, t: { monto_pen: number }) => s + parseFloat(String(t.monto_pen)), 0);
        const limit = parseFloat(String(b.monto_limite));
        // Mismo redondeo que el backend (ver api/score/route.ts): los tramos operan
        // sobre el porcentaje entero, no sobre el decimal crudo.
        const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
        if (pct <= 100) totalBudgetScore += 100;
        else if (pct <= 120) totalBudgetScore += 80 - ((pct - 100) / 20) * 40;
        else totalBudgetScore += Math.max(0, 40 - ((Math.min(pct - 120, 80)) / 80) * 40);
      }
      budget = Math.round(totalBudgetScore / monthBudgets.length);
    }

    // Factor 3: Savings — (income - expenses) / income
    const income = monthTxs.filter(t => t.tipo === 'ingreso').reduce((s: number, t: { monto_pen: number }) => s + parseFloat(String(t.monto_pen)), 0);
    const expenses = monthTxs.filter(t => t.tipo === 'gasto').reduce((s: number, t: { monto_pen: number }) => s + parseFloat(String(t.monto_pen)), 0);
    let savings = 50;
    if (income > 0) {
      const ratio = (income - expenses) / income;
      savings = ratio >= 0.20 ? 100 : ratio >= 0.10 ? 75 : ratio >= 0.05 ? 55 : ratio >= 0 ? 35 : Math.max(0, 20 + ratio * 100);
    }

    // Factors 4-6: Use current state as approximation (these don't change much
    // historically). goals/debts con la misma lógica que el backend/route fresco
    // (lib/score-factors) para no divergir del score que el cron asienta.
    const goals = goalsFactor(activeGoals);
    const debtScore = debtsFactor(debts, now);

    let visibility = 0;
    if (budgets.length > 0) visibility += 30;
    if (activeGoals.length > 0) visibility += 25;
    if (usuario.gmail_access_token) visibility += 25;
    if (usuario.recordatorios_activos !== false) visibility += 20;

    const factors = { consistency, budget, savings, goals, debts: debtScore, visibility };
    const score = Math.max(0, Math.min(100, Math.round(
      factors.consistency * WEIGHTS.consistency +
      factors.budget * WEIGHTS.budget +
      factors.savings * WEIGHTS.savings +
      factors.goals * WEIGHTS.goals +
      factors.debts * WEIGHTS.debts +
      factors.visibility * WEIGHTS.visibility
    )));

    const { error } = await getServiceClient().from('neto_scores').upsert({
      user_id: usuario.id,
      score,
      factor_consistency: Math.round(factors.consistency),
      factor_budget: Math.round(factors.budget),
      factor_savings: Math.round(factors.savings),
      factor_goals: Math.round(factors.goals),
      factor_debts: Math.round(factors.debts),
      factor_visibility: Math.round(factors.visibility),
      period,
    }, { onConflict: 'user_id,period' });

    if (error) {
      console.error(`[backfill] upsert failed for period ${period}:`, error.message, error.details, JSON.stringify(factors));
      continue;
    }

    backfilled++;
  }

  return NextResponse.json({ backfilled, message: `${backfilled} months backfilled` });
}
