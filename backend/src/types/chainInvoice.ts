import type { AssetId, ChainId } from '../config/chainAssets';

/**
 * An invoice for a payment made by sending coin to an address we control.
 *
 * The lifecycle the table has always implied and never declared. `'waiting'`
 * was the only literal anywhere in the repository before this; the states it
 * could move to were in nobody's head but the schema's.
 *
 *   waiting  - quoted, the slot is reserved, nothing has arrived
 *   seen     - a transfer of the right amount is on the chain but not yet deep
 *              enough to be treated as final
 *   credited - settled; the credits are in the ledger
 *   held     - money arrived that cannot be matched safely, and a person has
 *              to look at it. NEVER silently credited and never written off
 *   expired  - nothing arrived inside the window; the slot is released
 *
 * Only `credited` and `expired` are ordinary ends. `held` is an end that wants
 * attention: it exists precisely so that an unmatchable payment is visible
 * rather than lost.
 */
export type ChainInvoiceState = 'waiting' | 'seen' | 'credited' | 'held' | 'expired';

/** The states that are finished, whatever the outcome. */
export const TERMINAL_INVOICE_STATES: readonly ChainInvoiceState[] = [
  'credited',
  'held',
  'expired',
];

export type ChainInvoice = {
  id: string;
  paymentId: string;
  chain: ChainId;
  asset: AssetId;
  /** The address the buyer was told to send to, as it was shown to them. */
  address: string;
  /**
   * What to send, in the asset's smallest unit, as a DECIMAL STRING.
   *
   * A string rather than a number, all the way up and down: an 18-decimal
   * amount outgrows both SQLite's 64-bit integer and JavaScript's safe integer
   * range, and a silently truncated amount is a payment nobody can match.
   * Arithmetic on it is `BigInt` and nothing else.
   */
  amountAtomic: string;
  /**
   * Snapshotted from the asset at creation, not read from it later.
   *
   * The definition could in principle be corrected in a later release; this
   * invoice was quoted against the number that was in force when it was made,
   * and that is the number it has to be settled against.
   */
  decimals: number;
  /** What one whole unit was worth in USD when this was quoted, as a string. */
  unitPriceUsd: string;
  /** 1 while this amount is claimed. The partial unique index reads it. */
  reserved: boolean;
  /** When the RATE stops being honoured, and the buyer's countdown ends. */
  quoteExpiresAt: string;
  /** How long the watcher keeps looking. Later than the expiry, on purpose. */
  monitorUntil: string;
  seenTxid: string;
  /** What actually arrived, when it differs from what was asked for. */
  seenAmount: string;
  seenAt: string;
  confirmations: number;
  state: ChainInvoiceState;
  /** Why it is held, or any other note a person needs to read. */
  note: string;
  createdAt: string;
  updatedAt: string;
};

/** What a transfer looks like once a reader has parsed it off a chain. */
export type ChainTransfer = {
  chain: ChainId;
  asset: AssetId;
  /** The transaction it arrived in. */
  txid: string;
  /** The amount, in the asset's smallest unit, as a decimal string. */
  amountAtomic: string;
  /** The block it is in, so its depth can be worked out. */
  height: number;
  /** How deep it is now, when the reader knows. */
  confirmations: number;
};
