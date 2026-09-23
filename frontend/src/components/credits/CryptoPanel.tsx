'use client';

import ChainDepositCard, { ExactAmountNote } from './ChainDepositCard';
import { LABEL, PANEL, PRIMARY, QUIET } from './chrome';
import type { Order } from './order';
import { formatAmount, type ChainInvoiceView, type PaymentTarget } from '@/lib/payments';

/**
 * Step 3, crypto column: where to send coin, and how much.
 *
 * Non-custodial, which is the whole point: the address below belongs to the
 * operator, the coin goes straight there, and no processor stands in between.
 * What that costs is precision - the amount is how the payment is identified,
 * because everybody sends to the same address - and this panel's job is to
 * make that unmissable without being frightening.
 *
 * **Every figure here came from the server.** The amount is not a price
 * converted in the browser; it is the exact quantity the server quoted at the
 * rate it recorded, rounded onto that asset's own lattice. A number worked out
 * here would be a number no invoice matches.
 *
 * The panel polls, because a chain takes minutes and nothing else would change
 * on the screen. Three states matter to somebody watching: nothing seen yet,
 * seen but not yet deep enough, and credited.
 */

/** How often to ask. Slow enough to be polite, fast enough to feel live. */
const POLL_MS = 8_000;

export default function CryptoPanel({
  order,
  target,
  invoice,
  onCancel,
  onRetry,
}: {
  order: Order;
  target: PaymentTarget;
  /** The live invoice, re-read by the parent while this is open. */
  invoice: ChainInvoiceView | null;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (order.status === 'none' || order.status === 'starting') {
    return (
      <div className={PANEL}>
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-blue-600" />
        <p className="mt-3 text-center text-sm text-muted">Preparing your order…</p>
      </div>
    );
  }

  if (order.status === 'failed') {
    /*
     * The 409 case reads differently from every other failure, and it should.
     *
     * "Somebody is already paying that exact amount" is not a fault and not a
     * outage: the amounts have to stay distinct or neither payment can be
     * attributed to anybody. A moment later, or a different amount, and it
     * works - so the wording says that rather than apologising.
     */
    const taken = /already paying/i.test(order.message);
    return (
      <div className={PANEL}>
        <p className="text-sm font-semibold text-ink">
          {taken ? 'That amount is briefly taken' : 'This order could not be started.'}
        </p>
        <p className="mt-1 text-sm text-muted">{order.message}</p>
        <p className="mt-1 text-xs text-subtle">Nothing was sent and nothing was charged.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onRetry} className={`${PRIMARY} px-4 py-2`}>
            Try again
          </button>
          <button type="button" onClick={onCancel} className={`${QUIET} px-4 py-2`}>
            Change the amount
          </button>
        </div>
      </div>
    );
  }

  const { started } = order;

  /*
   * A provider that hosts its own page, which is now the ordinary case.
   *
   * Cryptomus works this way, and so did Coinbase Commerce before it: the
   * buyer picks the coin and the network on the provider's page, at the
   * provider's rates, and this application never sees an address. The branch
   * below it - a deposit card with an exact amount - is the retired on-chain
   * path, kept because invoices opened that way are still out there waiting.
   */
  if (!invoice && started.redirectUrl) {
    return (
      <div className={PANEL}>
        <p className="text-sm font-semibold text-ink">{target.label}</p>
        <p className="mt-3 text-sm text-muted">
          The next page is the payment provider&apos;s, not ours. You choose the coin and the
          network there, and send{' '}
          <span className="font-semibold text-ink">
            {formatAmount(started.amountCents, started.currency)}
          </span>{' '}
          worth of it to the address they show you.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            // A full navigation: the destination is somebody else's domain.
            onClick={() => window.location.assign(started.redirectUrl!)}
            className={PRIMARY}
          >
            Continue to payment
          </button>
          <button type="button" onClick={onCancel} className={QUIET}>
            Change the amount
          </button>
        </div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className={PANEL}>
        <p className="text-sm font-semibold text-ink">
          This order was recorded but no payment details came back.
        </p>
        <p className="mt-1 text-sm text-muted">
          Nothing was sent. Order <span className="font-mono">{started.reference}</span> is left
          unpaid and will expire on its own.
        </p>
        <button type="button" onClick={onRetry} className={`${PRIMARY} mt-3 px-4 py-2`}>
          Try again
        </button>
      </div>
    );
  }

  const credited = invoice.state === 'credited';
  const seen = invoice.state === 'seen';
  const done = credited || invoice.state === 'held';

  return (
    <div className="space-y-3">
      <ChainDepositCard invoice={invoice} reference={started.reference} />

      {/*
        What is happening, in the buyer's terms. `seen` exists precisely so
        this can say "we can see it, it is confirming" rather than leaving
        somebody watching an unchanged screen for ten minutes.
      */}
      <div className={PANEL}>
        <div className={LABEL}>Status</div>
        {credited ? (
          <p className="mt-1 text-sm font-medium text-emerald-700">
            Paid and credited. Your credits are on your account.
          </p>
        ) : seen ? (
          <>
            <p className="mt-1 text-sm font-medium text-ink">
              {invoice.paid} {invoice.symbol} received. Waiting for the network to confirm it.
            </p>
            <p className="mt-1 text-xs text-subtle">
              {invoice.confirmations} of {invoice.confirmationsNeeded} confirmations.
              {invoice.txid && (
                <>
                  {' '}
                  Transaction <span className="break-all font-mono">{invoice.txid}</span>.
                </>
              )}
            </p>
          </>
        ) : invoice.state === 'held' ? (
          <p className="mt-1 text-sm font-medium text-red-700">
            Something arrived that we could not match to this order automatically. It has not been
            lost — an administrator will be in touch.
          </p>
        ) : invoice.state === 'expired' ? (
          <p className="mt-1 text-sm font-medium text-muted">
            This quote has expired and nothing arrived. Start again for a fresh amount.
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">
            Waiting for your transfer. You can close this window once you have sent it — the order
            does not depend on this page staying open.
          </p>
        )}
      </div>

      {!done && <ExactAmountNote />}
    </div>
  );
}

/** How often the parent should re-read the invoice while this is open. */
export { POLL_MS as CHAIN_POLL_MS };
