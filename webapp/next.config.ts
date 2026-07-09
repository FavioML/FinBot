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
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default nextConfig;
