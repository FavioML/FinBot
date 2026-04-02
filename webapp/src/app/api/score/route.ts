import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

async function getNetoUserId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();
  return data as { id: string; plan: string } | null;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const usuario = await getNetoUserId(supabase);
  if (!usuario) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const wantHistory = searchParams.get('history') === 'true';
  const months = parseInt(searchParams.get('months') || '1');

  const { data: score } = await supabase
    .from('neto_scores')
    .select('*')
    .eq('user_id', usuario.id)
    .order('period', { ascending: false })
    .limit(1)
    .single();

  if (!score) return NextResponse.json({ score: null });

  const isPro = usuario.plan === 'premium';
  const response: Record<string, unknown> = {
    score: score.score,
    period: score.period,
  };

  if (isPro) {
    response.factors = {
      consistency: score.factor_consistency,
      budget: score.factor_budget,
      savings: score.factor_savings,
      goals: score.factor_goals,
      debts: score.factor_debts,
      visibility: score.factor_visibility,
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

    response.history = isPro
      ? history
      : (history || []).map((h: { score: number; period: string }) => ({ score: h.score, period: h.period }));
  }

  return NextResponse.json(response);
}
