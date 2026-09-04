import type { NextConfig } from "next";
import path from "path";

// Extra origins allowed to reach the dev server, e.g. the LAN address the
// frontend is served from. Comma separated, configured per environment.
const configuredDevOrigins = (process.env.NEXT_PUBLIC_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...configuredDevOrigins,
  ],
  turbopack: {
    // Restrict root to frontend only to avoid watching backend/static and other sibling dirs
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
