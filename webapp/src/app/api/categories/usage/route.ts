import { getServiceClient } from '@/lib/supabase/service';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

/** Escapa los comodines de LIKE (%, _, \) para que `ilike` sea un match exacto
 * case-insensitive y no un patrón (ej. "Trabajo_Negocio" tiene un guion bajo). */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/* GET — cuántas transacciones referencian una categoría (y opcionalmente una sub) */
export async function GET(request: Request) {
  const auth = await requireLectura();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const nombre = (searchParams.get('nombre') || '').trim();
  const sub = (searchParams.get('sub') || '').trim();
  if (!nombre)
    return NextResponse.json({ error: 'nombre requerido' }, { status: 400 });

  let q = getServiceClient()
    .from('transacciones')
    .select('*', { count: 'exact', head: true })
    .eq('usuario_id', userId)
    .ilike('categoria', likeEscape(nombre));
  if (sub) q = q.ilike('subcategoria', likeEscape(sub));

  const { count, error } = await q;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ count: count ?? 0 });
}
