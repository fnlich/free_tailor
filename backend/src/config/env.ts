import dotenv from 'dotenv';
import path from 'path';
import { applyEnvFile, describeShadowed, readEnvFileText } from './envFile';

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
 * The ENVIRONMENT beats the file: a variable already set when the process
 * starts keeps its value, and the file fills in only what is missing. That is
 * dotenv's own default, how systemd's Environment=, `docker run -e` and
 * compose's `environment:` are meant to work, and what the frontend half has
 * always done (frontend/scripts/next.mjs, which must agree with this - change
 * the two together). It used to be the other way round here, inherited from
 * the first single-file service, so `DB_DIR=/tmp/x node dist/index.js` was
 * silently ignored whenever the file set DB_DIR, and `PORT=4000` moved the
 * frontend to port 4000 while the backend stayed on the file's 3001.
 *
 * A name set in both with different values is said once at startup, by NAME
 * only, so an install that relied on the file winning sees the change.
 */

/**
 * The ONE file this app reads, exported so a doctor can report it rather than
 * recompute it. Resolved from this compiled module, so it is always the
 * repository root - never `backend/.env`, which is where it gets put by anyone
 * running the scripts from `backend/`.
 */
export const ENV_PATH = path.join(__dirname, '../../../.env');

const { shadowed } = applyEnvFile(dotenv.parse(readEnvFileText(ENV_PATH)), process.env);
const shadowedLine = describeShadowed(shadowed, ENV_PATH);
if (shadowedLine) console.warn(shadowedLine);
