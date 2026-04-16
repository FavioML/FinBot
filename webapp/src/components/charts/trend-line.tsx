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

interface TrendLineProps {
  data: TendenciaMensual[];
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="px-3 py-2.5 text-[12px] shadow-xl rounded-lg border border-[rgba(255,255,255,0.1)]" style={{ background: '#1A1A17', backdropFilter: 'blur(12px)' }}>
      <p className="font-medium text-[#F0EFE8] mb-1">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey} style={{ color: entry.color }}>
          {entry.dataKey === 'ingresos' ? 'Ingresos' : 'Gastos'}:{' '}
          {formatCurrency(entry.value)}
        </p>
      ))}
    </div>
  );
}

export function TrendLine({ data }: TrendLineProps) {
  if (data.length === 0) {
    return (
      <div className="glass-card p-5 flex items-center justify-center h-[320px]">
        <p className="text-sm text-[#8A877D]">Sin datos de tendencia</p>
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
      <h3 className="text-sm font-medium md:text-base md:font-semibold text-[#C8C6BC] mb-4">Ingresos vs Gastos</h3>
      <div className="h-[240px] lg:h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradIngresos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1D9E75" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#1D9E75" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradGastos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#D85A30" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#D85A30" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.06)"
              vertical={false}
            />
            <XAxis
              dataKey="mes"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#8A877D', fontSize: 12 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#8A877D', fontSize: 11 }}
              tickFormatter={(v) => `S/${(v / 1000).toFixed(0)}k`}
              width={52}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="ingresos"
              stroke="#1D9E75"
              strokeWidth={2}
              fill="url(#gradIngresos)"
            />
            <Area
              type="monotone"
              dataKey="gastos"
              stroke="#D85A30"
              strokeWidth={2}
              fill="url(#gradGastos)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}
