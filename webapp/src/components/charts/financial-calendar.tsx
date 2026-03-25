'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import { getCategoriaEmoji } from '@/lib/constants';
import type { Transaccion } from '@/lib/types';

interface FinancialCalendarProps {
  transactions: Transaccion[];
  currentMonth: number;
  currentYear: number;
}

const DIAS_SEMANA = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'];

export function FinancialCalendar({ transactions, currentMonth, currentYear }: FinancialCalendarProps) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState(currentMonth);
  const [viewYear, setViewYear] = useState(currentYear);

  const { grid, maxSpend, dayMap } = useMemo(() => {
    // Build day → total spending map
    const dayMap = new Map<string, { total: number; txs: Transaccion[] }>();
    for (const t of transactions) {
      const d = new Date(t.fecha + 'T00:00:00');
      if (d.getMonth() + 1 !== viewMonth || d.getFullYear() !== viewYear) continue;
      const key = t.fecha;
      const prev = dayMap.get(key) || { total: 0, txs: [] };
      if (t.tipo === 'gasto') prev.total += t.monto_pen;
      prev.txs.push(t);
      dayMap.set(key, prev);
    }

    // Build calendar grid
    const firstDay = new Date(viewYear, viewMonth - 1, 1);
    const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
    let startDay = (firstDay.getDay() + 6) % 7; // Monday = 0

    const grid: (number | null)[][] = [];
    let week: (number | null)[] = [];

    // Pad start
    for (let i = 0; i < startDay; i++) week.push(null);

    for (let d = 1; d <= daysInMonth; d++) {
      week.push(d);
      if (week.length === 7) {
        grid.push(week);
        week = [];
      }
    }
    // Pad end
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      grid.push(week);
    }

    let maxSpend = 0;
    for (const [, v] of dayMap) {
      if (v.total > maxSpend) maxSpend = v.total;
    }

    return { grid, maxSpend, dayMap };
  }, [transactions, viewMonth, viewYear]);

  const selectedTxs = useMemo(() => {
    if (!selectedDay) return [];
    return dayMap.get(selectedDay)?.txs || [];
  }, [selectedDay, dayMap]);

  function getDateKey(day: number): string {
    return `${viewYear}-${String(viewMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function getCellColor(amount: number): string {
    if (amount === 0) return 'transparent';
    const intensity = maxSpend > 0 ? amount / maxSpend : 0;
    if (intensity < 0.25) return 'rgba(29,158,117,0.15)';
    if (intensity < 0.5) return 'rgba(29,158,117,0.3)';
    if (intensity < 0.75) return 'rgba(239,159,39,0.3)';
    return 'rgba(216,90,48,0.35)';
  }

  const MESES_NOMBRE = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  function prevMonth() {
    if (viewMonth === 1) { setViewMonth(12); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
    setSelectedDay(null);
  }

  function nextMonth() {
    if (viewMonth === 12) { setViewMonth(1); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
    setSelectedDay(null);
  }

  const today = new Date();
  const isToday = (day: number) =>
    day === today.getDate() && viewMonth === today.getMonth() + 1 && viewYear === today.getFullYear();

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[#C8C6BC]">Calendario financiero</h3>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="p-1 rounded text-[#8A877D] hover:text-[#F0EFE8] transition-colors">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-medium text-[#C8C6BC] w-28 text-center">
            {MESES_NOMBRE[viewMonth]} {viewYear}
          </span>
          <button onClick={nextMonth} className="p-1 rounded text-[#8A877D] hover:text-[#F0EFE8] transition-colors">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DIAS_SEMANA.map((d) => (
          <div key={d} className="text-center text-[9px] text-[#8A877D] font-medium py-1">{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="space-y-1">
        {grid.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 gap-1">
            {week.map((day, di) => {
              if (day === null) return <div key={di} />;
              const key = getDateKey(day);
              const data = dayMap.get(key);
              const amount = data?.total || 0;
              const isSelected = selectedDay === key;
              const isFuture = new Date(viewYear, viewMonth - 1, day) > today;

              return (
                <button
                  key={di}
                  onClick={() => setSelectedDay(isSelected ? null : key)}
                  disabled={isFuture}
                  className={`relative rounded-lg p-1 min-h-[40px] flex flex-col items-center justify-center transition-all text-center ${
                    isSelected
                      ? 'ring-1 ring-[#1D9E75] bg-[rgba(29,158,117,0.1)]'
                      : isFuture
                      ? 'opacity-30 cursor-default'
                      : 'hover:bg-[rgba(255,255,255,0.04)] cursor-pointer'
                  }`}
                  style={{ backgroundColor: isSelected ? undefined : getCellColor(amount) }}
                >
                  <span className={`text-[11px] font-medium ${
                    isToday(day) ? 'text-[#1D9E75]' : 'text-[#C8C6BC]'
                  }`}>
                    {day}
                  </span>
                  {amount > 0 && (
                    <span className="text-[8px] text-[#8A877D] tabular-nums mt-0.5 leading-none">
                      {amount >= 1000 ? `${(amount / 1000).toFixed(1)}k` : Math.round(amount)}
                    </span>
                  )}
                  {isToday(day) && (
                    <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-[#1D9E75]" />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Selected day detail */}
      <AnimatePresence>
        {selectedDay && selectedTxs.length > 0 && (
          <motion.div
            className="mt-4 pt-3 border-t border-[rgba(255,255,255,0.06)] space-y-1.5"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <p className="text-xs text-[#8A877D] mb-2">
              {new Date(selectedDay + 'T12:00:00').toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' })}
              {' — '}
              <span className="text-[#D85A30] font-medium">
                {formatCurrency(dayMap.get(selectedDay)?.total || 0)} en gastos
              </span>
            </p>
            {selectedTxs.slice(0, 8).map((tx) => (
              <div key={tx.id} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-xs shrink-0">{getCategoriaEmoji(tx.categoria)}</span>
                  <span className="text-xs text-[#C8C6BC] truncate">{tx.comercio || tx.subcategoria || tx.categoria}</span>
                </div>
                <span
                  className="text-xs font-medium tabular-nums shrink-0 ml-2"
                  style={{ color: tx.tipo === 'ingreso' ? '#1D9E75' : '#D85A30' }}
                >
                  {tx.tipo === 'ingreso' ? '+' : '-'}{formatCurrency(tx.monto_pen)}
                </span>
              </div>
            ))}
            {selectedTxs.length > 8 && (
              <p className="text-[10px] text-[#8A877D] text-center">y {selectedTxs.length - 8} mas...</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
