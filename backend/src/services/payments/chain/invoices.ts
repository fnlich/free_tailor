import {
  ASSETS,
  CHAINS,
  type AssetDefinition,
  type AssetId,
} from '../../../config/chainAssets';
import { readChainPaymentsConfig, type EnabledAsset } from '../../../config/chainPayments';
import {
  countOpenInvoicesForUser,
  createChainInvoice,
  SlotTakenError,
} from '../../../database/chainInvoiceRepository';
import type { ChainInvoice } from '../../../types/chainInvoice';
import { rateFor, RateUnavailableError } from './rates';

/**
 * Turning a sale in dollars into an amount of coin, and claiming it.
 *
 * The conversion is four lines and every one of them is a place a customer's
 * money gets lost, so each says why it is the way it is.
 *
 * **Decimals come from the asset definition, never from a symbol.** USDT is 6
 * decimals on Ethereum and TRON and EIGHTEEN on BNB Chain - a factor of a
 * trillion on a token with the same ticker. `ASSETS` is the only source, and
 * the figure is snapshotted onto the invoice so that a later correction to the
 * constant cannot change what an old invoice meant.
 *
 * **The arithmetic is BigInt from the first step.** 10^18 is past what a
 * double holds exactly, so a `Number` anywhere on this path silently rounds an
 * amount to something no wallet will ever send.
 *
 * **Rounding is UP, to a multiple of slotUnit.** Up, because a rounding error
 * in the buyer's favour is the house's loss on every sale; and onto the lattice
 * because `slotUnit` is what keeps an 18-decimal amount to a figure a wallet
 * renders legibly and an exchange withdrawal does not truncate.
 *
 * **A taken amount is refused, not shifted.** The obvious move when the slot is
 * claimed is to add one unit and try again. This does not do that, by decision:
 * two open invoices one atomic unit apart are two orders that a wrong-amount
 * payment could equally have meant, and that ambiguity is exactly what the
 * settlement path has to guarantee never happens. Somebody waits a moment
 * instead.
 */

/** 10^n as a BigInt, which is the only safe way to hold it. */
function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Cents of USD into the asset's smallest unit, at a given price.
 *
 * Exported and pure because this is the single most consequential calculation
 * in the crypto path and it deserves tests of its own, against real decimals
 * for every asset offered.
 *
 * `priceUsd` arrives as a string from the rate feed and is parsed to a scaled
 * integer rather than a float: `0.1 + 0.2` is not `0.3`, and a price with
 * eight significant figures through a double is a different amount of coin.
 */
export function usdCentsToAtomic(
  amountCents: number,
  priceUsd: string,
  asset: AssetDefinition,
  spreadPercent: number
): bigint {
  const PRICE_SCALE = 12;
  const scaledPrice = parseDecimal(priceUsd, PRICE_SCALE);
  if (scaledPrice <= 0n) {
    throw new Error(`${asset.id} cannot be quoted at a price of ${priceUsd}.`);
  }

  /*
   * atomic = cents / 100 / price x 10^decimals, all in integers.
   *
   * Written as one fraction so there is exactly one division and therefore
   * exactly one place a remainder can appear. Dividing twice would truncate
   * twice, and the second truncation would be invisible.
   */
  const numerator = BigInt(amountCents) * pow10(asset.decimals) * pow10(PRICE_SCALE);
  const denominator = 100n * scaledPrice;

  // The spread widens what the buyer sends, because the rate can move between
  // the quote and the transfer landing, and it is the operator who carries
  // that risk otherwise. Applied before the lattice, so the rounding below is
  // the last thing to happen.
  const withSpread = (numerator * BigInt(10_000 + Math.round(spreadPercent * 100))) / 10_000n;

  const exact = ceilDivide(withSpread, denominator);
  return ceilToMultiple(exact, asset.slotUnit);
}

/** A decimal string as an integer scaled by 10^scale, with no float step. */
export function parseDecimal(value: string, scale: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const [whole, fraction = ''] = trimmed.split('.');
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  return BigInt(whole) * pow10(scale) + BigInt(padded || '0');
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function ceilToMultiple(value: bigint, unit: bigint): bigint {
  if (unit <= 1n) return value;
  return ceilDivide(value, unit) * unit;
}

/** An atomic amount as the decimal figure a buyer is shown. */
export function formatAtomic(amountAtomic: string | bigint, decimals: number): string {
  const value = typeof amountAtomic === 'bigint' ? amountAtomic : BigInt(amountAtomic || '0');
  if (decimals === 0) return value.toString();
  const unit = pow10(decimals);
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export class ChainInvoiceError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'ChainInvoiceError';
  }
}

/** The enabled asset, or a refusal naming why it is not on offer. */
export function enabledAsset(
  assetId: AssetId,
  env: NodeJS.ProcessEnv = process.env
): EnabledAsset {
  const config = readChainPaymentsConfig(env);
  const found = config.assets.find((entry) => entry.definition.id === assetId);
  if (found) return found;

  const problem = config.problems.find((entry) => entry.asset === assetId);
  throw new ChainInvoiceError(
    problem
      ? `${assetId} is not available: ${problem.reason}`
      : `${assetId} is not one of the coins this server takes.`,
    503
  );
}

export type NewInvoiceRequest = {
  paymentId: string;
  userId: string;
  assetId: AssetId;
  amountCents: number;
};

/**
 * Quotes an amount of coin and claims it, or says why not.
 *
 * The payment row already exists when this is called - the same ordering the
 * card path uses, and for the same reason: the thing a settlement lands on has
 * to exist before anybody can pay it.
 */
export async function openInvoice(
  request: NewInvoiceRequest,
  env: NodeJS.ProcessEnv = process.env,
  at: Date = new Date()
): Promise<ChainInvoice> {
  const config = readChainPaymentsConfig(env);
  const enabled = enabledAsset(request.assetId, env);
  const asset = enabled.definition;

  /*
   * A ceiling on how many amounts one account may hold at once.
   *
   * Every open invoice takes a slot out of a finite lattice - Bitcoin has a
   * hundred of them, deliberately - so an account opening invoices in a loop
   * would exhaust the asset for everybody else without paying for anything.
   */
  const open = countOpenInvoicesForUser(request.userId);
  if (open >= config.maxOpenInvoicesPerUser) {
    throw new ChainInvoiceError(
      `You have ${open} crypto payments already waiting. Finish or abandon one before ` +
        'starting another.',
      429
    );
  }

  let rate;
  try {
    rate = await rateFor(asset, env, at);
  } catch (error) {
    if (error instanceof RateUnavailableError) {
      throw new ChainInvoiceError(error.message, 503);
    }
    throw error;
  }

  const amountAtomic = usdCentsToAtomic(
    request.amountCents,
    rate.usd,
    asset,
    config.spreadPercent
  );
  if (amountAtomic <= 0n) {
    throw new ChainInvoiceError('That amount is too small to send on this network.');
  }

  /*
   * Two deadlines, and they are deliberately different.
   *
   * `quoteExpiresAt` is when the RATE stops being honoured: the countdown the
   * buyer watches, and after which the amount they were quoted is no longer
   * the amount this sale is worth.
   *
   * `monitorUntil` is how long the watcher keeps looking, and it is LATER -
   * because a transfer sent in the last second of the window still has to
   * confirm, and a chain takes its own time about that. Bitcoin's two
   * confirmations are twenty minutes on their own. Cutting the watcher off at
   * the quote's expiry would mean money that was sent in good time arriving to
   * find nobody watching.
   */
  const quoteExpiresAt = new Date(at.getTime() + config.quoteTtlSeconds * 1000);
  const chain = CHAINS[asset.chain];
  const confirmationGraceMs = chain.confirmations * chain.blockSeconds * 1000;
  const monitorUntil = new Date(
    quoteExpiresAt.getTime() +
      confirmationGraceMs +
      (config.creditLatePayments ? config.monitorWindowHours * 60 * 60 * 1000 : 0)
  );

  try {
    return createChainInvoice({
      paymentId: request.paymentId,
      chain: asset.chain,
      asset: asset.id,
      address: enabled.address,
      amountAtomic: amountAtomic.toString(),
      decimals: asset.decimals,
      unitPriceUsd: rate.usd,
      quoteExpiresAt: quoteExpiresAt.toISOString(),
      monitorUntil: monitorUntil.toISOString(),
    });
  } catch (error) {
    if (error instanceof SlotTakenError) {
      /*
       * 409, and the wording matters.
       *
       * This is not the buyer's mistake and nothing is wrong with their order:
       * somebody else is mid-purchase at the same figure, and the amounts have
       * to stay distinct or neither payment can be attributed. A moment later,
       * or a different amount, and it works.
       */
      throw new ChainInvoiceError(
        `Somebody is already paying exactly ${formatAtomic(amountAtomic, asset.decimals)} ` +
          `${asset.symbol}. Try again in a moment, or choose a different amount.`,
        409
      );
    }
    throw error;
  }
}

/** What the browser is told about an invoice. No internal ids. */
export function describeInvoice(invoice: ChainInvoice) {
  const asset = ASSETS[invoice.asset];
  const chain = CHAINS[invoice.chain];
  return {
    asset: invoice.asset,
    assetLabel: asset.label,
    symbol: asset.symbol,
    chain: invoice.chain,
    chainLabel: chain.label,
    address: invoice.address,
    /** The figure to send, as a buyer reads it. */
    amount: formatAtomic(invoice.amountAtomic, invoice.decimals),
    amountAtomic: invoice.amountAtomic,
    decimals: invoice.decimals,
    /** What has arrived so far, when anything has. */
    paid: invoice.seenAmount ? formatAtomic(invoice.seenAmount, invoice.decimals) : '',
    confirmations: invoice.confirmations,
    confirmationsNeeded: chain.confirmations,
    state: invoice.state,
    expiresAt: invoice.quoteExpiresAt,
    ...(invoice.seenTxid ? { txid: invoice.seenTxid } : {}),
  };
}
