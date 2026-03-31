"use client";
import { useRef } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import BlurReveal from "@/components/shared/BlurReveal";

const EASE = [0.16, 1, 0.3, 1] as const;

interface Step {
  number: string;
  title: string;
  desc: string;
  side: "left" | "right";
}

const STEPS: Step[] = [
  {
    number: "01",
    title: "Conectas tu Gmail",
    desc: "Un clic. Neto accede solo a los correos de transacciones bancarias — nunca tus correos personales, nunca tus contraseñas bancarias.",
    side: "left",
  },
  {
    number: "02",
    title: "Neto trabaja solo",
    desc: "Lee cada notificación de BCP, BBVA, Interbank, Scotiabank, Yape, Plin y más. Categoriza con IA automáticamente. Tú no haces nada.",
    side: "right",
  },
  {
    number: "03",
    title: "Recibes tu resumen",
    desc: "Neto te manda resúmenes diarios, semanales y mensuales a WhatsApp con tus gastos, tendencias y recomendaciones personalizadas.",
    side: "left",
  },
  {
    number: "04",
    title: "Exploras tu dashboard",
    desc: "Entra a app.neto.pe para ver gráficos interactivos, score financiero, calendario de gastos, metas de ahorro y reportes PDF descargables.",
    side: "right",
  },
];

function StepCard({ step, index }: { step: Step; index: number }) {
  return (
    <motion.div
      className="rounded-[20px] bg-neto-bg2 border border-white/5 p-6 max-w-[420px] w-full"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, ease: EASE, delay: index * 0.05 }}
    >
      <span className="text-4xl font-bold font-mono text-neto-green opacity-30 block mb-3 leading-none">
        {step.number}
      </span>
      <h3 className="text-xl font-bold text-neto-txt mb-2">{step.title}</h3>
      <p className="text-sm text-neto-txt2 leading-relaxed">{step.desc}</p>
    </motion.div>
  );
}

export default function HowItWorks() {
  const containerRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start center", "end center"],
  });

  const fillHeight = useTransform(scrollYProgress, [0, 1], ["0%", "100%"]);

  return (
    <section id="como-funciona" className="py-24 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <BlurReveal className="text-center mb-16">
          <div className="inline-flex items-center gap-2 rounded-full border border-neto-green-light/20 bg-neto-green-light/5 px-4 py-1.5 mb-6">
            <span className="text-xs font-medium text-neto-green-light">
              Cómo funciona
            </span>
          </div>
          <h2 className="text-4xl min-[860px]:text-5xl font-extrabold tracking-tight text-neto-txt mb-4">
            Cuatro pasos. Cero fricción.
          </h2>
          <p className="text-neto-txt3 text-base max-w-lg mx-auto">
            Neto se conecta a tu correo, lee las notificaciones de tu banco y te
            manda todo resumido a WhatsApp. Así de simple.
          </p>
        </BlurReveal>

        {/* Timeline — desktop */}
        <div ref={containerRef} className="hidden min-[860px]:block relative">
          {/* Vertical line track */}
          <div
            className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-0.5 bg-neto-bg5"
            aria-hidden="true"
          >
            {/* Green fill */}
            <motion.div
              className="absolute top-0 left-0 right-0 bg-neto-green origin-top rounded-full"
              style={{ height: fillHeight }}
            />
          </div>

          <div className="flex flex-col gap-16">
            {STEPS.map((step, i) => (
              <div
                key={step.number}
                className="grid grid-cols-[1fr,60px,1fr] items-center gap-0"
              >
                {/* Left column */}
                <div
                  className={`flex ${step.side === "left" ? "justify-end pr-8" : "justify-start"}`}
                >
                  {step.side === "left" && (
                    <StepCard step={step} index={i} />
                  )}
                </div>

                {/* Center — dot */}
                <div className="flex items-center justify-center relative z-10">
                  <div className="w-4 h-4 rounded-full bg-neto-green border-2 border-neto-bg" />
                </div>

                {/* Right column */}
                <div
                  className={`flex ${step.side === "right" ? "justify-start pl-8" : "justify-end"}`}
                >
                  {step.side === "right" && (
                    <StepCard step={step} index={i} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Timeline — mobile */}
        <div className="min-[860px]:hidden relative pl-8">
          {/* Vertical line track */}
          <div
            className="absolute top-0 bottom-0 left-3 w-0.5 bg-neto-bg5"
            aria-hidden="true"
          >
            <motion.div
              className="absolute top-0 left-0 right-0 bg-neto-green origin-top rounded-full"
              style={{ height: fillHeight }}
            />
          </div>

          <div className="flex flex-col gap-10">
            {STEPS.map((step, i) => (
              <div key={step.number} className="relative">
                {/* Dot */}
                <div className="absolute -left-[22px] top-6 z-10">
                  <div className="w-4 h-4 rounded-full bg-neto-green border-2 border-neto-bg" />
                </div>
                <StepCard step={step} index={i} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
