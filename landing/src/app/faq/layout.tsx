import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Preguntas Frecuentes — Neto",
  description:
    "Preguntas frecuentes sobre Neto — Asistente financiero por WhatsApp para Perú",
  alternates: { canonical: "https://neto.pe/faq" },
};

export default function FaqLayout({ children }: { children: React.ReactNode }) {
  return children;
}
