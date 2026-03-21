"use client";

import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";

interface PaymentMethodsProps {
  metodosPago: DashboardData["metodosPago"];
}

const BAR_COLORS = ["#378ADD", "#1D9E75"];

export default function PaymentMethods({ metodosPago }: PaymentMethodsProps) {
  const maxMonto = metodosPago.length > 0
    ? Math.max(...metodosPago.map((m) => m.monto))
    : 1;

  return (
    <DashCard>
      <p className="mb-4 text-[11px] uppercase tracking-wider text-neto-txt3">
        Métodos de Pago
      </p>

      <div className="flex flex-col gap-3.5">
        {metodosPago.map((metodo, i) => {
          const pct = (metodo.monto / maxMonto) * 100;
          const barColor = BAR_COLORS[i % BAR_COLORS.length];

          return (
            <div key={metodo.nombre}>
              <div className="mb-1 flex items-center justify-between">
                <span className="max-w-[160px] truncate text-[13px] text-neto-txt2">
                  {metodo.nombre}
                </span>
                <span className="text-[13px] font-medium text-neto-txt">
                  S/ {metodo.monto.toLocaleString("es-PE", { minimumFractionDigits: 0 })}
                </span>
              </div>

              <div className="h-[6px] w-full rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${pct}%`, backgroundColor: barColor }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </DashCard>
  );
}
