"use client";

import { motion } from "framer-motion";
import { DashboardData } from "@/types/dashboard";

interface KPICardsProps {
  kpis: DashboardData["kpis"];
}

interface KPIItem {
  label: string;
  value: string;
  delta: number;
  /** 0-100 for the donut */
  donutPct: number;
  ringColor: string;
  favorableWhenPositive: boolean;
}

function MiniDonut({
  pct,
  ringColor,
}: {
  pct: number;
  ringColor: string;
}) {
  const r = 16;
  const strokeWidth = 3;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <svg width={40} height={40} viewBox="0 0 40 40" className="shrink-0">
      {/* Background track */}
      <circle
        cx={20}
        cy={20}
        r={r}
        fill="none"
        stroke="var(--color-neto-bg5)"
        strokeWidth={strokeWidth}
      />
      {/* Filled arc */}
      <circle
        cx={20}
        cy={20}
        r={r}
        fill="none"
        stroke={ringColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 20 20)"
      />
    </svg>
  );
}

const containerVariants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

export default function KPICards({ kpis }: KPICardsProps) {
  const {
    totalIngresos,
    totalGastos,
    pctAhorro,
    deltaIngreso,
    deltaGasto,
  } = kpis;

  const totalSum = totalIngresos + totalGastos || 1;

  const items: KPIItem[] = [
    {
      label: "Ingresos",
      value: `S/ ${totalIngresos.toLocaleString("es-PE", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      delta: deltaIngreso,
      donutPct: (totalIngresos / totalSum) * 100,
      ringColor: "var(--color-neto-green)",
      favorableWhenPositive: true,
    },
    {
      label: "Gastos",
      value: `S/ ${totalGastos.toLocaleString("es-PE", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      delta: deltaGasto,
      donutPct: (totalGastos / totalSum) * 100,
      ringColor:
        totalGastos / totalSum > 0.7
          ? "var(--color-neto-red)"
          : "var(--color-neto-amber)",
      favorableWhenPositive: false,
    },
    {
      label: "Tasa de Ahorro",
      value: `${pctAhorro.toFixed(0)}%`,
      delta: deltaIngreso - deltaGasto, // net change proxy
      donutPct: Math.abs(pctAhorro),
      ringColor:
        pctAhorro >= 0
          ? "var(--color-neto-green)"
          : "var(--color-neto-red)",
      favorableWhenPositive: true,
    },
  ];

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="show"
      className="grid grid-cols-1 min-[480px]:grid-cols-3 gap-3"
    >
      {items.map((item) => {
        const isFavorable = item.favorableWhenPositive
          ? item.delta >= 0
          : item.delta <= 0;

        return (
          <motion.div
            key={item.label}
            variants={cardVariants}
            className="relative bg-neto-bg3/60 border border-white/[0.06] rounded-[16px] p-4"
          >
            {/* Donut top-right */}
            <div className="absolute top-3 right-3">
              <MiniDonut pct={item.donutPct} ringColor={item.ringColor} />
            </div>

            <div className="flex flex-col gap-1 pr-12">
              <span className="text-[11px] uppercase tracking-wider text-neto-txt3">
                {item.label}
              </span>
              <span className="text-[22px] font-semibold text-neto-txt leading-tight">
                {item.value}
              </span>
              <span
                className={`inline-flex items-center gap-0.5 text-[12px] font-medium ${
                  isFavorable ? "text-neto-green" : "text-neto-red"
                }`}
              >
                <svg
                  width={8}
                  height={8}
                  viewBox="0 0 10 10"
                  fill="none"
                  className={isFavorable ? "" : "rotate-180"}
                >
                  <path d="M5 2L8 6H2L5 2Z" fill="currentColor" />
                </svg>
                {Math.abs(item.delta).toFixed(0)}%
              </span>
            </div>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
