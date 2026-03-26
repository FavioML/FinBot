"use client";

import { Gift, Users, Crown, ArrowRight } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20saber%20sobre%20el%20programa%20de%20referidos%20%F0%9F%8E%81";

const STEPS = [
  {
    Icon: Users,
    step: "1",
    title: "Invita a 3 amigos",
    desc: "Comparte tu link de referido por WhatsApp. Cuando se registren, se vinculan a tu cuenta.",
  },
  {
    Icon: Gift,
    step: "2",
    title: "Ellos se suscriben a Neto",
    desc: "Tus amigos se registran y pagan su plan. Cuando tengan 3+ transacciones, cuentan como activos.",
  },
  {
    Icon: Crown,
    step: "3",
    title: "Tú ganas 1 mes gratis",
    desc: "Cuando 3 referidos están activos, tu siguiente mes es gratis. Automáticamente.",
  },
];

export default function Referral() {
  return (
    <section className="py-20 relative overflow-hidden">
      <div className="mx-auto max-w-[1000px] px-6">
        <div className="rounded-[28px] bg-gradient-to-br from-[#1C1C19] to-[#18181A] overflow-hidden relative">
          {/* Accent glow */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[50%] h-20 bg-[#EF9F27]/10 blur-[60px]" />
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#EF9F27]/40 to-transparent" />

          <div className="relative p-8 min-[860px]:p-12">
            {/* Header */}
            <div className="text-center mb-12">
              <span className="inline-flex items-center gap-2 rounded-full bg-[#EF9F27]/10 px-5 py-2 text-xs font-medium text-[#EF9F27] mb-6 tracking-wide">
                <Gift size={14} />
                Programa de referidos
              </span>
              <h2 className="text-2xl min-[860px]:text-4xl font-extrabold tracking-tight mb-4">
                <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
                  Invita amigos,
                </span>{" "}
                <span className="bg-gradient-to-r from-[#EF9F27] to-[#D4860E] bg-clip-text text-transparent">
                  gana 1 mes gratis
                </span>
              </h2>
              <p className="text-[#87948c] max-w-[400px] mx-auto text-base leading-relaxed">
                3 referidos activos = 1 mes gratis. Así de simple.
              </p>
            </div>

            {/* Steps */}
            <div className="grid grid-cols-1 min-[640px]:grid-cols-3 gap-6 mb-10">
              {STEPS.map((s) => {
                const { Icon } = s;
                return (
                  <div key={s.step} className="text-center">
                    <div className="w-14 h-14 rounded-2xl bg-[#EF9F27]/10 flex items-center justify-center mx-auto mb-4">
                      <Icon size={24} className="text-[#EF9F27]" />
                    </div>
                    <div className="text-xs font-bold text-[#EF9F27] mb-2">
                      Paso {s.step}
                    </div>
                    <h3 className="text-base font-semibold text-[#e5e2de] mb-2">
                      {s.title}
                    </h3>
                    <p className="text-sm text-[#87948c] leading-relaxed">
                      {s.desc}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* CTA */}
            <div className="text-center">
              <a
                href={WA_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-[#EF9F27] px-7 py-3.5 text-sm font-semibold text-[#0E0E0C] hover:brightness-110 transition-all duration-200 cursor-pointer"
              >
                Obtener mi link de referido
                <ArrowRight size={16} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
