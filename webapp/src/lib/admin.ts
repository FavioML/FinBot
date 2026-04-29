import { createClient } from '@/lib/supabase/server';
import type { User } from '@supabase/supabase-js';

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
