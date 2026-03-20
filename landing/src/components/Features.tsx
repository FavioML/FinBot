"use client";

import { Shield, Smartphone, Heart } from "lucide-react";

const FEATURES = [
  {
    Icon: Shield,
    title: "Sin contraseña bancaria",
    desc: "Solo leemos los correos de notificación que tu banco ya te envía. Nunca accedemos a tu banca directa. Cero riesgo.",
  },
  {
    Icon: Smartphone,
    title: "Sin app que descargar",
    desc: "Neto vive en WhatsApp — donde ya estás. No hay nada que instalar ni recordar abrir. El resumen llega solo.",
  },
  {
    Icon: Heart,
    title: "Paga con Yape",
    desc: "El único asistente financiero que acepta Yape como método de pago. Sin tarjeta de crédito. Sin trámites. Peruano de verdad.",
  },
];

export default function Features() {
  return (
    <section className="py-24 bg-neto-bg2">
      <div className="mx-auto max-w-[1200px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full border border-neto-green/30 bg-neto-green/10 px-4 py-1 text-xs font-medium text-neto-green mb-4">
            Características
          </span>
          <h2 className="text-3xl min-[860px]:text-4xl font-bold tracking-tight">
            La única app de finanzas en WhatsApp.
          </h2>
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-1 min-[860px]:grid-cols-3 gap-[1px] bg-white/5 rounded-[20px] overflow-hidden">
          {FEATURES.map(({ Icon, title, desc }) => (
            <div
              key={title}
              className="group relative bg-neto-bg p-8 cursor-default"
            >
              <div className="mb-5 inline-flex items-center justify-center w-12 h-12 rounded-[12px] bg-neto-green/10 text-neto-green">
                <Icon size={24} />
              </div>
              <h3 className="text-lg font-bold mb-3">{title}</h3>
              <p className="text-sm text-neto-txt2 leading-relaxed">{desc}</p>

              {/* Bottom border sweep on hover */}
              <span className="absolute bottom-0 left-0 h-[2px] w-full bg-neto-green origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-300" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
