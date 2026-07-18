import type { Deuda, DebtGroup } from '@/lib/hooks/use-debts';

/** Selección activa del master-detail: una persona (agrupado) o una deuda (plano). */
export type Selection =
  | { kind: 'group'; key: string }
  | { kind: 'debt'; id: string }
  | null;

/** Clave normalizada de una contraparte (para agrupar/seleccionar). */
export function groupKey(contraparte: string): string {
  return contraparte.toLowerCase().trim();
}

/**
 * Devuelve una selección válida para el estado actual: conserva la previa si sigue
 * existiendo, o cae a la primera fila disponible. null si no hay nada que mostrar.
 */
export function resolveSelection(
  prev: Selection,
  mode: 'grouped' | 'flat',
  groups: DebtGroup[],
  debts: Deuda[],
): Selection {
  if (mode === 'grouped') {
    if (prev?.kind === 'group' && groups.some((g) => groupKey(g.contraparte) === prev.key)) return prev;
    return groups.length > 0 ? { kind: 'group', key: groupKey(groups[0].contraparte) } : null;
  }
  if (prev?.kind === 'debt' && debts.some((d) => d.id === prev.id)) return prev;
  return debts.length > 0 ? { kind: 'debt', id: debts[0].id } : null;
}
