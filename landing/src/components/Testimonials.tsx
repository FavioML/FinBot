import { Star } from "lucide-react";

const TESTIMONIALS = [
  {
    quote:
      "Antes gastaba sin darme cuenta. Ahora Neto me avisa al instante y sé exactamente a dónde va mi plata. Lo mejor: no tuve que instalar nada.",
    name: "Carlos M.",
    role: "Analista financiero, 32 años, Lima",
    initials: "CM",
  },
  {
    quote:
      "Como freelancer mis ingresos varían mucho. Neto me ayuda a ver patrones que yo sola no veía. El resumen semanal es oro puro.",
    name: "Valeria R.",
    role: "Diseñadora independiente, 28 años",
    initials: "VR",
  },
  {
    quote:
      "Lo conecté en 2 minutos y ya no necesito revisar los correos del banco. Neto me dice todo por WhatsApp. Simple y directo.",
    name: "Diego P.",
    role: "Emprendedor, 35 años, Lima",
    initials: "DP",
  },
];

function Stars() {
  return (
    <div className="flex gap-0.5 mb-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          size={16}
          className="fill-neto-amber text-neto-amber"
        />
      ))}
    </div>
  );
}

export default function Testimonials() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-[1200px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full border border-neto-green/30 bg-neto-green/10 px-4 py-1 text-xs font-medium text-neto-green mb-4">
            Testimonios
          </span>
          <h2 className="text-3xl min-[860px]:text-4xl font-bold tracking-tight">
            Lo que dicen nuestros usuarios
          </h2>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 min-[860px]:grid-cols-3 gap-6">
          {TESTIMONIALS.map((t) => (
            <div
              key={t.name}
              className="rounded-[20px] bg-neto-bg3 border border-white/5 p-8 flex flex-col"
            >
              <Stars />
              <blockquote className="text-sm text-neto-txt2 leading-relaxed flex-1 mb-6">
                &ldquo;{t.quote}&rdquo;
              </blockquote>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-neto-green/20 text-neto-green flex items-center justify-center text-sm font-semibold">
                  {t.initials}
                </div>
                <div>
                  <p className="text-sm font-semibold">{t.name}</p>
                  <p className="text-xs text-neto-txt3">{t.role}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
