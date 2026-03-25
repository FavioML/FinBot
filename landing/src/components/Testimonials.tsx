"use client";

import { Star, Quote } from "lucide-react";

const TESTIMONIALS = [
  {
    quote:
      "Antes gastaba sin darme cuenta. Ahora Neto me avisa al instante y sé exactamente a dónde va mi plata. Lo mejor: no tuve que instalar nada.",
    name: "Carlos M.",
    role: "Analista financiero",
    location: "Lima",
    initials: "CM",
    metric: "S/2,400",
    metricLabel: "ahorrados en 3 meses",
  },
  {
    quote:
      "Como freelancer mis ingresos varían mucho. Neto me ayuda a ver patrones que yo sola no veía. El resumen semanal es oro puro.",
    name: "Valeria R.",
    role: "Diseñadora independiente",
    location: "Arequipa",
    initials: "VR",
    metric: "+32%",
    metricLabel: "mejor control de gastos",
  },
  {
    quote:
      "Lo conecté en 2 minutos y ya no necesito revisar los correos del banco. Neto me dice todo por WhatsApp. Simple y directo.",
    name: "Diego P.",
    role: "Emprendedor",
    location: "Lima",
    initials: "DP",
    metric: "2 min",
    metricLabel: "de setup inicial",
  },
  {
    quote:
      "Mis gastos hormiga eran un problema serio. Desde que uso Neto bajé mi gasto diario en delivery un 40%. La data no miente.",
    name: "Lucía F.",
    role: "Contadora",
    location: "Trujillo",
    initials: "LF",
    metric: "-40%",
    metricLabel: "en gastos hormiga",
  },
];

function StarRow() {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} size={14} className="fill-[#EF9F27] text-[#EF9F27]" />
      ))}
    </div>
  );
}

export default function Testimonials() {
  return (
    <section className="py-28 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute top-[30%] right-[10%] w-[500px] h-[500px] -z-10 rounded-full bg-[#1D9E75]/[0.04] blur-[120px]" />

      <div className="mx-auto max-w-[1200px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full bg-[#1D9E75]/10 px-5 py-2 text-xs font-medium text-[#68dbae] mb-6 tracking-wide">
            Testimonios
          </span>
          <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight mb-5">
            <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
              Historias reales.
            </span>
            <br />
            <span className="bg-gradient-to-r from-[#68dbae] to-[#1D9E75] bg-clip-text text-transparent">
              Resultados reales.
            </span>
          </h2>
        </div>

        {/* Bento testimonial grid */}
        <div className="grid grid-cols-1 min-[860px]:grid-cols-12 gap-4">
          {/* Featured card — Carlos */}
          <div className="min-[860px]:col-span-7 group relative rounded-[24px] bg-[#1C1C19] overflow-hidden transition-all duration-300 hover:bg-[#20201d] cursor-default"
               style={{ transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)" }}>
            {/* Gradient accent top */}
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#1D9E75] to-transparent opacity-40" />

            <div className="p-8 min-[860px]:p-10 flex flex-col h-full">
              <div className="flex items-center justify-between mb-6">
                <StarRow />
                <Quote size={32} className="text-[#1D9E75]/20" />
              </div>

              <blockquote className="text-xl min-[860px]:text-2xl font-medium text-[#e5e2de] leading-relaxed flex-1 mb-8">
                &ldquo;{TESTIMONIALS[0].quote}&rdquo;
              </blockquote>

              {/* Metric highlight */}
              <div className="rounded-2xl bg-[#20201d] p-5 mb-6">
                <p className="text-3xl font-bold text-[#68dbae] tracking-tight">
                  {TESTIMONIALS[0].metric}
                </p>
                <p className="text-sm text-[#87948c] mt-1">
                  {TESTIMONIALS[0].metricLabel}
                </p>
              </div>

              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#1D9E75] to-[#0F6E56] flex items-center justify-center text-white font-semibold">
                  {TESTIMONIALS[0].initials}
                </div>
                <div>
                  <p className="font-semibold text-[#e5e2de]">{TESTIMONIALS[0].name}</p>
                  <p className="text-sm text-[#87948c]">
                    {TESTIMONIALS[0].role} · {TESTIMONIALS[0].location}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Right column — stacked */}
          <div className="min-[860px]:col-span-5 flex flex-col gap-4">
            {/* Valeria */}
            <div className="group relative rounded-[24px] bg-[#1C1C19] overflow-hidden transition-all duration-300 hover:bg-[#20201d] cursor-default flex-1"
                 style={{ transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)" }}>
              <div className="p-7 flex flex-col h-full">
                <StarRow />
                <blockquote className="text-sm text-[#bccac1] leading-relaxed mt-4 flex-1">
                  &ldquo;{TESTIMONIALS[1].quote}&rdquo;
                </blockquote>
                <div className="flex items-center justify-between mt-5">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-[#1D9E75]/20 flex items-center justify-center text-[#68dbae] text-xs font-semibold">
                      {TESTIMONIALS[1].initials}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-[#e5e2de]">{TESTIMONIALS[1].name}</p>
                      <p className="text-xs text-[#87948c]">{TESTIMONIALS[1].role}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-[#68dbae]">{TESTIMONIALS[1].metric}</p>
                    <p className="text-[10px] text-[#87948c]">{TESTIMONIALS[1].metricLabel}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Diego */}
            <div className="group relative rounded-[24px] bg-[#1C1C19] overflow-hidden transition-all duration-300 hover:bg-[#20201d] cursor-default flex-1"
                 style={{ transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)" }}>
              <div className="p-7 flex flex-col h-full">
                <StarRow />
                <blockquote className="text-sm text-[#bccac1] leading-relaxed mt-4 flex-1">
                  &ldquo;{TESTIMONIALS[2].quote}&rdquo;
                </blockquote>
                <div className="flex items-center justify-between mt-5">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-[#1D9E75]/20 flex items-center justify-center text-[#68dbae] text-xs font-semibold">
                      {TESTIMONIALS[2].initials}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-[#e5e2de]">{TESTIMONIALS[2].name}</p>
                      <p className="text-xs text-[#87948c]">{TESTIMONIALS[2].role}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-[#68dbae]">{TESTIMONIALS[2].metric}</p>
                    <p className="text-[10px] text-[#87948c]">{TESTIMONIALS[2].metricLabel}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom row — Lucía (full width accent card) */}
          <div className="min-[860px]:col-span-12 group relative rounded-[24px] overflow-hidden transition-all duration-300 cursor-default"
               style={{
                 background: "linear-gradient(135deg, #1D9E75 0%, #0F6E56 100%)",
                 transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
               }}>
            <div className="p-7 min-[860px]:p-8 flex flex-col min-[860px]:flex-row min-[860px]:items-center gap-6">
              <div className="flex-1">
                <StarRow />
                <blockquote className="text-lg text-white/95 leading-relaxed mt-4">
                  &ldquo;{TESTIMONIALS[3].quote}&rdquo;
                </blockquote>
                <div className="flex items-center gap-3 mt-5">
                  <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-white text-sm font-semibold">
                    {TESTIMONIALS[3].initials}
                  </div>
                  <div>
                    <p className="font-semibold text-white">{TESTIMONIALS[3].name}</p>
                    <p className="text-sm text-white/70">
                      {TESTIMONIALS[3].role} · {TESTIMONIALS[3].location}
                    </p>
                  </div>
                </div>
              </div>
              <div className="min-[860px]:border-l min-[860px]:border-white/20 min-[860px]:pl-8 text-center min-[860px]:text-left">
                <p className="text-4xl font-bold text-white tracking-tight">
                  {TESTIMONIALS[3].metric}
                </p>
                <p className="text-sm text-white/70 mt-1">
                  {TESTIMONIALS[3].metricLabel}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Trust indicator */}
        <div className="mt-12 text-center">
          <p className="text-sm text-[#87948c]">
            Disponible en Perú. Empieza gratis hoy.
          </p>
        </div>
      </div>
    </section>
  );
}
