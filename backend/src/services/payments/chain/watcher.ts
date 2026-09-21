import { CHAINS, type ChainId } from '../../../config/chainAssets';
import {
  readChainPaymentsConfig,
  type ChainPaymentsConfig,
  type EnabledAsset,
} from '../../../config/chainPayments';
import { advanceCursor, getCursor } from '../../../database/chainCursorRepository';
import {
  listOpenInvoices,
  releaseFinishedInvoices,
} from '../../../database/chainInvoiceRepository';
import type { ChainTransfer } from '../../../types/chainInvoice';
import * as bitcoin from './readers/bitcoin';
import * as evm from './readers/evm';
import * as tron from './readers/tron';
import { forgetSeenTransfer, settleTransfer } from './settle';

/**
 * The process that watches the chains and credits what arrives.
 *
 * Started at boot beside `startOrderRetention()`, and built the same way: stop
 * whatever is running, sweep once immediately, then on an interval, with the
 * timer unref'd so it never holds the process open. A sweep that throws is
 * logged and the next one runs.
 *
 * Three rules keep it honest.
 *
 * **"We could not look" is never "nothing arrived".** Every read here can fail
 * - a public node rate-limits, lags, or answers from a stale fork - and a
 * failure moves to the next endpoint and then to the next tick. Nothing is
 * ever marked failed or expired because a request did not come back. The only
 * thing that expires an invoice is the clock.
 *
 * **The cursor moves in the same transaction as the work it produced.** A
 * cursor advanced first is a crash away from a transfer that arrived, was
 * never recorded, and will never be looked for again.
 *
 * **A quiet chain costs nothing.** Assets with no open invoice are not read at
 * all, so an installation with nobody mid-purchase makes no requests beyond a
 * tip height - which matters when the endpoints are free ones with a budget.
 */

type ChainTimer = ReturnType<typeof setInterval>;

const timers = new Map<ChainId, ChainTimer>();

/** Endpoints already checked to be on the chain they claim, per process. */
const verifiedChains = new Set<ChainId>();

/** Exported for tests, which need each case to re-verify. */
export function resetChainVerification(): void {
  verifiedChains.clear();
}

function assetsOn(chain: ChainId, config: ChainPaymentsConfig): EnabledAsset[] {
  return config.assets.filter((entry) => entry.definition.chain === chain);
}

/**
 * Reads one EVM chain and settles what it finds.
 *
 * Two heights, and conflating them cost the buyer's page its most useful
 * state. Discovery reads all the way to the TIP, so a transfer three blocks
 * old is found and the invoice can say "we can see it, it is confirming" -
 * without that, an Ethereum buyer stares at an unchanged screen for twelve
 * blocks and then it is simply done. Crediting still waits for depth; the
 * settler decides that, not the scan.
 *
 * The CURSOR, though, only ever advances to the safe height - the tip less the
 * confirmation depth. A cursor past that would mark blocks as read whose
 * contents can still change, and a reorg would then drop a transfer this
 * server had already decided it had seen everything in. So the last few blocks
 * are deliberately re-read on every tick, which is cheap and is the only
 * arrangement where neither fact is lost.
 */
async function sweepEvm(
  chain: ChainId,
  entries: EnabledAsset[],
  config: ChainPaymentsConfig
): Promise<number> {
  const sample = entries[0].definition;

  if (!verifiedChains.has(chain)) {
    // Once per process. A testnet URL answers everything else perfectly and
    // watches an address that will never be paid, so this is worth a request.
    await evm.assertChainId(sample, config);
    verifiedChains.add(chain);
  }

  const tip = await evm.readTipHeight(sample, config);
  const safeTip = Math.max(0, tip - CHAINS[chain].confirmations);
  const cursor = getCursor(chain);

  if (cursor === null) {
    /*
     * A first run has no history to catch up on, and must not invent one.
     *
     * Starting from genesis is days of requests no public node will serve;
     * starting from the tip is correct and is said out loud, because an
     * operator switching a chain on should know that anything paid BEFORE
     * this moment was never watched for.
     */
    advanceCursor(chain, safeTip);
    console.log(
      `[chain] ${CHAINS[chain].label}: starting from block ${safeTip}. Transfers before that ` +
        'block are not looked for.'
    );
    return confirmSeen(chain, entries, config, tip);
  }

  const from = cursor + 1;
  if (from > tip) {
    /*
     * The cursor is ahead of the chain, which should be impossible.
     *
     * A tip only grows, so this means the endpoint is answering for a
     * DIFFERENT chain than the one this cursor was built against - a testnet
     * URL swapped in, a node restored from a snapshot, a database copied
     * between installations. The dangerous part is what happens next if
     * nothing is said: every sweep from here on reads nothing, finds nothing
     * and logs nothing, so the watcher looks healthy while no payment is ever
     * seen again. Saying it is the whole fix; it is not this code's business
     * to decide whose number is wrong.
     */
    if (from > tip + 1) {
      console.warn(
        `[chain] ${CHAINS[chain].label}: the last block read (${cursor}) is ahead of the chain's ` +
          `own tip (${tip}). No transfer will be seen until that is resolved - check that the ` +
          'endpoint is on the network you think it is.'
      );
    }
    return confirmSeen(chain, entries, config, tip);
  }
  const to = Math.min(tip, from + evm.MAX_BLOCK_SPAN - 1);

  let settled = 0;
  for (const entry of entries) {
    const asset = entry.definition;
    // Nothing open on this asset means nothing to find, so do not ask.
    if (listOpenInvoices(chain, asset.id).length === 0) continue;

    const transfers = await evm.readTransfers(asset, entry.address, from, to, config, tip);
    settled += handleTransfers(transfers);
  }

  /*
   * Read to `to`, remembered only as far as `safeTip`.
   *
   * The gap between them is re-read next tick on purpose: those blocks can
   * still be reorganised, and a cursor that had passed them would mean a
   * transfer that changed blocks was never looked at again.
   */
  advanceCursor(chain, Math.min(to, safeTip));
  return settled + (await confirmSeen(chain, entries, config, tip));
}

/**
 * TRON, which is indexed rather than scanned.
 *
 * TronGrid hands back an address's recent TRC-20 transfers directly, so there
 * is no range and no cursor to advance - the listing is re-read each tick and
 * the invoice's own state is what stops a transfer being settled twice. The
 * cursor is still written, as a record of how current the read is.
 */
async function sweepTron(entries: EnabledAsset[], config: ChainPaymentsConfig): Promise<number> {
  const tip = await tron.readTipHeight(config);
  let settled = 0;

  for (const entry of entries) {
    const asset = entry.definition;
    if (listOpenInvoices('tron', asset.id).length === 0) continue;

    const transfers = await tron.readTransfers(asset, entry.address, config);
    // The listing carries no block number, so depth is resolved per transfer -
    // and only for the ones that matter, which is at most a handful.
    const measured: ChainTransfer[] = [];
    for (const transfer of transfers) {
      const height = transfer.txid ? await tron.readTransactionHeight(transfer.txid, config) : 0;
      measured.push({
        ...transfer,
        height,
        confirmations: height > 0 ? Math.max(0, tip - height + 1) : 0,
      });
    }
    settled += handleTransfers(measured);
  }

  advanceCursor('tron', tip);
  return settled + (await confirmSeen('tron', entries, config, tip));
}

/** Bitcoin, also indexed: the API serves an address's history whole. */
async function sweepBitcoin(
  entries: EnabledAsset[],
  config: ChainPaymentsConfig
): Promise<number> {
  const tip = await bitcoin.readTipHeight(config);
  let settled = 0;

  for (const entry of entries) {
    const asset = entry.definition;
    if (listOpenInvoices('bitcoin', asset.id).length === 0) continue;

    const transfers = await bitcoin.readTransfers(asset, entry.address, config, tip);
    settled += handleTransfers(transfers);
  }

  advanceCursor('bitcoin', tip);
  return settled + (await confirmSeen('bitcoin', entries, config, tip));
}

/**
 * Hands each transfer to the settler and reports what happened.
 *
 * Separated so the three sweeps above differ only in how they READ. What a
 * transfer means is one decision in one place.
 */
function handleTransfers(transfers: ChainTransfer[]): number {
  let credited = 0;

  for (const transfer of transfers) {
    const outcome = settleTransfer(transfer);
    if (outcome.status === 'credited') {
      credited += 1;
      console.log(
        `[chain] ${transfer.asset}: ${transfer.txid} credited ${outcome.credits} credit(s).`
      );
    } else if (outcome.status === 'held') {
      console.warn(`[chain] ${transfer.asset}: ${outcome.reason}`);
    }
  }

  return credited;
}

/**
 * The second pass: invoices that have seen a transfer and are waiting on depth.
 *
 * This is its own pass, asking about each transaction BY ID, and the reason is
 * specific to how an EVM chain is read. Discovery scans a range of blocks; a
 * transfer found in blocks 100-200 does not appear again when the scan moves
 * on to 201-300. A watcher that measured depth from the discovery scan would
 * therefore conclude, on the very next tick, that every transfer it had just
 * found had vanished - and reset an invoice that was perfectly fine.
 *
 * Asking the chain where that transaction is now answers both questions at
 * once and is cheap, because only invoices mid-confirmation are asked about
 * and there are never many of those:
 *
 *   a height, deep enough   -> credit it
 *   a height, not deep yet  -> leave it, say how deep
 *   no height at all        -> it is gone; back to waiting
 *
 * The last case is a reorg below the confirmation depth, which is exactly what
 * confirmations exist to protect against. Nothing is credited and nothing is
 * failed: the buyer may simply need to wait, or to send again.
 */
async function confirmSeen(
  chain: ChainId,
  entries: EnabledAsset[],
  config: ChainPaymentsConfig,
  tipHeight: number
): Promise<number> {
  let credited = 0;

  for (const entry of entries) {
    const asset = entry.definition;

    for (const invoice of listOpenInvoices(chain, asset.id)) {
      if (invoice.state !== 'seen' || !invoice.seenTxid) continue;

      let height = 0;
      try {
        if (chain === 'bitcoin') {
          height = await bitcoin.readTransactionHeight(invoice.seenTxid, config);
        } else if (chain === 'tron') {
          height = await tron.readTransactionHeight(invoice.seenTxid, config);
        } else {
          height = await evm.readTransactionHeight(asset, invoice.seenTxid, config);
        }
      } catch (error) {
        /*
         * Could not look, which is NOT "it is gone".
         *
         * Treating an unreachable endpoint as a vanished transfer would reset
         * a perfectly good invoice every time a public node had a bad minute,
         * and a buyer watching the page would see their payment un-seen.
         */
        console.warn(
          `[chain] ${asset.id}: could not check ${invoice.seenTxid}; leaving it as seen.`,
          error instanceof Error ? error.message : error
        );
        continue;
      }

      if (height <= 0) {
        forgetSeenTransfer(invoice);
        continue;
      }

      const depth = Math.max(0, tipHeight - height + 1);
      credited += handleTransfers([
        {
          chain,
          asset: asset.id,
          txid: invoice.seenTxid,
          amountAtomic: invoice.seenAmount || invoice.amountAtomic,
          height,
          confirmations: depth,
        },
      ]);
    }
  }

  return credited;
}

/** One pass over one chain. Exported so a test can drive it without a timer. */
export async function sweepChain(
  chain: ChainId,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const config = readChainPaymentsConfig(env);
  const entries = assetsOn(chain, config);
  if (entries.length === 0) return 0;

  // Expiring is the clock's job and runs whatever the network is doing, so it
  // happens before any read that might throw.
  const expired = releaseFinishedInvoices();
  if (expired > 0) {
    console.log(`[chain] ${expired} invoice(s) expired and their amounts were released.`);
  }

  if (chain === 'tron') return sweepTron(entries, config);
  if (chain === 'bitcoin') return sweepBitcoin(entries, config);
  return sweepEvm(chain, entries, config);
}

/** Which chains have at least one asset the operator has switched on. */
export function watchedChains(env: NodeJS.ProcessEnv = process.env): ChainId[] {
  const config = readChainPaymentsConfig(env);
  const chains = new Set<ChainId>();
  for (const entry of config.assets) chains.add(entry.definition.chain);
  return [...chains];
}

export function stopChainWatcher(): void {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}

/**
 * Starts one loop per watched chain. Returns the stopper.
 *
 * Following `services/orders/retention.ts` exactly, which is the house pattern
 * for boot-time background work: stop first so a restart cannot double up,
 * sweep once immediately so a payment made while the process was down is found
 * without waiting a full interval, then interval, then unref.
 */
export function startChainWatcher(env: NodeJS.ProcessEnv = process.env): () => void {
  stopChainWatcher();

  const chains = watchedChains(env);
  if (chains.length === 0) return stopChainWatcher;

  const config = readChainPaymentsConfig(env);

  for (const chain of chains) {
    const seconds = chain === 'bitcoin' ? config.bitcoinPollSeconds : config.pollSeconds;

    const sweep = () => {
      void sweepChain(chain, env).catch((error) => {
        // Warn, not error, and explicitly not fatal: a public endpoint being
        // unreachable is an ordinary Tuesday, and the next tick tries again.
        console.warn(
          `[chain] ${CHAINS[chain].label}: this sweep could not complete; it will run again.`,
          error instanceof Error ? error.message : error
        );
      });
    };

    sweep();
    const timer = setInterval(sweep, seconds * 1000);
    timer.unref?.();
    timers.set(chain, timer);
  }

  const assets = readChainPaymentsConfig(env).assets.map((entry) => entry.definition.id);
  console.log(`[chain] Watching ${chains.join(', ')} for ${assets.join(', ')}.`);

  return stopChainWatcher;
}

/** Re-exported for the boot log, which names what could not be served. */
export function chainProblems(env: NodeJS.ProcessEnv = process.env) {
  return readChainPaymentsConfig(env).problems;
}

