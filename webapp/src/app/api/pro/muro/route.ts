import { requireNetoUser } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { eventoTrialBackend } from '@/lib/trial-backend';
import { NextResponse, after } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/pro/muro — lo único que la pantalla del muro puede mostrar.
 *
 * Usa `requireNetoUser` y NO `requireLectura` a propósito: es la ruta que alimenta
 * justamente al usuario que está en el muro, así que gatearla lo dejaría mirando una
 * pantalla vacía. Lo que devuelve es exactamente lo que se decidió dejar del lado gratis:
 * cuántos gastos tiene guardados y cuánto lleva este mes. Un número, sin desglose —
 * la señal de que su data sigue creciendo, que es lo que hace que el paywall muerda.
 *
 * `?visto=1` emite el evento del embudo (paso 401). Va por el backend porque posthog-js
 * usa otro distinct_id y partiría el embudo (mismo patrón que /internal/activacion-completada).
 */
export async function GET(request: Request) {
  const auth = await requireNetoUser('id, nombre, plan, trial_estado, trial_vence');
  if (!auth.ok) return auth.response;
  const userId = auth.user.id as string;

  const svc = getServiceClient();
  const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const inicioMes = hoyLima.slice(0, 8) + '01';

  const [{ count: conteoTx }, { data: delMes }] = await Promise.all([
    svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', userId),
    svc
      .from('transacciones')
      .select('monto, monto_pen')
      .eq('usuario_id', userId)
      .eq('tipo', 'gasto')
      .gte('fecha', inicioMes)
      .lte('fecha', hoyLima),
  ]);

  // monto_pen es NULLABLE a propósito (la rama USD fuera de rango deja null honesto),
  // así que se lee con coalesce igual que en el resto del código.
  const totalMes = (delMes ?? []).reduce(
    (acc, t) => acc + Number(t.monto_pen != null ? t.monto_pen : (t.monto ?? 0)),
    0,
  );

  if (new URL(request.url).searchParams.has('visto')) {
    after(async () => {
      await eventoTrialBackend(userId, 'paywall_visto');
    });
  }

  return NextResponse.json({
    conteoTx: conteoTx ?? 0,
    totalMes,
    trialVence: (auth.user.trial_vence as string | null) ?? null,
    trialEstado: (auth.user.trial_estado as string | null) ?? null,
    nombre: (auth.user.nombre as string | null) ?? null,
  });
}
