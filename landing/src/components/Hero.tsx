"use client";

import { ArrowRight } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const BANK_CHIPS = [
  "BCP · BBVA · Interbank · Scotia",
  "Yape · Plin",
  "Sin contraseña bancaria",
];

const MINI_CARDS = [
  { label: "Mayor gasto", value: "S/210", color: "text-neto-txt" },
  { label: "Score salud", value: "72/100", color: "text-neto-green" },
  { label: "Ahorro mes", value: "S/340", color: "text-neto-green" },
  { label: "Reporte", value: "Listo", color: "text-neto-amber" },
];

export default function Hero() {
  return (
    <section className="relative min-h-[100svh] flex items-center pt-20 pb-16">
      <div className="mx-auto max-w-[1200px] px-6 w-full grid grid-cols-1 min-[860px]:grid-cols-[1.1fr_1fr] gap-12 items-center">
        {/* Left column */}
        <div className="animate-fade-up">
          {/* Eyebrow */}
          <div className="flex items-center gap-2 mb-6">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full bg-neto-green opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-neto-green" />
            </span>
            <span className="text-sm text-neto-txt3 tracking-wide">
              Asistente financiero · WhatsApp
            </span>
          </div>

          {/* Heading */}
          <h1 className="text-4xl min-[860px]:text-[3.5rem] font-bold leading-[1.1] tracking-tight mb-6">
            Ordena tu{" "}
            <span className="text-neto-green">plata</span>
            <br />
            sin mover un dedo
          </h1>

          {/* Subtitle */}
          <p className="text-lg text-neto-txt2 max-w-[480px] mb-8 leading-relaxed">
            Neto lee tus correos del banco, Yape y Plin automáticamente y te
            manda un resumen directo a WhatsApp. Sin apps. Sin contraseñas
            bancarias.
          </p>

          {/* Bank chips */}
          <div className="flex flex-wrap gap-2 mb-8">
            {BANK_CHIPS.map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-white/10 bg-neto-bg2 px-4 py-1.5 text-xs text-neto-txt3"
              >
                {chip}
              </span>
            ))}
          </div>

          {/* CTA */}
          <a
            href={WA_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full bg-neto-green px-7 py-3.5 text-base font-semibold text-white hover:bg-neto-green-dark transition-colors duration-200 cursor-pointer"
          >
            Empezar gratis
            <ArrowRight size={18} />
          </a>
        </div>

        {/* Right column — Dashboard mockup */}
        <div className="hidden min-[860px]:block animate-fade-up" style={{ animationDelay: "0.15s" }}>
          <div className="space-y-4">
            {/* Main stat card */}
            <div className="rounded-[20px] bg-neto-bg2 border border-white/5 p-6">
              <p className="text-sm text-neto-txt3 mb-1">Esta semana gastaste</p>
              <p className="text-4xl font-bold text-neto-amber tracking-tight">
                S/847
              </p>
              <div className="mt-4 h-1 rounded-full bg-neto-bg4 overflow-hidden">
                <div
                  className="h-full rounded-full bg-neto-amber"
                  style={{ width: "68%" }}
                />
              </div>
            </div>

            {/* Mini grid */}
            <div className="grid grid-cols-2 gap-4">
              {MINI_CARDS.map((card) => (
                <div
                  key={card.label}
                  className="rounded-[20px] bg-neto-bg2 border border-white/5 p-5"
                >
                  <p className="text-xs text-neto-txt3 mb-1">{card.label}</p>
                  <p className={`text-xl font-bold ${card.color}`}>
                    {card.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
