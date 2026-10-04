import dotenv from 'dotenv';
import path from 'path';
import { readEnvFileText } from './envFile';

/**
 * Loads the repository `.env`, and does it FIRST.
 *
 * Import this before anything else in the entry point. ES import bindings are
 * evaluated depth-first before the importing module's own statements, so a
 * `dotenv.config()` written in the body of index.ts runs AFTER every module it
 * imports has already been evaluated - which meant module-scope reads such as
 * `process.env.AI_CLI_MODEL` in aiModelCatalog never saw the file at all.
 * Putting the load in its own module makes "first import wins" do the work.
 *
 * `override: true` semantics are preserved below: the checked-in `.env` beats
 * whatever the shell happens to export.
 */

/**
 * The ONE file this app reads, exported so a doctor can report it rather than
 * recompute it. Resolved from this compiled module, so it is always the
 * repository root - never `backend/.env`, which is where it gets put by anyone
 * running the scripts from `backend/`.
 */
export const ENV_PATH = path.join(__dirname, '../../../.env');

const parsed = dotenv.parse(readEnvFileText(ENV_PATH));
for (const [key, value] of Object.entries(parsed)) {
  process.env[key] = value;
}

