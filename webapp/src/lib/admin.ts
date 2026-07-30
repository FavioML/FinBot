import { createClient } from '@/lib/supabase/server';
import type { User } from '@supabase/supabase-js';

// Formas de las RPC del panel (migración 039). El service client no está tipado con el
// schema generado, así que sin estos tipos las filas quedarían en `any`.
// Las consumen /api/admin/stats y /api/admin/users, que comparten admin_user_tx_stats.
export type ActivityRow = { dau: number; wau: number; mau: number; tx_month: number };
export type UserTxStatsRow = {
  usuario_id: string;
  tx_count: number;
  first_tx: string | null;
  last_tx: string | null;
};

/** Lee la lista de admin user IDs desde env. Comma-separated UUIDs. */
function getAdminUserIds(): string[] {
  const raw = process.env.ADMIN_USER_IDS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Devuelve true si el supabase auth user.id está en la allowlist. */
export function isAdminAuthId(authId: string | null | undefined): boolean {
  if (!authId) return false;
  const allowlist = getAdminUserIds();
  return allowlist.includes(authId);
}

/** Server-side: lee la sesión y devuelve { user, isAdmin }. */
export async function getAdminContext(): Promise<{
  user: User | null;
  isAdmin: boolean;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return {
    user,
    isAdmin: isAdminAuthId(user?.id),
  };
}

/** Para usar en API routes admin. Devuelve user o null si no admin. */
export async function requireAdminUser(): Promise<User | null> {
  const { user, isAdmin } = await getAdminContext();
  if (!user || !isAdmin) return null;
  return user;
}
