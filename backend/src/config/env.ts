import dotenv from 'dotenv';
import path from 'path';

/**
 * Loads the repository `.env`, and does it FIRST.
 *
 * Import this before anything else in the entry point. ES import bindings are
 * evaluated depth-first before the importing module's own statements, so a
 * `dotenv.config()` written in the body of index.ts runs AFTER every module it
 * imports has already been evaluated - which meant module-scope reads such as
 * `process.env.OPENAI_MODEL` in aiModelCatalog never saw the file at all.
 * Putting the load in its own module makes "first import wins" do the work.
 *
 * `override: true` preserves the behaviour the old per-module load had: the
 * checked-in `.env` beats whatever the shell happens to export.
 */
dotenv.config({ path: path.join(__dirname, '../../../.env'), override: true });

export const ENV_LOADED = true;
