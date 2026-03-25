import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getNetoUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await serviceClient
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data?.id || null;
}

export async function GET() {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Fetch all user data in parallel
  const [txResult, budgetResult, goalsResult, userResult] = await Promise.all([
    serviceClient
      .from('transacciones')
      .select('*')
      .eq('usuario_id', userId)
      .order('fecha', { ascending: false }),
    serviceClient
      .from('presupuestos')
      .select('*')
      .eq('usuario_id', userId),
    serviceClient
      .from('metas_ahorro')
      .select('*')
      .eq('usuario_id', userId),
    serviceClient
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
