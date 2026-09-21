import crypto from 'crypto';

import { getDb } from './sqlite';
import type { AssetId, ChainId } from '../config/chainAssets';
import {
  TERMINAL_INVOICE_STATES,
  type ChainInvoice,
  type ChainInvoiceState,
} from '../types/chainInvoice';

/**
 * Invoices for payments made by sending coin to an address we control.
 *
 * One thing decides almost everything in this file: **buyers all send to the
 * SAME address for a given chain**, so the amount is the only thing that tells
 * one buyer's payment from another's. That is why
 *
 *   CREATE UNIQUE INDEX idx_chain_invoices_slot
 *     ON chain_invoices (chain, asset, amount_atomic) WHERE reserved = 1
 *
 * is not a nicety. It is the matching scheme. An application-level "is this
 * amount taken?" check would lose the race it exists to win: two requests can
 * both read "free" and both insert, and then a payment arrives that two orders
 * could equally have meant.
 *
 * `amount_atomic` is TEXT and every comparison here is `BigInt`. An 18-decimal
 * amount outgrows SQLite's 64-bit integer AND JavaScript's safe integer range,
 * so a `Number` anywhere on this path is a silently truncated amount, which is
 * a payment nobody can match.
 */

export type ChainInvoiceRow = {
  id: string;
  payment_id: string;
  chain: string;
  asset: string;
  address: string;
  amount_atomic: string;
  decimals: number;
  unit_price_usd: string;
  reserved: number;
  quote_expires_at: string;
  monitor_until: string;
  seen_txid: string | null;
  seen_amount: string | null;
  seen_at: string | null;
  confirmations: number;
  state: string;
  note: string;
  created_at: string;
  updated_at: string;
};

const INVOICE_COLUMNS = `id, payment_id, chain, asset, address, amount_atomic, decimals,
  unit_price_usd, reserved, quote_expires_at, monitor_until, seen_txid, seen_amount, seen_at,
  confirmations, state, note, created_at, updated_at`;

const STATES: readonly ChainInvoiceState[] = ['waiting', 'seen', 'credited', 'held', 'expired'];

function toState(value: string): ChainInvoiceState {
  // Coerced rather than trusted, the same way a role is: a row carrying a
  // state this build has never heard of reads as the state that does nothing,
  // not as one that might credit somebody.
  return (STATES as readonly string[]).includes(value) ? (value as ChainInvoiceState) : 'held';
}

function toInvoice(row: ChainInvoiceRow): ChainInvoice {
  return {
    id: row.id,
    paymentId: row.payment_id,
    chain: row.chain as ChainId,
    asset: row.asset as AssetId,
    address: row.address,
    amountAtomic: row.amount_atomic,
    decimals: row.decimals,
    unitPriceUsd: row.unit_price_usd,
    reserved: row.reserved === 1,
    quoteExpiresAt: row.quote_expires_at,
    monitorUntil: row.monitor_until,
    seenTxid: row.seen_txid ?? '',
    seenAmount: row.seen_amount ?? '',
    seenAt: row.seen_at ?? '',
    confirmations: row.confirmations,
    state: toState(row.state),
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

export type NewChainInvoice = {
  paymentId: string;
  chain: ChainId;
  asset: AssetId;
  address: string;
  amountAtomic: string;
  decimals: number;
  unitPriceUsd: string;
  quoteExpiresAt: string;
  monitorUntil: string;
};

/**
 * Thrown when the amount a new invoice wants is already being paid.
 *
 * Its own class because the caller has something specific to say about it -
 * "somebody is already paying that exact amount, try again" - and because the
 * alternative, shifting the amount up to the next free slot, was deliberately
 * ruled out. Shifting means two open invoices one atomic unit apart, and that
 * is precisely what makes a wrong-amount payment impossible to attribute.
 */
export class SlotTakenError extends Error {
  constructor(readonly asset: AssetId) {
    super('That exact amount is already being paid by somebody else.');
    this.name = 'SlotTakenError';
  }
}

/**
 * Claims an amount, or refuses because somebody else has it.
 *
 * The INDEX decides, not a read. That is the whole point: this function does
 * not ask whether the slot is free, it tries to take it and lets the database
 * say no. Two requests racing for the same amount cannot both win.
 */
export function createChainInvoice(input: NewChainInvoice): ChainInvoice {
  const db = getDb();
  const timestamp = now();
  const id = `cinv_${crypto.randomUUID()}`;

  try {
    db.prepare(
      `INSERT INTO chain_invoices (id, payment_id, chain, asset, address, amount_atomic, decimals,
                                   unit_price_usd, reserved, quote_expires_at, monitor_until,
                                   confirmations, state, note, created_at, updated_at)
       VALUES (@id, @paymentId, @chain, @asset, @address, @amountAtomic, @decimals,
               @unitPriceUsd, 1, @quoteExpiresAt, @monitorUntil, 0, 'waiting', '',
               @createdAt, @createdAt)`
    ).run({
      id,
      paymentId: input.paymentId,
      chain: input.chain,
      asset: input.asset,
      address: input.address,
      amountAtomic: input.amountAtomic,
      decimals: input.decimals,
      unitPriceUsd: input.unitPriceUsd,
      quoteExpiresAt: input.quoteExpiresAt,
      monitorUntil: input.monitorUntil,
      createdAt: timestamp,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // The slot index and the one-invoice-per-payment index are different
    // failures and must not be conflated: the first is somebody else's
    // purchase, the second is this code asking twice for the same payment.
    if (/idx_chain_invoices_slot|chain_invoices\.amount_atomic/i.test(message)) {
      throw new SlotTakenError(input.asset);
    }
    throw error;
  }

  return getChainInvoice(id)!;
}

export function getChainInvoice(id: string): ChainInvoice | null {
  const row = getDb()
    .prepare(`SELECT ${INVOICE_COLUMNS} FROM chain_invoices WHERE id = ?`)
    .get(id) as ChainInvoiceRow | undefined;
  return row ? toInvoice(row) : null;
}

export function getInvoiceForPayment(paymentId: string): ChainInvoice | null {
  const row = getDb()
    .prepare(`SELECT ${INVOICE_COLUMNS} FROM chain_invoices WHERE payment_id = ?`)
    .get(paymentId) as ChainInvoiceRow | undefined;
  return row ? toInvoice(row) : null;
}

/** How many invoices an account is holding open right now. */
export function countOpenInvoicesForUser(userId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS open FROM chain_invoices
       JOIN payments ON payments.id = chain_invoices.payment_id
       WHERE payments.user_id = ? AND chain_invoices.state IN ('waiting', 'seen')`
    )
    .get(userId) as { open: number } | undefined;
  return row?.open ?? 0;
}

/**
 * The one invoice claiming exactly this amount, if any.
 *
 * `reserved = 1` matters: a released row may hold the same amount as a live
 * one, and crediting the released one would credit a purchase that expired.
 */
export function findInvoiceBySlot(
  chain: ChainId,
  asset: AssetId,
  amountAtomic: string
): ChainInvoice | null {
  const row = getDb()
    .prepare(
      `SELECT ${INVOICE_COLUMNS} FROM chain_invoices
       WHERE chain = ? AND asset = ? AND amount_atomic = ? AND reserved = 1`
    )
    .get(chain, asset, amountAtomic) as ChainInvoiceRow | undefined;
  return row ? toInvoice(row) : null;
}

/** Every invoice still worth looking for, for one asset. */
export function listOpenInvoices(chain: ChainId, asset: AssetId): ChainInvoice[] {
  const rows = getDb()
    .prepare(
      `SELECT ${INVOICE_COLUMNS} FROM chain_invoices
       WHERE chain = ? AND asset = ? AND state IN ('waiting', 'seen')
       ORDER BY created_at ASC`
    )
    .all(chain, asset) as ChainInvoiceRow[];
  return rows.map(toInvoice);
}

/** Every asset with something open on it, so a quiet chain costs no requests. */
export function listAssetsWithOpenInvoices(chain: ChainId): AssetId[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT asset FROM chain_invoices
       WHERE chain = ? AND state IN ('waiting', 'seen')`
    )
    .all(chain) as Array<{ asset: string }>;
  return rows.map((row) => row.asset as AssetId);
}

/**
 * Records that a transfer has been seen, without crediting anything.
 *
 * Conditional on the invoice still being open, so a late reader cannot reopen
 * one that has already settled. `confirmations` is overwritten rather than
 * accumulated: it is a depth read off the chain, not a counter, and a reorg
 * legitimately makes it smaller.
 */
export function markInvoiceSeen(
  invoiceId: string,
  seen: { txid: string; amountAtomic: string; confirmations: number }
): boolean {
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE chain_invoices
       SET state = 'seen', seen_txid = @txid, seen_amount = @amount, seen_at = @at,
           confirmations = @confirmations, updated_at = @at
       WHERE id = @id AND state IN ('waiting', 'seen')`
    )
    .run({
      id: invoiceId,
      txid: seen.txid,
      amount: seen.amountAtomic,
      confirmations: seen.confirmations,
      at: timestamp,
    });
  return result.changes > 0;
}

/**
 * Puts a seen invoice back to waiting, because the transfer went away.
 *
 * A reorg below the confirmation depth is exactly the case this exists for.
 * The alternative - leaving it `seen` - would show a buyer a payment that is
 * no longer on the chain, and would stop a genuine later transfer being
 * noticed.
 */
export function resetInvoiceToWaiting(invoiceId: string, note: string): boolean {
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE chain_invoices
       SET state = 'waiting', seen_txid = NULL, seen_amount = NULL, seen_at = NULL,
           confirmations = 0, note = @note, updated_at = @at
       WHERE id = @id AND state = 'seen'`
    )
    .run({ id: invoiceId, note, at: timestamp });
  return result.changes > 0;
}

/**
 * Moves an invoice to a terminal state, exactly once.
 *
 * Conditional on it being open, and that condition is load-bearing: it is the
 * chain path's stand-in for the unique provider event id the webhook path has.
 * Two sweeps that both see the same transfer cannot both settle it.
 */
export function finishInvoice(
  invoiceId: string,
  state: ChainInvoiceState,
  note = ''
): boolean {
  if (!TERMINAL_INVOICE_STATES.includes(state)) {
    throw new Error(`${state} is not a state an invoice can finish in.`);
  }
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE chain_invoices
       SET state = @state, note = @note, reserved = 0, updated_at = @at
       WHERE id = @id AND state IN ('waiting', 'seen')`
    )
    .run({ id: invoiceId, state, note, at: timestamp });
  return result.changes > 0;
}

/**
 * Releases the amounts nobody is going to pay any more.
 *
 * Two things at once, and they are separate rules:
 *
 *  - an invoice past its monitor window becomes `expired`, because the watcher
 *    has stopped looking for it;
 *  - any row in a terminal state stops reserving its amount, whatever put it
 *    there, so the slot can be sold again.
 *
 * Returns how many were expired, for the log line.
 */
export function releaseFinishedInvoices(at: Date = new Date()): number {
  const db = getDb();
  const timestamp = at.toISOString();

  const expired = db
    .prepare(
      `UPDATE chain_invoices
       SET state = 'expired', reserved = 0, updated_at = @at
       WHERE state IN ('waiting', 'seen') AND monitor_until < @at`
    )
    .run({ at: timestamp });

  db.prepare(
    `UPDATE chain_invoices SET reserved = 0, updated_at = @at
     WHERE reserved = 1 AND state IN ('credited', 'held', 'expired')`
  ).run({ at: timestamp });

  return expired.changes;
}

/** Everything a person needs to look at. Newest first, because it is a queue. */
export function listHeldInvoices(limit = 50): ChainInvoice[] {
  const rows = getDb()
    .prepare(
      `SELECT ${INVOICE_COLUMNS} FROM chain_invoices
       WHERE state = 'held' ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as ChainInvoiceRow[];
  return rows.map(toInvoice);
}
