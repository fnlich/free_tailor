import crypto from 'crypto';

import { getDb } from './sqlite';
import type { AssetId, ChainId } from '../config/chainAssets';

/**
 * Coin that arrived and belongs to nobody this server can name.
 *
 * There is exactly one way to get here: a transfer whose amount was close
 * enough to TWO open orders that crediting either might have robbed the other.
 * The settler refuses to guess - that refusal is the whole design - but the
 * money is real and somebody has to look at it, so it is written down here.
 *
 * The open invoices are deliberately NOT touched. Those buyers may still pay
 * the exact figure they were quoted, and cancelling their orders because a
 * third party sent an odd amount would punish them for somebody else's
 * mistake. That is why this is its own table rather than a state on an
 * invoice: the record has no invoice to belong to.
 */

export type ChainOrphan = {
  id: string;
  chain: ChainId;
  asset: AssetId;
  txid: string;
  amountAtomic: string;
  decimals: number;
  reason: string;
  resolvedAt: string;
  createdAt: string;
  updatedAt: string;
};

type OrphanRow = {
  id: string;
  chain: string;
  asset: string;
  txid: string;
  amount_atomic: string;
  decimals: number;
  reason: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = `id, chain, asset, txid, amount_atomic, decimals, reason, resolved_at,
  created_at, updated_at`;

function toOrphan(row: OrphanRow): ChainOrphan {
  return {
    id: row.id,
    chain: row.chain as ChainId,
    asset: row.asset as AssetId,
    txid: row.txid,
    amountAtomic: row.amount_atomic,
    decimals: row.decimals,
    reason: row.reason,
    resolvedAt: row.resolved_at ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Records an unattributable transfer, once.
 *
 * `ON CONFLICT DO NOTHING` rather than a read-then-insert, and it is not
 * decoration: the watcher re-reads the same transfer on every tick for as long
 * as it is in the window it scans, so one unclaimed payment would otherwise
 * become a row a minute for ever. The index decides, as it does everywhere
 * else on this path.
 *
 * The reason is left as first written, because the first reading is the one
 * taken closest to the event.
 */
export function recordOrphan(input: {
  chain: ChainId;
  asset: AssetId;
  txid: string;
  amountAtomic: string;
  decimals: number;
  reason: string;
}): void {
  const timestamp = now();
  getDb()
    .prepare(
      `INSERT INTO chain_orphans (${COLUMNS})
       VALUES (@id, @chain, @asset, @txid, @amountAtomic, @decimals, @reason, NULL,
               @createdAt, @createdAt)
       ON CONFLICT (chain, asset, txid) DO NOTHING`
    )
    .run({
      id: `corph_${crypto.randomUUID()}`,
      chain: input.chain,
      asset: input.asset,
      txid: input.txid,
      amountAtomic: input.amountAtomic,
      decimals: input.decimals,
      reason: input.reason,
      createdAt: timestamp,
    });
}

/** What still needs a person. Newest first, because it is a queue. */
export function listOpenOrphans(limit = 50): ChainOrphan[] {
  const rows = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM chain_orphans
       WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as OrphanRow[];
  return rows.map(toOrphan);
}

/**
 * Marks one as dealt with, so the queue can actually be cleared.
 *
 * A list that only grows is a list nobody reads, and an administrator who has
 * refunded or manually credited an unclaimed payment has genuinely finished
 * with it. Conditional on it still being open, so two administrators pressing
 * at once resolve it once.
 */
export function resolveOrphan(id: string): boolean {
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE chain_orphans SET resolved_at = @at, updated_at = @at
       WHERE id = @id AND resolved_at IS NULL`
    )
    .run({ id, at: timestamp });
  return result.changes > 0;
}
