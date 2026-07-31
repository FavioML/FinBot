import type { SupabaseClient } from '@supabase/supabase-js';
import { CATEGORIAS } from '@/lib/constants';

// Creación de cuenta Neto web-first (login Google, SIN número de WhatsApp).
//
// Hasta el sprint de onboarding web, la fila `usuarios` solo nacía de un mensaje de
// WhatsApp. Este es el segundo punto de creación: el callback de auth lo llama cuando
// un login de Google no corresponde a ninguna fila (ni por auth_id ni por email).
// El número queda NULL y WhatsApp pasa a ser un vínculo opcional posterior (reverse-OTP).

interface CreateWebUserInput {
  authId: string;
  email: string | null;
  nombre: string | null;
}

/**
 * Crea la fila `usuarios` web-first y siembra las categorías default. Idempotente ante
 * carrera: si otra pestaña ya creó la fila (unique en supabase_auth_id → 23505), la
 * recupera en vez de fallar. Devuelve el id interno de `usuarios`, o null si no se pudo
 * crear ni encontrar (el caller decide el fallback).
 */
export async function createWebUser(
  svc: SupabaseClient,
  { authId, email, nombre }: CreateWebUserInput,
): Promise<string | null> {
  const { data: created, error } = await svc
    .from('usuarios')
    .insert({
      supabase_auth_id: authId,
      email: email || null,
      nombre: nombre || null,
      plan: 'free',
      onboarding_completado: true,
      onboarding_paso: 0,
    })
    .select('id')
    .single();

  let userId: string | undefined = created?.id;

  if (error) {
    if (error.code === '23505') {
      // Otra sesión creó la fila en la ventana. La recuperamos por auth_id.
      const { data: existing } = await svc
        .from('usuarios')
        .select('id')
        .eq('supabase_auth_id', authId)
        .maybeSingle();
      userId = existing?.id;
    } else {
      console.error('[create-web-user] insert falló:', error.code, error.message);
      return null;
    }
  }

  if (!userId) return null;

  await seedDefaultCategories(svc, userId);
  return userId;
}

/**
 * Siembra el set canónico de categorías (con subcategorías) para un usuario nuevo.
 * Best-effort: si falla, la cuenta ya quedó creada y el dashboard tiene CRUD de
 * categorías. Dos inserts (padres, luego hijas) en vez de ~70. `activa` toma su default.
 */
async function seedDefaultCategories(svc: SupabaseClient, usuarioId: string): Promise<void> {
  try {
    const parents = CATEGORIAS.map((c) => ({
      usuario_id: usuarioId,
      nombre: c.nombre,
      emoji: c.emoji,
    }));
    const { data: createdCats, error } = await svc
      .from('categorias_usuario')
      .insert(parents)
      .select('id, nombre');
    if (error || !createdCats) {
      console.error('[create-web-user] seed padres falló:', error?.message);
      return;
    }

    const idByNombre = new Map<string, string>(
      createdCats.map((p: { id: string; nombre: string }) => [p.nombre, p.id]),
    );
    const subs: { usuario_id: string; nombre: string; padre_id: string }[] = [];
    for (const c of CATEGORIAS) {
      const padreId = idByNombre.get(c.nombre);
      if (!padreId) continue;
      for (const s of c.subs) subs.push({ usuario_id: usuarioId, nombre: s, padre_id: padreId });
    }
    if (subs.length) {
      const { error: subErr } = await svc.from('categorias_usuario').insert(subs);
      if (subErr) console.error('[create-web-user] seed subcategorías falló:', subErr.message);
    }
  } catch (e) {
    console.error('[create-web-user] seed categorías excepción:', (e as Error).message);
  }
}
