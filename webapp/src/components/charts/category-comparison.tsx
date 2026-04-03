'use client';

import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { getCategoriaEmoji, MESES } from '@/lib/constants';
import type { Transaccion } from '@/lib/types';

interface CategoryComparisonProps {
  allTransactions: Transaccion[];
  currentMonth: number;
  currentYear: number;
  onCategoryClick?: (categoria: string) => void;
}

export function CategoryComparison({ allTransactions, currentMonth, currentYear, onCategoryClick }: CategoryComparisonProps) {
  const data = useMemo(() => {
    // Current month gastos by category
    const currentGastos = allTransactions.filter((t) => {
      if (t.tipo !== 'gasto') return false;
      const d = new Date(t.fecha + 'T00:00:00');
      return d.getMonth() + 1 === currentMonth && d.getFullYear() === currentYear;
    });

    // Previous month
    const prevDate = new Date(currentYear, currentMonth - 2, 1);
    const pm = prevDate.getMonth() + 1;
    const py = prevDate.getFullYear();
    const prevGastos = allTransactions.filter((t) => {
      if (t.tipo !== 'gasto') return false;
      const d = new Date(t.fecha + 'T00:00:00');
      return d.getMonth() + 1 === pm && d.getFullYear() === py;
    });

    if (currentGastos.length === 0 && prevGastos.length === 0) return [];

    // Aggregate by category
    const catMap = new Map<string, { current: number; previous: number }>();

    for (const t of currentGastos) {
      const prev = catMap.get(t.categoria) || { current: 0, previous: 0 };
      prev.current += t.monto_pen;
      catMap.set(t.categoria, prev);
    }

    for (const t of prevGastos) {
      const prev = catMap.get(t.categoria) || { current: 0, previous: 0 };
      prev.previous += t.monto_pen;
      catMap.set(t.categoria, prev);
    }

    return Array.from(catMap.entries())
      .map(([cat, vals]) => ({
        categoria: cat,
        emoji: getCategoriaEmoji(cat),
        label: `${getCategoriaEmoji(cat)} ${cat}`,
        current: Math.round(vals.current),
        previous: Math.round(vals.previous),
        change: vals.previous > 0
          ? Math.round(((vals.current - vals.previous) / vals.previous) * 100)
          : vals.current > 0 ? 100 : 0,
      }))
      .sort((a, b) => (b.current + b.previous) - (a.current + a.previous));
  }, [allTransactions, currentMonth, currentYear]);

  const [expanded, setExpanded] = useState(false);

  if (data.length === 0) return null;

  const VISIBLE_COUNT = 6;
  const chartData = expanded ? data : data.slice(0, VISIBLE_COUNT);
  const hasMore = data.length > VISIBLE_COUNT;

  const prevDate = new Date(currentYear, currentMonth - 2, 1);
  const pmLabel = MESES[prevDate.getMonth() + 1];
  const cmLabel = MESES[currentMonth];

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[#C8C6BC]">Comparativa por categoria</h3>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[#8A877D]" />
            {pmLabel}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[#1D9E75]" />
            {cmLabel}
          </span>
        </div>
      </div>

      {/* Chart */}
      <div style={{ height: Math.max(200, chartData.length * 36) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
            <XAxis
              type="number"
              tick={{ fill: '#8A877D', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fill: '#C8C6BC', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={120}
            />
            <Tooltip
              contentStyle={{
                background: '#1A1A17',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '0.75rem',
                fontSize: '12px',
                color: '#F0EFE8',
                boxShadow: '0 20px 25px -5px rgba(0,0,0,0.4)',
              }}
              itemStyle={{ color: '#C8C6BC' }}
              labelStyle={{ color: '#8A877D', fontSize: '11px' }}
              formatter={(value: unknown, name: unknown) => [
                formatCurrency(Number(value)),
                name === 'previous' ? pmLabel : cmLabel,
              ]}
              cursor={{ fill: 'rgba(255,255,255,0.02)' }}
            />
            <Bar dataKey="previous" fill="#8A877D" radius={[0, 4, 4, 0]} barSize={8} opacity={0.5} isAnimationActive={true} />
            <Bar dataKey="current" radius={[0, 4, 4, 0]} barSize={8} isAnimationActive={true}
              cursor={onCategoryClick ? 'pointer' : undefined}
              onClick={onCategoryClick ? (entry: any) => onCategoryClick(entry.categoria) : undefined}
            >
              {chartData.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.change > 10 ? '#D85A30' : entry.change < -10 ? '#1D9E75' : '#EF9F27'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Change badges */}
      <div className="flex flex-wrap gap-2 mt-3">
        {chartData.filter((d) => d.change !== 0).slice(0, 4).map((d) => (
          <span
            key={d.categoria}
            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: d.change > 0 ? 'rgba(216,90,48,0.1)' : 'rgba(29,158,117,0.1)',
              color: d.change > 0 ? '#D85A30' : '#1D9E75',
            }}
          >
            {d.emoji} {d.change > 0 ? '+' : ''}{d.change}%
          </span>
        ))}
      </div>

      {/* Expand/collapse button */}
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-center gap-1.5 w-full mt-3 py-2 rounded-lg text-xs font-medium text-[#8A877D] hover:text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.03)] transition-colors"
        >
          {expanded ? 'Ver menos' : `Ver todas (${data.length})`}
          <motion.span
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.25 }}
            className="inline-flex"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </motion.span>
        </button>
      )}
    </motion.div>
  );
}
