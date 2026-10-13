'use client';

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card px-3 py-2 text-xs">
      <p className="text-muted-foreground mb-0.5">{label}</p>
      <p className="text-primary font-semibold">{payload[0].value} pts</p>
    </div>
  );
}

interface ScoreEvolutionChartProps {
  data: Array<{ period: string; score: number }>;
}

export function ScoreEvolutionChart({ data }: ScoreEvolutionChartProps) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--foreground) 4%, transparent)" />
        <XAxis
          dataKey="period"
          tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          width={28}
        />
        <Tooltip content={<CustomTooltip />} />
        <Line
          type="monotone"
          dataKey="score"
          stroke="var(--primary)"
          strokeWidth={2.5}
          dot={{ fill: 'var(--primary)', r: 4, strokeWidth: 0 }}
          activeDot={{ r: 6, fill: 'var(--primary)' }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
