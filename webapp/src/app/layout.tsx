import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import { PostHogProvider } from "@/components/PostHogProvider";
import { AppToaster } from "@/components/shared/app-toaster";
import "./globals.css";

// Todo lo que se monte acá entra al bundle de TODA ruta, incluida `/login` — la primera
// pantalla del que llega desde WhatsApp, a menudo por el navegador embebido y con datos
// móviles (hallazgo P′8). Antes de sumar algo, preguntate si `/login` lo necesita.
//
// Lo que se fue: `TooltipProvider` (@base-ui), **51.5 KB gzip** medidos, para cero tooltips
// fuera del dashboard. Vive ahora en `DashboardShell`, que es donde están sus dos únicos
// consumidores (`whatsapp-button`, `quick-add-button`).
//
// Lo que se QUEDA, y por qué, porque el primer intento lo sacó y estaba mal:
//
// - `<AppToaster>` (sonner) cuesta 9.2 KB gzip acá, y moverlo a cada superficie rompía los
//   toasts que se disparan JUSTO ANTES de navegar. Sonner no re-emite: el `<Toaster>` se
//   suscribe al montarse y arranca vacío, así que si el árbol que lo contiene se desmonta
//   con la navegación, el toast no llega a verse en ningún lado. Los dos casos reales son
//   el "Sesión cerrada" de `user-menu` (que empuja a `/`) y el "Cuenta verificada" del
//   onboarding (que puede aterrizar en `/join/*`, un árbol sin dashboard). 9.2 KB es el
//   precio de que un aviso de éxito no desaparezca en silencio.
// - `PostHogProvider`: la analítica tiene que ver el login. El SDK ya se carga perezoso
//   (chunk aparte, fuera de la primera carga), así que su costo no es de este layout.

const spaceGrotesk = Space_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "NETO — Dashboard financiero | Tu app de gastos",
  description:
    "Tu dashboard financiero personal. Visualiza gastos, ingresos, presupuestos, metas y score financiero. Anota por WhatsApp o desde la app.",
  icons: { icon: "/neto-icon.png", apple: "/neto-icon.png" },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "NETO",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${spaceGrotesk.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#0E0E0C]">
        <PostHogProvider>{children}</PostHogProvider>
        <AppToaster />
      </body>
    </html>
  );
}
