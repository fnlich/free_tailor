import type { AssetDefinition } from '../../../../config/chainAssets';
import type { ChainPaymentsConfig } from '../../../../config/chainPayments';
import type { ChainTransfer } from '../../../../types/chainInvoice';
import { getJson, postJson } from '../rpc';

/**
 * Reading TRC-20 transfers off TRON.
 *
 * TRON is the odd one of the four: it is not an EVM JSON-RPC at all from the
 * outside. TronGrid serves a REST index of an address's TRC-20 transfers
 * directly, which is both simpler and better than scanning - it hands back the
 * transfers already attributed to the address, newest first.
 *
 * Amounts come back as DECIMAL strings, not hex, and they are the raw token
 * units. `BigInt(value)` is exact on a decimal string, which is the whole
 * reason nothing here converts through a Number.
 *
 * As everywhere else, the token is identified by contract address. TronGrid
 * helpfully includes `token_info.symbol`, and it is ignored: a symbol is a
 * label anybody can mint.
 */

type TronTransfer = {
  transaction_id?: string;
  token_info?: { address?: string; decimals?: number; symbol?: string };
  from?: string;
  to?: string;
  value?: string;
  block_timestamp?: number;
};

/**
 * Turns a TronGrid `trc20` listing into transfers. Pure.
 *
 * `blockNumber` is not in this response - TronGrid gives a timestamp instead -
 * so `height` comes back as 0 and confirmations are resolved separately by
 * the caller, which knows the tip. That is a genuine limitation of the REST
 * index rather than an oversight, and it is why the TRON path confirms by
 * re-reading rather than by arithmetic on a height.
 */
export function parseTronTransfers(
  body: unknown,
  asset: AssetDefinition,
  address: string
): ChainTransfer[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const wantedContract = asset.contract;
  const transfers: ChainTransfer[] = [];

  for (const entry of data as TronTransfer[]) {
    if (!entry || typeof entry !== 'object') continue;
    // Base58 on TRON is case-sensitive, so this is an exact comparison.
    if (!wantedContract || entry.token_info?.address !== wantedContract) continue;
    if (entry.to !== address) continue;

    const raw = (entry.value ?? '').trim();
    if (!/^\d+$/.test(raw)) continue;
    const amount = BigInt(raw);
    if (amount <= 0n) continue;

    transfers.push({
      chain: asset.chain,
      asset: asset.id,
      txid: entry.transaction_id ?? '',
      amountAtomic: amount.toString(),
      height: 0,
      // Filled in by the caller. Zero here is "not yet known", and the
      // settlement path treats not-yet-known as not-yet-deep-enough.
      confirmations: 0,
    });
  }

  return transfers;
}

export async function readTransfers(
  asset: AssetDefinition,
  address: string,
  config: ChainPaymentsConfig,
  limit = 50
): Promise<ChainTransfer[]> {
  if (!asset.contract) return [];

  const headers: Record<string, string> = {};
  /*
   * The key is not optional in practice.
   *
   * TronGrid's keyless tier is rate limited to something a single busy minute
   * exhausts, and the failure mode is 429 rather than an error a person
   * notices - a watcher that quietly stops looking. `chainPayments.ts` refuses
   * to enable TRON without one for exactly this reason; the header is here for
   * when it is present.
   */
  if (config.tronApiKey) headers['TRON-PRO-API-KEY'] = config.tronApiKey;

  const body = await getJson(
    config.endpoints.tronApi,
    `/v1/accounts/${encodeURIComponent(address)}/transactions/trc20` +
      `?only_to=true&limit=${limit}&contract_address=${encodeURIComponent(asset.contract)}`,
    headers
  );

  return parseTronTransfers(body, asset, address);
}

type TronBlock = { block_header?: { raw_data?: { number?: number } } };

/** Pure, so the shape below is pinned by a test rather than by hope. */
export function parseTronHeight(body: unknown): number {
  const height = (body as TronBlock)?.block_header?.raw_data?.number;
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : 0;
}

/**
 * The current block height, for working out how deep a transfer is.
 *
 * POSTed, not fetched. TronGrid's `/wallet/*` routes are POST even when they
 * take no arguments - `getnowblock` is posted an empty object - and a GET to
 * them answers something that is not the block.
 */
export async function readTipHeight(config: ChainPaymentsConfig): Promise<number> {
  const headers: Record<string, string> = {};
  if (config.tronApiKey) headers['TRON-PRO-API-KEY'] = config.tronApiKey;

  const height = parseTronHeight(
    await postJson(config.endpoints.tronApi, '/wallet/getnowblock', {}, headers)
  );
  if (height <= 0) throw new Error('TRON answered an unusable block height.');
  return height;
}

type TronTransactionInfo = { blockNumber?: number };

/** Pure. Zero means "no height in that answer", which is not "height zero". */
export function parseTransactionHeight(body: unknown): number {
  const height = (body as TronTransactionInfo)?.blockNumber;
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : 0;
}

/**
 * The block one transaction landed in, so its depth can be measured.
 *
 * A second request per seen transfer, which sounds wasteful until you notice
 * it is only made for transfers that actually match an open invoice - at most
 * a handful at a time, and only while somebody is mid-purchase.
 */
export async function readTransactionHeight(
  txid: string,
  config: ChainPaymentsConfig
): Promise<number> {
  const headers: Record<string, string> = {};
  if (config.tronApiKey) headers['TRON-PRO-API-KEY'] = config.tronApiKey;

  return parseTransactionHeight(
    await postJson(
      config.endpoints.tronApi,
      '/wallet/gettransactioninfobyid',
      { value: txid },
      headers
    )
  );
}
