import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

/**
 * Gives every balance that predates the ledger a row explaining itself.
 *
 * An install upgrading into credits can already have a non-zero balance an
 * administrator typed into the accounts page, with nothing behind it. The whole
 * promise of the ledger is that any balance can be explained, and a balance
 * whose first row is a refund from a run it never paid for would read as an
 * accounting error rather than as history.
 *
 * Idempotent twice over - the NOT EXISTS and the unique key - because the
 * convention here is that a migration can be run twice and the second run does
 * nothing.
 */

export const CREDIT_LEDGER_SCHEMA_VERSION = 4;

export type CreditLedgerMigrationReport = {
  ran: boolean;
  accounts: number;
  units: number;
  notes: string[];
};

export function migrate004(db: Database.Database): CreditLedgerMigrationReport {
  const report: CreditLedgerMigrationReport = { ran: false, accounts: 0, units: 0, notes: [] };

  const pending = db
    .prepare(
      `SELECT id, credits FROM users
        WHERE credits > 0
          AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE credit_ledger.user_id = users.id)`
    )
    .all() as Array<{ id: string; credits: number }>;

  if (pending.length === 0) return report;

  const timestamp = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO credit_ledger
       (id, user_id, delta, balance_after, reason, ref_kind, ref_id, actor_id, note,
        idempotency_key, created_at)
     VALUES (@id, @userId, @delta, @balanceAfter, 'opening-balance', 'user', @userId, NULL, @note,
             @key, @createdAt)`
  );

  db.transaction(() => {
    for (const row of pending) {
      insert.run({
        id: `led_${randomUUID()}`,
        userId: row.id,
        delta: row.credits,
        balanceAfter: row.credits,
        note: 'Balance carried over from before the ledger existed.',
        key: `opening:${row.id}`,
        createdAt: timestamp,
      });
      report.accounts += 1;
      report.units += row.credits;
    }
  })();

  report.ran = report.accounts > 0;
  return report;
}
