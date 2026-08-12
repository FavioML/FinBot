import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { getCategoriaEmoji } from '@/lib/constants';
import {
  cascadeRootDelete,
  cascadeSubDelete,
  relabelRootName,
  relabelSubName,
  exactCI,
} from '@/lib/category-cascade';
import type { SupabaseClient } from '@supabase/supabase-js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Valida y normaliza un nombre de categoría/subcategoría. */
function cleanName(nombre: unknown): string | null {
  if (typeof nombre !== 'string') return null;
  const t = nombre.trim();
  if (t.length < 2 || t.length > 30) return null;
  return t;
}

/**
 * "Tombstone" de una subcategoría hardcodeada (system): inserta una fila
 * inactiva con ese nombre bajo el padre, para que el merge del cliente deje de
 * mostrar el default. Si ya existe una fila real (activa o no) con ese nombre,
 * la deja inactiva en vez de duplicar (evita chocar con el unique constraint
 * sobre (usuario_id, nombre, padre_id), que cuenta filas inactivas también).
 */
async function tombstoneSystemSub(
  svc: SupabaseClient,
  userId: string,
  padreId: string,
  nombre: string
) {
  const clean = nombre.trim();
  if (!clean) return;
  const { data: rows } = await svc
    .from('categorias_usuario')
    .select('id, activa')
    .eq('usuario_id', userId)
    .eq('padre_id', padreId)
    .filter('nombre', 'imatch', exactCI(clean))
    .limit(1);
  if (rows && rows.length > 0) {
    if (rows[0].activa) {
      await svc
        .from('categorias_usuario')
        .update({ activa: false })
        .eq('id', rows[0].id)
        .eq('usuario_id', userId);
    }
    return;
  }
  await svc
    .from('categorias_usuario')
    .insert({ usuario_id: userId, padre_id: padreId, nombre: clean, activa: false });
}

/* GET — list user categories with subcategories */
export async function GET() {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  // Get root categories
  const { data: cats, error } = await getServiceClient()
    .from('categorias_usuario')
    .select('*')
    .eq('usuario_id', userId)
    .eq('activa', true)
    .is('padre_id', null)
    .order('nombre');

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  // Get subcategories for each category from categorias_usuario
  const result: {
    id: string;
    nombre: string;
    subcategorias: { id: string | null; nombre: string; from_tx?: boolean }[];
    deletedSubNames?: string[];
  }[] = [];
  for (const cat of (cats || [])) {
    const { data: subs } = await getServiceClient()
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
  const { data: txRows } = await getServiceClient()
    .from('transacciones')
    .select('categoria, subcategoria')
    .eq('usuario_id', userId)
    .not('subcategoria', 'is', null);

  // Build map: categoria → Set of subcategorías used in transactions
  const txSubMap = new Map<string, Set<string>>();
  for (const tx of txRows || []) {
    const s = (tx.subcategoria || '').toLowerCase();
    if (!tx.subcategoria || s === 'null' || s === 'sin_categoria') continue;
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
    await getServiceClient().from('categorias_usuario').insert(newSubsToInsert);
    // Re-fetch subcategories now that new rows exist
    for (const cat of result) {
      const { data: subs } = await getServiceClient()
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

  // Attach soft-deleted subcategory names per category. The client uses these to
  // suppress hardcoded (system) subs that the user renamed away or deleted, so
  // they don't reappear from the CATEGORIAS constant on the next fetch.
  const { data: inactiveSubs } = await getServiceClient()
    .from('categorias_usuario')
    .select('nombre, padre_id')
    .eq('usuario_id', userId)
    .eq('activa', false)
    .not('padre_id', 'is', null);
  const deletedByParent = new Map<string, string[]>();
  for (const s of inactiveSubs || []) {
    if (!s.padre_id) continue;
    if (!deletedByParent.has(s.padre_id)) deletedByParent.set(s.padre_id, []);
    deletedByParent.get(s.padre_id)!.push(String(s.nombre).toLowerCase());
  }
  for (const cat of result) {
    cat.deletedSubNames = deletedByParent.get(cat.id) || [];
  }

  return NextResponse.json(result);
}

/* POST — create a root category or a subcategory (no gasto required) */
export async function POST(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json().catch(() => ({}));
  const nombre = cleanName(body?.nombre);
  if (!nombre)
    return NextResponse.json({ error: 'El nombre debe tener entre 2 y 30 caracteres' }, { status: 400 });

  const padreId = typeof body?.padreId === 'string' && body.padreId ? body.padreId : null;
  const svc = getServiceClient();

  // Subcategory: verify the parent belongs to the user and is itself a root
  if (padreId) {
    const { data: padre, error: padreErr } = await svc
      .from('categorias_usuario')
      .select('id, usuario_id, padre_id')
      .eq('id', padreId)
      .maybeSingle();
    if (padreErr)
      return NextResponse.json({ error: padreErr.message }, { status: 500 });
    if (!padre || padre.usuario_id !== userId)
      return NextResponse.json({ error: 'Categoría padre no encontrada' }, { status: 404 });
    if (padre.padre_id)
      return NextResponse.json({ error: 'No se pueden anidar subcategorías' }, { status: 400 });
  }

  // Look for an existing row with the same (nombre, padre) — case-insensitive.
  // .limit() + length check on purpose: .single() throws on >1 row and would
  // reintroduce the duplication cascade bug (project_categorias_dedup_singlebug).
  let existingQ = svc
    .from('categorias_usuario')
    .select('id, activa')
    .eq('usuario_id', userId)
    .filter('nombre', 'imatch', exactCI(nombre));
  existingQ = padreId ? existingQ.eq('padre_id', padreId) : existingQ.is('padre_id', null);
  const { data: existing } = await existingQ.order('created_at', { ascending: true }).limit(5);

  if ((existing || []).some((r) => r.activa)) {
    return NextResponse.json(
      { error: 'Ya existe una categoría con ese nombre', code: 'DUPLICATE' },
      { status: 409 }
    );
  }

  // Soft-deleted row with the same name → reactivate it (the user deleted it and
  // is recreating it; inserting a new row would violate the unique constraint).
  const inactive = (existing || []).find((r) => !r.activa);
  if (inactive) {
    const { data: row, error } = await svc
      .from('categorias_usuario')
      .update({ nombre, activa: true })
      .eq('id', inactive.id)
      .eq('usuario_id', userId)
      .select()
      .single();
    if (error) {
      // 23505 también acá: el índice único parcial de la migración 067 cubre las raíces, y
      // reactivar una choca contra otra que ya esté activa con ese nombre. Prod tiene un par
      // que difiere solo en mayúsculas ("transporte"/"Transporte"), así que este camino es
      // alcanzable — y devolvía 400 con el mensaje crudo de Postgres, que el usuario lee
      // como un error del sistema en vez de "esa ya existe".
      if (error.code === '23505')
        return NextResponse.json(
          { error: 'Ya existe una categoría con ese nombre', code: 'DUPLICATE' },
          { status: 409 }
        );
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(row, { status: 200 });
  }

  // Insert a fresh row. Roots get an auto-resolved emoji; subs don't use it.
  const insertRow: Record<string, unknown> = { usuario_id: userId, nombre, activa: true };
  if (padreId) insertRow.padre_id = padreId;
  else insertRow.emoji = getCategoriaEmoji(nombre);

  const { data: row, error } = await svc
    .from('categorias_usuario')
    .insert(insertRow)
    .select()
    .single();
  if (error) {
    if (error.code === '23505')
      return NextResponse.json(
        { error: 'Ya existe una categoría con ese nombre', code: 'DUPLICATE' },
        { status: 409 }
      );
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(row, { status: 201 });
}

/* DELETE — soft-delete a category/subcategory (set activa=false) */
export async function DELETE(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const svc = getServiceClient();

  // System subcategory (hardcoded default, no real row yet): sus transacciones
  // sueltan la sub y luego se tombstonea, tras verificar el padre del usuario.
  if (searchParams.get('system') === 'true') {
    const padreId = searchParams.get('padreId');
    const nombre = searchParams.get('nombre');
    if (!padreId || !nombre)
      return NextResponse.json({ error: 'Datos incompletos' }, { status: 400 });
    const { data: padre, error: padreErr } = await svc
      .from('categorias_usuario')
      .select('id, usuario_id, nombre')
      .eq('id', padreId)
      .maybeSingle();
    if (padreErr)
      return NextResponse.json({ error: padreErr.message }, { status: 500 });
    if (!padre || padre.usuario_id !== userId)
      return NextResponse.json({ error: 'Categoría no encontrada' }, { status: 404 });
    await cascadeSubDelete(svc, userId, padre.nombre, nombre);
    await tombstoneSystemSub(svc, userId, padreId, nombre);
    return NextResponse.json({ ok: true });
  }

  const catId = searchParams.get('id');

  if (!catId)
    return NextResponse.json({ error: 'ID requerido' }, { status: 400 });

  // Verify ownership
  const { data: cat, error: catErr } = await svc
    .from('categorias_usuario')
    .select('id, usuario_id, padre_id, nombre')
    .eq('id', catId)
    .maybeSingle();

  if (catErr)
    return NextResponse.json({ error: catErr.message }, { status: 500 });
  if (!cat || cat.usuario_id !== userId)
    return NextResponse.json({ error: 'Categoria no encontrada' }, { status: 404 });

  // Cascadear a los consumidores ANTES del soft-delete (decide por padre_id real, no
  // por el query param): las funciones filtran por el NOMBRE, que sigue vivo hasta el
  // update de abajo. Sub → las filas quedan con la categoría padre. Raíz → tx a "Por
  // revisar" + sus subs se desactivan. El alcance exacto, en `@/lib/category-refs`.
  if (cat.padre_id) {
    // 500 y NO seguir de largo. Esta lectura DECIDE si el cascade corre: sin el nombre
    // del padre no hay con qué filtrar, y postgrest no lanza — un hipo de Supabase
    // devolvía `parent === undefined`, el `if` no entraba, el cascade no corría, y la
    // ruta igual borraba la categoría y respondía 200. O sea: el síntoma exacto que este
    // módulo vino a cerrar (filas apuntando a un nombre que ya no existe) y sin un solo
    // log, porque el `avisar()` del cascade nunca llega a invocarse.
    const { data: parent, error: parentErr } = await svc
      .from('categorias_usuario')
      .select('nombre')
      .eq('id', cat.padre_id)
      .maybeSingle();
    if (parentErr) {
      console.error('[categories:padre] lectura fallida', { id: cat.padre_id, err: parentErr.message });
      return NextResponse.json({ error: parentErr.message }, { status: 500 });
    }
    if (parent?.nombre) {
      await cascadeSubDelete(svc, userId, parent.nombre, cat.nombre);
    }
  } else {
    await cascadeRootDelete(svc, userId, cat.nombre);
    await svc
      .from('categorias_usuario')
      .update({ activa: false })
      .eq('padre_id', catId)
      .eq('usuario_id', userId);
  }

  // Soft-delete the category itself
  const { error } = await svc
    .from('categorias_usuario')
    .update({ activa: false })
    .eq('id', catId)
    .eq('usuario_id', userId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

/* PUT — rename a category/subcategory */
export async function PUT(request: Request) {
  const auth = await requireNetoUser();
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const body = await request.json().catch(() => ({}));
  const nombre = cleanName(body?.nombre);
  if (!nombre)
    return NextResponse.json({ error: 'El nombre debe tener entre 2 y 30 caracteres' }, { status: 400 });

  const svc = getServiceClient();

  // System subcategory rename: materialize it. Create the real active row with
  // the new name and tombstone the old hardcoded name so it doesn't reappear.
  if (body?.system === true) {
    const padreId = typeof body?.padreId === 'string' ? body.padreId : null;
    const oldNombre = typeof body?.oldNombre === 'string' ? body.oldNombre.trim() : '';
    if (!padreId || !oldNombre)
      return NextResponse.json({ error: 'Datos incompletos' }, { status: 400 });

    const { data: padre, error: padreErr } = await svc
      .from('categorias_usuario')
      .select('id, usuario_id, padre_id, nombre')
      .eq('id', padreId)
      .maybeSingle();
    if (padreErr)
      return NextResponse.json({ error: padreErr.message }, { status: 500 });
    if (!padre || padre.usuario_id !== userId || padre.padre_id)
      return NextResponse.json({ error: 'Categoría no encontrada' }, { status: 404 });

    // Reuse create semantics for the new name under this parent
    const { data: existing } = await svc
      .from('categorias_usuario')
      .select('id, activa')
      .eq('usuario_id', userId)
      .eq('padre_id', padreId)
      .filter('nombre', 'imatch', exactCI(nombre))
      .order('created_at', { ascending: true })
      .limit(5);

    if ((existing || []).some((r) => r.activa)) {
      return NextResponse.json(
        { error: 'Ya existe una subcategoría con ese nombre', code: 'DUPLICATE' },
        { status: 409 }
      );
    }

    let created;
    const inactive = (existing || []).find((r) => !r.activa);
    if (inactive) {
      const { data, error } = await svc
        .from('categorias_usuario')
        .update({ nombre, activa: true })
        .eq('id', inactive.id)
        .eq('usuario_id', userId)
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      created = data;
    } else {
      const { data, error } = await svc
        .from('categorias_usuario')
        .insert({ usuario_id: userId, padre_id: padreId, nombre, activa: true })
        .select()
        .single();
      if (error && error.code !== '23505')
        return NextResponse.json({ error: error.message }, { status: 400 });
      created = data;
    }

    // Reetiquetar las transacciones/presupuestos/reglas que usaban el default.
    await relabelSubName(svc, userId, padre.nombre, oldNombre, nombre);
    await tombstoneSystemSub(svc, userId, padreId, oldNombre);
    return NextResponse.json(created ?? { ok: true, nombre });
  }

  // Real row rename (root or already-materialized sub)
  const id = body?.id;
  if (!id || typeof id !== 'string')
    return NextResponse.json({ error: 'ID requerido' }, { status: 400 });

  // Verify ownership
  const { data: cat, error: catErr } = await svc
    .from('categorias_usuario')
    .select('id, usuario_id, nombre, padre_id')
    .eq('id', id)
    .maybeSingle();

  if (catErr)
    return NextResponse.json({ error: catErr.message }, { status: 500 });
  if (!cat || cat.usuario_id !== userId)
    return NextResponse.json({ error: 'Categoria no encontrada' }, { status: 404 });

  const { error } = await svc
    .from('categorias_usuario')
    .update({ nombre })
    .eq('id', id)
    .eq('usuario_id', userId);

  if (error) {
    if (error.code === '23505')
      return NextResponse.json(
        { error: 'Ya existe una categoría con ese nombre', code: 'DUPLICATE' },
        { status: 409 }
      );
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Reetiquetar las tablas que referencian por nombre (transacciones, presupuestos,
  // reglas). Sub → subcategoria bajo su padre; raíz → categoria.
  if (cat.padre_id) {
    // Mismo caso que en el DELETE: sin el nombre del padre el cascade no puede correr.
    // Acá el rename de `categorias_usuario` YA se aplicó, así que devolver 500 deja la
    // categoría renombrada y sus consumidores no — pero es el único estado que el
    // usuario puede ver y reintentar. Tragarse el error deja el mismo desfase, mudo.
    const { data: parent, error: parentErr } = await svc
      .from('categorias_usuario')
      .select('nombre')
      .eq('id', cat.padre_id)
      .maybeSingle();
    if (parentErr) {
      console.error('[categories:padre] lectura fallida', { id: cat.padre_id, err: parentErr.message });
      return NextResponse.json({ error: parentErr.message }, { status: 500 });
    }
    if (parent?.nombre) await relabelSubName(svc, userId, parent.nombre, cat.nombre, nombre);
  } else {
    await relabelRootName(svc, userId, cat.nombre, nombre);
  }

  return NextResponse.json({ ok: true, nombre });
}
