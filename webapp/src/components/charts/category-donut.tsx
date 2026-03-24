'use client';

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { formatCurrency } from '@/lib/utils';
import type { CategoriaGasto } from '@/lib/types';

interface CategoryDonutProps {
  data: CategoriaGasto[];
}

const COLORS = [
  '#1D9E75', // green
  '#EF9F27', // amber
  '#378ADD', // blue
  '#D85A30', // red
  '#8A877D', // muted
  '#6CC4A1', // light green
  '#D4A843', // gold
  '#5FA0E0', // light blue
  '#E8845C', // salmon
  '#B0ADA5', // lighter muted
];

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-lg"
      style={{ background: '#1A1A17', border: '1px solid rgba(255,255,255,0.12)' }}
    >
      <p className="text-[#F0EFE8] font-medium">
        {d.emoji} {d.categoria}
      </p>
      <p className="text-[#C8C6BC]">{formatCurrency(d.total)}</p>
      <p className="text-[#8A877D]">{d.porcentaje.toFixed(1)}%</p>
    </div>
  );
}

export function CategoryDonut({ data }: CategoryDonutProps) {
  const total = data.reduce((sum, d) => sum + d.total, 0);

  if (data.length === 0) {
    return (
      <div className="glass-card p-5 flex items-center justify-center h-[320px]">
        <p className="text-sm text-[#8A877D]">Sin datos de gastos</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <h3 className="text-sm font-medium text-[#C8C6BC] mb-4">Gastos por Categoria</h3>
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
            <span className="text-xs text-[#8A877D]">Total</span>
            <span className="text-sm font-bold text-[#F0EFE8]">
              {formatCurrency(total)}
            </span>
          </div>
        </div>
        {/* Legend */}
        <div className="flex flex-col gap-2 flex-1 min-w-0">
          {data.map((item, i) => (
            <div key={item.categoria} className="flex items-center gap-2 text-xs">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="truncate text-[#C8C6BC]">
                {item.emoji} {item.categoria}
              </span>
              <span className="ml-auto shrink-0 font-medium text-[#F0EFE8]">
                {formatCurrency(item.total)}
              </span>
              <span className="shrink-0 text-[#8A877D]">
                {item.porcentaje.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
