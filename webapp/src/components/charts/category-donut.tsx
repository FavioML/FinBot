'use client';

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import type { CategoriaGasto } from '@/lib/types';
import type { ChartTooltipProps } from './chart-types';

interface CategoryDonutProps {
  data: CategoriaGasto[];
  onCategoryClick?: (categoria: string) => void;
}

// La paleta categórica verificada (>= 3:1 contra la tarjeta en los dos temas). Antes eran 10 hex
// sueltos; con más de 8 categorías se repite, que es preferible a dos verdes casi iguales.
const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)'];

function CustomTooltip({ active, payload }: ChartTooltipProps<CategoriaGasto>) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="px-3 py-2.5 text-[12px] shadow-xl rounded-lg border border-border" style={{ background: 'var(--surface-elevated)', backdropFilter: 'blur(12px)' }}>
      <p className="text-foreground font-medium">
        {d.emoji} {d.categoria}
      </p>
      <p className="text-foreground-soft">{formatCurrency(d.total)}</p>
      <p className="text-muted-foreground">{d.porcentaje.toFixed(1)}%</p>
    </div>
  );
}

export function CategoryDonut({ data, onCategoryClick }: CategoryDonutProps) {
  const total = data.reduce((sum, d) => sum + d.total, 0);

  if (data.length === 0) {
    return (
      <div className="glass-card p-5 flex items-center justify-center h-[320px]">
        <p className="text-sm text-muted-foreground">Sin datos de gastos</p>
      </div>
    );
  }

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <h3 className="text-sm font-medium md:text-base md:font-semibold text-foreground-soft mb-4">Gastos por Categoria</h3>
      <div className="flex flex-col md:flex-row items-center gap-4">
        <div className="relative w-[200px] h-[200px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                dataKey="total"
                stroke="none"
                paddingAngle={2}
                cursor={onCategoryClick ? 'pointer' : undefined}
                onClick={onCategoryClick ? (entry) => onCategoryClick((entry as unknown as CategoriaGasto).categoria) : undefined}
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                content={<CustomTooltip />}
                offset={20}
                wrapperStyle={{ zIndex: 100, pointerEvents: 'none' }}
              />
            </PieChart>
          </ResponsiveContainer>
          {/* Center text */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-xs text-muted-foreground">Total</span>
            <span className="text-sm font-bold text-foreground">
              {formatCurrency(total)}
            </span>
          </div>
        </div>
        {/* Legend */}
        <div className="flex flex-col gap-2.5 flex-1 min-w-0">
          {data.map((item, i) => (
            <div
              key={item.categoria}
              className={`flex items-center gap-2 text-xs ${onCategoryClick ? 'cursor-pointer rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-foreground/4 transition-colors' : ''}`}
              onClick={onCategoryClick ? () => onCategoryClick(item.categoria) : undefined}
            >
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="truncate text-foreground-soft">
                {item.emoji} {item.categoria}
              </span>
              <span className="ml-auto shrink-0 font-medium text-foreground">
                {formatCurrency(item.total)}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {item.porcentaje.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
