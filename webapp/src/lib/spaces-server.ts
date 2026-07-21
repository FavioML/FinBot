import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

/**
 * Chokepoint de autorizacion de Espacios.
 *
 * Las tablas `space_*` se leen y escriben SIEMPRE con service-role, que ignora
 * RLS: no hay policies de `authenticated` que sirvan de red debajo. Eso es
 * deliberado (ver webapp/CLAUDE.md), porque el modelo "host paga" obliga a leer
 * la fila `usuarios` del OWNER, cosa que una policy scopeada a auth.uid() nunca
 * permitiria.
 *
 * La consecuencia es que la autorizacion vive 100% en esta capa. Antes estaba
 * copiada a mano en 9 rutas distintas; toda ruta nueva bajo /api/spaces/* tiene
 * que pasar por `requireSpaceMember` o `requireSpaceOwner`. Una ruta que se
 * olvide el check es IDOR directo, sin nada debajo que lo detenga.
 */

export interface NetoUser {
  id: string;
  plan: string | null;
}

/** Usuario Neto detras de la sesion Supabase actual, o null si no hay sesion. */
export async function getSessionUser(): Promise<NetoUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id, plan')
    .eq('supabase_auth_id', user.id)
    .single();

  if (!data) return null;
  return { id: data.id as string, plan: (data.plan as string | null) ?? null };
}

export type SpaceAuth =
  | { ok: true; user: NetoUser; role: string }
  | { ok: false; response: NextResponse };

async function authorizeSpace(spaceId: string, ownerOnly: boolean): Promise<SpaceAuth> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const { data: membership } = await getServiceClient()
    .from('space_members')
    .select('role')
    .eq('space_id', spaceId)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    return { ok: false, response: NextResponse.json({ error: 'Not a member' }, { status: 403 }) };
  }

  const role = (membership.role as string | null) ?? 'member';
  if (ownerOnly && role !== 'owner') {
    return { ok: false, response: NextResponse.json({ error: 'Only owner can do this' }, { status: 403 }) };
  }

  return { ok: true, user, role };
}

/** Exige que el usuario de la sesion sea miembro del espacio. */
export function requireSpaceMember(spaceId: string): Promise<SpaceAuth> {
  return authorizeSpace(spaceId, false);
}

/** Exige que el usuario de la sesion sea el owner del espacio. */
export function requireSpaceOwner(spaceId: string): Promise<SpaceAuth> {
  return authorizeSpace(spaceId, true);
}

/** user_ids que pertenecen al espacio. Para validar destinatarios y splits. */
export async function getSpaceMemberIds(spaceId: string): Promise<Set<string>> {
  const { data } = await getServiceClient()
    .from('space_members')
    .select('user_id')
    .eq('space_id', spaceId);
  return new Set((data ?? []).map((m) => m.user_id as string));
}

/**
 * Resolves whether a shared space is on the Pro tier.
 *
 * Model: "host pays" — a space's Pro capabilities (custom split rules,
 * shared budgets, full history) depend on the plan of its OWNER (created_by),
 * NOT on the plan of whoever is currently viewing it. This is what makes the
 * collaborative feature usable: a Pro user can invite Free members into a
 * space and they all benefit from the Pro features the owner set up.
 */
export async function getSpaceOwnerIsPro(spaceId: string): Promise<boolean> {
  const svc = getServiceClient();
  const { data: space } = await svc
    .from('shared_spaces')
    .select('created_by')
    .eq('id', spaceId)
    .single();
  if (!space?.created_by) return false;
  const { data: owner } = await svc
    .from('usuarios')
    .select('plan')
    .eq('id', space.created_by)
    .single();
  return owner?.plan === 'premium';
}
