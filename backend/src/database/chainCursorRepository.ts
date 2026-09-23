import { getDb } from './sqlite';
import type { ChainId } from '../config/chainAssets';

/**
 * How far each chain has been read, and the rule for moving it.
 *
 * The cursor is the watcher's only memory. Everything else it knows it reads
 * off the chain each tick; this one number is the difference between "we have
 * looked at these blocks" and "we have not", and nothing else records it.
 *
 * So the rule is one line long and the whole file exists to keep it:
 *
 *   **Advance the cursor in the same transaction as the work that height
 *   produced, and never before.**
 *
 * Advancing first is a crash away from a transfer that arrived, was never
 * recorded, and will never be looked for again - the buyer's money is on the
 * chain and this server has permanently forgotten to check. Advancing after,
 * in a separate write, has the same hole in a smaller window. `advanceCursor`
 * is therefore something to call INSIDE a `db.transaction(...)`, alongside the
 * invoice updates, which is why it is a plain statement and not its own
 * transaction.
 */

function now(): string {
  return new Date().toISOString();
}

/**
 * The last height fully read, or null when this chain has never been read.
 *
 * Null is meaningfully different from zero: zero would mean "read from the
 * genesis block", which no public endpoint will serve and which would take
 * days. A caller that gets null starts from the tip and says so in the log,
 * because the first run of a new installation genuinely has no history to
 * catch up on - and an operator who has just switched a chain on should be
 * told that, rather than wondering why an old payment was never seen.
 */
export function getCursor(chain: ChainId): number | null {
  const row = getDb()
    .prepare('SELECT height FROM chain_cursors WHERE chain = ?')
    .get(chain) as { height: string } | undefined;
  if (!row) return null;
  const parsed = Number.parseInt(row.height, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Moves the cursor forward. Call it inside the caller's transaction.
 *
 * Forward only, and that guard is not paranoia: two endpoints in the same list
 * can disagree about the tip by a few blocks, and one of them answering from a
 * stale fork must not walk the cursor backwards and cause a range to be read
 * twice - or, worse, cause the later read to skip what the earlier one saw.
 */
export function advanceCursor(chain: ChainId, height: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO chain_cursors (chain, height, updated_at)
     VALUES (@chain, @height, @at)
     ON CONFLICT (chain) DO UPDATE SET
       height = CASE
         WHEN CAST(excluded.height AS INTEGER) > CAST(chain_cursors.height AS INTEGER)
         THEN excluded.height
         ELSE chain_cursors.height
       END,
       updated_at = @at`
  ).run({ chain, height: String(height), at: now() });
}
