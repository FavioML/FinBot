'use client';

import { AlertTriangle, Clock, Repeat } from 'lucide-react';
import type { Deuda } from '@/lib/hooks/use-debts';
import { getVencimientoBadge, frecuenciaLabel } from '../../_lib/debt-helpers';
import { tinta } from '@/lib/colores';

/** Badge de vencimiento (vencida / vence hoy / vence en Nd). Nada si no urge. */
export function VencimientoBadge({ debt, className = '' }: { debt: Deuda; className?: string }) {
  const badge = getVencimientoBadge(debt);
  if (!badge) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${className}`}
      style={{ backgroundColor: badge.bgColor, color: tinta(badge.color) }}
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
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/12 text-primary-ink font-medium ${className}`}>
      <Repeat className="h-3 w-3" />
      {frecuenciaLabel(debt.frecuencia)}
    </span>
  );
}
