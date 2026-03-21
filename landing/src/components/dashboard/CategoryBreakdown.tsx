"use client";

import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

interface CategoryBreakdownProps {
  categorias: DashboardData["categorias"];
}

const COLORS = [
  "#1D9E75",
  "#378ADD",
  "#EF9F27",
  "#D85A30",
  "#9B59B6",
  "#1ABC9C",
  "#E67E22",
];

export default function CategoryBreakdown({ categorias }: CategoryBreakdownProps) {
  /* Top 6 + "Otros" bucket */
  const sorted = [...categorias].sort((a, b) => b.monto - a.monto);
  const top6 = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const otrosMonto = rest.reduce((s, c) => s + c.monto, 0);

  const pieData =
    otrosMonto > 0
      ? [...top6, { nombre: "Otros", monto: otrosMonto, presupuesto: 0, pctPresupuesto: 0, color: COLORS[6] }]
      : top6;

  const totalGastos = categorias.reduce((s, c) => s + c.monto, 0);
  const maxMonto = sorted.length > 0 ? sorted[0].monto : 1;

  return (
    <DashCard>
      <p className="mb-4 text-[11px] uppercase tracking-wider text-neto-txt3">
        Categorias
      </p>

      <div className="flex flex-col gap-5 md:flex-row md:items-start">
        {/* Donut */}
        <div className="relative mx-auto w-[180px] shrink-0 md:mx-0">
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="monto"
                nameKey="nombre"
                cx="50%"
                cy="50%"
                innerRadius="55%"
                outerRadius="80%"
                strokeWidth={0}
                animationDuration={1200}
              >
                {pieData.map((entry, i) => (
                  <Cell
                    key={entry.nombre}
                    fill={entry.color || COLORS[i % COLORS.length]}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>

          {/* Center total */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[11px] text-neto-txt3">Total</span>
            <span className="text-[16px] font-semibold text-neto-txt">
              S/ {totalGastos.toLocaleString("es-PE", { minimumFractionDigits: 0 })}
            </span>
          </div>
        </div>

        {/* Horizontal bars */}
        <div className="flex flex-1 flex-col gap-3">
          {sorted.map((cat, i) => {
            const barColor = cat.color || COLORS[i % COLORS.length];
            const pct = (cat.monto / maxMonto) * 100;
            const budgetPct =
              cat.presupuesto > 0
                ? Math.min((cat.presupuesto / maxMonto) * 100, 100)
                : 0;

            return (
              <div key={cat.nombre}>
                <div className="mb-1 flex items-center justify-between">
                  <span className="max-w-[140px] truncate text-[12px] text-neto-txt2">
                    {cat.nombre}
                  </span>
                  <span className="text-[12px] font-medium text-neto-txt">
                    S/ {cat.monto.toLocaleString("es-PE", { minimumFractionDigits: 0 })}
                  </span>
                </div>

                <div className="relative h-2 w-full rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: barColor,
                    }}
                  />
                  {budgetPct > 0 && (
                    <div
                      className="absolute top-[-1px] h-[10px] w-[2px] rounded-full bg-[#EF9F27]"
                      style={{ left: `${budgetPct}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </DashCard>
  );
}
