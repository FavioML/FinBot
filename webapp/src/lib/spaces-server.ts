import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import {
  computeBalancesFromSnapshots,
  type SplitMember,
  type SplitRule,
  type SnapshotExpense,
  type SnapshotSettlement,
} from '@/lib/spaces-split';
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

const BACKEND_URL = process.env.NETO_BACKEND_URL || process.env.RAILWAY_URL || 'https://api.neto.pe';

/**
 * Le pide al backend que mande un aviso por WhatsApp a los miembros de un espacio.
 *
 * Vive alla porque solo el backend tiene el token de Meta; la webapp no puede
 * enviar nada. Se usa para los cambios que mueven la plata FUTURA de alguien
 * (entra un miembro, se edita el reparto por defecto o una regla por categoria):
 * la regla del producto es que eso nunca pasa en silencio.
 *
 * Best-effort a proposito: si el hop falla, la escritura ya ocurrio y el cambio se
 * ve igual en la webapp, que es la garantia real (fuera de la ventana de 24h de
 * Meta el mensaje libre tampoco se entregaria). Nunca lanza.
 */
export async function avisarBackendEspacio(
  ruta: 'espacio-nuevo-miembro' | 'espacio-reparto-cambiado' | 'espacio-reglas-cambiadas',
  payload: Record<string, unknown>
): Promise<void> {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return;
  try {
    await fetch(`${BACKEND_URL}/admin/${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify(payload),
    });
  } catch {
    // Silencioso a proposito: no vale la pena fallar la operacion por un aviso.
  }
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
  const { data, error } = await getServiceClient()
    .from('space_members')
    .select('user_id')
    .eq('space_id', spaceId);
  // Con `?? []` una lectura caida devuelve un Set vacio, o sea "aca no hay miembros":
  // todo destinatario y todo split valido se rechaza como si el usuario hubiera mandado
  // basura. Falla cerrado, pero mintiendo sobre la causa.
  if (error) {
    throw new Error(`No se pudo leer los miembros del espacio: ${error.message}`);
  }
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

/**
 * Tope de un movimiento de dinero en un espacio, igual que el de las metas
 * (`api/goals/route.ts`). La columna aguanta hasta 10^10, asi que sin esto un
 * miembro puede descuadrar el balance del grupo con un gasto absurdo.
 */
export const MAX_MONTO = 999999.99;

/**
 * Monto valido para un gasto o una liquidacion, o null si no lo es.
 *
 * `isNaN(Number(x))` no alcanza: `1e999` sobrevive a JSON.parse como Infinity y
 * `isNaN(Infinity)` es false, asi que pasaba el guard. Es el mismo hueco que S2
 * dejo abierto en los aportes de metas.
 */
export function parseSpaceAmount(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_MONTO) return null;
  return n;
}

export interface SpaceSplitContext {
  members: SplitMember[];
  /** Reglas que REALMENTE aplican: vacio si el espacio no es Pro (host paga). */
  effectiveRules: SplitRule[];
  ownerIsPro: boolean;
}

/**
 * Todo lo necesario para dividir un gasto: miembros actuales y reglas vigentes.
 *
 * Aplica el gate host-paga en un solo lugar: si el owner no es Pro, las reglas
 * personalizadas se ignoran (quedan stale tras un downgrade) y manda el split por
 * defecto. Sin esto, cada ruta que crea o edita un gasto tendria que acordarse.
 */
export async function getSpaceSplitContext(spaceId: string): Promise<SpaceSplitContext> {
  const svc = getServiceClient();
  const [{ data: space, error: eSpace }, { data: members, error: eMembers }] = await Promise.all([
    svc.from('shared_spaces').select('created_by, split_rules').eq('id', spaceId).single(),
    svc.from('space_members').select('user_id, split_percentage').eq('space_id', spaceId),
  ]);
  // Lo que sale de aca se CONGELA en el snapshot del gasto y ya nadie lo recalcula. Una
  // lectura caida no puede degradar a "sin reglas": un gasto con regla 70/30 quedaria
  // 50/50 para siempre. Espejo de `obtenerContextoSplit` en services/shared-spaces.js.
  const contextError = eSpace ?? eMembers;
  if (contextError) {
    throw new Error(`No se pudo leer el contexto del espacio: ${contextError.message}`);
  }

  const rawRules = ((space?.split_rules ?? []) as SplitRule[]) || [];

  let ownerIsPro = false;
  const ownerId = space?.created_by as string | undefined;
  if (ownerId) {
    const { data: owner, error: eOwner } = await svc.from('usuarios').select('plan').eq('id', ownerId).single();
    // Sin reglas configuradas el plan del owner da igual (todo cae al split por defecto);
    // con reglas, no saber si aplican es la diferencia entre 70/30 y 50/50.
    if (eOwner && rawRules.length > 0) {
      throw new Error(`No se pudo verificar el plan del owner: ${eOwner.message}`);
    }
    ownerIsPro = owner?.plan === 'premium';
  }
  return {
    members: (members ?? []) as SplitMember[],
    effectiveRules: ownerIsPro ? rawRules : [],
    ownerIsPro,
  };
}

/**
 * Balances del espacio en soles, leidos de los snapshots congelados.
 *
 * Cubre a los miembros actuales Y a cualquiera que aparezca en un gasto o
 * liquidacion: un ex-miembro con saldo pendiente tiene que seguir contando o su
 * deuda se evapora y el pagador queda acreditado por plata que nadie debe.
 */
export async function getSpaceBalances(spaceId: string): Promise<Record<string, number>> {
  const svc = getServiceClient();
  const [
    { data: members, error: eMembers },
    { data: expenses, error: eExpenses },
    { data: settlements, error: eSettlements },
  ] = await Promise.all([
    svc.from('space_members').select('user_id').eq('space_id', spaceId),
    svc.from('space_expenses').select('paid_by, amount, split_snapshot').eq('space_id', spaceId),
    svc.from('space_settlements').select('from_user, to_user, amount').eq('space_id', spaceId),
  ]);
  // El balance es una resta entre las tres tablas: degradar cualquiera a `?? []` no da
  // un error, da un saldo con la direccion equivocada. Y este numero es el que deja o no
  // sacar a un miembro (`DELETE /members`): con todo en cero, alguien sale del espacio
  // debiendo y su saldo ya no se puede liquidar desde la app. Espejo de
  // `obtenerBalanceEspacio` en services/shared-spaces.js.
  const readError = eMembers ?? eExpenses ?? eSettlements;
  if (readError) {
    throw new Error(`No se pudo calcular el balance del espacio: ${readError.message}`);
  }

  return computeBalancesFromSnapshots(
    (expenses ?? []) as unknown as SnapshotExpense[],
    (settlements ?? []) as unknown as SnapshotSettlement[],
    (members ?? []).map((m) => m.user_id as string)
  );
}
