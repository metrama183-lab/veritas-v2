import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // FASE 1 FIX: Ensure yt-dlp binary is available in serverless environment
  // Note: youtube-dl-exec is marked as external to prevent bundling issues
  serverExternalPackages: ['youtube-dl-exec'],
};

export default nextConfig;
