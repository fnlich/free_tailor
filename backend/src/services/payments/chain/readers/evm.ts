import {
  ASSETS,
  CHAINS,
  EVM_CHAIN_IDS,
  TRANSFER_TOPIC,
  type AssetDefinition,
} from '../../../../config/chainAssets';
import type { ChainPaymentsConfig } from '../../../../config/chainPayments';
import type { ChainTransfer } from '../../../../types/chainInvoice';
import { rpcCall } from '../rpc';

/**
 * Reading ERC-20 transfers off an EVM chain.
 *
 * Only tokens. A native transfer - plain ETH, plain BNB - emits no log at all
 * and can only be found by pulling whole block bodies, which against a free
 * public node is both the slowest thing here and the first thing to be rate
 * limited. Neither native asset is offered, so neither is read; adding one
 * later is a second function in this file and nothing else.
 *
 * The filter does the work. `eth_getLogs` is asked for exactly the logs that
 * matter - this contract, the Transfer topic, and our own address in the
 * recipient position - so a busy token like USDT returns a handful of entries
 * rather than the tens of thousands it emits an hour.
 *
 * **Tokens are identified by contract address and by nothing else.** The
 * `address` filter below is that rule in force: anybody can deploy a contract
 * whose name is "Tether USD" and emit Transfer events from it all day, and a
 * reader that matched on a symbol would credit them.
 */

/** An address as a 32-byte log topic: 24 zero bytes then the 20-byte address. */
export function addressTopic(address: string): string {
  const bare = address.toLowerCase().replace(/^0x/, '');
  return `0x${bare.padStart(64, '0')}`;
}

type EvmLog = {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
  removed?: boolean;
};

/**
 * Turns an `eth_getLogs` result into transfers. Pure, so tests feed it bytes.
 *
 * Anything that does not look exactly like a Transfer to our address from this
 * contract is dropped rather than guessed at. A log this function does not
 * fully understand is not a payment it should credit.
 */
export function parseTransferLogs(
  result: unknown,
  asset: AssetDefinition,
  address: string,
  tipHeight: number
): ChainTransfer[] {
  if (!Array.isArray(result)) return [];
  const wantedContract = asset.contract?.toLowerCase();
  const wantedRecipient = addressTopic(address);
  const transfers: ChainTransfer[] = [];

  for (const entry of result as EvmLog[]) {
    if (!entry || typeof entry !== 'object') continue;
    // A removed log is one a reorg took back out. It is not a payment.
    if (entry.removed === true) continue;
    if (!wantedContract || entry.address?.toLowerCase() !== wantedContract) continue;

    const topics = Array.isArray(entry.topics) ? entry.topics : [];
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    // topics[1] is the sender and topics[2] the recipient. Only the second
    // matters: money coming IN.
    if (topics[2]?.toLowerCase() !== wantedRecipient) continue;

    const raw = entry.data ?? '0x0';
    let amount: bigint;
    try {
      amount = BigInt(raw);
    } catch {
      continue;
    }
    if (amount <= 0n) continue;

    const height = Number.parseInt(entry.blockNumber ?? '', 16);
    if (!Number.isFinite(height)) continue;

    transfers.push({
      chain: asset.chain,
      asset: asset.id,
      txid: entry.transactionHash ?? '',
      amountAtomic: amount.toString(),
      height,
      // Depth from the tip, floored at zero: an endpoint answering from
      // slightly behind the one that gave us the tip must not produce a
      // negative depth that then reads as "deep enough".
      confirmations: Math.max(0, tipHeight - height + 1),
    });
  }

  return transfers;
}

/** Which endpoint list serves which method. See the note in chainPayments.ts. */
function endpointsFor(
  asset: AssetDefinition,
  config: ChainPaymentsConfig,
  method: string
): string[] {
  if (asset.chain !== 'bsc') return config.endpoints.ethereumRpc;
  /*
   * BNB Chain's public nodes split BY METHOD, and nothing documents it.
   * `bsc-dataseed` refuses eth_getLogs outright; `bsc-rpc.publicnode.com`
   * refuses old receipts because that is an archive request. Routing by
   * method is the only arrangement where both jobs get done.
   */
  return method === 'eth_getLogs' ? config.endpoints.bscLogRpc : config.endpoints.bscStateRpc;
}

export async function readTipHeight(
  asset: AssetDefinition,
  config: ChainPaymentsConfig
): Promise<number> {
  const result = await rpcCall(endpointsFor(asset, config, 'eth_blockNumber'), 'eth_blockNumber', []);
  const height = Number.parseInt(String(result ?? ''), 16);
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`${asset.chain} answered an unusable block height: ${String(result)}`);
  }
  return height;
}

/**
 * Checks the endpoint is on the chain this code thinks it is.
 *
 * A testnet URL left in `.env` answers every other call perfectly and watches
 * an address that will never receive a real payment - the failure is total and
 * completely silent. `eth_chainId` is one request that makes it loud.
 */
export async function assertChainId(
  asset: AssetDefinition,
  config: ChainPaymentsConfig
): Promise<void> {
  const expected = EVM_CHAIN_IDS[asset.chain as 'ethereum' | 'bsc'];
  const result = await rpcCall(endpointsFor(asset, config, 'eth_chainId'), 'eth_chainId', []);
  const actual = Number.parseInt(String(result ?? ''), 16);
  if (actual !== expected) {
    throw new Error(
      `The ${asset.chain} endpoint reports chain id ${actual}, not ${expected}. It is pointed ` +
        'at a different network, so payments to it would never be seen.'
    );
  }
}

/** How many blocks to ask for at once. Public nodes refuse wide ranges. */
export const MAX_BLOCK_SPAN = 800;

export async function readTransfers(
  asset: AssetDefinition,
  address: string,
  fromHeight: number,
  toHeight: number,
  config: ChainPaymentsConfig,
  tipHeight: number
): Promise<ChainTransfer[]> {
  if (!asset.contract) return [];

  const result = await rpcCall(endpointsFor(asset, config, 'eth_getLogs'), 'eth_getLogs', [
    {
      fromBlock: `0x${fromHeight.toString(16)}`,
      toBlock: `0x${toHeight.toString(16)}`,
      address: asset.contract,
      // null in the sender slot: from anybody, to us.
      topics: [TRANSFER_TOPIC, null, addressTopic(address)],
    },
  ]);

  return parseTransferLogs(result, asset, address, tipHeight);
}

type EvmReceipt = { blockNumber?: string; status?: string };

/**
 * Pure. The height a transaction landed at, or 0 for "not on the chain".
 *
 * Zero covers three different answers that mean the same thing here: null (the
 * node has never heard of it), a receipt with no block (still in the mempool),
 * and a receipt whose status is failure. None of them is a payment, and the
 * caller treats all three as "not confirmed yet".
 */
export function parseReceiptHeight(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const receipt = result as EvmReceipt;
  // `status` is 0x1 for success. A reverted transfer moved nothing.
  if (typeof receipt.status === 'string' && BigInt(receipt.status) !== 1n) return 0;
  const height = Number.parseInt(receipt.blockNumber ?? '', 16);
  return Number.isFinite(height) && height > 0 ? height : 0;
}

/**
 * Where one transaction is now, so an invoice already `seen` can be confirmed.
 *
 * This is why confirmation is its own pass rather than something the range
 * scan does. A transfer found in blocks 100-200 does not appear again when the
 * scan moves on to 201-300, so a watcher that measured depth from the scan
 * would conclude on the very next tick that the transfer had vanished. Asking
 * about the transaction directly is both correct and cheap: it is one request
 * per invoice that is mid-confirmation, and there are never many of those.
 */
export async function readTransactionHeight(
  asset: AssetDefinition,
  txid: string,
  config: ChainPaymentsConfig
): Promise<number> {
  const result = await rpcCall(
    endpointsFor(asset, config, 'eth_getTransactionReceipt'),
    'eth_getTransactionReceipt',
    [txid]
  );
  return parseReceiptHeight(result);
}

/** How deep a transfer must be on this chain before it counts. */
export function confirmationsNeeded(asset: AssetDefinition): number {
  return CHAINS[ASSETS[asset.id].chain].confirmations;
}
