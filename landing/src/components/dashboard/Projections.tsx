"use client";

import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";

interface ProjectionsProps {
  proyeccion: DashboardData["proyeccion"];
  kpis: DashboardData["kpis"];
}

export default function Projections({ proyeccion, kpis }: ProjectionsProps) {
  const withinBudget = proyeccion.total <= kpis.totalIngresos;

  const rows = [
    { label: "Gastos Fijos", value: proyeccion.fijos, isTotal: false },
    { label: "Gastos Variables", value: proyeccion.variables, isTotal: false },
    { label: "Total Proyectado", value: proyeccion.total, isTotal: true },
  ];

  return (
    <DashCard>
      <h3 className="mb-4 text-[15px] font-semibold text-neto-txt">
        Proyección del Mes
      </h3>

      <div>
        {rows.map((row, i) => (
          <div
            key={i}
            className={`flex items-center justify-between py-2 text-[13px] ${
              row.isTotal
                ? "font-semibold text-neto-txt"
                : "border-b border-white/[0.06] text-neto-txt2"
            }`}
          >
            <span>{row.label}</span>
            <span>S/ {row.value.toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* Insight */}
      <div
        className={`mt-3 rounded-r-lg border-l-2 p-3 text-[13px] ${
          withinBudget
            ? "border-neto-green bg-[#1D9E75]/8 text-[#7DCEAE]"
            : "border-neto-red bg-[#D85A30]/8 text-[#E8A088]"
        }`}
      >
        {proyeccion.insight}
      </div>
    </DashCard>
  );
}
