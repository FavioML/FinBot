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
            <svg
              width="28"
              height="28"
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width="32" height="32" rx="8" fill="#1D9E75" />
              <path
                d="M9 22V14l4 5 4-8 2 4"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <text
                x="7"
                y="13"
                fill="white"
                fontSize="9"
                fontWeight="bold"
                fontFamily="system-ui"
              >
                N
              </text>
            </svg>
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
