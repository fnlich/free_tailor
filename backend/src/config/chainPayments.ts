import {
  ALL_ASSET_IDS,
  ASSETS,
  CHAINS,
  isAssetId,
  type AssetDefinition,
  type AssetId,
  type ChainId,
} from './chainAssets';
import { checkAddress } from '../utils/chainAddress';

/**
 * Which crypto assets this installation can actually take, and why not.
 *
 * The house rule elsewhere is "a half-configured method is not offered at all",
 * because a method that can take money the server never hears about is worse
 * than no method. Here the same rule applies at a finer grain: the failure is
 * per ASSET, not per method. A missing TRON key endangers TRON payments and
 * nothing else, so TRON goes dark and Bitcoin carries on.
 *
 *   An asset is offered only when everything it needs is present and valid.
 *   The crypto method is offered when at least one asset is.
 *
 * An asset the operator explicitly asked for and that cannot be served is a
 * misconfiguration they need to SEE - it is reported, not silently dropped.
 */

export type EnabledAsset = {
  definition: AssetDefinition;
  /** The address a buyer sends to, already validated. */
  address: string;
};

export type AssetProblem = { asset: AssetId; reason: string };

export type ChainPaymentsConfig = {
  assets: EnabledAsset[];
  problems: AssetProblem[];
  /** Endpoints, per chain, tried in order. */
  endpoints: {
    ethereumRpc: string[];
    /** BNB Chain needs two sets. See the note below. */
    bscLogRpc: string[];
    bscStateRpc: string[];
    bitcoinApi: string[];
    tronApi: string[];
  };
  tronApiKey: string;
  coingeckoKey: string;
  pollSeconds: number;
  bitcoinPollSeconds: number;
  quoteTtlSeconds: number;
  monitorWindowHours: number;
  creditLatePayments: boolean;
  spreadPercent: number;
  maxOpenInvoicesPerUser: number;
};

/*
 * BNB Chain needs two sets of endpoints, and this is not redundancy.
 *
 * The public nodes split by METHOD. `bsc-dataseed.bnbchain.org` refuses
 * `eth_getLogs` outright - it is disabled on those endpoints - but serves state
 * and receipts happily. `bsc-rpc.publicnode.com` serves logs but refuses
 * receipts for anything more than a few hundred blocks old, because that is an
 * archive request. Neither can do the whole job, and nothing documents the
 * split, so routing by method is the only thing that works.
 */
const DEFAULTS = {
  ethereumRpc: ['https://ethereum-rpc.publicnode.com', 'https://gateway.tenderly.co/public/mainnet'],
  bscLogRpc: ['https://bsc-rpc.publicnode.com'],
  bscStateRpc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed-public.bnbchain.org'],
  bitcoinApi: ['https://mempool.space/api', 'https://blockstream.info/api'],
  tronApi: ['https://api.trongrid.io'],
};

function list(raw: string | undefined, fallback: string[]): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function number(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function addressFor(chain: ChainId, env: NodeJS.ProcessEnv): { address?: string; reason?: string } {
  const variable = CHAINS[chain].addressVariable;
  const raw = env[variable]?.trim() ?? '';
  if (!raw) return { reason: `${variable} is not set.` };

  const checked = checkAddress(CHAINS[chain].addressKind, raw);
  if (!checked.valid) return { reason: `${variable} is not usable: ${checked.reason}` };
  return { address: checked.normalized ?? raw };
}

/**
 * Reads the configuration. Cheap, synchronous, and does not touch the network.
 *
 * The on-chain half of the checking - that a contract really has the decimals
 * this code believes it has - happens in the watcher, because it needs the
 * network and the network must not be able to hold up a boot.
 */
export function readChainPaymentsConfig(
  env: NodeJS.ProcessEnv = process.env
): ChainPaymentsConfig {
  const requested = (env.CHAIN_ASSETS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const assets: EnabledAsset[] = [];
  const problems: AssetProblem[] = [];
  const addressCache = new Map<ChainId, { address?: string; reason?: string }>();
  const tronApiKey = env.TRONGRID_API_KEY?.trim() ?? '';

  for (const entry of requested) {
    if (!isAssetId(entry)) {
      problems.push({
        asset: entry as AssetId,
        reason: `"${entry}" is not an asset this server knows. Known assets: ${ALL_ASSET_IDS.join(', ')}.`,
      });
      continue;
    }

    const definition = ASSETS[entry];
    if (!addressCache.has(definition.chain)) {
      addressCache.set(definition.chain, addressFor(definition.chain, env));
    }
    const resolved = addressCache.get(definition.chain)!;
    if (!resolved.address) {
      problems.push({ asset: entry, reason: resolved.reason ?? 'No receiving address.' });
      continue;
    }

    /*
     * A native coin on an EVM chain cannot be watched, so it is not offered.
     *
     * The reader for Ethereum and BNB Chain finds transfers by asking for
     * Transfer LOGS from a token contract. A native transfer - plain ETH,
     * plain BNB - emits no log at all, so there is nothing to ask for; finding
     * one means pulling whole block bodies, hundreds an hour, which is the
     * first thing a free public node throttles. Bitcoin is native too and is
     * fine, because its APIs index an address for you.
     *
     * This guard is the difference between a misconfiguration and a money
     * loss, and it was missing. Without it `CHAIN_ASSETS=ethereum:ETH` was
     * accepted in full: offered to buyers as available, quoted a real address
     * and a real amount - and then `readers/evm.ts` returns nothing for an
     * asset with no contract, so the coin that arrived was never seen, never
     * credited and never even held for review. The documentation promised the
     * opposite of what the code did.
     */
    if (definition.native && CHAINS[definition.chain].addressKind === 'evm') {
      problems.push({
        asset: entry,
        reason:
          `${definition.symbol} is ${CHAINS[definition.chain].label}'s own coin, and a native ` +
          'transfer emits no log this server can watch for. Take a token on that chain ' +
          'instead - USDT or USDC - or take Bitcoin.',
      });
      continue;
    }

    /*
     * TRON without a key is TRON that stops working under load rather than
     * one that never works, which is the more dangerous shape: it would take
     * money and miss it. TronGrid's free tier is keyless only for light use.
     */
    if (definition.chain === 'tron' && !tronApiKey) {
      problems.push({
        asset: entry,
        reason: 'TRONGRID_API_KEY is not set. It is free, and TRON payments are unreliable without it.',
      });
      continue;
    }

    assets.push({ definition, address: resolved.address });
  }

  return {
    assets,
    problems,
    endpoints: {
      ethereumRpc: list(env.CHAIN_ETH_RPC_URLS, DEFAULTS.ethereumRpc),
      bscLogRpc: list(env.CHAIN_BSC_LOG_RPC_URLS, DEFAULTS.bscLogRpc),
      bscStateRpc: list(env.CHAIN_BSC_STATE_RPC_URLS, DEFAULTS.bscStateRpc),
      bitcoinApi: list(env.CHAIN_BTC_API_URLS, DEFAULTS.bitcoinApi),
      tronApi: list(env.CHAIN_TRON_API_URLS, DEFAULTS.tronApi),
    },
    tronApiKey,
    coingeckoKey: env.COINGECKO_DEMO_API_KEY?.trim() ?? '',
    pollSeconds: number(env.CHAIN_POLL_INTERVAL_SECONDS, 30, 10, 600),
    bitcoinPollSeconds: number(env.BTC_POLL_INTERVAL_SECONDS, 60, 15, 900),
    quoteTtlSeconds: number(env.CHAIN_QUOTE_TTL_SECONDS, 1_200, 120, 3600),
    monitorWindowHours: number(env.CHAIN_MONITOR_WINDOW_HOURS, 24, 1, 168),
    creditLatePayments: (env.CHAIN_CREDIT_LATE_PAYMENTS ?? 'true').trim() !== 'false',
    spreadPercent: number(env.CHAIN_RATE_SPREAD_PERCENT, 1, 0, 10),
    maxOpenInvoicesPerUser: number(env.CHAIN_MAX_OPEN_INVOICES_PER_USER, 3, 1, 20),
  };
}

/** True when at least one asset can actually be paid with. */
export function isChainPaymentsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readChainPaymentsConfig(env).assets.length > 0;
}

/**
 * What to tell an operator who has not finished setting this up.
 *
 * Written for whoever has to fix it, which is why it names variables rather
 * than describing them.
 */
export function chainPaymentsReason(env: NodeJS.ProcessEnv = process.env): string {
  const config = readChainPaymentsConfig(env);
  if (config.assets.length > 0) return '';
  if (config.problems.length === 0) {
    return 'Set CHAIN_ASSETS and the receiving addresses to take crypto payments.';
  }
  return config.problems.map((problem) => `${problem.asset}: ${problem.reason}`).join(' ');
}
