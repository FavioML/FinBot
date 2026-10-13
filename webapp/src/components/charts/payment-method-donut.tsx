'use client';

import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import { normalizeMetodoPago, getMetodoIcon, formatLast4 } from '@/lib/format';
import type { Transaccion } from '@/lib/types';
import { montoPen } from '@/lib/tx-monto';
import type { ChartTooltipProps } from './chart-types';

interface PaymentMethodDonutProps {
  transactions: Transaccion[];
  onMethodClick?: (method: string) => void;
}

interface MetodoDatum {
  metodo: string;
  metodoBase: string;
  last4: string;
  icon: string;
  total: number;
  count: number;
  porcentaje: number;
}

const COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)'];

function CustomTooltip({ active, payload }: ChartTooltipProps<MetodoDatum>) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="px-3 py-2.5 text-[12px] shadow-xl rounded-lg border border-border" style={{ background: 'var(--surface-elevated)', backdropFilter: 'blur(12px)' }}>
      <p className="text-foreground font-medium">{d.icon} {d.metodo}</p>
      <p className="text-foreground-soft">{formatCurrency(d.total)}</p>
      <p className="text-muted-foreground">{d.porcentaje.toFixed(1)}% · {d.count} transacciones</p>
    </div>
  );
}

export function PaymentMethodDonut({ transactions, onMethodClick }: PaymentMethodDonutProps) {
  const data = useMemo(() => {
    const gastos = transactions.filter((t) => t.tipo === 'gasto');
    const totalGastos = gastos.reduce((s, t) => s + montoPen(t), 0);
    if (totalGastos === 0) return [];

    // Se agrupa por método + tarjeta: dos tarjetas del mismo banco (mismo método)
    // aparecen como slices separados. El click sigue filtrando por método base
    // (metodoBase) para no romper el detalle de la página de transacciones.
    const map = new Map<string, { metodoBase: string; last4: string; total: number; count: number }>();
    for (const t of gastos) {
      const metodoBase = normalizeMetodoPago(t.metodo_pago, t.banco);
      const last4 = t.tarjeta_last4 && /^\d{4}$/.test(t.tarjeta_last4) ? t.tarjeta_last4 : '';
      const key = metodoBase + formatLast4(last4);
      const prev = map.get(key) || { metodoBase, last4, total: 0, count: 0 };
      prev.total += montoPen(t);
      prev.count += 1;
      map.set(key, prev);
    }

    return Array.from(map.entries())
      .map(([metodo, { metodoBase, last4, total, count }]) => ({
        metodo,
        metodoBase,
        last4,
        icon: getMetodoIcon(metodoBase),
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
      className="@container glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
    >
      <h3 className="text-sm font-medium md:text-base md:font-semibold text-foreground-soft mb-4">Metodos de pago</h3>
      {/* Lado a lado según el ancho de la TARJETA (@sm = 384 px), no del viewport: con el riel lateral, a 1040
          la tarjeta mide 320 por dentro y la leyenda quedaba con 104 px; el monto pisaba el nombre. */}
      <div className="flex flex-col @sm:flex-row items-center gap-4">
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
                onClick={onMethodClick ? (entry) => onMethodClick((entry as unknown as MetodoDatum).metodoBase) : undefined}
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
            <span className="text-xs text-muted-foreground">Total</span>
            <span className="text-xs font-bold text-foreground">{formatCurrency(total)}</span>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-col gap-1.5 flex-1 min-w-0">
          {data.map((item, i) => (
            <div
              key={item.metodo}
              className={`flex items-center gap-2 text-xs ${onMethodClick ? 'cursor-pointer rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-foreground/4 transition-colors' : ''}`}
              onClick={onMethodClick ? () => onMethodClick(item.metodoBase) : undefined}
            >
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="text-foreground-soft truncate">
                {item.icon} {item.metodo}
              </span>
              <span className="ml-auto shrink-0 font-medium text-foreground tabular-nums">
                {formatCurrency(item.total)}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums w-[36px] text-right">
                {item.porcentaje.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
