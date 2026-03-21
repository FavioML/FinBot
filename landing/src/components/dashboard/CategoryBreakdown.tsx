"use client";

import { useState } from "react";
import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { motion, AnimatePresence } from "framer-motion";

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
  const [expandedCat, setExpandedCat] = useState<string | null>(null);

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

  const toggleCategory = (catName: string) => {
    setExpandedCat(prev => (prev === catName ? null : catName));
  };

  return (
    <DashCard>
      <p className="mb-4 text-[11px] uppercase tracking-wider text-neto-txt3">
        Categorías
      </p>

      <div className="flex flex-col gap-5 md:flex-row md:items-start">
        {/* Donut */}
        <div className="relative mx-auto w-[220px] shrink-0 md:mx-0">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="monto"
                nameKey="nombre"
                cx="50%"
                cy="50%"
                innerRadius="58%"
                outerRadius="82%"
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
            <span className="text-[14px] font-semibold text-neto-txt">
              S/ {totalGastos.toLocaleString("es-PE", { minimumFractionDigits: 0 })}
            </span>
          </div>
        </div>

        {/* Horizontal bars */}
        <div className="flex flex-1 flex-col gap-1">
          {sorted.map((cat, i) => {
            const barColor = cat.color || COLORS[i % COLORS.length];
            const pct = (cat.monto / maxMonto) * 100;
            const budgetPct =
              cat.presupuesto > 0
                ? Math.min((cat.presupuesto / maxMonto) * 100, 100)
                : 0;
            const isExpanded = expandedCat === cat.nombre;
            const hasSubs = cat.subcategorias && cat.subcategorias.length > 1;

            return (
              <div key={cat.nombre}>
                <button
                  type="button"
                  onClick={() => hasSubs && toggleCategory(cat.nombre)}
                  className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                    hasSubs ? "cursor-pointer hover:bg-white/[0.04]" : "cursor-default"
                  } ${isExpanded ? "bg-white/[0.04]" : ""}`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 max-w-[160px] truncate text-[12px] text-neto-txt2">
                      {hasSubs && (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 10 10"
                          fill="currentColor"
                          className={`shrink-0 text-neto-txt3 transition-transform duration-200 ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                        >
                          <path d="M3 1l4 4-4 4" />
                        </svg>
                      )}
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
                </button>

                {/* Subcategories expandable */}
                <AnimatePresence>
                  {isExpanded && cat.subcategorias && cat.subcategorias.length > 0 && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: "easeInOut" }}
                      className="overflow-hidden"
                    >
                      <div className="ml-6 mr-2 mt-1 mb-1 flex flex-col gap-1.5 border-l border-white/[0.08] pl-3">
                        {cat.subcategorias.map((sub) => {
                          const subPct = (sub.monto / cat.monto) * 100;
                          return (
                            <div key={sub.nombre}>
                              <div className="mb-0.5 flex items-center justify-between">
                                <span className="max-w-[130px] truncate text-[11px] text-neto-txt3">
                                  {sub.nombre}
                                </span>
                                <span className="text-[11px] text-neto-txt3">
                                  S/ {sub.monto.toLocaleString("es-PE", { minimumFractionDigits: 0 })}
                                </span>
                              </div>
                              <div className="h-1.5 w-full rounded-full bg-white/[0.04]">
                                <div
                                  className="h-full rounded-full transition-all duration-500"
                                  style={{
                                    width: `${subPct}%`,
                                    backgroundColor: barColor,
                                    opacity: 0.6,
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </DashCard>
  );
}
