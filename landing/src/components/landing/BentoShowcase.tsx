"use client";
import { motion } from "framer-motion";
import { RefreshCw, FileText } from "lucide-react";
import { BentoCard } from "./BentoCard";
import BlurReveal from "@/components/shared/BlurReveal";

// ─── Card visuals ────────────────────────────────────────────────────────────

function DashboardVisual() {
  return (
    <div className="grid grid-cols-2 gap-2 h-full">
      <div className="rounded-[14px] bg-neto-bg2 p-3 col-span-2 flex items-start justify-between">
        <div>
          <p className="text-[10px] text-neto-txt3 mb-0.5">Esta semana</p>
          <p className="text-xl font-bold text-neto-amber">S/847</p>
        </div>
        <div className="flex items-end gap-0.5 h-10">
          {[40, 65, 45, 80, 55, 70, 90].map((h, i) => (
            <div
              key={i}
              className="w-2 rounded-t-sm"
              style={{
                height: `${h}%`,
                background: i === 6 ? "#1D9E75" : "#2A2A28",
              }}
            />
          ))}
        </div>
      </div>
      <div className="rounded-[14px] bg-neto-bg2 p-3">
        <p className="text-[10px] text-neto-txt3 mb-1">Score</p>
        <p className="text-lg font-bold text-neto-green-light">84</p>
      </div>
      <div className="rounded-[14px] bg-neto-bg2 p-3">
        <p className="text-[10px] text-neto-txt3 mb-1">Ahorro</p>
        <p className="text-lg font-bold text-neto-green-light">S/340</p>
      </div>
    </div>
  );
}

const EASE = [0.16, 1, 0.3, 1] as const;

function AIVisual() {
  const bars: { label: string; pct: number; color: string }[] = [
    { label: "Comida", pct: 82, color: "#EF9F27" },
    { label: "Transport", pct: 94, color: "#378ADD" },
    { label: "Entret.", pct: 76, color: "#68dbae" },
  ];

  return (
    <div className="flex flex-col justify-center gap-3 h-full">
      {bars.map(({ label, pct, color }) => (
        <div key={label} className="flex items-center gap-2">
          <span className="text-[10px] text-neto-txt3 w-16 shrink-0">
            {label}
          </span>
          <div className="flex-1 h-1.5 rounded-full bg-neto-bg5 overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{ backgroundColor: color }}
              initial={{ width: 0 }}
              whileInView={{ width: `${pct}%` }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.9, ease: EASE, delay: 0.1 }}
            />
          </div>
          <span className="text-[10px] text-neto-green-light w-8 text-right shrink-0">
            {pct}%
          </span>
        </div>
      ))}
    </div>
  );
}

function ChatVisual() {
  return (
    <div className="space-y-2">
      <div className="rounded-[12px] bg-neto-bg4 px-3 py-2 text-[11px] text-neto-txt2 max-w-[80%]">
        "¿cuánto gasté en comida?"
      </div>
      <div className="rounded-[12px] bg-neto-green/20 px-3 py-2 text-[11px] text-neto-green-light max-w-[80%] ml-auto">
        S/342 en las últimas 2 semanas
      </div>
    </div>
  );
}

function GoalsVisual() {
  const goals: { label: string; pct: number; color: string }[] = [
    { label: "Viaje", pct: 72, color: "#1D9E75" },
    { label: "Fondo", pct: 45, color: "#EF9F27" },
  ];

  return (
    <div className="flex flex-col justify-center gap-3 h-full">
      {goals.map(({ label, pct, color }) => (
        <div key={label} className="flex flex-col gap-1">
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-neto-txt3">{label}</span>
            <span className="text-[10px] font-medium" style={{ color }}>
              {pct}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-neto-bg5 overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{ backgroundColor: color }}
              initial={{ width: 0 }}
              whileInView={{ width: `${pct}%` }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.9, ease: EASE, delay: 0.15 }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function CalendarVisual() {
  const intensities = [
    0, 1, 0, 2, 0, 3, 0, 1, 2, 0, 0, 1, 3, 0, 2, 1, 0, 0, 2, 1, 0,
  ];
  const colors = [
    "bg-neto-bg5",
    "bg-neto-green/30",
    "bg-neto-green/60",
    "bg-neto-green",
  ];

  return (
    <div className="flex items-center h-full">
      <div className="grid grid-cols-7 gap-1.5">
        {intensities.map((v, i) => (
          <div key={i} className={`w-3 h-3 rounded-sm ${colors[v]}`} />
        ))}
      </div>
    </div>
  );
}

function SubscriptionsVisual() {
  const items: { name: string; amount: string }[] = [
    { name: "Netflix", amount: "S/45" },
    { name: "Spotify", amount: "S/18" },
    { name: "iCloud", amount: "S/4" },
  ];

  return (
    <div className="flex flex-col justify-center gap-2 h-full">
      {items.map(({ name, amount }) => (
        <div
          key={name}
          className="flex justify-between items-center rounded-[10px] bg-neto-bg2 px-3 py-2"
        >
          <span className="text-[11px] text-neto-txt2">{name}</span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-neto-amber font-medium">
              {amount}
            </span>
            <RefreshCw size={10} className="text-neto-txt3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function PdfVisual() {
  return (
    <div className="flex items-center gap-3 h-full">
      <div className="w-10 h-12 rounded-[8px] bg-neto-red/20 flex items-center justify-center shrink-0">
        <FileText size={18} className="text-neto-red" />
      </div>
      <div>
        <div className="h-1.5 w-16 rounded bg-neto-bg5 mb-1.5" />
        <div className="h-1.5 w-12 rounded bg-neto-bg5 mb-1.5" />
        <div className="h-1.5 w-14 rounded bg-neto-bg5" />
      </div>
    </div>
  );
}

// ─── Section ─────────────────────────────────────────────────────────────────

export default function BentoShowcase() {
  return (
    <section className="py-24 px-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <BlurReveal className="text-center mb-14">
          <div className="inline-flex items-center gap-2 rounded-full border border-neto-green-light/20 bg-neto-green-light/5 px-4 py-1.5 mb-6">
            <span className="text-xs font-medium text-neto-green-light">
              Asistente completo
            </span>
          </div>
          <h2 className="text-4xl min-[860px]:text-5xl font-extrabold tracking-tight mb-4">
            <span className="bg-gradient-to-r from-neto-txt to-neto-txt3 text-transparent bg-clip-text block">
              Todo lo que necesitas.
            </span>
            <span className="bg-gradient-to-r from-neto-green-light to-neto-green text-transparent bg-clip-text block">
              Nada que no.
            </span>
          </h2>
          <p className="text-neto-txt3 text-base max-w-md mx-auto">
            WhatsApp + dashboard web. Sin contraseñas bancarias. Solo
            resultados.
          </p>
        </BlurReveal>

        {/* Bento grid */}
        <div className="grid grid-cols-1 min-[640px]:grid-cols-2 min-[1024px]:grid-cols-3 gap-4">
          {/* Row 1 */}
          <BentoCard
            title="Dashboard interactivo"
            desc="Gráficos, KPIs, score financiero, top comercios. Todo en app.neto.pe."
            visual={<DashboardVisual />}
            size="large"
            className="min-[1024px]:col-span-2"
          />
          <BentoCard
            title="IA que aprende de ti"
            desc="Categoriza automáticamente. Corrígelo una vez y aprende para siempre."
            visual={<AIVisual />}
          />

          {/* Row 2 */}
          <BentoCard
            title="Consultas naturales"
            desc="Pregúntale como a un amigo: '¿cuánto gasté en delivery?'"
            visual={<ChatVisual />}
          />
          <BentoCard
            title="Metas de ahorro"
            desc="Define cuánto quieres ahorrar y ve tu progreso en tiempo real."
            visual={<GoalsVisual />}
          />
          <BentoCard
            title="Calendario financiero"
            desc="Detecta patrones de gasto día a día."
            visual={<CalendarVisual />}
          />

          {/* Row 3 */}
          <BentoCard
            title="Suscripciones detectadas"
            desc="Netflix, Spotify, PedidosYa y 50+ servicios. Ve cuánto pagas sin darte cuenta."
            visual={<SubscriptionsVisual />}
            size="large"
            className="min-[1024px]:col-span-2"
          />
          <BentoCard
            title="Reportes PDF"
            desc="Descarga tu reporte mensual completo con gráficos y score financiero."
            visual={<PdfVisual />}
          />
        </div>
      </div>
    </section>
  );
}
