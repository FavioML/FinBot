"use client";

import { useState } from "react";
import { Check, Crown } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const FEATURES = [
  "WhatsApp: registro, gastos y consultas",
  "Lectura automática de correos bancarios",
  "Clasificación automática con IA",
  "Categorías personalizables",
  "Presupuestos ilimitados",
  "Dashboard web interactivo con historial completo",
  "Resumen semanal con IA (insights + comparativa)",
  "Resumen mensual",
  "Lectura de imágenes Yape/Plin ilimitada",
  "Score financiero con desglose + tendencia",
  "Suscripciones detectadas + alertas",
  "Metas de ahorro ilimitadas",
  "Consejo IA personalizado diario",
  "Resumen diario por WhatsApp",
  "Reportes PDF descargables",
  "Calendario financiero",
  "Export CSV/JSON + carga masiva",
  "Recordatorios diarios (8 pm)",
];

export default function Pricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="precios" className="py-28 relative overflow-hidden">
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
            Todo incluido. Sin funciones bloqueadas.
          </p>

          {/* Toggle mensual/anual */}
          <div className="mt-8 inline-flex items-center gap-3 rounded-full bg-[#1C1C19] p-1.5">
            <button
              onClick={() => setAnnual(false)}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-all duration-200 cursor-pointer ${
                !annual ? "bg-[#1D9E75] text-white" : "text-[#87948c] hover:text-[#bccac1]"
              }`}
            >
              Mensual
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-all duration-200 cursor-pointer ${
                annual ? "bg-[#1D9E75] text-white" : "text-[#87948c] hover:text-[#bccac1]"
              }`}
            >
              Anual
              <span className="ml-1.5 text-xs text-[#68dbae]">-17%</span>
            </button>
          </div>
        </div>

        {/* Single pricing card */}
        <div className="max-w-[500px] mx-auto">
          <div className="group relative rounded-[24px] overflow-hidden transition-all duration-300 cursor-default">
            <div className="absolute inset-0 rounded-[24px] bg-gradient-to-br from-[#68dbae]/30 via-[#1D9E75]/20 to-[#0F6E56]/30" />
            <div className="absolute inset-[1px] rounded-[23px] bg-[#131311]" />
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-24 bg-[#1D9E75]/20 blur-[60px] -z-0" />

            <div className="relative p-8 flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#1D9E75]/20 flex items-center justify-center">
                    <Crown size={20} className="text-[#68dbae]" />
                  </div>
                  <h3 className="text-xl font-bold text-[#e5e2de]">Neto Pro</h3>
                </div>
                <span className="rounded-full bg-[#EF9F27] px-3 py-1 text-xs font-bold text-[#0E0E0C]">
                  PRECIO FUNDADOR
                </span>
              </div>

              {/* Price */}
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-5xl font-extrabold text-[#e5e2de] tracking-tight">
                  {annual ? "S/99" : "S/10"}
                </span>
                <span className="text-sm text-[#87948c]">
                  {annual ? "/año" : "/mes"}
                </span>
              </div>
              <p className="text-sm text-[#87948c] mb-8">
                {annual
                  ? "Equivale a S/8.25/mes — 2 meses gratis"
                  : "Cancela cuando quieras"}
              </p>

              {/* Features */}
              <ul className="space-y-3 mb-8">
                {FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-[#1D9E75]/15 flex items-center justify-center shrink-0 mt-0.5">
                      <Check size={12} className="text-[#1D9E75]" />
                    </div>
                    <span className="text-sm text-[#bccac1]">{f}</span>
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
                Empezar ahora
              </a>

              <p className="text-center text-xs text-[#87948c] mt-4">
                Paga con Yape · Setup en 5 min
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
