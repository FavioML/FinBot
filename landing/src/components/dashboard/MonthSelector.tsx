"use client";

import { DashboardData } from "@/types/dashboard";

interface MonthSelectorProps {
  mesesDisponibles: DashboardData["mesesDisponibles"];
  mesActual: number;
  anioActual: number;
  onSelect: (mes: number, anio: number) => void;
}

export default function MonthSelector({
  mesesDisponibles,
  mesActual,
  anioActual,
  onSelect,
}: MonthSelectorProps) {
  return (
    <>
      <style jsx>{`
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
      <div className="scrollbar-hide flex gap-2 overflow-x-auto snap-x snap-mandatory pb-2">
        {mesesDisponibles.map((m) => {
          const isActive = m.mes === mesActual && m.anio === anioActual;
          return (
            <button
              key={`${m.anio}-${m.mes}`}
              onClick={() => onSelect(m.mes, m.anio)}
              className={`snap-start whitespace-nowrap rounded-full px-4 py-1.5 text-[12px] font-medium transition-colors ${
                isActive
                  ? "bg-neto-green text-white"
                  : "bg-neto-bg4 text-neto-txt3 hover:bg-neto-bg5"
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
