#!/usr/bin/env node
/**
 * Checks, before the root `npm run dev` (and `dev:live`, `dev:poll`) reaches
 * `concurrently`, that every package the root, backend and frontend
 * package.json files name is installed. npm runs it as their `pre` hooks.
 *
 * Silent, and exit 0, when everything is there. Otherwise one message - what
 * is missing in which package, and `npm run install:all` from the repository
 * root by its path - and exit 1, which stops npm before the script itself, so
 * the person never meets cmd's "'concurrently' is not recognized ..." or sh's
 * "concurrently: not found" instead. What is missing and what to say are
 * decided in installCheck.mjs, which has no side effects and is tested from
 * backend/test/installCheck.test.js; this file reads the disk and the
 * environment for it.
 *
 * It needs nothing installed - it runs exactly when packages are missing - so
 * it imports only Node's own modules, and installCheck.mjs inside the `try`.
 * It never throws: a check of the install must not stop a launch over a fault
 * of its own, so one prints a line and lets the script go on.
 *
 * Usage: node scripts/checkInstall.mjs   (from anywhere - the root is found
 * from this file's own location)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const { installAdvice, missingPackages, npmSettingsFrom, scriptBefore } = await import('./installCheck.mjs');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const missing = missingPackages({
    root,
    join,
    exists: existsSync,
    read: (file) => readFileSync(file, 'utf8'),
  });
  const advice = installAdvice({
    root,
    missing,
    ...npmSettingsFrom(process.env),
    script: scriptBefore(process.env.npm_lifecycle_event),
  });
  if (advice) {
    console.error(advice);
    // exitCode, not process.exit(): a write to a Windows console is
    // asynchronous, and exiting at once can cut the message off.
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `[install] Could not check which packages are installed (${error instanceof Error ? error.message : String(error)}); going on.`
  );
}
