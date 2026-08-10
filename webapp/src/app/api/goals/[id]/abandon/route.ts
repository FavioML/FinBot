import { getServiceClient } from '@/lib/supabase/service';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';

/**
 * Abandonar una meta. Era la ÚNICA ruta de /api/goals que escribía con el cliente anon
 * (`createClient`), y por eso no funcionaba nunca (D7, auditoría 10-ago-2026): `metas_ahorro`
 * tiene RLS con policy de SELECT y nada más, así que el UPDATE matcheaba 0 filas, `.single()`
 * lo convertía en el error PGRST116 y la ruta devolvía 400 con "Cannot coerce the result to a
 * single JSON object". Medido contra producción antes de tocar nada: la meta quedaba en
 * `active`. Las 0 filas en `abandoned` de prod no eran "nadie lo usa".
 *
 * La autorización NO la da RLS acá —igual que en el resto de /api/goals— sino el
 * `.eq('usuario_id', ...)` en el mismo statement: sin él, service-role abandona la meta de
 * cualquiera. No lo saques.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireLectura();
  if (!auth.ok) return auth.response;
  const usuario = auth.user;

  // maybeSingle y no single: con `single()` las 0 filas llegan como error igual que una
  // lectura caída, que es justo lo que hacía ilegible este bug. Acá 0 filas significa una
  // sola cosa —la meta no existe o no es suya— y eso es un 404, no un 400.
  const { data, error } = await getServiceClient()
    .from('metas_ahorro')
    .update({ status: 'abandoned', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('usuario_id', usuario.id)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: 'Meta no encontrada' }, { status: 404 });
  return NextResponse.json(data);
}
