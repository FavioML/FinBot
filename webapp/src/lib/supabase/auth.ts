import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';

/**
 * Mapea el usuario autenticado (Supabase Auth) a su id interno en `usuarios`.
 * Devuelve null si no hay sesión. Mismo patrón que las rutas existentes, centralizado
 * para las nuevas rutas /api/pro/*.
 */
export async function getNetoUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data?.id || null;
}

/** Igual que getNetoUserId pero devuelve las columnas pedidas del usuario (o null). */
export async function getNetoUser(columns: string): Promise<Record<string, unknown> | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await getServiceClient()
    .from('usuarios')
    .select(columns)
    .eq('supabase_auth_id', user.id)
    .single();
  return (data as unknown as Record<string, unknown>) || null;
}
