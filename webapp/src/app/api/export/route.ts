import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

export async function GET() {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  // Check plan early before fetching all data
  const { data: userData } = await getServiceClient()
    .from('usuarios')
    .select('plan')
    .eq('id', userId)
    .single();

  if (userData?.plan !== 'premium') {
    return NextResponse.json(
      { error: 'Exportar datos es una función Pro. Activa Pro por WhatsApp.', upgrade: true },
      { status: 403 },
    );
  }

  // Fetch all user data in parallel
  const [txResult, budgetResult, goalsResult, userResult] = await Promise.all([
    getServiceClient()
      .from('transacciones')
      .select('*')
      .eq('usuario_id', userId)
      .order('fecha', { ascending: false }),
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
