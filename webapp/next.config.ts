import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // All pages that use Supabase must be dynamically rendered
  // (not pre-rendered at build time)
  experimental: {},
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
};

export default nextConfig;
