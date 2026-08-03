'use client';

import { useMemo } from 'react';
import { TrendingUp, TrendingDown, ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import { montoPen } from '@/lib/tx-monto';
import type { Transaccion } from '@/lib/types';

interface SpendingProjectionProps {
  transactions: Transaccion[];
  allTransactions: Transaccion[];
  currentMonth: number;
  currentYear: number;
}

export function SpendingProjection({
  transactions,
  allTransactions,
  currentMonth,
  currentYear,
}: SpendingProjectionProps) {
  const projection = useMemo(() => {
    const gastos = transactions.filter((t) => t.tipo === 'gasto');
    if (gastos.length === 0) return null;

    const totalSpent = gastos.reduce((s, t) => s + montoPen(t), 0);

    // Days elapsed in current month
    const today = new Date();
    const isCurrentMonth = today.getMonth() + 1 === currentMonth && today.getFullYear() === currentYear;
    if (!isCurrentMonth) return null; // Only show projection for current month

    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
    const daysRemaining = daysInMonth - dayOfMonth;

    if (dayOfMonth < 5) return null; // Not enough data in first 5 days

    // Daily average and projection
    const dailyAvg = totalSpent / dayOfMonth;
    const projected = dailyAvg * daysInMonth;

    // Previous month for comparison
    const prevDate = new Date(currentYear, currentMonth - 2, 1);
    const pm = prevDate.getMonth() + 1;
    const py = prevDate.getFullYear();
    const prevGastos = allTransactions
      .filter((t) => {
        if (t.tipo !== 'gasto') return false;
        const d = new Date(t.fecha + 'T00:00:00');
        return d.getMonth() + 1 === pm && d.getFullYear() === py;
      })
      .reduce((s, t) => s + montoPen(t), 0);

    const vsLastMonth = prevGastos > 0 ? ((projected - prevGastos) / prevGastos) * 100 : 0;

    return {
      totalSpent,
      dailyAvg,
      projected,
      daysRemaining,
      daysInMonth,
      dayOfMonth,
      prevGastos,
      vsLastMonth,
      progress: (dayOfMonth / daysInMonth) * 100,
    };
  }, [transactions, allTransactions, currentMonth, currentYear]);

  if (!projection) return null;

  const isOverPrev = projection.vsLastMonth > 0;

  return (
    <motion.div
      className="glass-card glass-card-glow p-4"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-[10px] text-[#8A877D] uppercase tracking-wider mb-0.5">Proyeccion del mes</p>
          <p className="text-xl font-bold text-[#F0EFE8] tabular-nums">{formatCurrency(projection.projected)}</p>
        </div>
        {projection.prevGastos > 0 && (
          <div
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: isOverPrev ? 'rgba(216,90,48,0.1)' : 'rgba(29,158,117,0.1)',
              color: isOverPrev ? '#D85A30' : '#1D9E75',
            }}
          >
            {isOverPrev ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {Math.abs(Math.round(projection.vsLastMonth))}% vs mes anterior
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5 mb-3">
        <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
          <motion.div
            className="h-full rounded-full bg-[#1D9E75]"
            initial={{ width: 0 }}
            animate={{ width: `${projection.progress}%` }}
            transition={{ duration: 0.6 }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-[#8A877D]">
          <span>Dia {projection.dayOfMonth} de {projection.daysInMonth}</span>
          <span>{projection.daysRemaining} dias restantes</span>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs">
        <div>
          <span className="text-[#8A877D]">Gastado: </span>
          <span className="text-[#D85A30] font-medium tabular-nums">{formatCurrency(projection.totalSpent)}</span>
        </div>
        <ArrowRight className="h-3 w-3 text-[#8A877D]" />
        <div>
          <span className="text-[#8A877D]">Promedio diario: </span>
          <span className="text-[#C8C6BC] font-medium tabular-nums">{formatCurrency(projection.dailyAvg)}</span>
        </div>
      </div>
    </motion.div>
  );
}
