'use client';

import { CoinMark } from '@/components/icons/marks';
import { PANEL, PRIMARY, QUIET } from './chrome';
import type { Order } from './order';
import { formatAmount, type PaymentTarget } from '@/lib/payments';

/**
 * Step 3, crypto column.
 *
 * Today this is a hand-off: the configured provider hosts its own page, the
 * coin is chosen there, and the browser is sent to it. The on-chain version -
 * a deposit address of the operator's own, an expected amount in the coin, a
 * live paid amount and a countdown - is the next commit, and the reason it is
 * not folded in here is that it needs something that does not exist yet: a
 * process watching three chains. Showing an address before anything reads that
 * address would be showing somebody a place to send money that nobody is
 * looking at.
 *
 * So this column stays honest about which it is. When the server hands back a
 * per-asset invoice instead of a redirect, the address panel replaces the
 * button and nothing above this file changes.
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

  // Crypto always opens an order: the provider's page is the payment, and
  // there is nothing to show until it exists.
  if (order.status === 'none' || order.status === 'starting') {
    return (
      <div className={PANEL}>
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-blue-600" />
        <p className="mt-3 text-center text-sm text-muted">Preparing your order…</p>
      </div>
    );
  }

  if (order.status === 'failed') {
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

  if (!started.redirectUrl) {
    return (
      <div className={PANEL}>
        <p className="text-sm font-semibold text-ink">
          This order was recorded but no payment page came back.
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

  return (
    <div className={PANEL}>
      <div className="flex items-center gap-3">
        <CoinMark assetId={target.asset} symbol={target.symbol} className="h-8 w-8" />
        <div>
          <p className="text-sm font-semibold text-ink">{target.label}</p>
          <p className="text-xs text-subtle">
            Order <span className="font-mono">{started.reference}</span>
          </p>
        </div>
      </div>

      <p className="mt-4 text-sm text-muted">
        The next page is the payment provider&apos;s, not ours. You choose the coin and the
        network there, and send{' '}
        <span className="font-semibold text-ink">
          {formatAmount(started.amountCents, started.currency)}
        </span>{' '}
        worth of it to the address they show you.
      </p>

      <p className="mt-2 text-xs text-subtle">
        Your credits arrive when the payment is confirmed on the chain, which can take a few
        minutes. You can close this window once you have sent it - the order does not depend on
        this page staying open.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {/*
          A full navigation, not a router push: the destination is somebody
          else's domain. `assign` rather than setting `href`, which the lint
          rule reads as mutating a value from outside the component.
        */}
        <button
          type="button"
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
