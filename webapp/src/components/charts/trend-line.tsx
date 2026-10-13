'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { motion } from 'motion/react';
import { formatCurrency } from '@/lib/utils';
import type { TendenciaMensual } from '@/lib/types';
import type { ChartTooltipProps } from './chart-types';

interface TrendLineProps {
  data: TendenciaMensual[];
}

function CustomTooltip({ active, payload, label }: ChartTooltipProps<TendenciaMensual>) {
  if (!active || !payload?.length) return null;
  return (
    <div className="px-3 py-2.5 text-[12px] shadow-xl rounded-lg border border-border" style={{ background: 'var(--surface-elevated)', backdropFilter: 'blur(12px)' }}>
      <p className="font-medium text-foreground mb-1">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} style={{ color: entry.color }}>
          {entry.dataKey === 'ingresos' ? 'Ingresos' : 'Gastos'}:{' '}
          {formatCurrency(entry.value ?? 0)}
        </p>
      ))}
    </div>
  );
}

export function TrendLine({ data }: TrendLineProps) {
  if (data.length === 0) {
    return (
      <div className="glass-card p-5 flex items-center justify-center h-[320px]">
        <p className="text-sm text-muted-foreground">Sin datos de tendencia</p>
      </div>
    );
  }

  return (
    <motion.div
      className="glass-card glass-card-glow p-5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <h3 className="text-sm font-medium md:text-base md:font-semibold text-foreground-soft mb-4">Ingresos vs Gastos</h3>
      <div className="h-[240px] lg:h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradIngresos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--positive)" stopOpacity={0.25} />
                <stop offset="100%" stopColor="var(--positive)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradGastos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--negative)" stopOpacity={0.25} />
                <stop offset="100%" stopColor="var(--negative)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="color-mix(in srgb, var(--foreground) 6%, transparent)"
              vertical={false}
            />
            <XAxis
              dataKey="mes"
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
              tickFormatter={(v) => `S/${(v / 1000).toFixed(0)}k`}
              width={52}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="ingresos"
              stroke="var(--positive)"
              strokeWidth={2}
              fill="url(#gradIngresos)"
            />
            <Area
              type="monotone"
              dataKey="gastos"
              stroke="var(--negative)"
              strokeWidth={2}
              fill="url(#gradGastos)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}
