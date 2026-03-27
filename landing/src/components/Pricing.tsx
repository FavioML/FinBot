"use client";

import { useState } from "react";
import { Check, X, Crown } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";
const WA_PRO_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20activar%20Pro%20%E2%AD%90";

interface Feature {
  name: string;
  free: string | boolean;
  pro: string | boolean;
}

const FEATURES: Feature[] = [
  { name: "Lectura automática de gastos por correo", free: false, pro: "11 bancos + Yape + Plin" },
  { name: "Múltiples cuentas Gmail", free: false, pro: true },
  { name: "WhatsApp: registro de gastos", free: true, pro: true },
  { name: "Lectura de imágenes Yape/Plin", free: "5/mes", pro: "Ilimitada" },
  { name: "Dashboard web", free: "Mes actual", pro: "Historial completo" },
  { name: "Clasificación automática con IA", free: true, pro: true },
  { name: "Categorías fijas (11)", free: true, pro: true },
  { name: "Categorías personalizadas", free: false, pro: "Ilimitadas" },
  { name: "Presupuestos", free: "3", pro: "Ilimitados" },
  { name: "Metas de ahorro", free: "1", pro: "Ilimitadas" },
  { name: "Resumen semanal", free: "Básico", pro: "Completo con IA" },
  { name: "Resumen diario por WhatsApp", free: false, pro: true },
  { name: "Score financiero", free: "Número", pro: "Desglose + tendencia" },
  { name: "Reportes PDF descargables", free: false, pro: true },
  { name: "Calendario financiero", free: false, pro: true },
  { name: "Heatmap de gastos", free: false, pro: true },
  { name: "Consejo IA", free: "1/semana", pro: "Diario" },
  { name: "Export CSV/JSON + carga masiva", free: false, pro: true },
  { name: "Recordatorios diarios (8 pm)", free: false, pro: true },
  { name: "Multimoneda USD/PEN", free: true, pro: true },
  { name: "Referidos (3 Pro activos = 1 mes gratis)", free: true, pro: true },
];

function FeatureCell({ value }: { value: string | boolean }) {
  if (value === true)
    return (
      <div className="w-5 h-5 rounded-full bg-[#1D9E75]/15 flex items-center justify-center">
        <Check size={12} className="text-[#1D9E75]" />
      </div>
    );
  if (value === false)
    return (
      <div className="w-5 h-5 rounded-full bg-[#87948c]/10 flex items-center justify-center">
        <X size={12} className="text-[#87948c]/50" />
      </div>
    );
  return <span className="text-xs text-[#bccac1]">{value}</span>;
}

export default function Pricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="precios" className="py-28 relative overflow-hidden">
      <div className="absolute top-[10%] left-[50%] -translate-x-1/2 w-[800px] h-[600px] -z-10 rounded-full bg-[#1D9E75]/[0.04] blur-[150px]" />

      <div className="mx-auto max-w-[900px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full bg-[#1D9E75]/10 px-5 py-2 text-xs font-medium text-[#68dbae] mb-6 tracking-wide">
            Precios
          </span>
          <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight mb-5">
            <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
              Empieza gratis. Crece con Pro.
            </span>
          </h2>
          <p className="text-[#87948c] max-w-[520px] mx-auto text-lg leading-relaxed">
            Registra tus gastos sin costo. Activa Pro cuando quieras lectura automática de correos y todo ilimitado.
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

        {/* Two pricing cards */}
        <div className="grid min-[860px]:grid-cols-2 gap-6 mb-12">
          {/* FREE Card */}
          <div className="relative rounded-[24px] overflow-hidden">
            <div className="absolute inset-0 rounded-[24px] bg-gradient-to-br from-[#87948c]/20 via-[#87948c]/10 to-[#87948c]/5" />
            <div className="absolute inset-[1px] rounded-[23px] bg-[#131311]" />

            <div className="relative p-8 flex flex-col h-full">
              <h3 className="text-xl font-bold text-[#e5e2de] mb-4">Free</h3>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-5xl font-extrabold text-[#e5e2de] tracking-tight">S/0</span>
              </div>
              <p className="text-sm text-[#87948c] mb-8">Para siempre</p>

              <a
                href={WA_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-[#87948c]/30 text-[#e5e2de] px-6 py-3.5 text-sm font-semibold text-center transition-all duration-300 hover:border-[#87948c]/60 cursor-pointer block mt-auto"
              >
                Empezar gratis
              </a>
            </div>
          </div>

          {/* PRO Card */}
          <div className="relative rounded-[24px] overflow-hidden">
            <div className="absolute inset-0 rounded-[24px] bg-gradient-to-br from-[#68dbae]/30 via-[#1D9E75]/20 to-[#0F6E56]/30" />
            <div className="absolute inset-[1px] rounded-[23px] bg-[#131311]" />
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-24 bg-[#1D9E75]/20 blur-[60px] -z-0" />

            <div className="relative p-8 flex flex-col h-full">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <Crown size={20} className="text-[#68dbae]" />
                  <h3 className="text-xl font-bold text-[#e5e2de]">Pro</h3>
                </div>
                <span className="rounded-full bg-[#EF9F27] px-3 py-1 text-xs font-bold text-[#0E0E0C]">
                  PRECIO FUNDADOR
                </span>
              </div>
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

              <a
                href={WA_PRO_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-gradient-to-br from-[#68dbae] to-[#26a37a] text-[#002115] px-6 py-3.5 text-sm font-semibold text-center transition-all duration-300 hover:shadow-[0_0_40px_rgba(29,158,117,0.35)] hover:scale-[1.02] cursor-pointer block mt-auto"
              >
                Activar Pro
              </a>
              <p className="text-center text-xs text-[#87948c] mt-4">
                Paga con Yape · Setup en 5 min
              </p>
            </div>
          </div>
        </div>

        {/* Feature comparison table */}
        <div className="rounded-[20px] border border-white/5 bg-[#131311] overflow-hidden">
          <div className="grid grid-cols-[1fr_80px_80px] min-[860px]:grid-cols-[1fr_120px_120px] items-center px-6 py-4 border-b border-white/5">
            <span className="text-xs font-medium text-[#87948c] uppercase tracking-wider">Función</span>
            <span className="text-xs font-medium text-[#87948c] uppercase tracking-wider text-center">Free</span>
            <span className="text-xs font-medium text-[#68dbae] uppercase tracking-wider text-center">Pro</span>
          </div>
          {FEATURES.map((f) => (
            <div
              key={f.name}
              className="grid grid-cols-[1fr_80px_80px] min-[860px]:grid-cols-[1fr_120px_120px] items-center px-6 py-3 border-b border-white/[0.03] last:border-0"
            >
              <span className="text-sm text-[#bccac1]">{f.name}</span>
              <div className="flex justify-center">
                <FeatureCell value={f.free} />
              </div>
              <div className="flex justify-center">
                <FeatureCell value={f.pro} />
              </div>
            </div>
          ))}
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
