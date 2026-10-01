import { getServiceClient } from '@/lib/supabase/service';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { todasLasFilas } from '@/lib/supabase/todas-las-filas';

export async function GET() {
  const auth = await requireLectura();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  // El plan ya lo gatea `requireLectura` (402 fuera de Pro o trial, 500 si la lectura cae). Acá
  // había una segunda lectura de `usuarios.plan` que sólo agregaba un modo de falla.

  // Fetch all user data in parallel. Las transacciones van paginadas: sin `.range()` PostgREST
  // corta en 1000 y el archivo salía con las 1000 más recientes de 1105 (medido el 01-oct-2026),
  // con un `totalTransacciones` que decía 1000. Un export es lo que la persona se lleva como
  // copia de su historia: uno corto es un dato falso entregado como completo.
  const [txResult, budgetResult, goalsResult, userResult] = await Promise.all([
    todasLasFilas(
      (desde, hasta, primera) =>
        getServiceClient()
          .from('transacciones')
          .select('*', primera ? { count: 'exact' } : undefined)
          .eq('usuario_id', userId)
          .order('fecha', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(desde, hasta),
      (t: { id: string }) => t.id,
    ),
    getServiceClient()
      .from('presupuestos')
      .select('*')
      .eq('usuario_id', userId),
    getServiceClient()
      .from('metas_ahorro')
      .select('*')
      .eq('usuario_id', userId),
    getServiceClient()
      .from('usuarios')
      .select('nombre, email, whatsapp, plan, created_at')
      .eq('id', userId)
      .single(),
  ]);

  // Una lectura caída no puede volverse una sección vacía del archivo: antes `txResult.data || []`
  // entregaba un export con cero transacciones que se veía exactamente como uno legítimo.
  // `todasLasFilas` con error trae lo que alcanzó a llegar, que tampoco es la lista completa.
  if (txResult.error || budgetResult.error || goalsResult.error || userResult.error) {
    return NextResponse.json(
      { error: 'No se pudo leer tu información completa. Intenta de nuevo en un momento.' },
      { status: 500 },
    );
  }

  const exportData = {
    exportDate: new Date().toISOString(),
    version: '1.0',
    user: userResult.data || {},
    transacciones: txResult.data || [],
    presupuestos: budgetResult.data || [],
    metas_ahorro: goalsResult.data || [],
    resumen: {
      totalTransacciones: txResult.data?.length || 0,
      totalPresupuestos: budgetResult.data?.length || 0,
      totalMetas: goalsResult.data?.length || 0,
    },
  };

  return new NextResponse(JSON.stringify(exportData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="neto-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
