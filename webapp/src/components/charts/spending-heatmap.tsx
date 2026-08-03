'use client';

import { useMemo } from 'react';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import { montoPen } from '@/lib/tx-monto';
import type { Transaccion } from '@/lib/types';

interface SpendingHeatmapProps {
  transactions: Transaccion[];
}

const DIAS = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'];

function getColor(intensity: number): string {
  if (intensity === 0) return 'rgba(255,255,255,0.03)';
  if (intensity < 0.25) return 'rgba(29,158,117,0.2)';
  if (intensity < 0.5) return 'rgba(29,158,117,0.4)';
  if (intensity < 0.75) return 'rgba(239,159,39,0.5)';
  return 'rgba(216,90,48,0.6)';
}

export function SpendingHeatmap({ transactions }: SpendingHeatmapProps) {
  const { grid, maxSpend } = useMemo(() => {
    // Build a map of date → total spending (last 12 weeks)
    const today = new Date();
    const dayMap = new Map<string, number>();
    const numWeeks = 12;

    // Find start date: go back 12 weeks from end of current week
    const dayOfWeek = (today.getDay() + 6) % 7; // Monday=0
    const endDate = new Date(today);
    const startDate = new Date(today);
    startDate.setDate(endDate.getDate() - dayOfWeek - (numWeeks - 1) * 7);

    // Fill expense data
    for (const t of transactions) {
      if (t.tipo !== 'gasto') continue;
      const key = t.fecha; // YYYY-MM-DD
      dayMap.set(key, (dayMap.get(key) || 0) + montoPen(t));
    }

    // Build grid: rows = 7 days, cols = weeks
    const grid: { date: string; amount: number; dayLabel: string }[][] = [];
    let maxSpend = 0;

    const cursor = new Date(startDate);
    for (let w = 0; w < numWeeks; w++) {
      const week: { date: string; amount: number; dayLabel: string }[] = [];
      for (let d = 0; d < 7; d++) {
        const key = cursor.toISOString().slice(0, 10);
        const amount = dayMap.get(key) || 0;
        if (amount > maxSpend) maxSpend = amount;
        const isFuture = cursor > today;
        week.push({
          date: key,
          amount: isFuture ? -1 : amount, // -1 = future
          dayLabel: DIAS[d],
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      grid.push(week);
    }

    return { grid, maxSpend };
  }, [transactions]);

  if (transactions.length === 0) return null;

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
    >
      <h3 className="text-sm font-medium text-[#C8C6BC] mb-4">Actividad de gastos</h3>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {/* Day labels */}
        <div className="flex flex-col gap-1 shrink-0 mr-1">
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <div key={d} className="h-[14px] flex items-center">
              {d % 2 === 0 && (
                <span className="text-[9px] text-[#8A877D] w-6 text-right">{DIAS[d]}</span>
              )}
            </div>
          ))}
        </div>

        {/* Heatmap grid */}
        {grid.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-1">
            {week.map((day) => {
              const intensity = day.amount < 0 ? -1 : maxSpend > 0 ? day.amount / maxSpend : 0;
              return (
                <div
                  key={day.date}
                  className="w-[14px] h-[14px] rounded-[3px] transition-all duration-150 cursor-default"
                  style={{
                    backgroundColor: intensity < 0 ? 'transparent' : getColor(intensity),
                  }}
                  title={day.amount < 0 ? '' : `${day.date}: ${day.amount > 0 ? formatCurrency(day.amount) : 'Sin gastos'}`}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-2 mt-3 text-[9px] text-[#8A877D]">
        <span>Menos</span>
        {[0, 0.2, 0.4, 0.7, 1].map((v) => (
          <div
            key={v}
            className="w-[10px] h-[10px] rounded-[2px]"
            style={{ backgroundColor: getColor(v) }}
          />
        ))}
        <span>Mas</span>
        {maxSpend > 0 && (
          <span className="ml-auto">Dia pico: {formatCurrency(maxSpend)}</span>
        )}
      </div>
    </motion.div>
  );
}
