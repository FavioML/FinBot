import { getServiceClient } from '@/lib/supabase/service';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { exactCI } from '@/lib/category-cascade';

/*
 * Este endpoint alimenta el NÚMERO que el usuario ve antes de confirmar el borrado
 * ("esto afecta a N transacciones"), así que tiene que contar exactamente lo mismo que
 * después va a tocar el cascade. Por eso importa `exactCI` en vez de tener su propia
 * copia: hasta el 12-ago-2026 acá vivía un `likeEscape` duplicado, y el día que uno de
 * los dos se arreglara —como pasó con el agujero del `*`— el preview y el borrado
 * habrían empezado a hablar de conjuntos distintos, en silencio.
 */

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
    .filter('categoria', 'imatch', exactCI(nombre));
  if (sub) q = q.filter('subcategoria', 'imatch', exactCI(sub));

  const { count, error } = await q;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ count: count ?? 0 });
}
