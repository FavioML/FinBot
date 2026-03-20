import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Preguntas Frecuentes - Neto",
  description:
    "Preguntas frecuentes de Neto - Tu asistente financiero personal por WhatsApp",
};

export default function FaqLayout({ children }: { children: React.ReactNode }) {
  return children;
}
