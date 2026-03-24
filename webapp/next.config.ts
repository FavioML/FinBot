import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // All pages that use Supabase must be dynamically rendered
  // (not pre-rendered at build time)
  experimental: {},
};

export default nextConfig;
