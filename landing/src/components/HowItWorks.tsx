const STEPS = [
  {
    num: "01",
    title: "Conectas tu Gmail",
    desc: "Un clic. Neto accede solo a los correos de transacciones — nunca tus correos personales, nunca tus contraseñas bancarias.",
  },
  {
    num: "02",
    title: "Neto trabaja solo",
    desc: "Lee cada notificación de tu banco, Yape y Plin. Categoriza con IA automáticamente. Tú no haces absolutamente nada.",
  },
  {
    num: "03",
    title: "Recibes tu resumen",
    desc: "Neto te manda un resumen a WhatsApp con tus gastos, tendencias y recomendaciones. Configura cuándo y con qué frecuencia.",
  },
];

export default function HowItWorks() {
  return (
    <section id="como-funciona" className="py-24">
      <div className="mx-auto max-w-[1200px] px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block rounded-full border border-neto-green/30 bg-neto-green/10 px-4 py-1 text-xs font-medium text-neto-green mb-4">
            Cómo funciona
          </span>
          <h2 className="text-3xl min-[860px]:text-4xl font-bold tracking-tight mb-4">
            Tres pasos. Cero fricción.
          </h2>
          <p className="text-neto-txt2 max-w-[520px] mx-auto">
            Neto se conecta a tu correo, lee las notificaciones de tu banco y te
            manda todo resumido a WhatsApp. Así de simple.
          </p>
        </div>

        {/* Steps grid */}
        <div className="grid grid-cols-1 min-[860px]:grid-cols-3 gap-6">
          {STEPS.map((step) => (
            <div
              key={step.num}
              className="group relative rounded-[20px] bg-neto-bg2 border border-white/5 p-8 overflow-hidden transition-all duration-300 hover:bg-[#1C1C19] hover:border-[#1D9E75]/20 hover:shadow-[0_0_30px_rgba(29,158,117,0.08)] cursor-default"
            >
              {/* Big faded number */}
              <span className="absolute top-4 right-6 text-[5rem] font-bold leading-none text-white/[0.03] select-none pointer-events-none">
                {step.num}
              </span>

              <span className="inline-block text-sm font-semibold text-neto-green mb-3">
                Paso {step.num}
              </span>
              <h3 className="text-xl font-bold mb-3">{step.title}</h3>
              <p className="text-sm text-neto-txt2 leading-relaxed">
                {step.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
