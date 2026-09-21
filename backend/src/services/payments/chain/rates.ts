import { ASSETS, type AssetDefinition, type AssetId } from '../../../config/chainAssets';
import { readChainPaymentsConfig } from '../../../config/chainPayments';
import { getJson } from './rpc';

/**
 * What one whole unit of an asset is worth in USD.
 *
 * Two rules, and the first one removes most of the work.
 *
 * **A stablecoin is its own rate.** `stable: true` means exactly $1 and no
 * network call at all - not a call that usually returns 1.00, no call. Five of
 * the six assets this installation offers are stablecoins, so the feed below
 * exists for Bitcoin and for whatever volatile asset is added next.
 *
 * **A rate that cannot be fetched falls back to the last one that could.**
 * This is the operator's choice and it is the right one for a quote that lives
 * twenty minutes: a price a few minutes stale, widened by the configured
 * spread, is a number somebody can stand behind, and refusing the sale outright
 * because a third-party price API had a bad minute costs a customer for
 * nothing. What is NOT acceptable is quoting from no price at all, so an asset
 * whose price has never once been fetched is reported unavailable rather than
 * quoted at zero - there is nothing to be stale about yet.
 *
 * The price used is recorded on the invoice, so a dispute months later is
 * argued from the figure the buyer was actually shown rather than from what
 * the feed says today.
 */

export class RateUnavailableError extends Error {
  constructor(readonly asset: AssetId, message: string) {
    super(message);
    this.name = 'RateUnavailableError';
  }
}

export type Rate = {
  /** USD for one whole unit, as a string so it is recorded exactly. */
  usd: string;
  /** When this price was fetched. Equal to now for a fresh one. */
  at: string;
  /** True when the feed could not be reached and this came from the cache. */
  stale: boolean;
};

type CacheEntry = { usd: string; at: number };

/**
 * Last known good price per CoinGecko id, for the life of the process.
 *
 * In memory rather than in the database, deliberately. A price is only useful
 * while it is recent; one restored from disk after a week's downtime would be
 * a stale number wearing a fresh number's clothes, and the honest behaviour on
 * a cold start is to fetch or refuse.
 */
const cache = new Map<string, CacheEntry>();

/** How old a cached price may be before a fetch is attempted again. */
const CACHE_TTL_MS = 60_000;

/** Exported for tests, which need a cold cache per case. */
export function clearRateCache(): void {
  cache.clear();
}

type CoingeckoResponse = Record<string, { usd?: number } | undefined>;

/**
 * Parses a CoinGecko `/simple/price` body. Pure, so a test can feed it bytes.
 *
 * Returns null rather than throwing for anything unexpected: a feed that has
 * changed shape is the same fact as a feed that is down, and both mean "use
 * the cache".
 */
export function parseCoingeckoPrice(body: unknown, priceId: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const entry = (body as CoingeckoResponse)[priceId];
  if (!entry || typeof entry.usd !== 'number') return null;
  if (!Number.isFinite(entry.usd) || entry.usd <= 0) return null;
  return String(entry.usd);
}

async function fetchPrice(priceId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const config = readChainPaymentsConfig(env);
  const headers: Record<string, string> = {};
  if (config.coingeckoKey) headers['x-cg-demo-api-key'] = config.coingeckoKey;

  try {
    const body = await getJson(
      ['https://api.coingecko.com/api/v3'],
      `/simple/price?ids=${encodeURIComponent(priceId)}&vs_currencies=usd`,
      headers
    );
    return parseCoingeckoPrice(body, priceId);
  } catch {
    // Swallowed on purpose. The caller's next move is the cache either way,
    // and a price feed being unreachable is not an error anybody can act on.
    return null;
  }
}

/**
 * The rate for one asset, fetching only when it has to.
 *
 * @throws RateUnavailableError when there is no price and never has been.
 */
export async function rateFor(
  asset: AssetDefinition,
  env: NodeJS.ProcessEnv = process.env,
  at: Date = new Date()
): Promise<Rate> {
  if (asset.stable) {
    return { usd: '1', at: at.toISOString(), stale: false };
  }

  if (!asset.priceId) {
    // A non-stable asset with nothing to look its price up under is a
    // misconfiguration in this repository's own constants, not the operator's.
    throw new RateUnavailableError(
      asset.id,
      `${asset.id} is not a stablecoin and has no price id, so it cannot be quoted.`
    );
  }

  const cached = cache.get(asset.priceId);
  if (cached && at.getTime() - cached.at < CACHE_TTL_MS) {
    return { usd: cached.usd, at: new Date(cached.at).toISOString(), stale: false };
  }

  const fresh = await fetchPrice(asset.priceId, env);
  if (fresh) {
    cache.set(asset.priceId, { usd: fresh, at: at.getTime() });
    return { usd: fresh, at: at.toISOString(), stale: false };
  }

  if (cached) {
    console.warn(
      `[chain] The price feed did not answer for ${asset.id}; using the last known price ` +
        `of $${cached.usd} from ${new Date(cached.at).toISOString()}.`
    );
    return { usd: cached.usd, at: new Date(cached.at).toISOString(), stale: true };
  }

  throw new RateUnavailableError(
    asset.id,
    `The price of ${asset.symbol} is not available yet, so it cannot be quoted. Try again in ` +
      'a moment, or pay with a stablecoin.'
  );
}

/** Convenience for callers holding an id rather than a definition. */
export async function rateForAsset(
  assetId: AssetId,
  env: NodeJS.ProcessEnv = process.env,
  at: Date = new Date()
): Promise<Rate> {
  return rateFor(ASSETS[assetId], env, at);
}
