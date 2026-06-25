'use client';

import {
  PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  ReferenceLine,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { getMetodoIcon } from '@/lib/format';

// Shared palette for all report charts (moved out of the page so recharts
// only loads inside this lazy chunk).
const PIE_COLORS = ['#1D9E75', '#EF9F27', '#D85A30', '#3B82F6', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

interface CategoryDatum { label: string; total: number; categoria: string }
interface PaymentDatum { name: string; value: number }
interface DailyDatum { day: number; total: number }

export function CategoryBarChart({ data, onSelect }: { data: CategoryDatum[]; onSelect: (categoria: string) => void }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 40)}>
      <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category" dataKey="label" width={140}
          tick={{ fill: '#C8C6BC', fontSize: 12 }}
        />
        <Tooltip
          contentStyle={{ background: 'rgba(28,28,26,0.8)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}
          labelStyle={{ color: '#F0EFE8', fontSize: 12 }}
          itemStyle={{ color: '#F0EFE8', fontSize: 12 }}
          formatter={(v) => formatCurrency(Number(v))}
        />
        <Bar
          dataKey="total"
          radius={[0, 6, 6, 0]}
          onClick={(e) => { const d = e as unknown as { categoria?: string }; if (d?.categoria) onSelect(d.categoria); }}
          cursor="pointer"
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PaymentMethodsPieChart({ data, onSelect }: { data: PaymentDatum[]; onSelect: (name: string) => void }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data} dataKey="value" nameKey="name"
          cx="50%" cy="50%" innerRadius={55} outerRadius={90}
          paddingAngle={3} strokeWidth={0}
          onClick={(e) => { const d = e as unknown as { name?: string }; if (d?.name) onSelect(d.name); }}
          cursor="pointer"
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ background: 'rgba(26,26,24,0.8)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#F0EFE8', fontSize: 12 }}
          formatter={(v) => formatCurrency(Number(v))}
        />
        <Legend
          formatter={(value: string) => <span className="text-xs text-[#C8C6BC]">{getMetodoIcon(value)} {value}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function DailySpendingChart({ data, dailyAverage, onSelect }: { data: DailyDatum[]; dailyAverage: number; onSelect: (day: number) => void }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ left: 0, right: 0 }}>
        <XAxis
          dataKey="day" tick={{ fill: '#8A877D', fontSize: 11 }}
          axisLine={false} tickLine={false}
        />
        <YAxis hide />
        <Tooltip
          contentStyle={{ background: 'rgba(26,26,24,0.8)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#F0EFE8', fontSize: 12 }}
          formatter={(v) => formatCurrency(Number(v))}
          labelFormatter={(l) => `Dia ${l}`}
        />
        {dailyAverage > 0 && (
          <ReferenceLine
            y={dailyAverage}
            stroke="#EF9F27"
            strokeDasharray="6 4"
            strokeOpacity={0.5}
          />
        )}
        <Bar dataKey="total" fill="#EF9F27" radius={[4, 4, 0, 0]} cursor="pointer"
          onClick={(e) => { const d = e as unknown as { day?: number; total?: number }; if (d?.day && (d.total ?? 0) > 0) onSelect(d.day); }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
