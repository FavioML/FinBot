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

/* GET — list user categories with subcategories */
export async function GET() {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  // Get root categories
  const { data: cats, error } = await serviceClient
    .from('categorias_usuario')
    .select('*')
    .eq('usuario_id', userId)
    .eq('activa', true)
    .is('padre_id', null)
    .order('nombre');

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Get subcategories for each category from categorias_usuario
  const result: { id: string; nombre: string; subcategorias: { id: string | null; nombre: string; from_tx?: boolean }[] }[] = [];
  for (const cat of (cats || [])) {
    const { data: subs } = await serviceClient
      .from('categorias_usuario')
      .select('*')
      .eq('usuario_id', userId)
      .eq('padre_id', cat.id)
      .eq('activa', true)
      .order('nombre');
    result.push({ ...cat, subcategorias: subs || [] });
  }

  // Also pull distinct (categoria, subcategoria) pairs from real transactions
  // so "Gestionar categorías" shows the same subcategories as the transaction filter
  const { data: txRows } = await serviceClient
    .from('transacciones')
    .select('categoria, subcategoria')
    .eq('usuario_id', userId)
    .not('subcategoria', 'is', null);

  // Build map: categoria → Set of subcategorías used in transactions
  const txSubMap = new Map<string, Set<string>>();
  for (const tx of txRows || []) {
    if (!tx.subcategoria || tx.subcategoria === 'null' || tx.subcategoria === 'sin_categoria') continue;
    if (!txSubMap.has(tx.categoria)) txSubMap.set(tx.categoria, new Set());
    txSubMap.get(tx.categoria)!.add(tx.subcategoria);
  }

  // Materialize tx-derived subs into categorias_usuario so they become fully editable
  const newSubsToInsert: { usuario_id: string; padre_id: string; nombre: string; activa: boolean }[] = [];
  for (const cat of result) {
    const txSubs = txSubMap.get(cat.nombre) || new Set<string>();
    const dbSubsLower = new Set(cat.subcategorias.map((s) => s.nombre.toLowerCase()));
    for (const txSub of txSubs) {
      if (!dbSubsLower.has(txSub.toLowerCase())) {
        newSubsToInsert.push({ usuario_id: userId, padre_id: cat.id, nombre: txSub, activa: true });
      }
    }
  }

  if (newSubsToInsert.length > 0) {
    await serviceClient.from('categorias_usuario').insert(newSubsToInsert);
    // Re-fetch subcategories now that new rows exist
    for (const cat of result) {
      const { data: subs } = await serviceClient
        .from('categorias_usuario')
        .select('*')
        .eq('usuario_id', userId)
        .eq('padre_id', cat.id)
        .eq('activa', true)
        .order('nombre');
      cat.subcategorias = subs || [];
    }
  } else {
    // Just sort what we have
    for (const cat of result) {
      cat.subcategorias.sort((a, b) => a.nombre.localeCompare(b.nombre));
    }
  }

  return NextResponse.json(result);
}

/* DELETE — soft-delete a category (set activa=false) */
export async function DELETE(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const catId = searchParams.get('id');
  const isSubcategory = searchParams.get('sub') === 'true';

  if (!catId)
    return NextResponse.json({ error: 'ID requerido' }, { status: 400 });

  // Verify ownership
  const { data: cat } = await serviceClient
    .from('categorias_usuario')
    .select('id, usuario_id, padre_id')
    .eq('id', catId)
    .single();

  if (!cat || cat.usuario_id !== userId)
    return NextResponse.json({ error: 'Categoria no encontrada' }, { status: 404 });

  if (!isSubcategory && !cat.padre_id) {
    // Deleting a root category — also deactivate its subcategories
    await serviceClient
      .from('categorias_usuario')
      .update({ activa: false })
      .eq('padre_id', catId)
      .eq('usuario_id', userId);
  }

  // Soft-delete the category itself
  const { error } = await serviceClient
    .from('categorias_usuario')
    .update({ activa: false })
    .eq('id', catId)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

/* PUT — rename a category */
export async function PUT(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const body = await request.json();
  const { id, nombre } = body;

  if (!id || !nombre || typeof nombre !== 'string')
    return NextResponse.json({ error: 'ID y nombre requeridos' }, { status: 400 });

  const nombreLimpio = nombre.trim();
  if (nombreLimpio.length < 2 || nombreLimpio.length > 30)
    return NextResponse.json({ error: 'El nombre debe tener entre 2 y 30 caracteres' }, { status: 400 });

  // Verify ownership
  const { data: cat } = await serviceClient
    .from('categorias_usuario')
    .select('id, usuario_id')
    .eq('id', id)
    .single();

  if (!cat || cat.usuario_id !== userId)
    return NextResponse.json({ error: 'Categoria no encontrada' }, { status: 404 });

  const { error } = await serviceClient
    .from('categorias_usuario')
    .update({ nombre: nombreLimpio })
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, nombre: nombreLimpio });
}
