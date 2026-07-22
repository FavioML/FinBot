import { createClient } from '@/lib/supabase/server';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

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

/**
 * Las fugas describen "este mes" (spike vs mes anterior, gastos hormiga del mes,
 * patrones recurrentes del mes). El mensaje se congela al generarse, así que una
 * alerta de mayo que dice "subió 140% este mes" es falsa cuando se lee en junio.
 * Por eso solo mostramos las del mes en curso (zona Lima). Las de meses pasados
 * quedan en la tabla como histórico, fuera de la vista.
 */
function inicioMesLimaISO(): string {
  // Mismo patrón que el resto del backend: componentes de fecha en hora Lima.
  const nowLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const y = nowLima.getFullYear();
  const m = String(nowLima.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01T00:00:00-05:00`;
}

/**
 * El cron Pro corre cada miércoles, así que un mismo spike/recurrente se re-inserta
 * varias veces en el mes. Deduplicamos por categoría (spike/projection), comercio
 * (recurring) o tipo (ant), quedándonos con la corrida más reciente.
 */
function alertKey(a: AlertRow): string {
  if (a.type === 'ant') return 'ant';
  if (a.type === 'recurring') {
    const m = a.message?.match(/Compraste en (.+?) \d+ veces/);
    return `recurring:${m ? m[1] : a.message ?? a.id}`;
  }
  return `${a.type}:${a.category ?? ''}`;
}

export async function GET(request: Request) {
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  // El resto de la ruta sigue leyendo con el cliente RLS-scoped de la sesion.
  const supabase = await createClient();

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '20');

  const { data } = await supabase
    .from('spending_alerts')
    .select('*')
    .eq('user_id', usuario.id)
    .gte('created_at', inicioMesLimaISO())
    .order('created_at', { ascending: false })
    .limit(100);

  const rows = (data || []) as AlertRow[];

  // Dedup: ya vienen ordenadas DESC, así que la primera de cada key es la más reciente.
  const seen = new Set<string>();
  const deduped: AlertRow[] = [];
  for (const a of rows) {
    const key = alertKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }

  return NextResponse.json({
    alerts: deduped.slice(0, limit),
    isPro: usuario.plan === 'premium',
  });
}
