"use client";

import { motion } from "framer-motion";
import { DashboardData } from "@/types/dashboard";

interface BalanceCardProps {
  kpis: DashboardData["kpis"];
  historial: DashboardData["historial"];
}

function MiniSparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;

  const w = 120;
  const h = 40;
  const padY = 4;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - padY - ((v - min) / range) * (h - padY * 2);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      fill="none"
      className="shrink-0"
    >
      <polyline
        points={points}
        stroke="var(--color-neto-green-light)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export default function BalanceCard({ kpis, historial }: BalanceCardProps) {
  const { ahorro, pctAhorro } = kpis;
  const isPositive = ahorro >= 0;

  // Last 4 months of gastos for the sparkline
  const sparkData = historial.slice(-4).map((h) => h.totalGastos);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="w-full rounded-[20px] bg-gradient-to-br from-neto-bg3 to-neto-bg2 border border-white/[0.06] p-6"
    >
      <div className="flex items-start justify-between">
        {/* Left: label + value */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-neto-txt3">
            Ahorro del mes
          </span>
          <span
            className={`text-[36px] font-bold tracking-tight leading-none ${
              isPositive ? "text-neto-green" : "text-neto-red"
            }`}
          >
            S/{" "}
            {Math.abs(ahorro).toLocaleString("es-PE", {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </span>
        </div>

        {/* Right: sparkline */}
        <div className="flex flex-col items-end gap-2 pt-1">
          <MiniSparkline data={sparkData} />

          {/* Badge */}
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${
              isPositive
                ? "bg-neto-green/15 text-neto-green"
                : "bg-neto-red/15 text-neto-red"
            }`}
          >
            <svg
              width={10}
              height={10}
              viewBox="0 0 10 10"
              fill="none"
              className={isPositive ? "" : "rotate-180"}
            >
              <path
                d="M5 2L8 6H2L5 2Z"
                fill="currentColor"
              />
            </svg>
            {Math.abs(pctAhorro).toFixed(0)}%
          </span>
        </div>
      </div>
    </motion.div>
  );
}
