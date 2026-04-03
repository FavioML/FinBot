import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { getExchangeRate } from '@/lib/exchange-rate';
import { checkRateLimit } from '@/lib/rate-limit';
import crypto from 'crypto';

/** Validate monto: must be positive number <= 999999.99 */
function validarMonto(valor: unknown): number | null {
  const n = parseFloat(String(valor));
  if (isNaN(n) || !isFinite(n) || n <= 0 || n > 999999.99) return null;
  return Math.round(n * 100) / 100;
}

/** Generate dedup hash matching backend format */
function generarDedupHash(userId: string, fecha: string, monto: number, comercio: string | null, tipo: string): string {
  const raw = userId + '|' + fecha + '|' + monto + '|' + (comercio || '') + '|' + tipo;
  return crypto.createHash('md5').update(raw).digest('hex');
}

async function getNetoUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data?.id || null;
}

// Save merchant → category rule so future transactions auto-categorize
async function syncReglaComercio(userId: string, comercio: string | null, categoria: string, subcategoria: string | null) {
  if (!comercio || !categoria) return;
  const patron = comercio.toLowerCase().trim();
  if (!patron) return;
  try {
    await getServiceClient().from('reglas_comercio').upsert({
      usuario_id: userId,
      comercio_pattern: patron,
      categoria,
      subcategoria: subcategoria && subcategoria !== 'sin_categoria' ? subcategoria : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'usuario_id,comercio_pattern' });
  } catch (e) {
    console.error('[sync-regla]', e);
  }
}

// Sync categoría y subcategoría custom a categorias_usuario
async function syncCategoriasUsuario(userId: string, categoria: string, subcategoria: string | null) {
  if (!categoria) return;

  // Buscar si la categoría padre existe en categorias_usuario
  const { data: padre } = await getServiceClient()
    .from('categorias_usuario')
    .select('id')
    .eq('usuario_id', userId)
    .eq('nombre', categoria)
    .is('padre_id', null)
    .maybeSingle();

  // Si la categoría no existe, crearla
  let padreId = padre?.id;
  if (!padreId) {
    const { data: nuevoPadre } = await getServiceClient()
      .from('categorias_usuario')
      .insert({ usuario_id: userId, nombre: categoria, activa: true })
      .select('id')
      .single();
    padreId = nuevoPadre?.id;
  }

  // Si hay subcategoría custom, crearla si no existe
  if (subcategoria && subcategoria !== 'sin_categoria' && padreId) {
    const { data: existeSub } = await getServiceClient()
      .from('categorias_usuario')
      .select('id')
      .eq('usuario_id', userId)
      .eq('padre_id', padreId)
      .ilike('nombre', subcategoria)
      .maybeSingle();

    if (!existeSub) {
      await getServiceClient().from('categorias_usuario').insert({
        usuario_id: userId,
        nombre: subcategoria,
        padre_id: padreId,
        activa: true,
      });
    }
  }
}

export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();

  // Validate monto
  const monto = validarMonto(body.monto);
  if (monto === null)
    return NextResponse.json({ error: 'Monto inválido' }, { status: 400 });

  // Calculate monto_pen based on moneda — use live exchange rate
  const tc = body.moneda === 'USD' ? await getExchangeRate() : 1;
  const montoPen = body.moneda === 'USD' ? Math.round(monto * tc * 100) / 100 : monto;

  const subcategoria = body.subcategoria || 'sin_categoria';
  const tipo = body.tipo || 'gasto';
  const dedupHash = generarDedupHash(userId, body.fecha, monto, body.comercio || null, tipo);

  const { data, error } = await getServiceClient()
    .from('transacciones')
    .insert({
      usuario_id: userId,
      tipo,
      monto,
      monto_pen: montoPen,
      moneda: body.moneda || 'PEN',
      tipo_cambio: body.moneda === 'USD' ? tc : null,
      comercio: body.comercio || null,
      categoria: body.categoria,
      subcategoria,
      fecha: body.fecha,
      metodo_pago: body.metodo_pago || null,
      dedup_hash: dedupHash,
    })
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Sync categoría/subcategoría a categorias_usuario (fire-and-forget)
  syncCategoriasUsuario(userId, body.categoria, body.subcategoria).catch((e) => console.error('[sync-cat]', e));
  // Learn merchant → category rule for auto-categorization
  syncReglaComercio(userId, body.comercio, body.categoria, body.subcategoria).catch((e) => console.error('[sync-regla]', e));

  return NextResponse.json(data);
}

export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();
  const monto = validarMonto(body.monto);
  if (monto === null)
    return NextResponse.json({ error: 'Monto inválido' }, { status: 400 });

  const tc = body.moneda === 'USD' ? await getExchangeRate() : 1;
  const montoPen = body.moneda === 'USD' ? Math.round(monto * tc * 100) / 100 : monto;

  const subcategoria = body.subcategoria || 'sin_categoria';

  const { data, error } = await getServiceClient()
    .from('transacciones')
    .update({
      tipo: body.tipo,
      monto,
      monto_pen: montoPen,
      moneda: body.moneda || 'PEN',
      tipo_cambio: body.moneda === 'USD' ? tc : null,
      comercio: body.comercio || null,
      categoria: body.categoria,
      subcategoria,
      fecha: body.fecha,
      metodo_pago: body.metodo_pago || null,
    })
    .eq('id', body.id)
    .eq('usuario_id', userId)
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Sync categoría/subcategoría a categorias_usuario (fire-and-forget)
  syncCategoriasUsuario(userId, body.categoria, body.subcategoria).catch((e) => console.error('[sync-cat]', e));
  // Learn merchant → category rule for auto-categorization
  syncReglaComercio(userId, body.comercio, body.categoria, body.subcategoria).catch((e) => console.error('[sync-regla]', e));

  return NextResponse.json(data);
}

/* PATCH — bulk update selected fields on multiple transactions */
export async function PATCH(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json();
  const { ids, updates } = body;

  if (!ids || !Array.isArray(ids) || ids.length === 0)
    return NextResponse.json({ error: 'IDs requeridos' }, { status: 400 });

  if (ids.length > 200)
    return NextResponse.json({ error: 'Máximo 200 transacciones por lote' }, { status: 400 });

  if (!updates || typeof updates !== 'object')
    return NextResponse.json({ error: 'Campos a actualizar requeridos' }, { status: 400 });

  // Only allow these fields for bulk edit
  const allowed = ['metodo_pago', 'banco', 'categoria', 'subcategoria'];
  const cleanUpdates: Record<string, string | null> = {};
  for (const key of allowed) {
    if (key in updates && updates[key] !== undefined) {
      // subcategoria debe ser 'sin_categoria' (nunca null) para consistencia con el bot
      if (key === 'subcategoria') {
        cleanUpdates[key] = updates[key] || 'sin_categoria';
      } else {
        cleanUpdates[key] = updates[key] || null;
      }
    }
  }

  if (Object.keys(cleanUpdates).length === 0)
    return NextResponse.json({ error: 'Sin campos validos' }, { status: 400 });

  // Update all matching transactions owned by user
  const { error, count } = await getServiceClient()
    .from('transacciones')
    .update(cleanUpdates)
    .in('id', ids)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Sync category if changed
  if (cleanUpdates.categoria) {
    syncCategoriasUsuario(userId, cleanUpdates.categoria, cleanUpdates.subcategoria || null).catch((e) => console.error('[sync-cat]', e));
  }

  return NextResponse.json({ ok: true, updated: count ?? ids.length });
}

export async function DELETE(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // Leer transacción antes de borrar para guardar exclusión Gmail si aplica
  const { data: txToDelete } = await getServiceClient()
    .from('transacciones')
    .select('id, descripcion_original')
    .eq('id', id)
    .eq('usuario_id', userId)
    .single();

  if (!txToDelete)
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

  // Limpiar consultas_pendientes asociadas
  await getServiceClient()
    .from('consultas_pendientes')
    .update({ estado: 'respondida', respondida_at: new Date().toISOString() })
    .eq('transaccion_id', id)
    .eq('estado', 'pendiente');

  // Si es transacción de Gmail, guardar en excluidos para evitar re-importación
  if (txToDelete.descripcion_original && !txToDelete.descripcion_original.startsWith('duplicado:')) {
    try {
      await getServiceClient()
        .from('gmail_excluidos')
        .upsert(
          { usuario_id: userId, descripcion_original: txToDelete.descripcion_original },
          { onConflict: 'usuario_id,descripcion_original' }
        );
    } catch { /* ignore — best effort */ }
  }

  const { error } = await getServiceClient()
    .from('transacciones')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
