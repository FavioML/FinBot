import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { goalsFactor, debtsFactor } from '@/lib/score-factors';

// Cold starts + 5 queries paralelas + upsert pueden exceder el límite default de
// la función serverless en el path de cálculo fresco, lo que Vercel devuelve como
// 502. Damos headroom explícito para que la función responda antes de que la
// plataforma la mate.
export const maxDuration = 20;

const WEIGHTS = {
  consistency: 0.20,
  budget: 0.25,
  savings: 0.20,
  goals: 0.15,
  debts: 0.10,
  visibility: 0.10,
};

type ScoreFactors = {
  consistency: number;
  budget: number;
  savings: number;
  goals: number;
  debts: number;
  visibility: number;
};

type ScoreResult = { score: number; factors: ScoreFactors; period: string };

async function getNetoUserId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  // maybeSingle (not single): un usuario autenticado en Supabase puede no tener
  // aún fila en `usuarios` (registro WhatsApp-first). single() devuelve 406 con
  // 0 filas; maybeSingle() devuelve data:null y lo tratamos como no-autorizado.
  const { data } = await supabase
    .from('usuarios')
    .select('id, plan, gmail_access_token, recordatorios_activos')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();
  return data as { id: string; plan: string; gmail_access_token: string | null; recordatorios_activos: boolean | null } | null;
}

/**
 * Calculate a fresh Neto Score with direct Supabase queries. Espeja el backend
 * `services/neto-score.js` (fuente de verdad que persiste `neto_scores` vía el
 * cron diario). Este path solo corre cuando aún no hay score persistido (usuario
 * nuevo) o con ?refresh=true; el resto del tiempo se sirve el valor del cron.
 * goals y debts usan la misma lógica que el backend (ritmo de ahorro / penalidad
 * por mora) vía lib/score-factors para no divergir del score que el cron asienta.
 */
async function calculateFreshScore(usuario: NonNullable<Awaited<ReturnType<typeof getNetoUserId>>>) {
  const svc = getServiceClient();
  const userId = usuario.id;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sinceDate = thirtyDaysAgo.toISOString().split('T')[0];

  // Current month boundaries (Lima timezone approximation: UTC-5)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const curMes = now.getMonth() + 1;
  const curAnio = now.getFullYear();
  const monthStart = `${curAnio}-${String(curMes).padStart(2, '0')}-01`;
  const nextMonth = new Date(curAnio, curMes, 1);
  const monthEnd = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

  const [txResult, monthTxResult, budgetResult, goalsResult, debtsResult] = await Promise.all([
    svc.from('transacciones').select('fecha').eq('usuario_id', userId).gte('fecha', sinceDate),
    svc.from('transacciones').select('tipo, monto_pen, categoria').eq('usuario_id', userId).gte('fecha', monthStart).lt('fecha', monthEnd),
    svc.from('presupuestos').select('categoria, monto_limite, mes, anio').eq('usuario_id', userId),
    svc.from('metas_ahorro').select('id, completada, monto_objetivo, monto_actual, fecha_limite, created_at').eq('usuario_id', userId).eq('completada', false),
    svc.from('deudas').select('id, tipo, monto_original, monto_pendiente, estado, fecha_vencimiento').eq('usuario_id', userId).eq('tipo', 'debo'),
  ]);

  // Factor 1: Consistency — unique days in last 30 days
  const txDays = txResult.data || [];
  const uniqueDays = new Set(txDays.map((t: { fecha: string }) => t.fecha)).size;
  const daysPerWeek = uniqueDays / 4.3;
  const consistency = daysPerWeek >= 5 ? 100 : daysPerWeek >= 4 ? 85 : daysPerWeek >= 3 ? 70 : daysPerWeek >= 2 ? 50 : daysPerWeek >= 1 ? 30 : 10;

  // Factor 2: Budget control — solo presupuestos del mes en curso (igual que el
  // backend construirDatosUsuario, que filtra por mes/anio); usar todos contaría una
  // categoría por cada mes con presupuesto y distorsionaría el factor.
  const allBudgets = budgetResult.data || [];
  const budgets = allBudgets.filter((b: { mes: number; anio: number }) => b.mes === curMes && b.anio === curAnio);
  const monthTxs = monthTxResult.data || [];
  let budget = 50;
  if (budgets.length > 0) {
    let totalBudgetScore = 0;
    for (const b of budgets) {
      const spent = monthTxs
        .filter((t: { tipo: string; categoria: string | null }) => t.tipo === 'gasto' && t.categoria?.toLowerCase() === b.categoria?.toLowerCase())
        .reduce((s: number, t: { monto_pen: number }) => s + parseFloat(String(t.monto_pen)), 0);
      const limit = parseFloat(String(b.monto_limite));
      const pct = limit > 0 ? (spent / limit) * 100 : 0;
      if (pct <= 100) totalBudgetScore += 100;
      else if (pct <= 120) totalBudgetScore += 80 - ((pct - 100) / 20) * 40;
      else totalBudgetScore += Math.max(0, 40 - ((Math.min(pct - 120, 80)) / 80) * 40);
    }
    budget = Math.round(totalBudgetScore / budgets.length);
  }

  // Factor 3: Savings capacity
  const income = monthTxs.filter((t: { tipo: string }) => t.tipo === 'ingreso').reduce((s: number, t: { monto_pen: number }) => s + parseFloat(String(t.monto_pen)), 0);
  const expenses = monthTxs.filter((t: { tipo: string }) => t.tipo === 'gasto').reduce((s: number, t: { monto_pen: number }) => s + parseFloat(String(t.monto_pen)), 0);
  let savings = 50;
  if (income > 0) {
    const ratio = (income - expenses) / income;
    savings = ratio >= 0.20 ? 100 : ratio >= 0.10 ? 75 : ratio >= 0.05 ? 55 : ratio >= 0 ? 35 : Math.max(0, 20 + ratio * 100);
  }

  // Factor 4: Goal progress — misma lógica de ritmo que el backend (lib/score-factors)
  const activeGoals = goalsResult.data || [];
  const goals = goalsFactor(activeGoals);

  // Factor 5: Debt management — promedio de progreso ± mora/bonus (lib/score-factors)
  const debts = debtsResult.data || [];
  const debtScore = debtsFactor(debts, now);

  // Factor 6: Financial visibility — cuenta si tiene presupuestos (cualquier mes,
  // igual que el backend calcFactorVisibility que no filtra por mes/anio).
  let visibility = 0;
  if (allBudgets.length > 0) visibility += 30;
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

  // Persist to neto_scores so WhatsApp/cron stay in sync
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await svc.from('neto_scores').upsert({
    user_id: userId,
    score,
    factor_consistency: Math.round(factors.consistency),
    factor_budget: Math.round(factors.budget),
    factor_savings: Math.round(factors.savings),
    factor_goals: Math.round(factors.goals),
    factor_debts: Math.round(factors.debts),
    factor_visibility: Math.round(factors.visibility),
    period: today,
  }, { onConflict: 'user_id,period' });

  return { score, factors, period: today };
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const usuario = await getNetoUserId(supabase);
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const wantHistory = searchParams.get('history') === 'true';
  const months = parseInt(searchParams.get('months') || '1');
  const forceRefresh = searchParams.get('refresh') === 'true';

  const isPro = usuario.plan === 'premium';

  // Serve the persisted score instead of recalculating on every request.
  // The daily cron (6am Lima) is the source of truth and writes neto_scores for
  // every onboarded user, so the latest row is normally today's. We only compute
  // on-demand when no score exists yet (brand-new user) or on an explicit refresh.
  let current: ScoreResult | null = null;

  if (!forceRefresh) {
    const svc = getServiceClient();
    const { data: rows } = await svc
      .from('neto_scores')
      .select('score, factor_consistency, factor_budget, factor_savings, factor_goals, factor_debts, factor_visibility, period')
      .eq('user_id', usuario.id)
      .order('period', { ascending: false })
      .limit(1);
    const row = rows?.[0];
    if (row && row.score != null) {
      current = {
        score: row.score,
        factors: {
          consistency: row.factor_consistency ?? 0,
          budget: row.factor_budget ?? 0,
          savings: row.factor_savings ?? 0,
          goals: row.factor_goals ?? 0,
          debts: row.factor_debts ?? 0,
          visibility: row.factor_visibility ?? 0,
        },
        period: row.period,
      };
    }
  }

  // Fallback: no persisted score yet (or forced refresh) → compute once and persist.
  if (!current) {
    try {
      current = await calculateFreshScore(usuario);
    } catch (error) {
      // Un fallo en las queries/upsert de Supabase no debe crashear la función
      // (que la plataforma reporta como 502). Devolvemos un error controlado.
      console.error('score fresh-calc error:', error);
      return NextResponse.json({ error: 'No se pudo calcular el score' }, { status: 500 });
    }
  }

  const response: Record<string, unknown> = {
    score: current.score,
    period: current.period,
  };

  if (isPro) {
    response.factors = {
      consistency: current.factors.consistency,
      budget: current.factors.budget,
      savings: current.factors.savings,
      goals: current.factors.goals,
      debts: current.factors.debts,
      visibility: current.factors.visibility,
    };
  }

  if (wantHistory) {
    const maxMonths = isPro ? Math.min(months, 6) : 1;
    const since = new Date();
    since.setMonth(since.getMonth() - maxMonths);

    const { data: history } = await supabase
      .from('neto_scores')
      .select('score, period, factor_consistency, factor_budget, factor_savings, factor_goals, factor_debts, factor_visibility')
      .eq('user_id', usuario.id)
      .gte('period', since.toISOString().split('T')[0])
      .order('period', { ascending: true });

    // Dedupe: el cron guarda un registro por día. Conservamos solo el último
    // por mes (YYYY-MM) para que el gráfico no repita meses.
    const latestByMonth = new Map<string, NonNullable<typeof history>[number]>();
    for (const h of history || []) {
      const ym = (h.period || '').slice(0, 7);
      if (!ym) continue;
      latestByMonth.set(ym, h); // order asc → el último set es el más reciente
    }
    const dedupedHistory = Array.from(latestByMonth.values());

    response.history = isPro
      ? dedupedHistory
      : dedupedHistory.map((h) => ({ score: h.score, period: h.period }));
  }

  return NextResponse.json(response);
}
