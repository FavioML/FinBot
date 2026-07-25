/**
 * Single source of truth for budget progress state and color.
 *
 * Thresholds are deliberate: red (`exceeded`) is reserved for spending that is
 * STRICTLY over the limit. Hitting exactly 100% ("you spent it all but didn't
 * go over") is `warning` amber, not red — landing on the limit shouldn't read
 * as "you blew the budget". Amber covers 80–100% inclusive.
 *
 * Before this helper the thresholds were duplicated and inconsistent across the
 * card (60/90), the detail dialog (80/100) and the global bar (80/100), so the
 * same spend showed different colors in different places.
 */

export type BudgetEstado = 'ok' | 'warning' | 'exceeded';

export const BUDGET_COLORS: Record<BudgetEstado, string> = {
  ok: '#1D9E75', // verde Neto
  warning: '#EF9F27', // ámbar
  exceeded: '#D85A30', // rojo (solo cuando gasto > límite)
};

/** Percentage at/above which the amber "warning" state kicks in. */
export const BUDGET_WARNING_PCT = 80;

export interface BudgetStatus {
  /** Raw percentage spent (can exceed 100). 0 when there is no positive limit. */
  pct: number;
  /** Percentage clamped to [0, 100] — use this for progress bar widths. */
  clampedPct: number;
  estado: BudgetEstado;
  /** Hex color for bars, badges and text. */
  color: string;
}

export function budgetStatus(spent: number, limit: number): BudgetStatus {
  const hasLimit = limit > 0;
  const pct = hasLimit ? (spent / limit) * 100 : 0;

  let estado: BudgetEstado;
  if (hasLimit && spent > limit) {
    estado = 'exceeded'; // strictly over budget
  } else if (pct >= BUDGET_WARNING_PCT) {
    estado = 'warning'; // 80–100% inclusive, includes hitting the limit exactly
  } else {
    estado = 'ok';
  }

  return {
    pct,
    clampedPct: Math.min(Math.max(pct, 0), 100),
    estado,
    color: BUDGET_COLORS[estado],
  };
}
