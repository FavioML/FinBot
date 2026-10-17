import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { parsePedidoVistas } from '@/lib/tx-nuevas';

/**
 * Marca movimientos como vistos (le quita la marca "Nuevo" en Transacciones). Ver
 * `lib/tx-nuevas.ts` y la migración 091.
 *
 * - El id del usuario sale de la sesión y filtra el UPDATE: es lo que hace que no haya IDOR.
 * - `.is('vista_at', null)`: una fila ya vista conserva la hora en que se vio por primera vez.
 * - Límite de ritmo con clave propia: tocar OK fila por fila no puede gastarle el cupo de 30/min
 *   que comparten crear, editar y borrar.
 */
export async function POST(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  if (!checkRateLimit(`vistas:${userId}`, 120)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 });
  }
  const pedido = parsePedidoVistas(body);
  if (!pedido.ok) return NextResponse.json({ error: pedido.error }, { status: 400 });

  const query = getServiceClient()
    .from('transacciones')
    .update({ vista_at: new Date().toISOString() }, { count: 'exact' })
    .eq('usuario_id', userId)
    .is('vista_at', null)
    .in('id', pedido.ids);

  // supabase-js no lanza: sin leer `error`, una escritura caída respondería "listo".
  const { error, count } = await query;
  if (error) {
    console.error('[tx-vistas]', error.message);
    return NextResponse.json({ error: 'No pudimos guardarlo' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, vistas: count ?? 0 });
}
