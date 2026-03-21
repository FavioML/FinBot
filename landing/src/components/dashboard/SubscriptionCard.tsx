"use client";

import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";

interface SubscriptionCardProps {
  suscripciones: DashboardData["suscripciones"];
  totalSuscripciones: number;
}

export default function SubscriptionCard({
  suscripciones,
  totalSuscripciones,
}: SubscriptionCardProps) {
  return (
    <DashCard>
      <h3 className="mb-4 text-[15px] font-semibold text-neto-txt">
        Suscripciones
      </h3>

      {suscripciones.length === 0 ? (
        <p className="text-[13px] text-neto-txt3">
          No se detectaron suscripciones
        </p>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-neto-txt2">Total mensual</span>
            <span className="font-semibold text-neto-amber">
              S/ {totalSuscripciones.toLocaleString()}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-neto-txt3">
            S/ {(totalSuscripciones * 12).toLocaleString()}/año
          </p>

          {/* List */}
          <div className="mt-3">
            {suscripciones.map((sub, i) => (
              <div
                key={i}
                className={`flex items-center justify-between py-2 ${
                  i < suscripciones.length - 1
                    ? "border-b border-white/[0.06]"
                    : ""
                }`}
              >
                <span className="text-[13px] text-neto-txt2">
                  {sub.comercio}
                </span>
                <span className="text-[13px] text-neto-txt">
                  S/ {sub.monto.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </DashCard>
  );
}
