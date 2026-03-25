'use client';

import { useMemo } from 'react';
import { CalendarDays } from 'lucide-react';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import type { Transaccion } from '@/lib/types';

interface TodaySpendingProps {
  transactions: Transaccion[];
  currentMonth: number;
  currentYear: number;
}

export function TodaySpending({ transactions, currentMonth, currentYear }: TodaySpendingProps) {
  const { todayTotal, dailyAvg, ratio } = useMemo(() => {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const monthGastos = transactions.filter((t) => {
      if (t.tipo !== 'gasto') return false;
      const d = new Date(t.fecha + 'T00:00:00');
      return d.getMonth() + 1 === currentMonth && d.getFullYear() === currentYear;
    });

    const todayTotal = monthGastos
      .filter((t) => t.fecha === todayKey)
      .reduce((s, t) => s + t.monto_pen, 0);

    const totalMonth = monthGastos.reduce((s, t) => s + t.monto_pen, 0);
    const daysWithSpending = new Set(monthGastos.map((t) => t.fecha)).size;
    const dailyAvg = daysWithSpending > 0 ? totalMonth / daysWithSpending : 0;

    const ratio = dailyAvg > 0 ? todayTotal / dailyAvg : 0;

    return { todayTotal, dailyAvg, ratio };
  }, [transactions, currentMonth, currentYear]);

  // Don't show if no data at all
  if (dailyAvg === 0 && todayTotal === 0) return null;

  const barColor = ratio > 1.3 ? '#D85A30' : ratio > 0.8 ? '#EF9F27' : '#1D9E75';
  const barWidth = Math.min(ratio * 100, 100);

  return (
    <motion.div
      className="glass-card glass-card-glow p-4"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-2 mb-2">
        <CalendarDays className="h-3.5 w-3.5 text-[#8A877D]" />
        <span className="text-xs font-medium text-[#C8C6BC]">Gasto de hoy</span>
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-lg font-bold" style={{ color: barColor }}>
          {formatCurrency(todayTotal)}
        </span>
        <span className="text-[10px] text-[#8A877D]">
          / prom. {formatCurrency(dailyAvg)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: barColor }}
          initial={{ width: 0 }}
          animate={{ width: `${barWidth}%` }}
          transition={{ duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94] }}
        />
      </div>
      {todayTotal > 0 && ratio > 1.3 && (
        <p className="text-[10px] text-[#D85A30] mt-1.5">
          {Math.round((ratio - 1) * 100)}% sobre tu promedio diario
        </p>
      )}
      {todayTotal === 0 && (
        <p className="text-[10px] text-[#1D9E75] mt-1.5">
          Sin gastos hoy
        </p>
      )}
    </motion.div>
  );
}
