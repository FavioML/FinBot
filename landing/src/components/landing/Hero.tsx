"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";
import { Sparkles, ChevronDown } from "lucide-react";
import ChatSimulator from "./ChatSimulator";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";
const DASHBOARD_URL = "https://app.neto.pe";

const EASE = [0.16, 1, 0.3, 1] as const;

const fadeUp = (delay: number) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, ease: EASE, delay },
});

export default function Hero() {
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;

    const reset = () => {
      clearTimeout(timeout);
      document.getElementById("hero-cta")?.classList.remove("cta-attention");
      timeout = setTimeout(() => {
        document.getElementById("hero-cta")?.classList.add("cta-attention");
      }, 8000);
    };

    window.addEventListener("mousemove", reset, { passive: true });
    window.addEventListener("scroll", reset, { passive: true });
    reset();

    return () => {
      clearTimeout(timeout);
      window.removeEventListener("mousemove", reset);
      window.removeEventListener("scroll", reset);
    };
  }, []);

  return (
    <section className="relative min-h-[100svh] bg-neto-bg overflow-hidden flex flex-col justify-center">
      {/* Grid pattern */}
      <div
        className="absolute inset-0 -z-20 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #68dbae 1px, transparent 1px), linear-gradient(to bottom, #68dbae 1px, transparent 1px)",
          backgroundSize: "4rem 4rem",
          WebkitMaskImage:
            "radial-gradient(ellipse 70% 50% at 50% 40%, black 40%, transparent 100%)",
          maskImage:
            "radial-gradient(ellipse 70% 50% at 50% 40%, black 40%, transparent 100%)",
        }}
      />

      {/* Green radial glow */}
      <div
        className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[900px] h-[700px] -z-10 bg-[#1D9E75]/[0.08] blur-[140px] pointer-events-none"
        aria-hidden
      />

      {/* Amber glow */}
      <div
        className="absolute bottom-[-10%] right-[5%] w-[400px] h-[400px] -z-10 bg-[#EF9F27]/[0.05] blur-[100px] pointer-events-none"
        aria-hidden
      />

      {/* Main content grid */}
      <div className="relative z-10 w-full max-w-7xl mx-auto px-6 py-20 grid grid-cols-1 min-[1024px]:grid-cols-[55fr_45fr] gap-12 min-[1024px]:gap-8 items-center">
        {/* Left column — text */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="flex flex-col gap-8 min-[1024px]:pr-8"
        >
          {/* Eyebrow badge */}
          <motion.div {...fadeUp(0.1)}>
            <span className="inline-flex items-center gap-2 border border-neto-green/30 bg-neto-green/10 px-5 py-1.5 rounded-full">
              <Sparkles
                size={14}
                className="text-neto-amber shrink-0"
                aria-hidden
              />
              <span className="text-xs text-neto-green-light font-medium">
                WhatsApp + Dashboard · Lima, Perú
              </span>
            </span>
          </motion.div>

          {/* H1 */}
          <motion.h1
            {...fadeUp(0.2)}
            className="text-[clamp(2.5rem,7vw,5.5rem)] font-extrabold leading-[1.05] tracking-tight"
          >
            <span className="block bg-gradient-to-b from-neto-txt to-neto-txt3 bg-clip-text text-transparent">
              Ordena tu plata
            </span>
            <span className="block bg-gradient-to-r from-neto-green-light via-neto-green to-neto-green bg-clip-text text-transparent">
              sin mover un dedo
            </span>
          </motion.h1>

          {/* Subtitle */}
          <motion.p
            {...fadeUp(0.3)}
            className="text-lg text-neto-txt3 max-w-[520px] leading-relaxed"
          >
            Neto lee tus correos bancarios, categoriza con IA y te resume todo
            por WhatsApp. Gratis. Sin contraseñas bancarias.
          </motion.p>

          {/* CTA row */}
          <motion.div
            {...fadeUp(0.4)}
            className="flex flex-row flex-wrap gap-3"
          >
            <a
              href={WA_LINK}
              id="hero-cta"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-gradient-to-br from-neto-green-light to-neto-green text-[#002115] px-7 py-3.5 text-base font-semibold transition-all duration-200 hover:shadow-[0_0_40px_rgba(29,158,117,0.35)] hover:scale-[1.02] active:scale-[0.98]"
            >
              Regístrate en 2 minutos
            </a>
            <a
              href={DASHBOARD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-neto-bg5 bg-neto-bg3/60 backdrop-blur-sm px-7 py-3.5 text-base font-medium text-neto-txt2 transition-all duration-200 hover:bg-neto-bg4 hover:text-neto-txt active:scale-[0.98]"
            >
              Iniciar sesión
            </a>
          </motion.div>

          {/* Stats row */}
          <motion.div
            {...fadeUp(0.5)}
            className="flex flex-row flex-wrap items-center gap-x-4 gap-y-3"
          >
            {[
              { value: "Gratis", label: "Para empezar" },
              { value: "2 min", label: "De setup" },
              { value: "Sin contraseñas", label: "Bancarias" },
            ].map((stat, i) => (
              <div key={stat.label} className="flex flex-row items-center gap-4">
                {i > 0 && (
                  <span className="text-neto-txt3 select-none" aria-hidden>
                    ·
                  </span>
                )}
                <div className="flex flex-col">
                  <span className="text-neto-txt font-semibold text-sm leading-tight">
                    {stat.value}
                  </span>
                  <span className="text-neto-txt3 text-xs leading-tight">
                    {stat.label}
                  </span>
                </div>
              </div>
            ))}
          </motion.div>
        </motion.div>

        {/* Right column — chat simulator */}
        <div className="flex items-center justify-center relative">
          <ChatSimulator />
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 hidden min-[1024px]:flex flex-col items-center gap-1 pointer-events-none">
        <ChevronDown
          size={20}
          className="text-neto-txt3 animate-bounce"
          aria-hidden
        />
      </div>
    </section>
  );
}
