"use client";

import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";

interface TopMerchantsProps {
  comercios: DashboardData["comercios"];
}

export default function TopMerchants({ comercios }: TopMerchantsProps) {
  const top5 = comercios.slice(0, 5);
  const maxMonto = top5.length > 0 ? top5[0].monto : 1;

  return (
    <DashCard>
      <p className="mb-4 text-[11px] uppercase tracking-wider text-neto-txt3">
        Top Comercios
      </p>

      <div className="flex flex-col gap-3.5">
        {top5.map((comercio, i) => {
          const pct = (comercio.monto / maxMonto) * 100;

          return (
            <div key={comercio.nombre} className="flex items-center gap-3">
              {/* Rank badge */}
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neto-bg5 text-[11px] text-neto-txt3">
                {i + 1}
              </span>

              {/* Name + bar + amount */}
              <div className="flex flex-1 flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="max-w-[160px] truncate text-[13px] text-neto-txt2">
                    {comercio.nombre}
                  </span>
                  <span className="text-[13px] font-medium text-neto-txt">
                    S/ {comercio.monto.toLocaleString("es-PE", { minimumFractionDigits: 0 })}
                  </span>
                </div>

                <div className="h-[6px] w-full rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-neto-green transition-all duration-700"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </DashCard>
  );
}
