import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Expose the demo flag to the client bundle (drives IS_DEMO / mock data).
  env: {
    NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE || 'false',
  },
  experimental: {
    // Tree-shake heavy libs: import only the icons/charts/animations actually used
    optimizePackageImports: ['lucide-react', 'recharts', 'motion'],
  },
  // Pin the Turbopack root to this app: the backend in ../ has its own
  // package-lock.json, so without this Turbopack infers the wrong workspace root.
  turbopack: {
    root: __dirname,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';
    // CSP fase 1: bloquea exfiltración (connect-src), clickjacking (frame-ancestors),
    // inyección de <base>/plugins (base-uri/object-src) y form-action. script-src mantiene
    // 'unsafe-inline' porque Next.js inyecta scripts inline de hidratación/streaming sin nonce;
    // el hardening con nonce-middleware queda como fase 2. En dev se agrega 'unsafe-eval' para
    // el HMR de Turbopack (no se envía en producción).
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' https://us-assets.i.posthog.com${isDev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://lh3.googleusercontent.com https://us-assets.i.posthog.com",
      "font-src 'self' data:",
      // Supabase (auth/DB/realtime) + PostHog (ingest us.i + assets us-assets). Google fonts
      // se auto-hospedan en build (next/font), no requieren host externo.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://us.i.posthog.com https://us-assets.i.posthog.com",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
    ].join('; ');
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default nextConfig;
