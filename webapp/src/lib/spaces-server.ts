import { getServiceClient } from '@/lib/supabase/service';
import { requireNetoUser } from '@/lib/supabase/auth';
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

export type SpaceAuth =
  | { ok: true; user: NetoUser; role: string }
  | { ok: false; response: NextResponse };

async function authorizeSpace(spaceId: string, ownerOnly: boolean): Promise<SpaceAuth> {
  // El mapeo sesion -> `usuarios` (y sus 401/404/500) vive en `requireNetoUser`.
  const auth = await requireNetoUser('id, plan');
  if (!auth.ok) return { ok: false, response: auth.response };
  const user: NetoUser = { id: auth.user.id, plan: (auth.user.plan as string | null) ?? null };

  // maybeSingle + error explicito: con `single()` una lectura caida y "no es
  // miembro" llegan las dos como error, y el 403 "Not a member" se le mostraba
  // igual a quien SI es miembro.
  const { data: membership, error } = await getServiceClient()
    .from('space_members')
    .select('role')
    .eq('space_id', spaceId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[auth:space_members] lectura fallida', {
      space_id: spaceId,
      user_id: user.id,
      code: error.code,
      message: error.message,
    });
    return {
      ok: false,
      response: NextResponse.json({ error: 'Error temporal, intenta de nuevo' }, { status: 500 }),
    };
  }

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
  // Degradar a `false` con la lectura caida le responde "esta funcion es solo
  // Pro" al owner que SI es Pro, y le apaga presupuestos y reglas de reparto.
  // Mismo criterio que `getSpaceBalances` / `getSpaceSplitContext`: lanzar.
  const { data: space, error: eSpace } = await svc
    .from('shared_spaces')
    .select('created_by')
    .eq('id', spaceId)
    .maybeSingle();
  if (eSpace) {
    throw new Error(`No se pudo leer el espacio: ${eSpace.message}`);
  }
  if (!space?.created_by) return false;
  const { data: owner, error: eOwner } = await svc
    .from('usuarios')
    .select('plan')
    .eq('id', space.created_by)
    .maybeSingle();
  if (eOwner) {
    throw new Error(`No se pudo verificar el plan del owner: ${eOwner.message}`);
  }
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
 *
 * El filtro de TIPO no es ceremonia y lo encontraron los tests de `parseSpaceBudgets`,
 * no la lectura: `Number(true)` y `Number([1])` valen **1**, asi que `amount: true` en
 * `POST /expenses` registraba un gasto de S/1 que mueve el balance real del grupo, y
 * `amount: []` valia 0 (rechazado de casualidad, por el `<= 0`). Aca solo se aceptan
 * numeros y strings numericos, que es lo unico que manda un cliente honesto: el
 * formulario tipea un string y el JSON del harness manda un number.
 */
export function parseSpaceAmount(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_MONTO) return null;
  return n;
}

export interface SpaceBudget {
  id: string;
  category: string;
  limit: number;
}

/** Tope de presupuestos por espacio. Hay ~10 categorías; esto es holgura, no política. */
export const MAX_BUDGETS_POR_ESPACIO = 50;
const MAX_LARGO_CATEGORIA = 60;

/**
 * Valida y normaliza los presupuestos conjuntos de un espacio (S′6).
 *
 * `PUT /api/spaces/[id]/budgets` solo comprobaba `Array.isArray` y escribía el JSONB
 * crudo, así que era la única escritura de plata de Espacios que no pasaba por
 * `parseSpaceAmount`. Un `limit` en `1e999` sobrevive a `JSON.parse` como Infinity y
 * `JSON.stringify` lo manda como `null`; el detalle del espacio hace
 * `budget.limit > 0 ? Math.round(spent / budget.limit * 100) : 0` y
 * `budget.limit * frac` para lo que le toca a cada miembro, o sea que un límite
 * corrupto se convierte en el número que la pantalla le muestra a cada persona.
 *
 * RECHAZA en vez de sanear en silencio, al revés que `sanitizeSplitRules`, y la
 * diferencia no es de estilo: una regla de reparto la escribe el cliente a partir de
 * pesos que el usuario no ve uno por uno, mientras que un presupuesto ES el número
 * que la persona acaba de tipear. Dejarlo caer sin decir nada le muestra "guardado"
 * sobre un límite que no quedó. Además es lo que hacen las otras rutas de dinero
 * (`/api/budgets`, `/api/goals`, `/api/debts`) y lo que `qa-money-edge` verifica.
 *
 * Devuelve SOLO `{id, category, limit}`: lo que entra al JSONB es una forma cerrada,
 * no el objeto del cliente con las llaves que se le hayan colado.
 */
export function parseSpaceBudgets(
  raw: unknown
): { ok: true; budgets: SpaceBudget[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'budgets must be an array' };
  if (raw.length > MAX_BUDGETS_POR_ESPACIO) {
    return { ok: false, error: `Máximo ${MAX_BUDGETS_POR_ESPACIO} presupuestos por espacio` };
  }

  const budgets: SpaceBudget[] = [];
  const categoriasVistas = new Set<string>();
  const idsVistos = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'Cada presupuesto debe ser un objeto' };
    }
    const b = item as Record<string, unknown>;

    // `normalize('NFC')` antes de nada: "Café" precompuesto y "Café" descompuesto son
    // dos strings distintos que se ven idénticos, así que sin normalizar la dedup no
    // los cruza y el espacio muestra dos barras iguales para la misma categoría.
    // Y los invisibles (zero-width, BOM) NO son whitespace: sobreviven a `trim()`, o
    // sea que "​" pasaba como nombre de categoría "no vacío".
    const category = typeof b.category === 'string'
      ? b.category.normalize('NFC').replace(/[​-‍﻿]/g, '').trim()
      : '';
    if (!category) return { ok: false, error: 'Cada presupuesto necesita una categoría' };
    if (category.length > MAX_LARGO_CATEGORIA) {
      return { ok: false, error: 'Nombre de categoría demasiado largo' };
    }
    // Dos filas para la misma categoría se pintan las dos y el gasto se cuenta contra
    // ambas: el usuario ve dos barras distintas para la misma plata.
    const clave = category.toLocaleLowerCase('es');
    if (categoriasVistas.has(clave)) return { ok: false, error: `Presupuesto duplicado para ${category}` };
    categoriasVistas.add(clave);

    const limit = parseSpaceAmount(b.limit);
    if (limit === null) return { ok: false, error: `Límite inválido para ${category}` };

    // El `id` tiene que ser único: la UI borra con `filter(b => b.id !== budget.id)`,
    // así que dos presupuestos con el mismo id se borran de a dos.
    const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim().slice(0, 64) : category;
    if (idsVistos.has(id)) return { ok: false, error: `Identificador de presupuesto duplicado: ${id}` };
    idsVistos.add(id);

    budgets.push({ id, category, limit });
  }

  return { ok: true, budgets };
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
