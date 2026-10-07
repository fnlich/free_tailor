import type { NextConfig } from "next";
import path from "path";

// Extra origins allowed to reach the dev server, e.g. the LAN address the
// frontend is served from. Comma separated, configured per environment.
const configuredDevOrigins = (process.env.NEXT_PUBLIC_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Glob patterns that exclude a sibling directory of `frontend/` from the dev
 * watcher.
 *
 * The separator conversion is what makes this work on Windows. watchpack
 * matches through anymatch, which normalises the path it is TESTING to forward
 * slashes but leaves the pattern alone - so a pattern built with
 * `path.join` carries backslashes on Windows and can never match. The result
 * was a frontend dev server that rebuilt every time the backend watcher wrote
 * a file, on Windows only.
 */
function siblingIgnorePatterns(name: string): string[] {
  const absolute = path.join(__dirname, "..", name).replace(/\\/g, "/");
  return [absolute, `${absolute}/**`];
}

const nextConfig: NextConfig = {
  /*
   * Since 16.3, `next dev` started by an AI coding agent (Claude Code among
   * them, detected from its environment) writes frontend/AGENTS.md and
   * frontend/CLAUDE.md whenever they lack Next's own block - untracked files
   * in the working tree on every such start, and a second CLAUDE.md that the
   * agent then loads on top of the repository's. The repository's CLAUDE.md
   * is the one set of instructions; the docs for the installed Next, which
   * that block points at, are in node_modules/next/dist/docs/ either way.
   */
  agentRules: false,
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
          ...siblingIgnorePatterns("backend"),
          ...siblingIgnorePatterns("generated"),
        ],
        aggregateTimeout: 300,
      };
    }
    return config;
  },
};

export default nextConfig;
