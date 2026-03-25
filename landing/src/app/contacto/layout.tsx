import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contacto — Neto",
  description:
    "Contáctanos por WhatsApp o correo. Neto — Asistente financiero personal por WhatsApp para Perú",
  alternates: { canonical: "https://neto.pe/contacto" },
};

export default function ContactoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
