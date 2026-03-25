"use client";

import { ArrowRight, Sparkles } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const STATS = [
  { label: "Bancos soportados", value: "11", accent: false },
  { label: "Setup completo", value: "2 min", accent: true },
  { label: "Para empezar", value: "S/0", accent: false },
];

export default function Hero() {
  return (
    <section className="relative min-h-[100svh] flex flex-col items-center justify-center overflow-hidden">
      {/* ── Animated background layers ── */}
      {/* Grid pattern */}
      <div
        className="absolute inset-0 -z-20 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #68dbae 1px, transparent 1px), linear-gradient(to bottom, #68dbae 1px, transparent 1px)",
          backgroundSize: "4rem 4rem",
          maskImage: "radial-gradient(ellipse 70% 50% at 50% 40%, black 40%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 50% at 50% 40%, black 40%, transparent 100%)",
        }}
      />

      {/* Radial glow — green */}
      <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[800px] h-[600px] -z-10 rounded-full bg-[#1D9E75]/[0.08] blur-[120px]" />

      {/* Radial glow — amber subtle */}
      <div className="absolute bottom-[-10%] right-[10%] w-[400px] h-[400px] -z-10 rounded-full bg-[#EF9F27]/[0.05] blur-[100px]" />

      {/* ── Content ── */}
      <div className="relative mx-auto max-w-[1200px] px-6 pt-32 pb-20 w-full text-center">
        {/* Eyebrow badge */}
        <div className="animate-fade-up inline-flex items-center gap-2 rounded-full bg-[#1C1C19] px-5 py-2 mb-8">
          <Sparkles size={14} className="text-[#EF9F27]" />
          <span className="text-sm text-[#bccac1] tracking-wide">
            WhatsApp + Dashboard interactivo
          </span>
        </div>

        {/* Headline */}
        <h1
          className="animate-fade-up text-5xl min-[860px]:text-7xl min-[1100px]:text-[5.5rem] font-extrabold leading-[1.05] tracking-tight mb-8"
          style={{ animationDelay: "100ms" }}
        >
          <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
            Ordena tu plata
          </span>
          <br />
          <span className="bg-gradient-to-r from-[#68dbae] via-[#1D9E75] to-[#26a37a] bg-clip-text text-transparent">
            sin mover un dedo
          </span>
        </h1>

        {/* Subtitle */}
        <p
          className="animate-fade-up mx-auto max-w-[600px] text-lg min-[860px]:text-xl text-[#87948c] leading-relaxed mb-12"
          style={{ animationDelay: "200ms" }}
        >
          Neto lee tus correos de 11 bancos peruanos, te resume todo por
          WhatsApp y te da un dashboard completo. Sin contraseñas bancarias. Solo resultados.
        </p>

        {/* CTA buttons */}
        <div
          className="animate-fade-up flex flex-col min-[480px]:flex-row items-center justify-center gap-4 mb-20"
          style={{ animationDelay: "300ms" }}
        >
          <a
            href={WA_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-[#68dbae] to-[#26a37a] px-8 py-4 text-base font-semibold text-[#002115] transition-all duration-300 hover:shadow-[0_0_40px_rgba(29,158,117,0.35)] hover:scale-[1.02] cursor-pointer"
          >
            Empezar gratis
            <ArrowRight size={18} className="transition-transform duration-300 group-hover:translate-x-1" />
          </a>
          <a
            href="https://app.neto.pe"
            className="inline-flex items-center gap-2 rounded-full border border-[#3D4943]/30 bg-[#1C1C19]/60 backdrop-blur-sm px-8 py-4 text-base font-medium text-[#bccac1] transition-all duration-300 hover:bg-[#20201d] hover:text-[#e5e2de] hover:border-[#3D4943]/50 cursor-pointer"
          >
            Ver dashboard
          </a>
        </div>

        {/* ── Floating dashboard mockup ── */}
        <div
          className="animate-fade-up relative mx-auto max-w-[900px]"
          style={{ animationDelay: "450ms" }}
        >
          {/* Glass container */}
          <div className="relative rounded-[28px] bg-[#131311]/80 backdrop-blur-xl p-1.5 shadow-[0_32px_80px_rgba(0,0,0,0.5)]">
            {/* Inner content */}
            <div className="rounded-[22px] bg-[#131311] p-6 min-[860px]:p-8">
              {/* Top bar */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-[#D85A30]/60" />
                  <div className="w-3 h-3 rounded-full bg-[#EF9F27]/60" />
                  <div className="w-3 h-3 rounded-full bg-[#1D9E75]/60" />
                </div>
                <span className="text-xs text-[#87948c]">app.neto.pe — Dashboard</span>
              </div>

              {/* Bento dashboard */}
              <div className="grid grid-cols-2 min-[860px]:grid-cols-4 gap-3">
                {/* Large card — weekly spend */}
                <div className="col-span-2 rounded-[20px] bg-[#1C1C19] p-6 transition-all duration-300 hover:bg-[#20201d]">
                  <p className="text-xs text-[#87948c] mb-1">Esta semana gastaste</p>
                  <p className="text-3xl min-[860px]:text-4xl font-bold text-[#EF9F27] tracking-tight mb-3">
                    S/847
                  </p>
                  <div className="h-2 rounded-full bg-[#2A2A28] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[#EF9F27] to-[#EF9F27]/60"
                      style={{ width: "68%" }}
                    />
                  </div>
                  <div className="flex justify-between mt-2">
                    <span className="text-xs text-[#87948c]">68% del presupuesto</span>
                    <span className="text-xs text-[#68dbae]">S/1,250 meta</span>
                  </div>
                </div>

                {/* Mini stat cards */}
                <div className="rounded-[20px] bg-[#1C1C19] p-5 transition-all duration-300 hover:bg-[#20201d]">
                  <p className="text-xs text-[#87948c] mb-1">Score financiero</p>
                  <p className="text-2xl font-bold text-[#68dbae]">84</p>
                  <p className="text-xs text-[#1D9E75]">+6 pts</p>
                </div>
                <div className="rounded-[20px] bg-[#1C1C19] p-5 transition-all duration-300 hover:bg-[#20201d]">
                  <p className="text-xs text-[#87948c] mb-1">Ahorro mes</p>
                  <p className="text-2xl font-bold text-[#68dbae]">S/340</p>
                  <p className="text-xs text-[#1D9E75]">+12% vs ago</p>
                </div>

                {/* Category breakdown */}
                <div className="col-span-2 min-[860px]:col-span-2 rounded-[20px] bg-[#1C1C19] p-5 transition-all duration-300 hover:bg-[#20201d]">
                  <p className="text-xs text-[#87948c] mb-3">Top categorías</p>
                  <div className="space-y-2">
                    {[
                      { cat: "Comida", pct: 35, color: "bg-[#EF9F27]" },
                      { cat: "Transporte", pct: 22, color: "bg-[#378ADD]" },
                      { cat: "Entretenimiento", pct: 18, color: "bg-[#68dbae]" },
                    ].map((item) => (
                      <div key={item.cat} className="flex items-center gap-3">
                        <span className="text-xs text-[#bccac1] w-28">{item.cat}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-[#2A2A28] overflow-hidden">
                          <div
                            className={`h-full rounded-full ${item.color}`}
                            style={{ width: `${item.pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-[#87948c] w-8 text-right">{item.pct}%</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* WhatsApp preview */}
                <div className="col-span-2 rounded-[20px] bg-[#1C1C19] p-5 transition-all duration-300 hover:bg-[#20201d]">
                  <p className="text-xs text-[#87948c] mb-3">Último mensaje de Neto</p>
                  <div className="rounded-[16px] bg-[#20201d] p-4">
                    <p className="text-sm text-[#e5e2de] leading-relaxed">
                      &quot;Hoy gastaste <span className="text-[#EF9F27] font-semibold">S/45</span> en Rappi.
                      Llevas <span className="text-[#68dbae] font-semibold">S/847</span> esta semana.
                      Te quedan <span className="font-semibold">S/403</span>{" "}de tu presupuesto.&quot;
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom glow */}
          <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-[70%] h-16 bg-[#1D9E75]/10 blur-[40px] rounded-full" />
        </div>

        {/* ── Social proof stats ── */}
        <div
          className="animate-fade-up mt-20 flex flex-col min-[640px]:flex-row items-center justify-center gap-8 min-[640px]:gap-16"
          style={{ animationDelay: "550ms" }}
        >
          {STATS.map((stat) => (
            <div key={stat.label} className="text-center">
              <p className={`text-2xl min-[860px]:text-3xl font-bold tracking-tight ${stat.accent ? "text-[#68dbae]" : "text-[#e5e2de]"}`}>
                {stat.value}
              </p>
              <p className="text-sm text-[#87948c] mt-1">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Bank logos removed — BankStrip component handles this */}
      </div>
    </section>
  );
}
