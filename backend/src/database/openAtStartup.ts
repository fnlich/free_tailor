import { getDb } from './sqlite';
import { DatabaseNotUpgradedError } from './upgradeGuard';

/**
 * Opens the database the moment the server starts, before any route module is
 * loaded - index.ts imports this right after the `.env` loader.
 *
 * Some modules read the database as they LOAD (the PDF generator reads the
 * skill library), and imports run before index.ts's own code. Opened here
 * first, a database this build refuses (one an older build never finished
 * upgrading, upgradeGuard.ts) stops the server with the one sentence that
 * says what to do, and exit code 1 - not with a stack trace from whichever
 * module happened to read first. Any other failure is thrown as it was: the
 * message already says what is wrong.
 */
try {
  getDb();
} catch (error) {
  if (error instanceof DatabaseNotUpgradedError) {
    console.error(`[db] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
