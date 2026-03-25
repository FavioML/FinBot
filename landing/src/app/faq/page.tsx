"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const FAQ_DATA = [
  {
    group: "Sobre el servicio",
    items: [
      {
        q: "Que es Neto exactamente?",
        a: "Neto es tu asistente financiero personal que opera 100% por WhatsApp. Lee automaticamente los correos de notificacion que tu banco y Yape/Plin ya te envian, organiza tus gastos por categoria con IA y te manda un resumen a WhatsApp. Sin apps que descargar, sin ingresar datos manualmente.",
      },
      {
        q: "Que bancos y billeteras son compatibles?",
        a: 'Actualmente Neto es compatible con BCP, BBVA Peru, Interbank, Scotiabank, Yape y Plin. Si tu banco no esta en la lista, escribenos a <a href="mailto:hola@neto.pe" class="text-neto-green hover:underline">hola@neto.pe</a> - lo podemos activar a solicitud.',
      },
      {
        q: "Neto funciona sin internet o fuera de Lima?",
        a: "Neto procesa los correos en la nube, asi que necesitas que tu correo de Gmail reciba las notificaciones bancarias. Funciona desde cualquier lugar del Peru - no importa donde estes.",
      },
    ],
  },
  {
    group: "Privacidad y seguridad",
    items: [
      {
        q: "Neto accede a mi cuenta bancaria?",
        a: "No. Neto nunca accede a tu banca en linea ni te pide usuario o contrasena bancaria. Solo lee los correos de notificacion automatica que tu banco ya te envia - los mismos que llegarian aunque no usaras Neto.",
      },
      {
        q: "Que correos exactamente lee Neto?",
        a: 'Solo los correos de transacciones: notificaciones de compras, transferencias y cargos bancarios. Neto no lee tus correos personales, laborales ni ningun otro tipo de correo. Puedes verificar y revocar este acceso en cualquier momento desde <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" class="text-neto-green hover:underline">myaccount.google.com/permissions</a>.',
      },
      {
        q: "Venden mis datos a terceros?",
        a: 'No. Nunca. Tus datos financieros son estrictamente personales y solo se usan para brindarte el servicio. Consulta nuestra <a href="/privacidad" class="text-neto-green hover:underline">Politica de Privacidad</a> para mas detalles.',
      },
    ],
  },
  {
    group: "Planes y pagos",
    items: [
      {
        q: "Que incluye el plan gratis?",
        a: 'El plan gratis incluye: resumen de gastos por WhatsApp, categorizacion automatica con IA, correccion de categorias y consultas en lenguaje natural ("cuanto gaste en delivery?"). Es gratis para siempre, sin tarjeta de credito.',
      },
      {
        q: "Que incluye el plan Pro?",
        a: "El plan Pro (S/10/mes o S/99/ano) incluye todo lo del plan Gratis mas: reportes mensuales web ilimitados, historial ilimitado de transacciones, resumenes automaticos configurables, score de salud financiera y la opcion de pagar con Yape o tarjeta.",
      },
      {
        q: "Puedo pagar con Yape?",
        a: "Si. Neto acepta Yape, tarjeta de debito y tarjeta de credito. Somos el unico asistente financiero en Peru que acepta Yape como metodo de pago.",
      },
      {
        q: "Puedo cancelar cuando quiera?",
        a: "Si, sin tramites ni penalidades. Si cancelas, mantienes el acceso Pro hasta el final del periodo pagado y luego bajas automaticamente al plan Gratis. Tus datos historicos se conservan.",
      },
    ],
  },
  {
    group: "Uso del servicio",
    items: [
      {
        q: "Como empiezo a usar Neto?",
        a: 'Escribenos por WhatsApp al <a href="https://wa.me/51933014505" target="_blank" rel="noopener noreferrer" class="text-neto-green hover:underline">+51 933 014 505</a>. Neto te guiara paso a paso para conectar tu Gmail. El proceso toma menos de 2 minutos.',
      },
      {
        q: "Puedo corregir una categoria incorrecta?",
        a: 'Si. Solo escribele a Neto en lenguaje natural: "Cambia Rappi a delivery" o "Ese cargo de Netflix es suscripcion". Neto lo corrige y aprende para futuras transacciones del mismo comercio.',
      },
      {
        q: "Cada cuanto llega el resumen automatico?",
        a: "Con el plan Pro puedes configurar la frecuencia y el horario que prefieras. Con el plan Gratis puedes pedir tu resumen cuando quieras escribiendo a Neto por WhatsApp.",
      },
      {
        q: "Que es el reporte mensual web?",
        a: "Es un reporte completo de 3 paginas disponible en el navegador (no descarga obligatoria). Incluye: analisis de gastos por categoria, top comercios, suscripciones detectadas, score de salud financiera y 3 acciones concretas para el mes siguiente. Se accede desde un link que Neto te envia por WhatsApp.",
      },
    ],
  },
];

function FaqItem({
  question,
  answer,
  isOpen,
  onToggle,
}: {
  question: string;
  answer: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-white/6">
      <button
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-4 py-4 text-left cursor-pointer"
      >
        <span className="text-[15px] font-medium text-neto-txt leading-snug flex-1">
          {question}
        </span>
        <span
          className={`text-lg text-neto-green shrink-0 mt-0.5 transition-transform duration-200 ${
            isOpen ? "rotate-45" : ""
          }`}
        >
          +
        </span>
      </button>
      {isOpen && (
        <div
          className="pb-4 text-sm text-neto-txt2 leading-7"
          dangerouslySetInnerHTML={{ __html: answer }}
        />
      )}
    </div>
  );
}

export default function FaqPage() {
  const [openIndex, setOpenIndex] = useState<string | null>(null);

  const handleToggle = (key: string) => {
    setOpenIndex(openIndex === key ? null : key);
  };

  return (
    <>
      <Navbar />
      <main className="bg-neto-bg min-h-screen">
        <article className="mx-auto max-w-[800px] px-6 pt-28 pb-20 md:pt-32">
          {/* Header */}
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-neto-green mb-3">
            <span className="w-4 h-[2px] bg-neto-green" />
            Ayuda
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">
            Preguntas frecuentes
          </h1>
          <p className="text-base text-neto-txt2 font-light mb-10 pb-6 border-b border-white/7 leading-relaxed">
            Todo lo que necesitas saber antes de empezar. Si no encuentras tu
            respuesta, escribenos a{" "}
            <a
              href="mailto:hola@neto.pe"
              className="text-neto-green hover:underline"
            >
              hola@neto.pe
            </a>
            .
          </p>

          {/* FAQ Groups */}
          <div className="space-y-10">
            {FAQ_DATA.map((group) => (
              <section key={group.group}>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neto-green mb-3">
                  <span className="w-3.5 h-[2px] bg-neto-green" />
                  {group.group}
                </div>
                <div>
                  {group.items.map((item, i) => {
                    const key = `${group.group}-${i}`;
                    return (
                      <FaqItem
                        key={key}
                        question={item.q}
                        answer={item.a}
                        isOpen={openIndex === key}
                        onToggle={() => handleToggle(key)}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          {/* CTA Box */}
          <div className="bg-neto-green rounded-2xl p-7 mt-12 flex items-center justify-between gap-5 flex-wrap">
            <div>
              <h3 className="text-lg font-bold text-white mb-1">
                Tienes otra pregunta?
              </h3>
              <p className="text-sm text-white/75">
                Escribenos y te respondemos en menos de 24 horas.
              </p>
            </div>
            <a
              href="https://wa.me/51933014505"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-white text-neto-green-dark rounded-full px-6 py-2.5 text-sm font-semibold hover:opacity-90 transition-opacity shrink-0"
            >
              Escribir a Neto
            </a>
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
