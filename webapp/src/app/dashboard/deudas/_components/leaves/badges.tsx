'use client';

import { AlertTriangle, Clock, Repeat } from 'lucide-react';
import type { Deuda } from '@/lib/hooks/use-debts';
import { getVencimientoBadge, frecuenciaLabel } from '../../_lib/debt-helpers';

/** Badge de vencimiento (vencida / vence hoy / vence en Nd). Nada si no urge. */
export function VencimientoBadge({ debt, className = '' }: { debt: Deuda; className?: string }) {
  const badge = getVencimientoBadge(debt);
  if (!badge) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${className}`}
      style={{ backgroundColor: badge.bgColor, color: badge.color }}
    >
      {badge.priority <= 1 ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
      {badge.label}
    </span>
  );
}

/** Badge de compromiso recurrente con su frecuencia. */
export function RecurrenteBadge({ debt, className = '' }: { debt: Deuda; className?: string }) {
  if (!debt.es_recurrente || !debt.frecuencia) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-[rgba(29,158,117,0.12)] text-[#1D9E75] font-medium ${className}`}>
      <Repeat className="h-3 w-3" />
      {frecuenciaLabel(debt.frecuencia)}
    </span>
  );
}
