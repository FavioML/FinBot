import type { Metadata } from "next";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import { ArrowRight, Mail, Brain, MessageSquare, LayoutDashboard, Shield, HelpCircle } from "lucide-react";

export const metadata: Metadata = {
  title: "Cómo funciona Neto — Asistente financiero por WhatsApp",
  description:
    "Conecta tu Gmail en 1 clic, Neto lee tus correos bancarios automáticamente, categoriza con IA y te resume todo por WhatsApp. Sin contraseñas. Sin apps.",
  keywords:
    "cómo funciona neto, asistente financiero whatsapp, conectar banco whatsapp, control gastos automático peru",
  openGraph: {
    title: "Cómo funciona Neto — 4 pasos, cero fricción",
    description:
      "Conecta tu Gmail, Neto lee tus correos bancarios, categoriza con IA y te resume por WhatsApp. Gratis.",
    url: "https://neto.pe/como-funciona",
    type: "website",
    locale: "es_PE",
    siteName: "Neto",
  },
  alternates: { canonical: "https://neto.pe/como-funciona" },
};

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const STEPS = [
  {
    num: "01",
    Icon: Mail,
    title: "Conectas tu Gmail",
    desc: "Escríbele \"Hola\" a Neto por WhatsApp. Te enviará un enlace para conectar tu Gmail con un solo clic. Neto solo accede a los correos de notificación bancaria — nunca tus correos personales, laborales ni contraseñas.",
    detail: "Usamos Google OAuth, el mismo sistema que usan apps como Uber o Rappi. Puedes revocar el acceso en cualquier momento desde tu cuenta de Google.",
    accent: "text-[#EF9F27]",
    bg: "bg-[#EF9F27]/10",
  },
  {
    num: "02",
    Icon: Brain,
    title: "Neto lee y categoriza automáticamente",
    desc: "Cada vez que tu banco te envía un correo de notificación (compra, transferencia, pago), Neto lo detecta al instante. Extrae el monto, el comercio y la fecha.",
    detail: "La IA clasifica cada gasto en 11 categorías (alimentación, transporte, vivienda, etc.) y aprende tus comercios frecuentes para mejorar con el tiempo.",
    accent: "text-[#68dbae]",
    bg: "bg-[#1D9E75]/10",
  },
  {
    num: "03",
    Icon: MessageSquare,
    title: "Recibes resúmenes por WhatsApp",
    desc: "Sin abrir ninguna app, Neto te manda resúmenes directamente a WhatsApp. Semanal con tu total gastado y mensual con análisis completo.",
    detail: "Con el plan Pro también recibes resumen diario, consejos personalizados con IA y alertas cuando te acercas al límite de tus presupuestos.",
    accent: "text-[#25D366]",
    bg: "bg-[#25D366]/10",
  },
  {
    num: "04",
    Icon: LayoutDashboard,
    title: "Exploras tu dashboard web",
    desc: "Entra a app.neto.pe para ver gráficos interactivos, score financiero, calendario de gastos, detección de suscripciones y reportes PDF descargables.",
    detail: "El dashboard funciona en cualquier navegador (computadora o celular). No necesitas descargar ninguna aplicación.",
    accent: "text-[#818cf8]",
    bg: "bg-[#818cf8]/10",
  },
];

const FAQS = [
  {
    q: "¿Es seguro conectar mi Gmail?",
    a: "Sí. Usamos Google OAuth (el mismo sistema de Uber, Spotify, etc.). Solo leemos correos de notificación bancaria. Nunca accedemos a tus correos personales, laborales ni a tu banca en línea. Puedes revocar el acceso en cualquier momento.",
  },
  {
    q: "¿Necesito dar mi contraseña del banco?",
    a: "No. Nunca pedimos usuario ni contraseña de tu banco. Neto solo lee los correos que tu banco ya te envía automáticamente cuando haces una compra o transferencia.",
  },
  {
    q: "¿Con qué bancos funciona?",
    a: "BCP, BBVA, Interbank, Scotiabank, Yape, Plin, Falabella, Ripley, BanBif, Mibanco y CMAC. Si tu banco envía correos de notificación, probablemente funciona.",
  },
  {
    q: "¿Cuánto cuesta?",
    a: "El plan gratuito incluye WhatsApp ilimitado, presupuestos y metas ilimitados, lectura de fotos Yape/Plin y dashboard del mes actual. El plan Pro cuesta S/10/mes (o S/99/año) y desbloquea lectura automática de correos bancarios, historial completo, reportes PDF, resumen diario con IA y más.",
  },
  {
    q: "¿Puedo dejar de usarlo cuando quiera?",
    a: "Sí. Puedes revocar el acceso a tu Gmail desde tu cuenta de Google en cualquier momento. Tus datos se eliminan si lo solicitas. Sin contratos, sin permanencia.",
  },
];

export default function ComoFunciona() {
  const howItWorksSchema = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "Cómo funciona Neto — Asistente financiero por WhatsApp",
    description: "Conecta tu Gmail, Neto lee tus correos bancarios, categoriza con IA y te resume todo por WhatsApp.",
    step: STEPS.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.title,
      text: s.desc,
    })),
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-[#0E0E0C]">
        {/* Hero */}
        <section className="pt-32 pb-16 px-6">
          <div className="mx-auto max-w-[800px] text-center">
            <p className="text-sm text-[#1D9E75] font-medium tracking-wide uppercase mb-4">
              Cómo funciona
            </p>
            <h1 className="text-4xl min-[860px]:text-6xl font-extrabold leading-tight mb-6">
              <span className="bg-gradient-to-b from-[#e5e2de] to-[#87948c] bg-clip-text text-transparent">
                Cuatro pasos.
              </span>
              <br />
              <span className="bg-gradient-to-r from-[#68dbae] to-[#1D9E75] bg-clip-text text-transparent">
                Cero fricción.
              </span>
            </h1>
            <p className="text-lg text-[#87948c] max-w-[560px] mx-auto leading-relaxed">
              Neto se conecta a tu correo, lee las notificaciones de tu banco y te manda
              todo resumido a WhatsApp. Así de simple.
            </p>
          </div>
        </section>

        {/* Steps */}
        <section className="pb-20 px-6">
          <div className="mx-auto max-w-[800px] space-y-8">
            {STEPS.map((step) => (
              <div
                key={step.num}
                className="rounded-3xl bg-[#1C1C19] border border-white/5 p-8 min-[640px]:p-10"
              >
                <div className="flex items-start gap-5">
                  <div className={`flex-shrink-0 flex h-12 w-12 items-center justify-center rounded-2xl ${step.bg}`}>
                    <step.Icon className={`h-6 w-6 ${step.accent}`} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-3">
                      <span className={`text-xs font-bold ${step.accent} opacity-60`}>
                        PASO {step.num}
                      </span>
                    </div>
                    <h2 className="text-xl font-bold text-[#e5e2de] mb-3">
                      {step.title}
                    </h2>
                    <p className="text-[#87948c] leading-relaxed mb-3">
                      {step.desc}
                    </p>
                    <p className="text-sm text-[#87948c]/70 leading-relaxed">
                      {step.detail}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Security callout */}
        <section className="pb-20 px-6">
          <div className="mx-auto max-w-[800px]">
            <div className="rounded-3xl bg-[#1D9E75]/5 border border-[#1D9E75]/20 p-8 min-[640px]:p-10 flex items-start gap-5">
              <div className="flex-shrink-0 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#1D9E75]/15">
                <Shield className="h-6 w-6 text-[#1D9E75]" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-[#e5e2de] mb-2">
                  Tu seguridad es nuestra prioridad
                </h3>
                <p className="text-[#87948c] leading-relaxed">
                  Neto nunca accede a tu banca en línea. Solo lee correos de notificación
                  bancaria usando Google OAuth (el mismo sistema que usan Uber, Spotify y
                  miles de apps). Tus datos están encriptados con TLS y protegidos con
                  Row-Level Security. Puedes revocar el acceso cuando quieras.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="pb-20 px-6">
          <div className="mx-auto max-w-[800px]">
            <div className="flex items-center gap-3 mb-8">
              <HelpCircle className="h-5 w-5 text-[#EF9F27]" />
              <h2 className="text-2xl font-bold text-[#e5e2de]">Preguntas frecuentes</h2>
            </div>
            <div className="space-y-4">
              {FAQS.map((faq, i) => (
                <div key={i} className="rounded-2xl bg-[#1C1C19] border border-white/5 p-6">
                  <h3 className="font-semibold text-[#e5e2de] mb-2">{faq.q}</h3>
                  <p className="text-sm text-[#87948c] leading-relaxed">{faq.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="pb-24 px-6">
          <div className="mx-auto max-w-[800px] text-center">
            <h2 className="text-3xl font-bold text-[#e5e2de] mb-4">
              Empieza en 2 minutos
            </h2>
            <p className="text-[#87948c] mb-8 max-w-md mx-auto">
              Escríbele &quot;Hola&quot; a Neto por WhatsApp y conecta tu banco.
              Gratis, sin contraseñas, sin descargar nada.
            </p>
            <a
              href={WA_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-[#1D9E75] hover:bg-[#1D9E75]/90 text-white font-semibold px-8 py-4 text-lg transition-colors"
            >
              Regístrate ahora
              <ArrowRight size={18} />
            </a>
          </div>
        </section>
      </main>
      <Footer />

      {/* JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howItWorksSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
    </>
  );
}
