import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // FASE 1 FIX: Include yt-dlp binary in function bundle for Vercel
  experimental: {
    outputFileTracingIncludes: {
      '/api/analyze': ['./node_modules/youtube-dl-exec/bin/**/*'],
    },
  },
};

export default nextConfig;
