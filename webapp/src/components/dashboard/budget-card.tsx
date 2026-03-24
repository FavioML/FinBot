'use client';

import { Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { getCategoriaEmoji } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import { capitalizeDisplay } from '@/lib/format';
import type { Presupuesto } from '@/lib/types';

interface BudgetCardProps {
  categoria: string;
  totalBudget: Presupuesto | null;
  subBudgets: Presupuesto[];
  spendingByKey: Map<string, number>;
  onEdit: (budget: Presupuesto) => void;
  onDelete: (budget: Presupuesto) => void;
  onClick: (categoria: string) => void;
}

function getProgressColor(percentage: number): string {
  if (percentage < 60) return '#1D9E75';
  if (percentage < 90) return '#EF9F27';
  return '#D85A30';
}

/** Simple normalize: only handle accent variants, never remap category names */
function normalizeCatForMatch(cat: string): string {
  const map: Record<string, string[]> = {
    'alimentación': ['alimentacion', 'alimentación'],
    'educación': ['educacion', 'educación'],
  };
  const lower = cat.toLowerCase();
  for (const [canonical, aliases] of Object.entries(map)) {
    if (aliases.includes(lower) || lower === canonical) return canonical;
  }
  return lower;
}

export function BudgetCard({
  categoria,
  totalBudget,
  subBudgets,
  spendingByKey,
  onEdit,
  onDelete,
  onClick,
}: BudgetCardProps) {
  const catKey = normalizeCatForMatch(categoria);

  // Compute the effective total limit
  const totalLimit = totalBudget
    ? totalBudget.monto_limite
    : subBudgets.reduce((sum, b) => sum + b.monto_limite, 0);

  // Total spending for the category
  const totalSpent = spendingByKey.get(catKey) || 0;

  const rawPercentage = totalLimit > 0 ? (totalSpent / totalLimit) * 100 : 0;
  const clampedPercentage = Math.min(rawPercentage, 100);
  const progressColor = getProgressColor(rawPercentage);

  const emoji = getCategoriaEmoji(categoria);
  const alertPct = totalBudget?.alerta_porcentaje ?? 80;
  const showAlert = rawPercentage >= alertPct;

  // The budget to use for edit/delete actions (total row preferred, else first sub)
  const actionBudget = totalBudget || subBudgets[0];

  return (
    <motion.div
      className="glass-card glass-card-glow p-5 flex flex-col gap-3 cursor-pointer"
      onClick={() => onClick(categoria)}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">{emoji}</span>
            <span className="font-semibold text-[#F0EFE8] truncate">
              {capitalizeDisplay(categoria)}
            </span>
            {showAlert && (
              <span title={`Superaste el ${alertPct}% de tu presupuesto`}>
                <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: '#EF9F27' }} />
              </span>
            )}
          </div>
        </div>
        {actionBudget && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => { e.stopPropagation(); onEdit(actionBudget); }}
              aria-label="Editar presupuesto"
            >
              <Pencil className="h-3.5 w-3.5 text-[#8A877D]" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => { e.stopPropagation(); onDelete(actionBudget); }}
              aria-label="Eliminar presupuesto"
            >
              <Trash2 className="h-3.5 w-3.5 text-[#8A877D]" />
            </Button>
          </div>
        )}
      </div>

      {/* Main progress bar */}
      <div className="w-full">
        <div className="h-2 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{ backgroundColor: progressColor }}
            initial={{ width: 0 }}
            animate={{ width: `${clampedPercentage}%` }}
            transition={{ duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.1 }}
          />
        </div>
      </div>

      {/* Sub-budget rows */}
      {subBudgets.length > 0 && (
        <div className="flex flex-col gap-2 pt-1">
          {subBudgets.map((sub) => {
            const subKey = `${catKey}::${(sub.subcategoria || '').toLowerCase()}`;
            const subSpent = spendingByKey.get(subKey) || 0;
            const subRawPct = sub.monto_limite > 0 ? (subSpent / sub.monto_limite) * 100 : 0;
            const subClampedPct = Math.min(subRawPct, 100);
            const subColor = getProgressColor(subRawPct);

            return (
              <div key={sub.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#C8C6BC]">
                    {capitalizeDisplay(sub.subcategoria || '')}
                  </span>
                  <span className="text-[10px] text-[#8A877D]">
                    {formatCurrency(subSpent)} / {formatCurrency(sub.monto_limite)}
                  </span>
                </div>
                <div className="h-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: subColor }}
                    initial={{ width: 0 }}
                    animate={{ width: `${subClampedPct}%` }}
                    transition={{ duration: 0.7, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.2 }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#C8C6BC]">
          {formatCurrency(totalSpent)} / {formatCurrency(totalLimit)}
        </p>
        <span
          className="text-xs font-medium rounded-full px-2 py-0.5"
          style={{
            backgroundColor: `${progressColor}18`,
            color: progressColor,
          }}
        >
          {rawPercentage.toFixed(0)}%
        </span>
      </div>
    </motion.div>
  );
}
