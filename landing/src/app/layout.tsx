import type { Metadata } from "next";
import { Manrope, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const GA_ID = "G-6M907HW1YM";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-heading",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://neto.pe"),
  title: "Neto — Tu asistente financiero personal",
  description:
    "Neto lee tus correos del banco, Yape y Plin automáticamente y te manda un resumen a WhatsApp. Sin apps. Sin contraseñas bancarias. 100% peruano.",
  keywords:
    "finanzas personales Peru, asistente financiero WhatsApp, control de gastos Peru, Yape BCP Interbank BBVA, gastos hormiga, ahorro Peru",
  openGraph: {
    title: "Neto — Tu asistente financiero personal",
    description:
      "Ordena tu plata sin mover un dedo. Lee tu banco, Yape y Plin automáticamente.",
    url: "https://neto.pe",
    type: "website",
    locale: "es_PE",
    siteName: "Neto",
  },
  twitter: {
    card: "summary_large_image",
    title: "Neto — Tu asistente financiero personal",
    description:
      "Ordena tu plata sin mover un dedo. Lee tu banco, Yape y Plin automáticamente.",
  },
  robots: { index: true, follow: true },
  alternates: { canonical: "https://neto.pe" },
  icons: {
    icon: [
      { url: "/neto-icon.png", type: "image/png", sizes: "512x512" },
      { url: "/logo-icon.svg", type: "image/svg+xml" },
    ],
    apple: "/neto-icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={`${manrope.variable} ${inter.variable}`}>
      <head>
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
          strategy="afterInteractive"
        />
        <Script id="ga4-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_ID}');
          `}
        </Script>
      </head>
      <body>{children}</body>
    </html>
  );
}
