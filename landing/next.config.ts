import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  turbopack: { root: "." },
  // Rewrites only work in dev mode (ignored in static export)
  async rewrites() {
    return [
      {
        source: "/mi-reporte/:id",
        destination: "/mi-reporte",
      },
      {
        source: "/api/reporte/:id",
        destination: "/api/reporte/:id.json",
      },
    ];
  },
};

export default nextConfig;
