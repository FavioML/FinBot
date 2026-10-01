import { requireNetoUser } from '@/lib/supabase/auth';
import { getServiceClient } from '@/lib/supabase/service';
import { todasLasFilas } from '@/lib/supabase/todas-las-filas';
import { eventoTrialBackend } from '@/lib/trial-backend';
import { tieneWhatsapp } from '@/lib/whatsapp-vinculo';
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
  const auth = await requireNetoUser('id, nombre, whatsapp, bsuid, plan, trial_estado, trial_vence');
  if (!auth.ok) return auth.response;
  const userId = auth.user.id as string;

  const svc = getServiceClient();
  const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const inicioMes = hoyLima.slice(0, 8) + '01';

  const [{ count: conteoTx, error: errorConteo }, { data: delMes, error: errorMes }] = await Promise.all([
    svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', userId),
    // Paginado aunque un mes esté lejos de 1000 gastos (máximo medido el 01-oct-2026: 163): es
    // una SUMA que se le muestra al usuario, y cortada daría un total más bajo sin avisar.
    todasLasFilas<{ id: string; monto: number | null; monto_pen: number | null }>(
      (desde, hasta, primera) =>
        svc
          .from('transacciones')
          .select('id, monto, monto_pen', primera ? { count: 'exact' } : undefined)
          .eq('usuario_id', userId)
          .eq('tipo', 'gasto')
          .gte('fecha', inicioMes)
          .lte('fecha', hoyLima)
          .order('id')
          .range(desde, hasta),
      (t) => t.id,
    ),
  ]);

  // monto_pen es NULLABLE a propósito (la rama USD fuera de rango deja null honesto),
  // así que se lee con coalesce igual que en el resto del código.
  // Sin el conteo, `null` y no 0: con 0 la pantalla le pediría "tu primer gasto" a quien tiene
  // cientos. Y no un 500, que le haría perder a `paywall.tsx` el estado del trial y el canal (con
  // `datos` en null le dice "tu prueba terminó" a quien nunca la tuvo) y saltearía el `visto`.
  if (errorConteo) console.error('[pro/muro] no se pudo contar las transacciones', errorConteo);
  // Con error, `todasLasFilas` trae lo que alcanzó a llegar: sumarlo daría un total corto. En 0 la
  // pantalla no muestra la línea del total (`paywall.tsx` la pinta solo si es > 0).
  if (errorMes) console.error('[pro/muro] no se pudo sumar los gastos del mes', errorMes);
  const totalMes = errorMes ? 0 : delMes.reduce(
    (acc, t) => acc + Number(t.monto_pen != null ? t.monto_pen : (t.monto ?? 0)),
    0,
  );

  if (new URL(request.url).searchParams.has('visto')) {
    after(async () => {
      await eventoTrialBackend(userId, 'paywall_visto');
    });
  }

  return NextResponse.json({
    conteoTx: errorConteo ? null : (conteoTx ?? 0),
    totalMes,
    trialVence: (auth.user.trial_vence as string | null) ?? null,
    trialEstado: (auth.user.trial_estado as string | null) ?? null,
    nombre: (auth.user.nombre as string | null) ?? null,
    // El usuario web-first nace sin número (WhatsApp es un vínculo opcional posterior),
    // así que mandarlo a "anótalo por WhatsApp" lo manda a un canal que no tiene. La
    // pantalla necesita saberlo para apuntar al botón que sí está a su alcance.
    // Número o BSUID: quien se vinculó sin mostrar su número también anota por chat.
    tieneWhatsapp: tieneWhatsapp(auth.user),
  });
}
