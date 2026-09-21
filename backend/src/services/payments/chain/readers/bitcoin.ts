import type { AssetDefinition } from '../../../../config/chainAssets';
import type { ChainPaymentsConfig } from '../../../../config/chainPayments';
import type { ChainTransfer } from '../../../../types/chainInvoice';
import { getJson } from '../rpc';

/**
 * Reading payments to a Bitcoin address.
 *
 * Bitcoin is native-only and still the cheapest of the four to watch, which
 * looks like a contradiction until you see why: there are no tokens and no
 * logs, but mempool.space and blockstream both index an address's history and
 * serve it whole. Nothing is scanned. That is the same reason ETH and BNB are
 * NOT offered - on those chains a native transfer can only be found by pulling
 * block bodies, because nobody indexes an address for you.
 *
 * The two supported APIs answer the same shape, which is not a coincidence:
 * mempool.space implements Esplora, blockstream wrote it. So one parser serves
 * both, and the endpoint list can fall through from one to the other without
 * the reader knowing which answered.
 *
 * **Outputs are summed, not taken one at a time.** A wallet paying us may
 * produce several outputs to the same address in one transaction - and, more
 * to the point, one of the outputs is usually change going back to the sender.
 * Summing only the outputs that pay US is what makes the figure the amount we
 * actually received.
 */

type EsploraVout = {
  scriptpubkey_address?: string;
  value?: number;
};

type EsploraTx = {
  txid?: string;
  vout?: EsploraVout[];
  status?: { confirmed?: boolean; block_height?: number };
};

/**
 * Turns an Esplora address history into transfers. Pure.
 *
 * An unconfirmed transaction is included with `height: 0` and zero
 * confirmations rather than dropped: the buyer has sent it, the panel should
 * be able to say so, and the settlement path will not credit anything that is
 * not deep enough anyway. Showing "seen, waiting for confirmations" is the
 * difference between a page that looks broken and one that is informative.
 */
export function parseAddressHistory(
  body: unknown,
  asset: AssetDefinition,
  address: string,
  tipHeight: number
): ChainTransfer[] {
  if (!Array.isArray(body)) return [];
  const transfers: ChainTransfer[] = [];

  for (const entry of body as EsploraTx[]) {
    if (!entry || typeof entry !== 'object') continue;
    const outputs = Array.isArray(entry.vout) ? entry.vout : [];

    let received = 0n;
    for (const output of outputs) {
      if (output?.scriptpubkey_address !== address) continue;
      const value = output.value;
      // Satoshis arrive as a JSON number. Every whole-bitcoin amount is well
      // inside the safe integer range, so this one is checked rather than
      // feared - but it is checked.
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue;
      received += BigInt(value);
    }
    if (received <= 0n) continue;

    const confirmed = entry.status?.confirmed === true;
    const height = confirmed ? (entry.status?.block_height ?? 0) : 0;

    transfers.push({
      chain: asset.chain,
      asset: asset.id,
      txid: entry.txid ?? '',
      amountAtomic: received.toString(),
      height,
      confirmations: confirmed && height > 0 ? Math.max(0, tipHeight - height + 1) : 0,
    });
  }

  return transfers;
}

/** Pure. The tip comes back as a bare number in the body, not as JSON. */
export function parseTipHeight(body: unknown): number {
  const height = typeof body === 'number' ? body : Number.parseInt(String(body ?? ''), 10);
  return Number.isFinite(height) && height > 0 ? height : 0;
}

export async function readTipHeight(config: ChainPaymentsConfig): Promise<number> {
  const height = parseTipHeight(await getJson(config.endpoints.bitcoinApi, '/blocks/tip/height'));
  if (height <= 0) throw new Error('The Bitcoin API answered an unusable block height.');
  return height;
}

export async function readTransfers(
  asset: AssetDefinition,
  address: string,
  config: ChainPaymentsConfig,
  tipHeight: number
): Promise<ChainTransfer[]> {
  const body = await getJson(
    config.endpoints.bitcoinApi,
    `/address/${encodeURIComponent(address)}/txs`
  );
  return parseAddressHistory(body, asset, address, tipHeight);
}

type EsploraStatus = { status?: { confirmed?: boolean; block_height?: number } };

/** Pure. Zero means not confirmed, or not on the chain at all. */
export function parseTransactionHeight(body: unknown): number {
  const status = (body as EsploraStatus)?.status;
  if (status?.confirmed !== true) return 0;
  const height = status.block_height;
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : 0;
}

/**
 * Where one transaction is now, so an invoice already seen can be confirmed.
 *
 * Bitcoin's address history would serve for this too - it is re-read whole
 * each tick - but asking about the transaction directly is the same question
 * the other two chains are asked, and one shape of answer across all three is
 * worth one extra request.
 */
export async function readTransactionHeight(
  txid: string,
  config: ChainPaymentsConfig
): Promise<number> {
  return parseTransactionHeight(
    await getJson(config.endpoints.bitcoinApi, `/tx/${encodeURIComponent(txid)}`)
  );
}
