'use client';

import { Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { getCategoriaEmoji } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import type { Presupuesto } from '@/lib/types';

interface BudgetCardProps {
  budget: Presupuesto;
  spent: number;
  onEdit: (budget: Presupuesto) => void;
  onDelete: (budget: Presupuesto) => void;
  onClick?: (budget: Presupuesto) => void;
}

function getProgressColor(percentage: number): string {
  if (percentage < 60) return '#1D9E75';
  if (percentage < 90) return '#EF9F27';
  return '#D85A30';
}

export function BudgetCard({ budget, spent, onEdit, onDelete, onClick }: BudgetCardProps) {
  const percentage = budget.monto_limite > 0
    ? Math.min((spent / budget.monto_limite) * 100, 100)
    : 0;
  const rawPercentage = budget.monto_limite > 0
    ? (spent / budget.monto_limite) * 100
    : 0;
  const progressColor = getProgressColor(rawPercentage);
  const emoji = getCategoriaEmoji(budget.categoria);
  const showAlert = rawPercentage >= budget.alerta_porcentaje;

  // Display name: respect the original name, just capitalize first letter
  const displayName = budget.categoria.charAt(0).toUpperCase() + budget.categoria.slice(1);

  return (
    <div
      className="glass-card p-5 flex flex-col gap-3 cursor-pointer"
      onClick={() => onClick?.(budget)}
    >
      {/* Header row */}
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">{emoji}</span>
            <span className="font-semibold text-[#F0EFE8] truncate">
              {displayName}
            </span>
            {showAlert && (
              <Tooltip>
                <TooltipTrigger>
                  <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: '#EF9F27' }} />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Superaste el {budget.alerta_porcentaje}% de tu presupuesto</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {budget.subcategoria && (
            <p className="text-xs text-[#8A877D] mt-0.5 ml-7">
              {budget.subcategoria.charAt(0).toUpperCase() + budget.subcategoria.slice(1)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => { e.stopPropagation(); onEdit(budget); }}
            aria-label="Editar presupuesto"
          >
            <Pencil className="h-3.5 w-3.5 text-[#8A877D]" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => { e.stopPropagation(); onDelete(budget); }}
            aria-label="Eliminar presupuesto"
          >
            <Trash2 className="h-3.5 w-3.5 text-[#8A877D]" />
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full">
        <div className="h-2 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${percentage}%`,
              backgroundColor: progressColor,
            }}
          />
        </div>
      </div>

      {/* Footer info */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#C8C6BC]">
          {formatCurrency(spent)} / {formatCurrency(budget.monto_limite)}
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
    </div>
  );
}
