import { getServiceClient } from '@/lib/supabase/service';

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
