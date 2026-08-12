import type { SupabaseClient } from '@supabase/supabase-js';
import { CASCADE_REFS, SUB_SENTINEL_REVISAR } from './category-refs';

/**
 * Las cuatro operaciones que propagan un rename o un borrado de categoría a todos los
 * consumidores que la guardan POR NOMBRE.
 *
 * Viven acá y no dentro de `api/categories/route.ts` por una razón concreta: un
 * `route.ts` de App Router solo puede exportar los verbos HTTP, así que una función
 * declarada ahí adentro es intesteable sin copiarla — y una copia en el test es
 * exactamente la clase `paridad-entre-proyecciones` que ya cobró antes en este repo.
 * Acá el guard (`category-cascade.test.ts`) ejercita el MISMO código que corre en prod.
 *
 * A qué tablas alcanza cada una lo declara `CASCADE_REFS`; el porqué de cada entrada y
 * de cada exención está en `./category-refs`, junto con la regla para cuando aparezca
 * una tabla nueva.
 *
 * Todas son best-effort a propósito: un choque de constraint en una tabla no debe
 * abortar el resto del cascade y dejar la mitad reetiquetada. Y todas escopan por
 * `owner` además de por nombre — sin eso, borrar "Alimentación" le tocaría las filas a
 * cada usuario que tenga una categoría con ese nombre.
 */

/**
 * Match EXACTO case-insensitive de un nombre de categoría, como filtro de PostgREST.
 *
 * NO USES `ilike`, ni siquiera escapando `%`, `_` y `\`. PostgREST traduce `*` a `%`
 * en los patrones de `like`/`ilike` —es su alias para no tener que URL-encodear el
 * comodín— y esa traducción ocurre del lado del servidor, ANTES de que el escape del
 * cliente signifique nada: `\*` llega como `\%`, que es otra cosa. O sea que `*` no se
 * puede escapar. Medido contra prod el 12-ago-2026: una categoría llamada `*` hace que
 * `ilike('category', '*')` matchee TODAS las filas del usuario, y como `cleanName` solo
 * valida largo (2–30), es un nombre creable desde el panel.
 *
 * Con las políticas de borrado de CASCADE_REFS eso no es un rename raro: es un DELETE
 * sin `where` sobre los presupuestos, las reglas y las alertas de esa persona, y todas
 * sus transacciones a "Por revisar". Está escopado por dueño, así que no cruza usuarios,
 * pero tres de esas tablas no tienen rastro forense (el trigger de la migración 055
 * cubre `transacciones`, `deudas` y `deuda_abonos`, no estas).
 *
 * Al 12-ago-2026 la exposición REAL es cero: ni una categoría ni un valor de
 * `transacciones` en prod contiene `*`, `%` o `\`. Es latente, no activo — y por eso se
 * cierra ahora, que es barato, y no cuando alguien lo estrene.
 *
 * `imatch` es el operador `~*` de Postgres (regex POSIX). Ahí el patrón NO se
 * pre-traduce, así que escapando los metacaracteres de regex y anclando con `^…$` el
 * match es exacto. Verificado contra prod con las tres formas: `ZZP2 *`, `ZZP2 a.c` y
 * un nombre normal matchean UNA fila cada uno, la suya.
 */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Patrón anclado para `.filter(col, 'imatch', …)`. Exportado para los tests. */
export function exactCI(nombre: string): string {
  return '^' + reEscape(nombre) + '$';
}

/**
 * Best-effort NO significa a ciegas. postgrest-js **no lanza**: devuelve `{ error }`, así
 * que sin esto una tabla que falla deja exactamente el síntoma que este módulo vino a
 * cerrar —filas apuntando al nombre viejo, sin nada que lo delate— y encima con el fix
 * puesto, que es peor: el bug parece arreglado. Se loguea y se sigue, para no abortar el
 * cascade a la mitad y dejar la taxonomía partida en dos.
 */
function avisar(op: string, table: string, error: { message: string } | null) {
  if (error) console.error(`[category-cascade:${op}] ${table}: ${error.message}`);
}

/**
 * Borrado de una categoría RAÍZ. Según la tabla, la fila suelta el nombre (`detach`:
 * las transacciones pasan a "Por revisar", con el centinela que enciende needsReview)
 * o se borra (`delete`: presupuestos, reglas y alertas, que apuntando a una categoría
 * inexistente son peores que nada — el presupuesto zombie se auto-propaga con el
 * carry-forward, la regla recrea la categoría en el próximo gasto del comercio, y la
 * alerta ofrece un botón "ponle un límite" sobre un nombre fantasma).
 */
export async function cascadeRootDelete(svc: SupabaseClient, userId: string, rootNombre: string) {
  for (const ref of CASCADE_REFS) {
    if (ref.onRootDelete === 'delete') {
      const { error } = await svc.from(ref.table).delete().eq(ref.owner, userId).filter(ref.cat, 'imatch', exactCI(rootNombre));
      avisar('rootDelete', ref.table, error);
      continue;
    }
    const patch: Record<string, string | null> = { [ref.cat]: null };
    // El centinela solo se pone donde hay dónde ponerlo.
    if (ref.sub) patch[ref.sub] = SUB_SENTINEL_REVISAR;
    const { error } = await svc.from(ref.table).update(patch).eq(ref.owner, userId).filter(ref.cat, 'imatch', exactCI(rootNombre));
    avisar('rootDelete', ref.table, error);
  }
}

/**
 * Borrado de una SUBcategoría, bajo su padre. `detach` deja la fila con la categoría
 * padre (sub → null); `delete` la borra (un presupuesto de "Comida > Restaurantes" que
 * pasara a "Comida" ensancharía su scope en silencio y chocaría con el unique
 * constraint). Las tablas sin columna `sub` no participan: no tienen nada un nivel
 * abajo que soltar.
 */
export async function cascadeSubDelete(
  svc: SupabaseClient,
  userId: string,
  parentNombre: string,
  subNombre: string
) {
  for (const ref of CASCADE_REFS) {
    const sub = ref.sub;
    if (!sub) continue;
    const base = svc.from(ref.table);
    const op = ref.onSubDelete === 'delete' ? base.delete() : base.update({ [sub]: null });
    const { error } = await op
      .eq(ref.owner, userId)
      .filter(ref.cat, 'imatch', exactCI(parentNombre))
      .filter(sub, 'imatch', exactCI(subNombre));
    avisar('subDelete', ref.table, error);
  }
}

/** Renombra una categoría RAÍZ en todas las tablas que la referencian por nombre. */
export async function relabelRootName(
  svc: SupabaseClient,
  userId: string,
  oldName: string,
  newName: string
) {
  if (oldName === newName) return;
  for (const ref of CASCADE_REFS) {
    const { error } = await svc
      .from(ref.table)
      .update({ [ref.cat]: newName })
      .eq(ref.owner, userId)
      .filter(ref.cat, 'imatch', exactCI(oldName));
    avisar('relabelRoot', ref.table, error);
  }
}

/**
 * Renombra una SUBcategoría en las tablas que tienen ese nivel. Filtra TAMBIÉN por el
 * padre: sin eso, renombrar "Almuerzo" bajo Alimentación se llevaría puesto un
 * "Almuerzo" que cuelgue de Trabajo_Negocio.
 */
export async function relabelSubName(
  svc: SupabaseClient,
  userId: string,
  parentNombre: string,
  oldSub: string,
  newSub: string
) {
  if (oldSub === newSub) return;
  for (const ref of CASCADE_REFS) {
    if (!ref.sub) continue;
    const { error } = await svc
      .from(ref.table)
      .update({ [ref.sub]: newSub })
      .eq(ref.owner, userId)
      .filter(ref.cat, 'imatch', exactCI(parentNombre))
      .filter(ref.sub, 'imatch', exactCI(oldSub));
    avisar('relabelSub', ref.table, error);
  }
}
