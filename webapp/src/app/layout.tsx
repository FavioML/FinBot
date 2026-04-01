import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "NETO — Dashboard financiero | Tu app de gastos",
  description:
    "Tu dashboard financiero personal. Visualiza gastos, ingresos, presupuestos, metas y score financiero. Conecta tu banco por WhatsApp.",
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
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#1A1A18',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#F0EFE8',
              fontSize: '14px',
            },
          }}
        />
      </body>
    </html>
  );
}
