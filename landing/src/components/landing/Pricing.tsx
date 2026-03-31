"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Check, X, Zap, Crown } from "lucide-react";
import BlurReveal from "@/components/shared/BlurReveal";

const EASE = [0.16, 1, 0.3, 1] as const;

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

/* ─── Features ─── */
const FREE_FEATURES_BASE = [
  { text: "WhatsApp: registro de gastos", included: true },
  { text: "Dashboard web", included: true },
  { text: "Mes actual", included: true },
  { text: "Clasificación con IA", included: true },
  { text: "Categorías personalizables", included: true },
  { text: "Presupuestos ilimitados", included: true },
  { text: "Metas de ahorro ilimitadas", included: true },
  { text: "Resumen semanal básico", included: true },
  { text: "1 consejo IA/semana", included: true },
  { text: "Lectura automática de correos", included: false },
  { text: "Lectura de imágenes Yape/Plin", included: false },
  { text: "Historial completo", included: false },
  { text: "Resumen diario", included: false },
  { text: "Score financiero detallado", included: false },
  { text: "Reportes PDF", included: false },
  { text: "Calendario / Heatmap", included: false },
  { text: "Export CSV/JSON", included: false },
  { text: "Recordatorios", included: false },
  { text: "Multimoneda", included: false },
  { text: "Referidos", included: false },
];

const FREE_FEATURES = FREE_FEATURES_BASE;
const PRO_FEATURES = FREE_FEATURES_BASE.map((f) => ({
  ...f,
  included: true,
  isProExclusive: !f.included,
}));

/* ─── FeatureItem ─── */
function FeatureItem({
  text,
  included,
  isProExclusive,
}: {
  text: string;
  included: boolean;
  isProExclusive?: boolean;
}) {
  return (
    <li className="flex items-center gap-3">
      <div
        className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${
          included ? "bg-neto-green/20" : "bg-white/5"
        }`}
      >
        {included ? (
          <Check size={10} className="text-neto-green" />
        ) : (
          <X size={10} className="text-neto-txt3" />
        )}
      </div>
      <span
        className={`text-sm ${
          isProExclusive
            ? "text-neto-green-light font-medium"
            : included
            ? "text-neto-txt2"
            : "text-neto-txt3 line-through opacity-50"
        }`}
      >
        {text}
      </span>
    </li>
  );
}

export default function Pricing() {
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");

  const prices = {
    monthly: { free: "S/0", pro: "S/10" },
    yearly: { free: "S/0", pro: "S/99/año" },
  };

  return (
    <section className="py-24 relative overflow-hidden">
      <div className="max-w-5xl mx-auto px-6">
        {/* Header */}
        <BlurReveal>
          <div className="flex flex-col items-center text-center mb-12">
            <span className="rounded-full border border-neto-green/30 bg-neto-green/10 px-4 py-1.5 text-xs font-semibold tracking-wide text-neto-green uppercase mb-5">
              Precios
            </span>
            <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight leading-[1.1] mb-4">
              <span
                className="text-transparent bg-clip-text"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #e5e2de 0%, #bccac1 100%)",
                  WebkitBackgroundClip: "text",
                }}
              >
                Empieza gratis.{" "}
              </span>
              <span
                className="text-transparent bg-clip-text"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #68dbae 0%, #1D9E75 100%)",
                  WebkitBackgroundClip: "text",
                }}
              >
                Crece con Pro.
              </span>
            </h2>
            <p className="text-neto-txt3 text-base max-w-[520px] leading-relaxed">
              Registra tus gastos sin costo. Activa Pro cuando quieras lectura automática
              de correos y todo ilimitado.
            </p>
          </div>
        </BlurReveal>

        {/* Billing toggle */}
        <div className="flex justify-center mb-10">
          <div className="flex items-center rounded-full bg-neto-bg3 p-1 gap-1">
            <button
              onClick={() => setBilling("monthly")}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-all duration-200 ${
                billing === "monthly"
                  ? "bg-neto-green text-white shadow-sm"
                  : "text-neto-txt3 hover:text-neto-txt2"
              }`}
            >
              Mensual
            </button>
            <button
              onClick={() => setBilling("yearly")}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-all duration-200 flex items-center gap-2 ${
                billing === "yearly"
                  ? "bg-neto-green text-white shadow-sm"
                  : "text-neto-txt3 hover:text-neto-txt2"
              }`}
            >
              Anual
              <span className="rounded-full bg-neto-amber/20 border border-neto-amber/30 px-2 py-0.5 text-[10px] font-bold text-neto-amber">
                -17%
              </span>
            </button>
          </div>
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-1 min-[860px]:grid-cols-2 gap-6 items-start">
          {/* Free card */}
          <motion.div
            className="bg-neto-bg3 rounded-[24px] border border-white/5 p-8 flex flex-col"
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-neto-bg5 flex items-center justify-center">
                <Zap size={20} className="text-neto-txt2" />
              </div>
              <h3 className="text-xl font-bold text-neto-txt">Gratis</h3>
            </div>

            {/* Price */}
            <div className="mb-6">
              <span className="text-4xl font-extrabold text-neto-txt">
                {prices[billing].free}
              </span>
              <span className="text-neto-txt3 text-sm ml-2">/ siempre</span>
            </div>

            {/* Features */}
            <ul className="flex flex-col gap-3 mb-8">
              {FREE_FEATURES.map((f) => (
                <FeatureItem key={f.text} text={f.text} included={f.included} />
              ))}
            </ul>

            {/* CTA */}
            <a
              href={WA_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-auto w-full rounded-full border border-neto-bg5 bg-neto-bg4 px-6 py-3.5 text-sm font-semibold text-neto-txt2 text-center transition-all duration-200 hover:border-neto-green/40 hover:text-neto-txt"
            >
              Empezar gratis
            </a>
          </motion.div>

          {/* Pro card */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, delay: 0.08, ease: EASE }}
          >
            <div className="group relative rounded-[24px] overflow-hidden pro-card cursor-default">
              {/* Conic gradient border */}
              <div
                className="absolute inset-0 rounded-[24px]"
                style={{
                  background:
                    "conic-gradient(from var(--angle), #0F6E56, #68dbae, #1D9E75, #0F6E56)",
                }}
              />
              <div className="absolute inset-[1px] rounded-[23px] bg-neto-bg2" />
              {/* Glow */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-20 bg-neto-green/15 blur-[60px] pointer-events-none" />

              <div className="relative p-8 flex flex-col h-full">
                {/* Badge row */}
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-neto-green/20 flex items-center justify-center">
                      <Crown size={20} className="text-neto-green-light" />
                    </div>
                    <h3 className="text-xl font-bold text-neto-txt">Pro</h3>
                  </div>
                  <span className="rounded-full bg-neto-amber px-3 py-1 text-xs font-bold text-neto-bg">
                    PRECIO FUNDADOR
                  </span>
                </div>

                {/* Price */}
                <div className="mb-6">
                  <span className="text-4xl font-extrabold text-neto-txt">
                    {prices[billing].pro}
                  </span>
                  {billing === "monthly" && (
                    <span className="text-neto-txt3 text-sm ml-2">/ mes</span>
                  )}
                </div>

                {/* Features */}
                <ul className="flex flex-col gap-3 mb-8">
                  {PRO_FEATURES.map((f) => (
                    <FeatureItem
                      key={f.text}
                      text={f.text}
                      included={f.included}
                      isProExclusive={f.isProExclusive}
                    />
                  ))}
                </ul>

                {/* CTA */}
                <a
                  href={WA_LINK}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-auto w-full rounded-full bg-gradient-to-br from-neto-green-light to-neto-green px-6 py-3.5 text-sm font-semibold text-[#002115] text-center transition-all duration-200 hover:shadow-[0_0_24px_rgba(29,158,117,0.4)] hover:scale-[1.02]"
                >
                  Activar Pro
                </a>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Bottom note */}
        <p className="text-center text-xs text-neto-txt3 mt-8">
          Paga con Yape · Setup en 5 min
        </p>
      </div>
    </section>
  );
}
