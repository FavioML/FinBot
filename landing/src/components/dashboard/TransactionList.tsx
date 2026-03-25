"use client";

import { DashboardData } from "@/types/dashboard";
import { DashCard } from "@/components/ui/DashCard";

interface TransactionListProps {
  transacciones: DashboardData["transacciones"];
}

const categoryEmojis: Record<string, string> = {
  Alimentación: "🍽️",
  Transporte: "🚗",
  Salud: "💊",
  Entretenimiento: "🎬",
  Streaming: "📺",
  Vivienda: "🏠",
  Compras: "🛍️",
  Finanzas: "💰",
  Servicios: "⚙️",
};

function getEmoji(categoria: string): string {
  return categoryEmojis[categoria] || "📌";
}

function formatMonto(monto: number, tipo: string, moneda: string): string {
  const prefix = tipo === "ingreso" ? "+" : "";
  const symbol = moneda === "USD" ? "$" : "S/";
  return `${prefix}${symbol}${Math.abs(monto).toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function TransactionList({ transacciones }: TransactionListProps) {
  return (
    <DashCard>
      <h3 className="mb-4 text-[15px] font-semibold text-neto-txt">
        Transacciones Recientes
      </h3>

      {transacciones.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-neto-txt3">
          Sin transacciones
        </p>
      ) : (
        <div className="max-h-[400px] overflow-y-auto pr-2 [&::-webkit-scrollbar]:w-[4px] [&::-webkit-scrollbar-track]:bg-neto-bg5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-neto-bg6">
          {transacciones.map((tx, i) => (
            <div
              key={`${tx.fecha}-${tx.comercio}-${i}`}
              className="flex items-center gap-3 border-b border-white/[0.04] py-2.5"
            >
              {/* Category icon */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neto-bg5 text-[14px]">
                {getEmoji(tx.categoria)}
              </div>

              {/* Name & date */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-neto-txt">
                  {tx.comercio}
                </p>
                <p className="text-[11px] text-neto-txt3">{tx.fecha}</p>
              </div>

              {/* Amount */}
              <span
                className={`shrink-0 text-[13px] font-medium ${
                  tx.tipo === "ingreso" ? "text-neto-green" : "text-neto-txt"
                }`}
              >
                {formatMonto(tx.monto, tx.tipo, tx.moneda)}
              </span>
            </div>
          ))}
        </div>
      )}
    </DashCard>
  );
}
