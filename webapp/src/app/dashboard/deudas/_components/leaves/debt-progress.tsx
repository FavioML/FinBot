'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { Deuda } from '@/lib/hooks/use-debts';
import { pctPagado } from '../../_lib/debt-helpers';

/** Barra de progreso de abonos. Solo se muestra si hay algo pagado. */
export function DebtProgress({ debt, showLabel = true, className = '' }: { debt: Deuda; showLabel?: boolean; className?: string }) {
  const reduce = useReducedMotion();
  const pct = pctPagado(debt);
  if (pct <= 0 || debt.estado === 'pagada') return null;
  const esDebo = debt.tipo === 'debo';

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${esDebo ? 'bg-[#D85A30]' : 'bg-[#1D9E75]'}`}
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={reduce ? { duration: 0 } : { duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      {showLabel && <p className="text-xs text-[#8A877D]">{pct.toFixed(0)}% pagado</p>}
    </div>
  );
}
