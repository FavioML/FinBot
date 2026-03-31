"use client";

import { useState } from "react";
import { Send, Mail, Phone, User, MessageSquare } from "lucide-react";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";

export default function ContactoPage() {
  const [sent, setSent] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const nombre = data.get("nombre") as string;
    const correo = data.get("correo") as string;
    const telefono = data.get("telefono") as string;
    const mensaje = data.get("mensaje") as string;

    // Build WhatsApp message with form data
    const text = encodeURIComponent(
      `Hola, soy ${nombre}.\n\nCorreo: ${correo}\nTeléfono: ${telefono}\n\nMensaje: ${mensaje}`
    );
    window.open(`https://wa.me/51933014505?text=${text}`, "_blank");
    setSent(true);
  }

  return (
    <>
      <Navbar />
      <main className="bg-[#0E0E0C] min-h-screen">
        <div className="mx-auto max-w-[600px] px-6 pt-28 pb-20 min-[860px]:pt-32">
          {/* Header */}
          <div className="text-center mb-12">
            <span className="inline-block rounded-full bg-[#1D9E75]/10 px-5 py-2 text-xs font-medium text-[#68dbae] mb-6 tracking-wide">
              Contacto
            </span>
            <h1 className="text-3xl min-[860px]:text-4xl font-extrabold tracking-tight text-[#e5e2de] mb-4">
              Conversemos.
            </h1>
            <p className="text-[#87948c] text-lg leading-relaxed">
              ¿Tienes una pregunta, sugerencia o quieres activar tu banco? Escríbenos y te respondemos por WhatsApp.
            </p>
          </div>

          {/* Form */}
          {sent ? (
            <div className="rounded-[24px] bg-[#1C1C19] p-10 text-center">
              <div className="w-16 h-16 rounded-full bg-[#1D9E75]/20 flex items-center justify-center mx-auto mb-6">
                <Send size={28} className="text-[#68dbae]" />
              </div>
              <h2 className="text-xl font-bold text-[#e5e2de] mb-3">
                Mensaje enviado
              </h2>
              <p className="text-[#87948c] mb-6">
                Te redirigimos a WhatsApp para completar el envío. Te responderemos lo antes posible.
              </p>
              <a
                href="/"
                className="inline-flex items-center gap-2 rounded-full bg-[#2A2A28] text-[#e5e2de] px-6 py-3 text-sm font-semibold hover:bg-[#353532] transition-colors cursor-pointer"
              >
                Volver al inicio
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="rounded-[24px] bg-[#1C1C19] p-8 space-y-5">
              {/* Nombre */}
              <div>
                <label htmlFor="nombre" className="flex items-center gap-2 text-sm font-medium text-[#bccac1] mb-2">
                  <User size={14} className="text-[#68dbae]" />
                  Nombre
                </label>
                <input
                  id="nombre"
                  name="nombre"
                  type="text"
                  required
                  placeholder="Tu nombre completo"
                  className="w-full rounded-xl bg-[#20201d] border-none px-4 py-3 text-sm text-[#e5e2de] placeholder-[#87948c]/60 outline-none focus:ring-2 focus:ring-[#1D9E75]/40 transition-all"
                />
              </div>

              {/* Correo */}
              <div>
                <label htmlFor="correo" className="flex items-center gap-2 text-sm font-medium text-[#bccac1] mb-2">
                  <Mail size={14} className="text-[#68dbae]" />
                  Correo electrónico
                </label>
                <input
                  id="correo"
                  name="correo"
                  type="email"
                  required
                  placeholder="tu@correo.com"
                  className="w-full rounded-xl bg-[#20201d] border-none px-4 py-3 text-sm text-[#e5e2de] placeholder-[#87948c]/60 outline-none focus:ring-2 focus:ring-[#1D9E75]/40 transition-all"
                />
              </div>

              {/* Teléfono */}
              <div>
                <label htmlFor="telefono" className="flex items-center gap-2 text-sm font-medium text-[#bccac1] mb-2">
                  <Phone size={14} className="text-[#68dbae]" />
                  Teléfono
                </label>
                <input
                  id="telefono"
                  name="telefono"
                  type="tel"
                  required
                  placeholder="+51 999 999 999"
                  className="w-full rounded-xl bg-[#20201d] border-none px-4 py-3 text-sm text-[#e5e2de] placeholder-[#87948c]/60 outline-none focus:ring-2 focus:ring-[#1D9E75]/40 transition-all"
                />
              </div>

              {/* Mensaje */}
              <div>
                <label htmlFor="mensaje" className="flex items-center gap-2 text-sm font-medium text-[#bccac1] mb-2">
                  <MessageSquare size={14} className="text-[#68dbae]" />
                  Mensaje
                </label>
                <textarea
                  id="mensaje"
                  name="mensaje"
                  required
                  rows={4}
                  placeholder="Cuéntanos en qué podemos ayudarte..."
                  className="w-full rounded-xl bg-[#20201d] border-none px-4 py-3 text-sm text-[#e5e2de] placeholder-[#87948c]/60 outline-none focus:ring-2 focus:ring-[#1D9E75]/40 transition-all resize-none"
                />
              </div>

              {/* Submit */}
              <button
                type="submit"
                className="w-full rounded-full bg-gradient-to-br from-[#68dbae] to-[#26a37a] text-[#002115] px-6 py-3.5 text-sm font-semibold transition-all duration-300 hover:shadow-[0_0_40px_rgba(29,158,117,0.35)] hover:scale-[1.02] cursor-pointer flex items-center justify-center gap-2"
              >
                Enviar mensaje
                <Send size={16} />
              </button>
            </form>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
