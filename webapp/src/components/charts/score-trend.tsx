'use client';

import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Activity } from 'lucide-react';
import { calcularScoreFinanciero, getScoreColor } from '@/lib/utils';
import { MESES } from '@/lib/constants';
import type { Transaccion, Presupuesto } from '@/lib/types';

interface ScoreTrendProps {
  allTransactions: Transaccion[];
  budgets: Presupuesto[];
  currentMonth: number;
  currentYear: number;
}

interface MonthScore {
  label: string;
  score: number;
  color: string;
}

export function ScoreTrend({ allTransactions, budgets, currentMonth, currentYear }: ScoreTrendProps) {
  const scores = useMemo<MonthScore[]>(() => {
    const result: MonthScore[] = [];
    for (let i = 3; i >= 0; i--) {
      const d = new Date(currentYear, currentMonth - 1 - i, 1);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();

      const monthTxs = allTransactions.filter((t) => {
        const txDate = new Date(t.fecha + 'T00:00:00');
        return txDate.getMonth() + 1 === m && txDate.getFullYear() === y;
      });

      const gastos = monthTxs.filter((t) => t.tipo === 'gasto').reduce((s, t) => s + t.monto_pen, 0);
      const ingresos = monthTxs.filter((t) => t.tipo === 'ingreso').reduce((s, t) => s + t.monto_pen, 0);

      // Count exceeded budgets for this month
      const categoryBudgets = budgets.filter(b => !b.subcategoria);
      let exceeded = 0;
      for (const b of categoryBudgets) {
        const spent = monthTxs
          .filter(t => t.tipo === 'gasto' && t.categoria?.toLowerCase() === b.categoria?.toLowerCase())
          .reduce((s, t) => s + t.monto_pen, 0);
        if (spent > parseFloat(String(b.monto_limite))) exceeded++;
      }

      const score = monthTxs.length > 0 ? calcularScoreFinanciero(gastos, ingresos, exceeded) : 0;

      result.push({
        label: MESES[m]?.slice(0, 3) || '',
        score,
        color: getScoreColor(score),
      });
    }
    return result;
  }, [allTransactions, budgets, currentMonth, currentYear]);

  // Only show if at least 2 months have data
  const monthsWithData = scores.filter((s) => s.score > 0);
  if (monthsWithData.length < 2) return null;

  const maxScore = 100;

  return (
    <div className="glass-card glass-card-glow p-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-4 w-4 text-[#8A877D]" />
        <h3 className="text-sm font-medium text-[#C8C6BC]">Tendencia del Score</h3>
      </div>
      <div className="flex items-end gap-3 h-[100px]">
        {scores.map((month, i) => {
          const height = month.score > 0 ? Math.max(8, (month.score / maxScore) * 100) : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
              {month.score > 0 && (
                <span className="text-xs font-bold" style={{ color: month.color }}>
                  {month.score}
                </span>
              )}
              <div className="w-full flex items-end" style={{ height: '72px' }}>
                <motion.div
                  className="w-full rounded-t-md"
                  style={{ backgroundColor: month.score > 0 ? month.color : 'rgba(255,255,255,0.04)' }}
                  initial={{ height: 0 }}
                  animate={{ height: month.score > 0 ? `${height}%` : '8px' }}
                  transition={{ duration: 0.6, delay: i * 0.1, ease: [0.25, 0.46, 0.45, 0.94] }}
                />
              </div>
              <span className="text-[10px] text-[#8A877D]">{month.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
