import { ArrowRight } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

export default function FinalCTA() {
  return (
    <section
      className="relative py-24 overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse at 50% 120%, rgba(239,159,39,0.25) 0%, transparent 60%), #1D9E75",
      }}
    >
      <div className="mx-auto max-w-[700px] px-6 text-center">
        <h2 className="text-3xl min-[860px]:text-4xl font-bold text-white tracking-tight mb-4">
          ¿A dónde se fue tu plata este mes?
        </h2>
        <p className="text-lg text-white/80 mb-10">
          Conéctate ahora y Neto te responde.
        </p>

        <a
          href={WA_LINK}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-full bg-neto-amber px-7 py-3.5 text-base font-semibold text-neto-bg hover:brightness-110 transition-all duration-200 cursor-pointer"
        >
          Empezar ahora
          <ArrowRight size={18} />
        </a>

        <p className="mt-6 text-sm text-white/60">
          Gratis · Sin tarjeta · Sin contraseña bancaria
        </p>
      </div>
    </section>
  );
}
