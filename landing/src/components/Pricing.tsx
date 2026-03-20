import { Check, X } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const FREE_FEATURES = [
  { text: "Resumen de gastos por WhatsApp", on: true },
  { text: "Categorización automática con IA", on: true },
  { text: "Corrección de categorías", on: true },
  { text: "Consultas en lenguaje natural", on: true },
  { text: "Reportes web mensuales", on: false },
  { text: "Historial ilimitado", on: false },
  { text: "Resúmenes configurables", on: false },
];

const PRO_FEATURES = [
  "Todo lo del plan Gratis",
  "Reportes web mensuales ilimitados",
  "Historial ilimitado",
  "Resúmenes automáticos configurables",
  "Score de salud financiera",
  "Paga con Yape o tarjeta",
];

export default function Pricing() {
  return (
    <section id="precios" className="py-24 bg-neto-bg2">
      <div className="mx-auto max-w-[1200px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full border border-neto-green/30 bg-neto-green/10 px-4 py-1 text-xs font-medium text-neto-green mb-4">
            Precios
          </span>
          <h2 className="text-3xl min-[860px]:text-4xl font-bold tracking-tight mb-4">
            Simple y directo.
          </h2>
          <p className="text-neto-txt2 max-w-[480px] mx-auto">
            Dos planes. Sin letra chica. Empieza gratis y actualiza solo si lo
            ves útil.
          </p>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 min-[860px]:grid-cols-2 gap-6 max-w-[860px] mx-auto">
          {/* Free plan */}
          <div className="rounded-[20px] bg-neto-bg border border-white/10 p-8 flex flex-col">
            <h3 className="text-xl font-bold mb-1">Gratis</h3>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-4xl font-bold">S/0</span>
            </div>
            <p className="text-sm text-neto-txt3 mb-8">Para siempre</p>

            <ul className="space-y-3 flex-1 mb-8">
              {FREE_FEATURES.map((f) => (
                <li key={f.text} className="flex items-start gap-3">
                  {f.on ? (
                    <Check size={16} className="text-neto-green mt-0.5 shrink-0" />
                  ) : (
                    <X size={16} className="text-neto-txt3/50 mt-0.5 shrink-0" />
                  )}
                  <span
                    className={`text-sm ${f.on ? "text-neto-txt2" : "text-neto-txt3/50"}`}
                  >
                    {f.text}
                  </span>
                </li>
              ))}
            </ul>

            <a
              href={WA_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-neto-green text-neto-green px-6 py-3 text-sm font-semibold text-center hover:bg-neto-green/10 transition-colors duration-200 cursor-pointer"
            >
              Empezar gratis
            </a>
          </div>

          {/* Pro plan */}
          <div className="relative rounded-[20px] bg-neto-green p-8 flex flex-col text-white">
            <span className="absolute top-6 right-6 rounded-full bg-neto-amber px-3 py-0.5 text-xs font-bold text-neto-bg">
              PRO
            </span>
            <h3 className="text-xl font-bold mb-1">Pro</h3>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-4xl font-bold">S/10</span>
              <span className="text-sm text-white/70">/mes</span>
            </div>
            <p className="text-sm text-white/70 mb-8">
              o S/99/año — 2 meses gratis
            </p>

            <ul className="space-y-3 flex-1 mb-8">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3">
                  <Check size={16} className="text-white mt-0.5 shrink-0" />
                  <span className="text-sm text-white/90">{f}</span>
                </li>
              ))}
            </ul>

            <a
              href={WA_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-white text-neto-green-dark px-6 py-3 text-sm font-semibold text-center hover:bg-white/90 transition-colors duration-200 cursor-pointer"
            >
              Empezar con Pro
            </a>
          </div>
        </div>

        {/* Note */}
        <p className="text-center text-sm text-neto-txt3 mt-8">
          ¿Tu banco no está en la lista? Escríbenos — lo activamos a solicitud.
        </p>
      </div>
    </section>
  );
}
