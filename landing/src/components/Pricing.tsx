"use client";

import { Check, X, Zap, Crown } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const COMPARISON: { feature: string; free: boolean; pro: boolean; freeLabel?: string; proLabel?: string }[] = [
  { feature: "Resumen diario, semanal y mensual", free: true, pro: true },
  { feature: "Categorización automática con IA", free: true, pro: true },
  { feature: "Corrección de categorías", free: true, pro: true },
  { feature: "Consultas en lenguaje natural", free: true, pro: true },
  { feature: "Historial", free: true, pro: true, freeLabel: "3 meses", proLabel: "Ilimitado" },
  { feature: "Reportes web mensuales", free: false, pro: true },
  { feature: "Resúmenes configurables", free: false, pro: true },
  { feature: "Score de salud financiera", free: false, pro: true },
  { feature: "Carga de gastos históricos (Excel)", free: false, pro: true },
];

export default function Pricing() {
  return (
    <section id="precios" className="py-28 relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute top-[10%] left-[50%] -translate-x-1/2 w-[800px] h-[600px] -z-10 rounded-full bg-[#1D9E75]/[0.04] blur-[150px]" />

      <div className="mx-auto max-w-[1100px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full bg-[#1D9E75]/10 px-5 py-2 text-xs font-medium text-[#68dbae] mb-6 tracking-wide">
            Precios
          </span>
          <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight mb-5">
            <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
              Simple y transparente.
            </span>
          </h2>
          <p className="text-[#87948c] max-w-[480px] mx-auto text-lg leading-relaxed">
            Empieza gratis. Actualiza solo cuando veas el valor.
          </p>
        </div>

        {/* Pricing cards */}
        <div className="grid grid-cols-1 min-[860px]:grid-cols-2 gap-5 max-w-[900px] mx-auto">
          {/* Free plan */}
          <div className="group relative rounded-[24px] bg-[#1C1C19] overflow-hidden transition-all duration-300 hover:bg-[#20201d] cursor-default"
               style={{ transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)" }}>
            {/* Inner shadow */}
            <div className="absolute inset-0 rounded-[24px] pointer-events-none"
                 style={{ boxShadow: "0 -20px 80px -20px rgba(255,255,255,0.03) inset" }} />

            <div className="relative p-8 flex flex-col h-full">
              {/* Plan icon + name */}
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-[#2A2A28] flex items-center justify-center">
                  <Zap size={20} className="text-[#87948c]" />
                </div>
                <h3 className="text-xl font-bold text-[#e5e2de]">Gratis</h3>
              </div>

              {/* Price */}
              <div className="mb-2">
                <span className="text-5xl font-extrabold text-[#e5e2de] tracking-tight">S/0</span>
              </div>
              <p className="text-sm text-[#87948c] mb-8">Para siempre. Sin tarjeta.</p>

              {/* Features */}
              <ul className="space-y-3.5 flex-1 mb-8">
                {COMPARISON.map((row) => (
                  <li key={row.feature} className="flex items-start gap-3">
                    {row.free ? (
                      <div className="w-5 h-5 rounded-full bg-[#1D9E75]/15 flex items-center justify-center shrink-0 mt-0.5">
                        <Check size={12} className="text-[#1D9E75]" />
                      </div>
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-[#2A2A28] flex items-center justify-center shrink-0 mt-0.5">
                        <X size={12} className="text-[#87948c]/40" />
                      </div>
                    )}
                    <span className={`text-sm ${row.free ? "text-[#bccac1]" : "text-[#87948c]/40"}`}>
                      {row.feature}{row.freeLabel ? ` (${row.freeLabel})` : ""}
                    </span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <a
                href={WA_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-[#2A2A28] text-[#e5e2de] px-6 py-3.5 text-sm font-semibold text-center transition-all duration-300 hover:bg-[#353532] cursor-pointer block"
              >
                Empezar gratis
              </a>
            </div>
          </div>

          {/* Pro plan */}
          <div className="group relative rounded-[24px] overflow-hidden transition-all duration-300 cursor-default"
               style={{ transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)" }}>
            {/* Gradient border effect */}
            <div className="absolute inset-0 rounded-[24px] bg-gradient-to-br from-[#68dbae]/30 via-[#1D9E75]/20 to-[#0F6E56]/30" />
            <div className="absolute inset-[1px] rounded-[23px] bg-[#131311]" />

            {/* Glow effect */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-24 bg-[#1D9E75]/20 blur-[60px] -z-0" />

            <div className="relative p-8 flex flex-col h-full">
              {/* Plan icon + name + badge */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#1D9E75]/20 flex items-center justify-center">
                    <Crown size={20} className="text-[#68dbae]" />
                  </div>
                  <h3 className="text-xl font-bold text-[#e5e2de]">Pro</h3>
                </div>
                <span className="rounded-full bg-[#EF9F27] px-3 py-1 text-xs font-bold text-[#0E0E0C]">
                  POPULAR
                </span>
              </div>

              {/* Price */}
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-5xl font-extrabold text-[#e5e2de] tracking-tight">S/10</span>
                <span className="text-sm text-[#87948c]">/mes</span>
              </div>
              <p className="text-sm text-[#87948c] mb-8">
                o <span className="text-[#68dbae] font-medium">S/99/año</span> — 2 meses gratis
              </p>

              {/* Features */}
              <ul className="space-y-3.5 flex-1 mb-8">
                {COMPARISON.map((row) => (
                  <li key={row.feature} className="flex items-start gap-3">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                      (row.pro && !row.free) || row.proLabel ? "bg-[#1D9E75]" : "bg-[#1D9E75]/15"
                    }`}>
                      <Check size={12} className={(row.pro && !row.free) || row.proLabel ? "text-white" : "text-[#1D9E75]"} />
                    </div>
                    <span className={`text-sm ${row.pro && !row.free ? "text-[#e5e2de] font-medium" : row.proLabel ? "text-[#e5e2de] font-medium" : "text-[#bccac1]"}`}>
                      {row.proLabel ? `${row.feature} (${row.proLabel})` : row.feature}
                    </span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <a
                href={WA_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-gradient-to-br from-[#68dbae] to-[#26a37a] text-[#002115] px-6 py-3.5 text-sm font-semibold text-center transition-all duration-300 hover:shadow-[0_0_40px_rgba(29,158,117,0.35)] hover:scale-[1.02] cursor-pointer block"
              >
                Empezar con Pro
              </a>

              {/* Payment methods */}
              <p className="text-center text-xs text-[#87948c] mt-4">
                Paga con Yape o tarjeta
              </p>
            </div>
          </div>
        </div>

        {/* Bottom note */}
        <div className="mt-12 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-[#1C1C19] px-5 py-2.5">
            <span className="text-sm text-[#87948c]">
              ¿Tu banco no está en la lista?
            </span>
            <a href="/contacto" className="text-sm font-medium text-[#68dbae] hover:text-[#1D9E75] transition-colors cursor-pointer">
              Escríbenos
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
