import { ASSETS, CHAINS } from '../../../config/chainAssets';
import { readChainPaymentsConfig } from '../../../config/chainPayments';
import {
  finishInvoice,
  findInvoiceBySlot,
  listOpenInvoices,
  markInvoiceSeen,
  resetInvoiceToWaiting,
} from '../../../database/chainInvoiceRepository';
import { getPayment } from '../../../database/paymentRepository';
import { getDb } from '../../../database/sqlite';
import type { ChainInvoice, ChainTransfer } from '../../../types/chainInvoice';
import { creditPaid } from '../index';
import { formatAtomic } from './invoices';

/**
 * Deciding which order a transfer paid for, and crediting it.
 *
 * Buyers all send to ONE address per chain, so nothing about an incoming
 * transfer says whose it is except the amount. Everything below is about being
 * honest when the amount does not settle the question.
 *
 * **An exact match wins, and the index decides it.** This is the ordinary
 * case - the buyer sent the figure they were shown - and it is unambiguous by
 * construction, because the partial unique index on
 * `(chain, asset, amount_atomic) WHERE reserved = 1` allows only one open
 * invoice per amount.
 *
 * **Otherwise, exactly one candidate or nothing.** A transfer whose amount is
 * near but not equal to an open invoice's is credited in proportion to what
 * arrived - but ONLY when exactly one open invoice on that asset is inside the
 * band. Zero or two or more, and the money is held for a person. The guarantee
 * this gives is not arithmetic, it is structural: money only ever moves when
 * one order could possibly have meant it.
 *
 * That guard used to be much more dangerous than it is now. Invoices were
 * going to be allocated on a lattice one `slotUnit` apart, which for the
 * stablecoins is ten thousand amounts inside a single cent - so any band wide
 * enough to absorb a fee would have covered hundreds of live invoices and the
 * "exactly one" test would have failed constantly. Refusing a taken amount at
 * creation instead of shifting to the next one removed that by construction:
 * an open invoice now only exists at a figure a real buyer was quoted, and two
 * buyers' quotes differ by dollars.
 *
 * **Nothing here goes through `settleWebhookEvent`.** There is no event to
 * record, and the card path's rule - that the paid amount must equal the quote
 * EXACTLY or nothing is credited - is left exactly as it is. Proportional
 * crediting lives in this file and nowhere else.
 */

/** How far from the quoted amount still counts as this order. */
const DEFAULT_TOLERANCE_BPS = 200;

export type SettlementOutcome =
  | { status: 'ignored'; reason: string }
  | { status: 'seen'; invoice: ChainInvoice }
  | { status: 'credited'; invoice: ChainInvoice; credits: number }
  | { status: 'held'; invoice: ChainInvoice | null; reason: string };

function toleranceBps(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt((env.CHAIN_TOLERANCE_BPS ?? '').trim(), 10);
  if (!Number.isFinite(raw)) return DEFAULT_TOLERANCE_BPS;
  return Math.min(1_000, Math.max(0, raw));
}

/**
 * The open invoices this amount could plausibly have been meant for.
 *
 * Compared in BigInt, in JavaScript, because `amount_atomic` is TEXT and an
 * 18-decimal amount cannot be compared as a SQL integer without truncating.
 * The set is small - open invoices on one asset - so reading it is cheap.
 */
export function candidatesWithin(
  invoices: ChainInvoice[],
  arrivedAtomic: string,
  bps: number
): ChainInvoice[] {
  const arrived = BigInt(arrivedAtomic);
  return invoices.filter((invoice) => {
    const quoted = BigInt(invoice.amountAtomic);
    if (quoted <= 0n) return false;
    const difference = quoted > arrived ? quoted - arrived : arrived - quoted;
    return difference * 10_000n <= quoted * BigInt(bps);
  });
}

/**
 * Credits in proportion to what actually arrived, rounded DOWN.
 *
 * Down, and it is not a close call: rounding up would credit a fraction of a
 * credit nobody paid for, on every short payment, for ever. The residue stays
 * with the house, which is the same rule the fee uses.
 */
export function creditsForShortfall(
  quotedAtomic: string,
  arrivedAtomic: string,
  quotedCredits: number
): number {
  const quoted = BigInt(quotedAtomic);
  const arrived = BigInt(arrivedAtomic);
  if (quoted <= 0n) return 0;
  if (arrived >= quoted) return quotedCredits;
  return Number((arrived * BigInt(quotedCredits)) / quoted);
}

/**
 * Takes one transfer and decides what it means.
 *
 * Everything that changes the database happens inside a single transaction, so
 * a crash between marking the invoice and writing the ledger leaves neither.
 * The two idempotency guards that survive from the webhook path are both here:
 * `finishInvoice` only moves an OPEN invoice, and `creditPaid` writes the
 * ledger under a deterministic `purchase:<paymentId>` key.
 */
export function settleTransfer(
  transfer: ChainTransfer,
  env: NodeJS.ProcessEnv = process.env
): SettlementOutcome {
  const asset = ASSETS[transfer.asset];
  const chain = CHAINS[transfer.chain];
  const bps = toleranceBps(env);

  return getDb().transaction((): SettlementOutcome => {
    const exact = findInvoiceBySlot(transfer.chain, transfer.asset, transfer.amountAtomic);
    const open = listOpenInvoices(transfer.chain, transfer.asset);

    let invoice = exact;
    let shortPaid = false;

    if (!invoice) {
      const candidates = candidatesWithin(open, transfer.amountAtomic, bps);
      if (candidates.length === 1) {
        invoice = candidates[0];
        shortPaid = true;
      } else if (candidates.length > 1) {
        /*
         * The case this whole design exists to refuse.
         *
         * Two orders could equally have meant this money. Guessing would give
         * one buyer's coin to another buyer's order, and there is no way to
         * tell afterwards which of them was wronged - so nothing moves, and a
         * person is told.
         */
        return {
          status: 'held',
          invoice: null,
          reason:
            `${formatAtomic(transfer.amountAtomic, asset.decimals)} ${asset.symbol} arrived in ` +
            `${transfer.txid} and ${candidates.length} open orders are within ${bps / 100}% of ` +
            'it. It has not been credited to any of them.',
        };
      } else {
        // Nothing open is close to this. Very often it is not a payment for us
        // at all - somebody using the same address for something else - so
        // this is quiet rather than alarming.
        return {
          status: 'ignored',
          reason: `No open order matches ${formatAtomic(transfer.amountAtomic, asset.decimals)} ${asset.symbol}.`,
        };
      }
    }

    /*
     * Deep enough, or just seen.
     *
     * A transfer is recorded as `seen` the moment it appears so the buyer's
     * page can say so, and credited only once it is buried under the chain's
     * own confirmation count. The two are different facts and the panel shows
     * both.
     */
    if (transfer.confirmations < chain.confirmations) {
      markInvoiceSeen(invoice.id, {
        txid: transfer.txid,
        amountAtomic: transfer.amountAtomic,
        confirmations: transfer.confirmations,
      });
      return { status: 'seen', invoice };
    }

    const payment = getPayment(invoice.paymentId);
    if (!payment) {
      return {
        status: 'held',
        invoice,
        reason: `Invoice ${invoice.id} has no payment row, so nothing could be credited.`,
      };
    }

    const credits = shortPaid
      ? creditsForShortfall(invoice.amountAtomic, transfer.amountAtomic, payment.credits)
      : payment.credits;

    if (credits <= 0) {
      return {
        status: 'held',
        invoice,
        reason:
          `${formatAtomic(transfer.amountAtomic, asset.decimals)} ${asset.symbol} is too little ` +
          `of ${formatAtomic(invoice.amountAtomic, asset.decimals)} to buy a whole credit.`,
      };
    }

    markInvoiceSeen(invoice.id, {
      txid: transfer.txid,
      amountAtomic: transfer.amountAtomic,
      confirmations: transfer.confirmations,
    });

    const outcome = creditPaid(payment.id, credits);
    if (!outcome.credited) {
      /*
       * Already settled, or refused by the ledger's own key. Either way the
       * invoice is finished rather than left open: leaving it open would mean
       * the next sweep tries the same transfer again, for ever.
       */
      finishInvoice(invoice.id, 'credited', 'Already credited.');
      return { status: 'credited', invoice, credits: 0 };
    }

    finishInvoice(
      invoice.id,
      'credited',
      shortPaid
        ? `Paid ${formatAtomic(transfer.amountAtomic, asset.decimals)} of ` +
            `${formatAtomic(invoice.amountAtomic, asset.decimals)}; credited ${credits} of ` +
            `${payment.credits}.`
        : ''
    );

    return { status: 'credited', invoice, credits };
  })();
}

/**
 * Holds a transfer nobody could attribute, so an operator sees it.
 *
 * Separate from `settleTransfer` because the held case has no invoice to move:
 * the money arrived, nothing claimed it, and the record has to live somewhere
 * a person will look. The admin payments page reads this.
 */
export function holdInvoice(invoice: ChainInvoice, reason: string): void {
  finishInvoice(invoice.id, 'held', reason);
}

/**
 * A transfer that was seen and then vanished before it was deep enough.
 *
 * A reorg below the confirmation depth. The invoice goes back to `waiting`
 * rather than being credited or failed, because the buyer may simply have to
 * wait, or may have to send again - and either way nothing has been decided.
 */
export function forgetSeenTransfer(invoice: ChainInvoice): void {
  resetInvoiceToWaiting(
    invoice.id,
    `The transfer ${invoice.seenTxid} is no longer on the chain. Still waiting.`
  );
}

/** Exported for the watcher's log line and for tests. */
export function toleranceFor(env: NodeJS.ProcessEnv = process.env): number {
  return toleranceBps(env);
}

/** The env var that widens or narrows the band, for documentation. */
export const TOLERANCE_ENV = 'CHAIN_TOLERANCE_BPS';

/** Kept so the readers and the settler agree about what "enough" means. */
export function confirmationsRequired(chainId: keyof typeof CHAINS): number {
  return CHAINS[chainId].confirmations;
}

/** Re-exported so callers need not reach past this module for the config. */
export function settlementConfig(env: NodeJS.ProcessEnv = process.env) {
  return readChainPaymentsConfig(env);
}
