"use client";

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { Quote, Star } from "lucide-react";
import BlurReveal from "@/components/shared/BlurReveal";

const EASE = [0.16, 1, 0.3, 1] as const;

/* ─── useTilt hook ─── */
function useTilt() {
  const ref = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState(
    "perspective(800px) rotateX(0deg) rotateY(0deg)"
  );

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setTransform(
      `perspective(800px) rotateX(${-y * 3}deg) rotateY(${x * 3}deg)`
    );
  };

  const onMouseLeave = () =>
    setTransform("perspective(800px) rotateX(0deg) rotateY(0deg)");

  return { ref, transform, onMouseMove, onMouseLeave };
}

/* ─── Data ─── */
const TESTIMONIALS = [
  {
    name: "Carlos M.",
    role: "Analista financiero",
    location: "Lima",
    initials: "CM",
    quote:
      "Antes gastaba sin darme cuenta. Ahora Neto me avisa al instante y sé exactamente a dónde va mi plata. Lo mejor: no tuve que instalar nada.",
    metric: "S/2,400",
    metricLabel: "ahorrados en 3 meses",
  },
  {
    name: "Valeria R.",
    role: "Diseñadora independiente",
    location: "Arequipa",
    initials: "VR",
    quote:
      "Como freelancer mis ingresos varían mucho. Neto me ayuda a ver patrones que yo sola no veía. El resumen semanal es oro puro.",
    metric: "+32%",
    metricLabel: "mejor control de gastos",
  },
  {
    name: "Diego P.",
    role: "Emprendedor",
    location: "Lima",
    initials: "DP",
    quote:
      "Lo conecté en 2 minutos y ya no necesito revisar los correos del banco. Neto me dice todo por WhatsApp. Simple y directo.",
    metric: "2 min",
    metricLabel: "de setup inicial",
  },
  {
    name: "Lucía F.",
    role: "Contadora",
    location: "Trujillo",
    initials: "LF",
    quote:
      "Mis gastos hormiga eran un problema serio. Desde que uso Neto bajé mi gasto diario en delivery un 40%. La data no miente.",
    metric: "-40%",
    metricLabel: "en gastos hormiga",
  },
];

/* ─── StarRow ─── */
function StarRow() {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} size={14} className="fill-neto-amber text-neto-amber" />
      ))}
    </div>
  );
}

/* ─── Avatar ─── */
function Avatar({ initials }: { initials: string }) {
  return (
    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-neto-green to-neto-green-dark flex items-center justify-center shrink-0">
      <span className="text-white font-semibold text-sm">{initials}</span>
    </div>
  );
}

export default function Testimonials() {
  const tilt = useTilt();
  const [t0, t1, t2, t3] = TESTIMONIALS;

  return (
    <section className="py-24 relative overflow-hidden">
      <div className="max-w-6xl mx-auto px-6">
        {/* Header */}
        <BlurReveal>
          <div className="flex flex-col items-center text-center mb-14">
            <span className="rounded-full border border-neto-green/30 bg-neto-green/10 px-4 py-1.5 text-xs font-semibold tracking-wide text-neto-green uppercase mb-5">
              Historias reales
            </span>
            <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight leading-[1.1]">
              <span
                className="text-transparent bg-clip-text"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #68dbae 0%, #1D9E75 100%)",
                  WebkitBackgroundClip: "text",
                }}
              >
                Resultados reales.
              </span>
            </h2>
          </div>
        </BlurReveal>

        {/* Bento grid */}
        <div className="grid grid-cols-1 min-[860px]:grid-cols-12 gap-4">
          {/* Featured card [0] — col-span-7 */}
          <motion.div
            ref={tilt.ref}
            onMouseMove={tilt.onMouseMove}
            onMouseLeave={tilt.onMouseLeave}
            style={{ transform: tilt.transform }}
            className="min-[860px]:col-span-7 bg-neto-bg3 border border-white/5 rounded-[24px] overflow-hidden"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            {/* Top accent line */}
            <div className="h-[1px] bg-gradient-to-r from-transparent via-neto-green to-transparent opacity-40" />

            <div className="p-8 min-[860px]:p-10 flex flex-col gap-6">
              <StarRow />

              <div className="flex flex-col gap-4">
                <Quote size={32} className="text-neto-green/20" />
                <blockquote className="text-xl min-[860px]:text-2xl font-medium text-neto-txt leading-relaxed">
                  &ldquo;{t0.quote}&rdquo;
                </blockquote>
              </div>

              {/* Metric card */}
              <div className="rounded-2xl bg-neto-bg4 p-5 w-fit">
                <p className="text-3xl font-bold text-neto-green-light">{t0.metric}</p>
                <p className="text-sm text-neto-txt3 mt-0.5">{t0.metricLabel}</p>
              </div>

              {/* Author row */}
              <div className="flex items-center gap-3 pt-2">
                <Avatar initials={t0.initials} />
                <div>
                  <p className="text-sm font-semibold text-neto-txt">{t0.name}</p>
                  <p className="text-xs text-neto-txt3">
                    {t0.role} · {t0.location}
                  </p>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Right stack [1],[2] — col-span-5 */}
          <div className="min-[860px]:col-span-5 flex flex-col gap-4">
            {[t1, t2].map((t, idx) => (
              <motion.div
                key={t.name}
                className="bg-neto-bg3 rounded-[24px] p-7 flex flex-col gap-4 border border-white/5"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.6, delay: 0.1 + idx * 0.08, ease: EASE }}
              >
                <StarRow />
                <p className="text-sm text-neto-txt2 leading-relaxed">
                  &ldquo;{t.quote}&rdquo;
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Avatar initials={t.initials} />
                    <div>
                      <p className="text-sm font-semibold text-neto-txt">{t.name}</p>
                      <p className="text-xs text-neto-txt3">
                        {t.role} · {t.location}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-neto-green-light">{t.metric}</p>
                    <p className="text-xs text-neto-txt3">{t.metricLabel}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Full-width accent card [3] — col-span-12 */}
          <motion.div
            className="min-[860px]:col-span-12 rounded-[24px] overflow-hidden"
            style={{ background: "linear-gradient(135deg, #1D9E75 0%, #0F6E56 100%)" }}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, delay: 0.2, ease: EASE }}
          >
            <div className="p-8 min-[860px]:p-10 flex flex-col min-[860px]:flex-row min-[860px]:items-center gap-6 min-[860px]:gap-10">
              <div className="flex flex-col gap-4 flex-1">
                <StarRow />
                <p className="text-lg min-[860px]:text-xl font-medium text-white/95 leading-relaxed">
                  &ldquo;{t3.quote}&rdquo;
                </p>
                <div className="flex items-center gap-3">
                  <Avatar initials={t3.initials} />
                  <div>
                    <p className="text-sm font-semibold text-white">{t3.name}</p>
                    <p className="text-xs text-white/70">
                      {t3.role} · {t3.location}
                    </p>
                  </div>
                </div>
              </div>

              {/* Metric — right on desktop */}
              <div className="min-[860px]:text-right shrink-0 min-[860px]:border-l min-[860px]:border-white/20 min-[860px]:pl-10">
                <p className="text-4xl font-bold text-white">{t3.metric}</p>
                <p className="text-sm text-white/70 mt-1">{t3.metricLabel}</p>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
