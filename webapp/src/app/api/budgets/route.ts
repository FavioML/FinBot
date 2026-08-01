import { getServiceClient } from '@/lib/supabase/service';
import { requireLectura } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { parseMontoDinero } from '@/lib/money';

/** Capitalize first letter */
function capitalize(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

// GET /api/budgets?mes=X&anio=Y — get budgets with carry-forward logic
export async function GET(request: Request) {
  const auth = await requireLectura('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;
  const { searchParams } = new URL(request.url);
  const mes = parseInt(searchParams.get('mes') || '0');
  const anio = parseInt(searchParams.get('anio') || '0');

  if (!mes || !anio)
    return NextResponse.json({ error: 'mes and anio required' }, { status: 400 });

  // Check if budgets exist for the requested month
  const { data: existing } = await getServiceClient()
    .from('presupuestos')
    .select('*')
    .eq('usuario_id', userId)
    .eq('mes', mes)
    .eq('anio', anio);

  if (existing && existing.length > 0) {
    return NextResponse.json(existing);
  }

  // No budgets for this month — find the most recent month that has budgets
  const { data: latestBudgets } = await getServiceClient()
    .from('presupuestos')
    .select('*')
    .eq('usuario_id', userId)
    .order('anio', { ascending: false })
    .order('mes', { ascending: false });

  if (!latestBudgets || latestBudgets.length === 0) {
    return NextResponse.json([]);
  }

  // Get the most recent month's budgets
  const latestAnio = latestBudgets[0].anio;
  const latestMes = latestBudgets[0].mes;

  // Only carry forward if the requested month is AFTER the latest month
  const requestedDate = anio * 12 + mes;
  const latestDate = latestAnio * 12 + latestMes;

  if (requestedDate <= latestDate) {
    // Requested month is before or at the latest — no carry-forward, return empty
    return NextResponse.json([]);
  }

  // Carry forward: copy latest month's budgets into all intermediate months + the target month
  const sourceBudgets = latestBudgets.filter(
    (b) => b.mes === latestMes && b.anio === latestAnio,
  );

  // Generate all months between source (exclusive) and target (inclusive)
  const monthsToCreate: Array<{ mes: number; anio: number }> = [];
  const cursor = new Date(latestAnio, latestMes); // month after source (0-indexed)
  const targetDate = new Date(anio, mes - 1);

  while (cursor <= targetDate) {
    monthsToCreate.push({ mes: cursor.getMonth() + 1, anio: cursor.getFullYear() });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // Build inserts for each month in the range
  const allNewBudgets = monthsToCreate.flatMap(({ mes: m, anio: a }) =>
    sourceBudgets.map((b) => ({
      usuario_id: userId,
      categoria: b.categoria,
      subcategoria: b.subcategoria,
      monto_limite: b.monto_limite,
      alerta_porcentaje: b.alerta_porcentaje,
      mes: m,
      anio: a,
    })),
  );

  const { data: inserted, error } = await getServiceClient()
    .from('presupuestos')
    .insert(allNewBudgets)
    .select();

  if (error) {
    // If insert fails (e.g. unique constraint), just return empty
    return NextResponse.json([]);
  }

  // Return only the budgets for the requested month
  const forRequestedMonth = (inserted || []).filter(
    (b: { mes: number; anio: number }) => b.mes === mes && b.anio === anio,
  );
  return NextResponse.json(forRequestedMonth);
}

export async function POST(request: Request) {
  const auth = await requireLectura('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;

  const body = await request.json();

  // Validate monto_limite
  const montoLimite = parseMontoDinero(body.monto_limite);
  if (montoLimite === null) {
    return NextResponse.json({ error: 'Monto límite inválido' }, { status: 400 });
  }

  // Use mes/anio from body if provided (for creating budgets in a specific month),
  // otherwise default to current month in Lima timezone
  const now = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const defaultMes = parseInt(now.split('-')[1], 10);
  const defaultAnio = parseInt(now.split('-')[0], 10);
  const mes = body.mes ? parseInt(body.mes, 10) : defaultMes;
  const anio = body.anio ? parseInt(body.anio, 10) : defaultAnio;

  const { data, error } = await getServiceClient()
    .from('presupuestos')
    .insert({
      usuario_id: userId,
      categoria: body.categoria,
      subcategoria: capitalize(body.subcategoria),
      monto_limite: montoLimite,
      alerta_porcentaje: body.alerta_porcentaje || 80,
      mes,
      anio,
    })
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function PUT(request: Request) {
  const auth = await requireLectura('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;

  const body = await request.json();

  // El PUT tomaba `monto_limite` crudo (el POST hermano sí valida): editar un
  // presupuesto a 0/negativo hacía que el porcentaje usado dividiera por cero
  // (Infinity%) y la alerta ">= 100%" nunca disparara.
  const montoLimite = parseMontoDinero(body.monto_limite);
  if (montoLimite === null) {
    return NextResponse.json({ error: 'Monto límite inválido' }, { status: 400 });
  }

  const { data, error } = await getServiceClient()
    .from('presupuestos')
    .update({
      categoria: body.categoria,
      subcategoria: capitalize(body.subcategoria),
      monto_limite: montoLimite,
      alerta_porcentaje: body.alerta_porcentaje || 80,
    })
    .eq('id', body.id)
    .eq('usuario_id', userId)
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  const auth = await requireLectura('id, plan');
  if (!auth.ok) return auth.response;
  const netoUser = auth.user;

  if (!checkRateLimit(netoUser.id)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const userId = netoUser.id;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await getServiceClient()
    .from('presupuestos')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
