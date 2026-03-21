"use client";

import { DashboardData } from "@/types/dashboard";

interface DashboardShellProps {
  data: DashboardData;
  children: React.ReactNode;
}

function formatDate(fecha: string): string {
  try {
    return new Date(fecha).toLocaleDateString("es-PE", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return fecha;
  }
}

export default function DashboardShell({ data, children }: DashboardShellProps) {
  return (
    <div className="min-h-screen bg-neto-bg">
      {/* Sticky header */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-neto-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <img src="/logo-icon.svg" alt="Neto" width={28} height={28} className="rounded-lg" />
            <span className="text-lg font-bold text-neto-green">neto</span>
          </div>

          {/* User info */}
          <div className="text-right">
            <p className="text-[14px] text-neto-txt2">
              Hola, {data.nombre}
            </p>
            <p className="text-[11px] text-neto-txt3">
              {formatDate(data.fechaGeneracion)}
            </p>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>

      {/* Footer */}
      <footer className="py-8 text-center">
        <p className="text-[11px] text-neto-txt3">
          Generado por NETO &middot; neto.pe
        </p>
      </footer>
    </div>
  );
}
