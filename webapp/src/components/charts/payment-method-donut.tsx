'use client';

import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import { normalizeMetodoPago, getMetodoIcon } from '@/lib/format';
import type { Transaccion } from '@/lib/types';

interface PaymentMethodDonutProps {
  transactions: Transaccion[];
  onMethodClick?: (method: string) => void;
}

const COLORS = [
  '#1D9E75', '#378ADD', '#EF9F27', '#D85A30', '#8A877D',
  '#6CC4A1', '#5FA0E0', '#D4A843', '#E8845C', '#B0ADA5',
];

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="px-3 py-2.5 text-[12px] shadow-xl rounded-lg border border-[rgba(255,255,255,0.1)]" style={{ background: '#1A1A17', backdropFilter: 'blur(12px)' }}>
      <p className="text-[#F0EFE8] font-medium">{d.icon} {d.metodo}</p>
      <p className="text-[#C8C6BC]">{formatCurrency(d.total)}</p>
      <p className="text-[#8A877D]">{d.porcentaje.toFixed(1)}% · {d.count} transacciones</p>
    </div>
  );
}

export function PaymentMethodDonut({ transactions, onMethodClick }: PaymentMethodDonutProps) {
  const data = useMemo(() => {
    const gastos = transactions.filter((t) => t.tipo === 'gasto');
    const totalGastos = gastos.reduce((s, t) => s + t.monto_pen, 0);
    if (totalGastos === 0) return [];

    const map = new Map<string, { total: number; count: number }>();
    for (const t of gastos) {
      const metodo = normalizeMetodoPago(t.metodo_pago, t.banco);
      const prev = map.get(metodo) || { total: 0, count: 0 };
      prev.total += t.monto_pen;
      prev.count += 1;
      map.set(metodo, prev);
    }

    return Array.from(map.entries())
      .map(([metodo, { total, count }]) => ({
        metodo,
        icon: getMetodoIcon(metodo),
        total,
        count,
        porcentaje: (total / totalGastos) * 100,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
  }, [transactions]);

  if (data.length === 0) return null;

  const total = data.reduce((s, d) => s + d.total, 0);

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
    >
      <h3 className="text-sm font-medium md:text-base md:font-semibold text-[#C8C6BC] mb-4">Metodos de pago</h3>
      <div className="flex flex-col md:flex-row items-center gap-4">
        <div className="relative w-[180px] h-[180px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={80}
                dataKey="total"
                stroke="none"
                paddingAngle={2}
                cursor={onMethodClick ? 'pointer' : undefined}
                onClick={onMethodClick ? (entry: any) => onMethodClick(entry.metodo) : undefined}
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
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-[10px] text-[#8A877D]">Total</span>
            <span className="text-xs font-bold text-[#F0EFE8]">{formatCurrency(total)}</span>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-col gap-1.5 flex-1 min-w-0">
          {data.map((item, i) => (
            <div
              key={item.metodo}
              className={`flex items-center gap-2 text-xs ${onMethodClick ? 'cursor-pointer rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-[rgba(255,255,255,0.04)] transition-colors' : ''}`}
              onClick={onMethodClick ? () => onMethodClick(item.metodo) : undefined}
            >
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="text-[#C8C6BC] truncate">
                {item.icon} {item.metodo}
              </span>
              <span className="ml-auto shrink-0 font-medium text-[#F0EFE8] tabular-nums">
                {formatCurrency(item.total)}
              </span>
              <span className="shrink-0 text-[#8A877D] tabular-nums w-[36px] text-right">
                {item.porcentaje.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
