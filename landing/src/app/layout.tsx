import type { Metadata } from "next";
import { Manrope, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const GA_ID = "G-6M907HW1YM";
const AW_ID = "AW-8115117081";
const FB_PIXEL = "1510666681068015";

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
  title: "Neto — Asistente financiero por WhatsApp | Peru",
  description:
    "Neto lee tus correos de gastos financieros, categoriza con IA y te resume todo por WhatsApp. Sin apps. Sin contraseñas bancarias. 100% peruano.",
  keywords:
    "finanzas personales Peru, asistente financiero WhatsApp, control de gastos Peru, Yape BCP Interbank BBVA, gastos hormiga, ahorro Peru, presupuesto personal",
  openGraph: {
    title: "Neto — Asistente financiero por WhatsApp | Peru",
    description:
      "Lee tus correos de gastos financieros, categoriza con IA y te resume todo por WhatsApp. Sin contraseñas bancarias.",
    url: "https://neto.pe",
    type: "website",
    locale: "es_PE",
    siteName: "Neto",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Neto — Asistente financiero por WhatsApp para Peru" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Neto — Asistente financiero por WhatsApp | Peru",
    description:
      "Lee tus correos de gastos financieros, categoriza con IA y te resume todo por WhatsApp. Sin contraseñas bancarias.",
    images: ["/og-image.png"],
  },
  robots: { index: true, follow: true },
  alternates: {
    canonical: "https://neto.pe",
    languages: { "es-PE": "https://neto.pe" },
  },
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
  const organizationSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Neto",
    url: "https://neto.pe",
    logo: "https://neto.pe/neto-icon.png",
    description:
      "Asistente financiero personal por WhatsApp para Peru. Lee correos de gastos financieros y categoriza con IA.",
    areaServed: { "@type": "Country", name: "Peru" },
    sameAs: [
      "https://www.instagram.com/neto_peru",
      "https://www.tiktok.com/@neto_peru",
    ],
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer service",
      availableLanguage: "Spanish",
      url: "https://wa.me/51933014505",
    },
  };

  const websiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Neto",
    url: "https://neto.pe",
    inLanguage: "es-PE",
  };

  return (
    <html lang="es-PE" className={`${manrope.variable} ${inter.variable}`}>
      <head>
        <link rel="alternate" hrefLang="es-PE" href="https://neto.pe" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([organizationSchema, websiteSchema]),
          }}
        />
      </head>
      <body>
        {children}
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
            gtag('config', '${AW_ID}');
          `}
        </Script>
        <Script id="fb-pixel" strategy="afterInteractive">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '${FB_PIXEL}');
            fbq('track', 'PageView');
          `}
        </Script>
      </body>
    </html>
  );
}
