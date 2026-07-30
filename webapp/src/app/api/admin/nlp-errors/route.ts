import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { requireAdminUser } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await requireAdminUser())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');
  // Los 429 de OpenAI (error_tipo='rate_limit') son infra, no NLP. Por defecto se excluyen
  // del listado y del conteo real; se devuelven aparte para que el panel los muestre como
  // categoría separada. ?includeRateLimit=1 los trae mezclados.
  const includeRateLimit = searchParams.get('includeRateLimit') === '1';

  let query = getServiceClient()
    .from('nlp_errors')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (!includeRateLimit) query = query.neq('error_tipo', 'rate_limit');

  const { data, error, count } = await query.range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { count: rateLimitTotal } = await getServiceClient()
    .from('nlp_errors')
    .select('*', { count: 'exact', head: true })
    .eq('error_tipo', 'rate_limit');

  return NextResponse.json({
    ok: true,
    total: count || 0,
    rateLimitTotal: rateLimitTotal || 0,
    errors: data || [],
  });
}
