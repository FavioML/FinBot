"use client";

import {
  Shield,
  LayoutDashboard,
  Brain,
  Target,
  CalendarDays,
  FileText,
  MessageSquare,
  RefreshCw,
  ArrowRight,
} from "lucide-react";
import type { ReactNode } from "react";

interface Feature {
  Icon: typeof Shield;
  title: string;
  desc: string;
  visual: ReactNode;
  accent: string;
  glow: string;
}

const FEATURES: Feature[] = [
  {
    Icon: Shield,
    title: "Sin contraseña bancaria",
    desc: "Solo leemos los correos de notificación que tu banco ya te envía. Nunca accedemos a tu banca directa. 11 bancos peruanos soportados.",
    accent: "text-[#EF9F27]",
    glow: "bg-[#EF9F27]/10",
    visual: (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 rounded-xl bg-[#20201d] px-4 py-3">
          <div className="w-8 h-8 rounded-lg bg-[#EF9F27]/20 flex items-center justify-center">
            <Shield size={16} className="text-[#EF9F27]" />
          </div>
          <div className="flex-1">
            <div className="h-2 w-24 rounded bg-[#2A2A28]" />
            <div className="h-1.5 w-16 rounded bg-[#2A2A28] mt-1.5" />
          </div>
          <div className="w-5 h-5 rounded-full bg-[#1D9E75] flex items-center justify-center">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5L4.5 7.5L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-[#20201d] px-4 py-3">
          <div className="w-8 h-8 rounded-lg bg-[#D85A30]/20 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3V13M3 8H13" stroke="#D85A30" strokeWidth="1.5" strokeLinecap="round" transform="rotate(45 8 8)"/></svg>
          </div>
          <div className="flex-1">
            <div className="h-2 w-20 rounded bg-[#2A2A28]" />
            <div className="h-1.5 w-12 rounded bg-[#2A2A28] mt-1.5" />
          </div>
          <div className="w-5 h-5 rounded-full bg-[#D85A30]/20 flex items-center justify-center">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 3L7 7M7 3L3 7" stroke="#D85A30" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </div>
        </div>
      </div>
    ),
  },
  {
    Icon: LayoutDashboard,
    title: "Dashboard interactivo",
    desc: "Graficos, KPIs, calendario financiero, top comercios y metodos de pago. Todo en app.neto.pe con un clic.",
    accent: "text-[#68dbae]",
    glow: "bg-[#1D9E75]/10",
    visual: (
      <div className="grid grid-cols-3 gap-1.5">
        <div className="col-span-2 rounded-lg bg-[#20201d] p-2">
          <div className="h-1.5 w-12 rounded bg-[#2A2A28] mb-2" />
          <div className="flex items-end gap-1 h-8">
            {[40, 65, 45, 80, 55, 70].map((h, i) => (
              <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: i === 3 ? '#1D9E75' : '#2A2A28' }} />
            ))}
          </div>
        </div>
        <div className="rounded-lg bg-[#20201d] p-2 flex flex-col items-center justify-center">
          <span className="text-[10px] text-[#68dbae] font-bold">84</span>
          <span className="text-[7px] text-[#87948c]">score</span>
        </div>
        <div className="rounded-lg bg-[#20201d] p-2">
          <div className="h-1 w-8 rounded bg-[#EF9F27]/40 mb-1" />
          <div className="h-1 w-6 rounded bg-[#378ADD]/40" />
        </div>
        <div className="col-span-2 rounded-lg bg-[#20201d] p-2">
          <div className="grid grid-cols-7 gap-px">
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className="w-2 h-2 rounded-sm" style={{ background: [3,5,8,10,12].includes(i) ? '#1D9E75' : '#2A2A28' }} />
            ))}
          </div>
        </div>
      </div>
    ),
  },
  {
    Icon: Brain,
    title: "IA que aprende de ti",
    desc: "Cada gasto se clasifica automaticamente. Si Neto se equivoca, corrigelo y aprende para la proxima.",
    accent: "text-[#68dbae]",
    glow: "bg-[#1D9E75]/10",
    visual: (
      <div className="space-y-2">
        {[
          { label: "Comida", pct: 82, color: "bg-[#EF9F27]" },
          { label: "Transport", pct: 94, color: "bg-[#378ADD]" },
          { label: "Entret.", pct: 76, color: "bg-[#68dbae]" },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <span className="text-[10px] text-[#87948c] w-14 text-right">{item.label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-[#2A2A28] overflow-hidden">
              <div className={`h-full rounded-full ${item.color}`} style={{ width: `${item.pct}%` }} />
            </div>
            <span className="text-[10px] text-[#68dbae] w-8">{item.pct}%</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    Icon: Target,
    title: "Metas de ahorro",
    desc: "Define cuanto quieres ahorrar y Neto te muestra tu progreso. Visualiza cada meta con barras interactivas.",
    accent: "text-[#68dbae]",
    glow: "bg-[#1D9E75]/10",
    visual: (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#bccac1]">Viaje</span>
          <div className="flex-1 h-2 rounded-full bg-[#2A2A28] overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-[#1D9E75] to-[#68dbae]" style={{ width: '72%' }} />
          </div>
          <span className="text-[10px] text-[#68dbae]">72%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#bccac1]">Fondo</span>
          <div className="flex-1 h-2 rounded-full bg-[#2A2A28] overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-[#EF9F27] to-[#EF9F27]/60" style={{ width: '45%' }} />
          </div>
          <span className="text-[10px] text-[#EF9F27]">45%</span>
        </div>
      </div>
    ),
  },
  {
    Icon: CalendarDays,
    title: "Calendario financiero",
    desc: "Ve tus gastos dia por dia en un calendario visual. Detecta patrones y dias de mayor gasto de un vistazo.",
    accent: "text-[#68dbae]",
    glow: "bg-[#1D9E75]/10",
    visual: (
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 21 }).map((_, i) => {
          const intensities = [0, 1, 0, 2, 0, 3, 0, 1, 2, 0, 0, 1, 3, 0, 2, 1, 0, 0, 2, 1, 0];
          const colors = ['bg-[#2A2A28]', 'bg-[#1D9E75]/30', 'bg-[#1D9E75]/60', 'bg-[#1D9E75]'];
          return <div key={i} className={`w-3 h-3 rounded-sm ${colors[intensities[i]]}`} />;
        })}
      </div>
    ),
  },
  {
    Icon: FileText,
    title: "Reportes PDF",
    desc: "Descarga tu reporte mensual completo con graficos, score financiero y analisis de categorias.",
    accent: "text-[#68dbae]",
    glow: "bg-[#1D9E75]/10",
    visual: (
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-[#20201d] p-3 flex-1">
          <div className="h-1.5 w-16 rounded bg-[#2A2A28] mb-2" />
          <div className="h-1 w-12 rounded bg-[#2A2A28] mb-1" />
          <div className="h-1 w-14 rounded bg-[#2A2A28]" />
        </div>
        <div className="w-8 h-8 rounded-lg bg-[#D85A30]/20 flex items-center justify-center">
          <FileText size={14} className="text-[#D85A30]" />
        </div>
      </div>
    ),
  },
  {
    Icon: RefreshCw,
    title: "Suscripciones y recurrentes",
    desc: "Detecta automaticamente Netflix, Spotify, PedidosYa y 50+ servicios. Ve cuanto pagas cada mes sin darte cuenta.",
    accent: "text-[#EF9F27]",
    glow: "bg-[#EF9F27]/10",
    visual: (
      <div className="space-y-1.5">
        {[
          { name: "Netflix", amount: "S/45" },
          { name: "Spotify", amount: "S/18" },
          { name: "iCloud", amount: "S/4" },
        ].map((s) => (
          <div key={s.name} className="flex items-center justify-between rounded-lg bg-[#20201d] px-3 py-1.5">
            <span className="text-[10px] text-[#bccac1]">{s.name}</span>
            <span className="text-[10px] text-[#EF9F27] font-medium">{s.amount}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    Icon: MessageSquare,
    title: "Consultas naturales",
    desc: "Preguntale a Neto como le hablarias a un amigo: \"cuanto gaste en delivery?\" y te responde al instante.",
    accent: "text-[#68dbae]",
    glow: "bg-[#1D9E75]/10",
    visual: (
      <div className="space-y-2">
        <div className="rounded-xl bg-[#20201d] px-3 py-2 max-w-[80%]">
          <p className="text-[11px] text-[#bccac1]">&quot;cuanto gaste en comida?&quot;</p>
        </div>
        <div className="rounded-xl bg-[#1D9E75]/20 px-3 py-2 max-w-[85%] ml-auto">
          <p className="text-[11px] text-[#68dbae]">S/342 en las ultimas 2 semanas</p>
        </div>
      </div>
    ),
  },
];

function FeatureCard({ feature, size }: { feature: Feature; size: "large" | "small" }) {
  const { Icon, title, desc, visual, accent, glow } = feature;
  const isLarge = size === "large";

  return (
    <div className="group relative rounded-[24px] bg-[#1C1C19] overflow-hidden transition-all duration-300 cursor-default hover:bg-[#20201d]"
         style={{ transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)" }}>
      {/* Shine effect on hover */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
           style={{
             background: "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.03) 45%, rgba(255,255,255,0.05) 50%, rgba(255,255,255,0.03) 55%, transparent 60%)",
           }} />

      {/* Inner shadow effect */}
      <div className="absolute inset-0 rounded-[24px] pointer-events-none"
           style={{ boxShadow: "0 -20px 80px -20px rgba(255,255,255,0.03) inset" }} />

      <div className={`relative ${isLarge ? "p-8" : "p-6"} h-full flex flex-col`}>
        {/* Visual element — slides up on group hover */}
        <div className={`${isLarge ? "mb-6 h-24" : "mb-4 h-16"} transition-transform duration-300 group-hover:-translate-y-2`}>
          {visual}
        </div>

        {/* Icon + title */}
        <div className="flex items-center gap-3 mb-3">
          <div className={`inline-flex items-center justify-center w-9 h-9 rounded-xl ${glow}`}>
            <Icon size={18} className={accent} />
          </div>
          <h3 className={`${isLarge ? "text-lg" : "text-base"} font-bold text-[#e5e2de]`}>
            {title}
          </h3>
        </div>

        {/* Description */}
        <p className="text-sm text-[#87948c] leading-relaxed flex-1">{desc}</p>

        {/* CTA that appears on hover */}
        <div className="flex items-center gap-1.5 mt-4 text-sm font-medium text-[#68dbae] opacity-0 translate-y-3 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300">
          Conocer mas
          <ArrowRight size={14} className="transition-transform duration-300 group-hover:translate-x-1" />
        </div>
      </div>
    </div>
  );
}

export default function Features() {
  return (
    <section className="py-28 relative overflow-hidden">
      {/* Background radial glow */}
      <div className="absolute top-[20%] left-[10%] w-[500px] h-[500px] -z-10 rounded-full bg-[#1D9E75]/[0.04] blur-[120px]" />
      <div className="absolute bottom-[10%] right-[5%] w-[400px] h-[400px] -z-10 rounded-full bg-[#EF9F27]/[0.03] blur-[100px]" />

      <div className="mx-auto max-w-[1200px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full bg-[#1D9E75]/10 px-5 py-2 text-xs font-medium text-[#68dbae] mb-6 tracking-wide">
            Por que Neto
          </span>
          <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight mb-5">
            <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
              Todo lo que necesitas.
            </span>
            <br />
            <span className="bg-gradient-to-r from-[#68dbae] to-[#1D9E75] bg-clip-text text-transparent">
              Nada que no.
            </span>
          </h2>
          <p className="text-[#87948c] max-w-[520px] mx-auto text-lg leading-relaxed">
            WhatsApp + dashboard web. Sin contraseñas bancarias. Solo resultados.
          </p>
        </div>

        {/* Bento grid — asymmetric layout */}
        <div className="grid grid-cols-1 min-[640px]:grid-cols-2 min-[1024px]:grid-cols-3 gap-4">
          {/* Row 1: Large (security) + Small (dashboard) */}
          <div className="min-[1024px]:col-span-2">
            <FeatureCard feature={FEATURES[0]} size="large" />
          </div>
          <div>
            <FeatureCard feature={FEATURES[1]} size="small" />
          </div>

          {/* Row 2: IA + Metas + Calendario */}
          <div>
            <FeatureCard feature={FEATURES[2]} size="small" />
          </div>
          <div>
            <FeatureCard feature={FEATURES[3]} size="small" />
          </div>
          <div>
            <FeatureCard feature={FEATURES[4]} size="small" />
          </div>

          {/* Row 3: PDF + Suscripciones + Consultas */}
          <div>
            <FeatureCard feature={FEATURES[5]} size="small" />
          </div>
          <div>
            <FeatureCard feature={FEATURES[6]} size="small" />
          </div>
          <div>
            <FeatureCard feature={FEATURES[7]} size="small" />
          </div>
        </div>
      </div>
    </section>
  );
}
