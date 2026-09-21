/**
 * The chains and assets a buyer may pay with, and the constants that decide it.
 *
 * Two rules govern this file, and both exist because getting either wrong means
 * a customer's money arrives and is never credited.
 *
 * **Decimals are keyed on (chain, contract address), never on a symbol.** The
 * same token name carries different decimals on different chains: USDT is 6
 * decimals on Ethereum and TRON and 18 on BNB Chain. A $10 payment is
 * 10,000,000 raw units on Ethereum and 10,000,000,000,000,000,000 on BNB Chain
 * - a factor of a trillion. Nothing here may infer decimals from a symbol.
 *
 * **Tokens are matched by contract address, never by symbol or name.** Those
 * come off the chain and anybody can deploy a token calling itself "Tether USD"
 * and send a million of them. Only the address identifies a token.
 *
 * Every constant below is checked against the chain at startup - see
 * `chainPayments.ts`. A wrong value fails at boot with a loud message rather
 * than at payment time with a silence.
 */

export type ChainId = 'ethereum' | 'bsc' | 'tron' | 'bitcoin';
export type AssetId =
  | 'ethereum:USDT'
  | 'ethereum:USDC'
  | 'ethereum:ETH'
  | 'bsc:USDT'
  | 'bsc:USDC'
  | 'bsc:BNB'
  | 'tron:USDT'
  | 'bitcoin:BTC';

export type AddressKind = 'evm' | 'tron' | 'bitcoin';

export type ChainDefinition = {
  id: ChainId;
  label: string;
  addressKind: AddressKind;
  /** Which .env variable holds the receiving address for this chain. */
  addressVariable: string;
  /** How many confirmations before the money is treated as final. */
  confirmations: number;
  /** Roughly how long one block takes, for telling a buyer what to expect. */
  blockSeconds: number;
};

export const CHAINS: Record<ChainId, ChainDefinition> = {
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    addressKind: 'evm',
    addressVariable: 'CHAIN_EVM_ADDRESS',
    // Post-merge Ethereum finalises in epochs; 12 blocks is the usual
    // compromise between "safe" and "the buyer is still watching the page".
    confirmations: 12,
    blockSeconds: 12,
  },
  bsc: {
    id: 'bsc',
    label: 'BNB Chain',
    addressKind: 'evm',
    addressVariable: 'CHAIN_EVM_ADDRESS',
    confirmations: 15,
    blockSeconds: 3,
  },
  tron: {
    id: 'tron',
    label: 'TRON',
    addressKind: 'tron',
    addressVariable: 'CHAIN_TRON_ADDRESS',
    // TRON finalises after 19 block-producer confirmations; the network itself
    // marks a block irreversible at that point.
    confirmations: 19,
    blockSeconds: 3,
  },
  bitcoin: {
    id: 'bitcoin',
    label: 'Bitcoin',
    addressKind: 'bitcoin',
    addressVariable: 'CHAIN_BTC_ADDRESS',
    // Two blocks for a $5-$50 sale. One is the usual floor; two costs the
    // buyer ten more minutes and removes the cheap one-block reorg entirely.
    confirmations: 2,
    blockSeconds: 600,
  },
};

export type AssetDefinition = {
  id: AssetId;
  chain: ChainId;
  symbol: string;
  label: string;
  /** Native means the chain's own coin, with no contract behind it. */
  native: boolean;
  /** Lower-case hex for EVM, base58 for TRON. Absent for a native asset. */
  contract?: string;
  decimals: number;
  /** A stablecoin needs no exchange rate; it IS the rate. */
  stable: boolean;
  /** The id this asset's price is looked up under. Absent when stable. */
  priceId?: 'bitcoin' | 'ethereum' | 'binancecoin';
  /**
   * The smallest step between two quoted amounts, in atomic units.
   *
   * Not always 1. On BNB Chain a token has 18 decimals, and quoting a buyer an
   * 18-decimal amount produces a number no wallet renders legibly and that an
   * exchange withdrawal will silently truncate. So the step there is 10^12,
   * which leaves a normal-looking six-decimal amount padded with zeros.
   */
  slotUnit: bigint;
  /** How many distinct amounts may be in flight at once for this asset. */
  slotCount: number;
};

function asset(definition: AssetDefinition): AssetDefinition {
  return definition;
}

export const ASSETS: Record<AssetId, AssetDefinition> = {
  'ethereum:USDT': asset({
    id: 'ethereum:USDT',
    chain: 'ethereum',
    symbol: 'USDT',
    label: 'USDT on Ethereum',
    native: false,
    contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    decimals: 6,
    stable: true,
    slotUnit: 1n,
    slotCount: 10_000,
  }),
  'ethereum:USDC': asset({
    id: 'ethereum:USDC',
    chain: 'ethereum',
    symbol: 'USDC',
    label: 'USDC on Ethereum',
    native: false,
    contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    stable: true,
    slotUnit: 1n,
    slotCount: 10_000,
  }),
  'ethereum:ETH': asset({
    id: 'ethereum:ETH',
    chain: 'ethereum',
    symbol: 'ETH',
    label: 'ETH',
    native: true,
    decimals: 18,
    stable: false,
    priceId: 'ethereum',
    slotUnit: 1_000_000_000n, // one gwei
    slotCount: 1_000,
  }),
  'bsc:USDT': asset({
    id: 'bsc:USDT',
    chain: 'bsc',
    symbol: 'USDT',
    label: 'USDT on BNB Chain',
    native: false,
    contract: '0x55d398326f99059ff775485246999027b3197955',
    // EIGHTEEN, not six. This is the single highest-stakes number in the file.
    decimals: 18,
    stable: true,
    slotUnit: 1_000_000_000_000n,
    slotCount: 10_000,
  }),
  'bsc:USDC': asset({
    id: 'bsc:USDC',
    chain: 'bsc',
    symbol: 'USDC',
    label: 'USDC on BNB Chain',
    native: false,
    contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    decimals: 18,
    stable: true,
    slotUnit: 1_000_000_000_000n,
    slotCount: 10_000,
  }),
  'bsc:BNB': asset({
    id: 'bsc:BNB',
    chain: 'bsc',
    symbol: 'BNB',
    label: 'BNB',
    native: true,
    decimals: 18,
    stable: false,
    priceId: 'binancecoin',
    slotUnit: 1_000_000_000n,
    slotCount: 1_000,
  }),
  'tron:USDT': asset({
    id: 'tron:USDT',
    chain: 'tron',
    symbol: 'USDT',
    label: 'USDT on TRON',
    native: false,
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    stable: true,
    slotUnit: 1n,
    slotCount: 10_000,
  }),
  'bitcoin:BTC': asset({
    id: 'bitcoin:BTC',
    chain: 'bitcoin',
    symbol: 'BTC',
    label: 'Bitcoin',
    native: true,
    decimals: 8,
    stable: false,
    priceId: 'bitcoin',
    /*
     * One satoshi, and only a hundred of them.
     *
     * A satoshi is worth a fraction of a cent, so a hundred slots spread the
     * quoted amount by up to eight cents - which is over one percent of a $5
     * sale. That is not hidden (the buyer sees and agrees to the exact figure)
     * but it is real, and it is why this is 100 rather than the 10,000 the
     * stablecoins get.
     */
    slotUnit: 1n,
    slotCount: 100,
  }),
};

export const ALL_ASSET_IDS = Object.keys(ASSETS) as AssetId[];

/** The ERC-20 / TRC-20 `Transfer(address,address,uint256)` event topic. */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** What `eth_chainId` must answer for each EVM chain, so a testnet URL is caught. */
export const EVM_CHAIN_IDS: Record<'ethereum' | 'bsc', number> = {
  ethereum: 1,
  bsc: 56,
};

export function isAssetId(value: string): value is AssetId {
  return Object.prototype.hasOwnProperty.call(ASSETS, value);
}
