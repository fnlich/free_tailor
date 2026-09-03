import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://100.1.12.1:3000",
    "100.1.12.1",
  ],
  turbopack: {
    // Restrict root to frontend only to avoid watching backend/data and other sibling dirs
    root: path.join(__dirname),
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/.next/**",
          path.join(__dirname, "..", "backend"),
          path.join(__dirname, "..", "generated"),
        ],
        aggregateTimeout: 300,
      };
    }
    return config;
  },
};

export default nextConfig;
