import { getServiceClient } from '@/lib/supabase/service';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Mirror one category's budget config from a source month onto every LATER month
 * that already has budgets (materialized) for this user.
 *
 * This is the "recurring / para siempre" primitive. It handles both directions:
 *   - a sub-budget added/changed at the source month propagates forward
 *   - a sub-budget (or the whole category) removed at the source month is removed
 *     forward too, because future rows not present at the source are deleted.
 *
 * Months not yet materialized are intentionally NOT created here: the GET
 * carry-forward already clones the latest month into any empty future month the
 * user opens, so "forever" is covered without inserting unbounded rows.
 */
export async function POST(request: Request) {
  const auth = await requireLectura('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;
  const body = await request.json();
  const categoria = typeof body.categoria === 'string' ? body.categoria.trim() : '';
  const mes = parseInt(body.mes, 10);
  const anio = parseInt(body.anio, 10);

  if (!categoria || !mes || !anio) {
    return NextResponse.json({ error: 'categoria, mes y anio requeridos' }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Source rows: this category, at the source month.
  const { data: sourceRows, error: srcErr } = await supabase
    .from('presupuestos')
    .select('categoria, subcategoria, monto_limite, alerta_porcentaje')
    .eq('usuario_id', userId)
    .eq('categoria', categoria)
    .eq('mes', mes)
    .eq('anio', anio);
  if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 400 });

  // Latest month that has any budgets for this user.
  const { data: latest, error: latestErr } = await supabase
    .from('presupuestos')
    .select('mes, anio')
    .eq('usuario_id', userId)
    .order('anio', { ascending: false })
    .order('mes', { ascending: false })
    .limit(1);
  if (latestErr) return NextResponse.json({ error: latestErr.message }, { status: 400 });
  if (!latest || latest.length === 0) {
    return NextResponse.json({ ok: true, months: 0 });
  }

  // Month arithmetic on a 0-indexed (anio*12 + (mes-1)) scale.
  const sourceDate = anio * 12 + (mes - 1);
  const lastDate = latest[0].anio * 12 + (latest[0].mes - 1);

  const targetMonths: Array<{ mes: number; anio: number }> = [];
  for (let d = sourceDate + 1; d <= lastDate; d++) {
    targetMonths.push({ anio: Math.floor(d / 12), mes: (d % 12) + 1 });
  }
  if (targetMonths.length === 0) {
    return NextResponse.json({ ok: true, months: 0 });
  }
  const targetKeys = new Set(targetMonths.map(({ mes: m, anio: a }) => `${a}-${m}`));

  // Upsert the source rows into every target month (idempotent on the unique index).
  if (sourceRows && sourceRows.length > 0) {
    const rows = targetMonths.flatMap(({ mes: m, anio: a }) =>
      sourceRows.map((r) => ({
        usuario_id: userId,
        categoria: r.categoria,
        subcategoria: r.subcategoria,
        monto_limite: r.monto_limite,
        alerta_porcentaje: r.alerta_porcentaje,
        mes: m,
        anio: a,
      })),
    );
    const { error: upErr } = await supabase
      .from('presupuestos')
      .upsert(rows, { onConflict: 'usuario_id,categoria,subcategoria,mes,anio' });
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });
  }

  // Delete future rows of this category that no longer exist at the source month.
  const sourceSubcats = new Set(
    (sourceRows || []).map((r) => (r.subcategoria == null ? '' : r.subcategoria)),
  );
  const { data: futureRows, error: futErr } = await supabase
    .from('presupuestos')
    .select('id, subcategoria, mes, anio')
    .eq('usuario_id', userId)
    .eq('categoria', categoria);
  if (futErr) return NextResponse.json({ error: futErr.message }, { status: 400 });

  const staleIds = (futureRows || [])
    .filter((r) => targetKeys.has(`${r.anio}-${r.mes}`))
    .filter((r) => !sourceSubcats.has(r.subcategoria == null ? '' : r.subcategoria))
    .map((r) => r.id);

  if (staleIds.length > 0) {
    const { error: delErr } = await supabase
      .from('presupuestos')
      .delete()
      .eq('usuario_id', userId)
      .in('id', staleIds);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, months: targetMonths.length });
}
