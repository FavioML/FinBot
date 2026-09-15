import type { SupabaseClient } from '@supabase/supabase-js';
import { CATEGORIAS } from '@/lib/constants';
import type { AtribucionAlta } from '@/lib/atribucion';

// Creación de cuenta Neto web-first (login Google, SIN número de WhatsApp).
//
// Hasta el sprint de onboarding web, la fila `usuarios` solo nacía de un mensaje de
// WhatsApp. Este es el segundo punto de creación: el callback de auth lo llama cuando
// un login de Google no corresponde a ninguna fila por auth_id. Nunca adopta una fila por su
// correo: eso exige probar el número (activación firmada u OTP inverso).
// El número queda NULL y WhatsApp pasa a ser un vínculo opcional posterior (reverse-OTP).

interface CreateWebUserInput {
  authId: string;
  email: string | null;
  nombre: string | null;
  /**
   * Obligatorio a propósito: un caller que lo omitiera escribiría NULL, y NULL en `origen`
   * significa "alta anterior a la medición" (migración 084). Se arma con `atribucionDelAlta`.
   */
  atribucion: AtribucionAlta;
}

/**
 * Crea la fila `usuarios` web-first y siembra las categorías default. Idempotente ante
 * carrera: si otra pestaña ya creó la fila (unique en supabase_auth_id → 23505), la
 * recupera en vez de fallar. Devuelve el id interno de `usuarios`, o null si no se pudo
 * crear ni encontrar (el caller decide el fallback).
 */
export async function createWebUser(
  svc: SupabaseClient,
  { authId, email, nombre, atribucion }: CreateWebUserInput,
): Promise<string | null> {
  let userId: string | undefined;
  let emailAlta = email || null;

  // Dos intentos como máximo, y el segundo existe solo para soltar el correo. Un 23505 tiene DOS
  // causas y hasta el 15-sep-2026 se leía como una sola:
  //   · otra pestaña ya creó la fila de este auth_id (unique en supabase_auth_id) → se recupera;
  //   · el correo ya es de OTRA fila (`usuarios_email_lower_unique`, migración 022): la de WhatsApp
  //     de la misma persona, o la de alguien que dictó ese correo por error. Leída como carrera,
  //     no encontraba nada por auth_id, devolvía null y el callback mandaba a /onboarding, que para
  //     una sesión sin fila no tiene salida. Ahora el alta nace sin correo y la otra fila no se
  //     toca: si es la misma persona, `merge_and_link` le pasa el correo al fusionar.
  // No se distingue por el nombre del índice: si no aparece la fila por auth_id, el correo es lo
  // único que el INSERT trae que pueda chocar con otra.
  for (let intento = 0; intento < 2 && !userId; intento++) {
    const { data: created, error } = await svc
      .from('usuarios')
      .insert({
        supabase_auth_id: authId,
        email: emailAlta,
        nombre: nombre || null,
        plan: 'free',
        onboarding_completado: true,
        onboarding_paso: 0,
        // Fila recién nacida: no hay origen previo que respetar, así que el primer toque es este.
        origen: atribucion.origen,
        origen_cta: atribucion.origen_cta,
      })
      .select('id')
      .single();

    if (!error) {
      userId = created?.id;
      break;
    }
    if (error.code !== '23505') {
      console.error('[create-web-user] insert falló:', error.code, error.message);
      return null;
    }
    const { data: existing } = await svc
      .from('usuarios')
      .select('id')
      .eq('supabase_auth_id', authId)
      .maybeSingle();
    if (existing?.id) {
      userId = existing.id;
      break;
    }
    if (!emailAlta) return null;
    console.warn('[create-web-user] el correo de la sesión ya es de otra fila: el alta nace sin correo');
    emailAlta = null;
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
