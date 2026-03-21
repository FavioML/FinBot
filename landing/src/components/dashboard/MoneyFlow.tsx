"use client";

import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";
import {
  AreaChart,
  Area,
  XAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface MoneyFlowProps {
  historial: DashboardData["historial"];
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-white/10 bg-neto-bg2 p-3">
      <p className="mb-1.5 text-[11px] text-neto-txt3">{label}</p>
      {payload.map((entry) => (
        <p
          key={entry.dataKey}
          className="text-[12px] font-medium"
          style={{ color: entry.color }}
        >
          {entry.dataKey === "totalIngresos" ? "Ingresos" : "Gastos"}:{" "}
          S/ {entry.value.toLocaleString("es-PE", { minimumFractionDigits: 0 })}
        </p>
      ))}
    </div>
  );
}

export default function MoneyFlow({ historial }: MoneyFlowProps) {
  return (
    <DashCard>
      <p className="mb-4 text-[11px] uppercase tracking-wider text-neto-txt3">
        Flujo de Dinero
      </p>

      <ResponsiveContainer width="100%" height={220}>
        <AreaChart
          data={historial}
          margin={{ top: 4, right: 4, left: 4, bottom: 0 }}
        >
          <defs>
            <linearGradient id="gradIngresos" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1D9E75" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#1D9E75" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradGastos" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#EF9F27" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#EF9F27" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.04)"
            vertical={false}
          />

          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#87948c", fontSize: 11 }}
          />

          <Tooltip content={<CustomTooltip />} />

          <Area
            type="monotone"
            dataKey="totalIngresos"
            stroke="#1D9E75"
            strokeWidth={2}
            fill="url(#gradIngresos)"
            animationDuration={1200}
          />
          <Area
            type="monotone"
            dataKey="totalGastos"
            stroke="#EF9F27"
            strokeWidth={2}
            fill="url(#gradGastos)"
            animationDuration={1200}
          />
        </AreaChart>
      </ResponsiveContainer>

      <div className="mt-3 flex items-center justify-center gap-5">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#1D9E75]" />
          <span className="text-[11px] text-neto-txt3">Ingresos</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#EF9F27]" />
          <span className="text-[11px] text-neto-txt3">Gastos</span>
        </div>
      </div>
    </DashCard>
  );
}
