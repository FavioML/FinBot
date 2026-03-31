"use client";

import { motion } from "framer-motion";
import { Check, Shield } from "lucide-react";
import BlurReveal from "@/components/shared/BlurReveal";

const EASE = [0.16, 1, 0.3, 1] as const;

const SECURITY_ITEMS = [
  "Solo lectura de correos bancarios",
  "Cero contraseñas bancarias",
  "Datos encriptados (TLS + Row-Level Security)",
  "Login con Google OAuth 2.0",
  "Tú tienes el control (revoca cuando quieras)",
  "Hecho en Perú, para peruanos",
];

const TECH_BADGES = ["Google OAuth 2.0", "SSL/TLS 1.3", "Supabase RLS"];

export default function Security() {
  return (
    <section className="py-24 relative overflow-hidden bg-gradient-to-b from-transparent via-neto-green/[0.02] to-transparent">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-1 min-[860px]:grid-cols-2 gap-12 min-[860px]:gap-16 items-center">
          {/* Left column */}
          <div>
            <BlurReveal>
              <div className="flex flex-col">
                {/* Label pill */}
                <div className="inline-flex mb-5">
                  <span className="rounded-full border border-neto-green/30 bg-neto-green/10 px-4 py-1.5 text-xs font-semibold tracking-wide text-neto-green uppercase">
                    Seguridad
                  </span>
                </div>

                {/* H2 */}
                <h2 className="text-3xl min-[860px]:text-5xl font-extrabold tracking-tight leading-[1.1] mb-6">
                  <span className="text-neto-txt">Tu plata es tuya.</span>
                  <br />
                  <span
                    className="text-transparent"
                    style={{ WebkitTextStroke: "1.5px rgba(229,226,222,0.7)" }}
                  >
                    Tus datos también.
                  </span>
                </h2>

                {/* Subtitle */}
                <p className="text-neto-txt3 text-base leading-relaxed">
                  Neto está diseñado con seguridad desde el primer día.
                </p>
              </div>
            </BlurReveal>

            {/* Security list */}
            <ul className="mt-8 flex flex-col gap-4">
              {SECURITY_ITEMS.map((item, index) => (
                <motion.li
                  key={item}
                  className="flex gap-3"
                  initial={{ opacity: 0, x: -16 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: "-40px" }}
                  transition={{
                    duration: 0.5,
                    delay: index * 0.07,
                    ease: EASE,
                  }}
                >
                  <div className="w-5 h-5 rounded-full bg-neto-green/20 flex items-center justify-center shrink-0 mt-0.5">
                    <Check size={12} className="text-neto-green" />
                  </div>
                  <span className="text-sm text-neto-txt2">{item}</span>
                </motion.li>
              ))}
            </ul>
          </div>

          {/* Right column — glass card */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7, ease: EASE }}
          >
            <div className="rounded-[28px] bg-neto-bg2/80 backdrop-blur-xl border border-white/[0.08] p-8 flex flex-col items-center text-center relative overflow-hidden">
              {/* Green glow */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-24 bg-neto-green/15 blur-[60px] pointer-events-none" />

              {/* Shield icon */}
              <Shield size={48} className="text-neto-green-light mb-6 relative z-10" />

              {/* Title */}
              <h3 className="text-xl font-bold text-neto-txt mb-3 relative z-10">
                Privacidad by design
              </h3>

              {/* Description */}
              <p className="text-sm text-neto-txt3 leading-relaxed mb-6 relative z-10">
                Nunca almacenamos contraseñas bancarias. Solo leemos los correos de notificación que
                tu banco ya te envía.
              </p>

              {/* Tech badges */}
              <div className="flex flex-wrap gap-2 justify-center relative z-10">
                {TECH_BADGES.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-full border border-neto-bg5 bg-neto-bg3 px-3 py-1 text-xs font-medium text-neto-txt2"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
