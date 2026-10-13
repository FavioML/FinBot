import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import { PostHogProvider } from "@/components/PostHogProvider";
import { AppToaster } from "@/components/shared/app-toaster";
import { SCRIPT_TEMA, THEME_COLOR } from "@/lib/tema";
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
//
// El tema claro/oscuro NO es un provider: es un script inline en <head> (`lib/tema.ts`). Va inline
// y no en un componente porque tiene que correr antes del primer pintado: el dashboard es un shell
// estático y sin él se vería un destello del otro tema. Medido el 12-oct-2026 contra HEAD: mismos
// 14 `<script src>` en `/login`, +663 B gzip de JS (el `useTema` de `AppToaster`, que sonner
// necesita para pintar sus colores internos con el tema resuelto) y +754 B gzip de HTML.

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
    // `default` y no `black-translucent`: con translucent la hora del iPhone es blanca y en el
    // tema claro no se ve. Con `default` iOS toma el theme-color de abajo.
    statusBarStyle: "default",
    title: "NETO",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

// Cada <meta> lleva el color del esquema del SISTEMA; el script de tema los pisa cuando el usuario
// eligió lo contrario.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
  colorScheme: "light dark",
};

// Patrón de `node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`:
// `text/plain` en el cliente para que React no avise por renderizar un <script>, y
// `suppressHydrationWarning` para esa diferencia. Con la CSP actual (`'unsafe-inline'`) corre;
// si la CSP pasa a nonces, este script necesita el suyo.
function ScriptTema() {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: SCRIPT_TEMA }}
    />
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${spaceGrotesk.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <ScriptTema />
      </head>
      <body className="min-h-full flex flex-col bg-background">
        <PostHogProvider>{children}</PostHogProvider>
        <AppToaster />
      </body>
    </html>
  );
}
