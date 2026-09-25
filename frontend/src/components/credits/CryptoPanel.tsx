'use client';

import { PANEL, PRIMARY, QUIET } from './chrome';
import type { Order } from './order';
import { formatAmount, type PaymentTarget } from '@/lib/payments';

/**
 * Step 3, crypto column: the hand-off to the provider's own page.
 *
 * Short, because there is nothing for this application to do. The buyer picks
 * the coin and the network on Cryptomus's page, at Cryptomus's rates, and the
 * only thing that has to happen here is telling them so before they leave for
 * a domain that is not this one.
 *
 * It was much longer when crypto meant a wallet this operator owned: an exact
 * amount to send, an address to send it to, a countdown on the quoted rate,
 * and a poll watching an invoice go waiting -> seen -> credited. All of that
 * went with the watcher. What is left is one screen and one button.
 */

export default function CryptoPanel({
  order,
  target,
  onCancel,
  onRetry,
}: {
  order: Order;
  target: PaymentTarget;
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
     * One failure now, where there were two.
     *
     * This used to single out a 409 - "somebody is already paying that exact
     * amount" - because on-chain the amounts had to stay distinct or neither
     * payment could be attributed to anybody, and a buyer who hit it had done
     * nothing wrong. A hosted invoice reserves no amount, so nothing can
     * produce that message and the special case has gone with it.
     */
    return (
      <div className={PANEL}>
        <p className="text-sm font-semibold text-ink">This order could not be started.</p>
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

  if (started.redirectUrl) {
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

  /*
   * A crypto order with no URL on it.
   *
   * Nothing to do and nowhere to go: the provider answered without a page to
   * send anybody to. Saying so beats a blank panel, and the order is left
   * unpaid rather than quietly retried.
   */
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
