'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Notice } from '@/components/ui/kit';
import { ApiResponseError } from '@/lib/api';
import type { SubmitBatchResponse } from '@/lib/generationQueue';
import {
  cancelOrderQuestion,
  describeCancelOutcome,
  isOrderLive,
  ordersApi,
  type CancelOutcome,
  type Order,
  type OrderState,
} from '@/lib/orders';

/**
 * The receipt for a placed order - "You ordered successfully: Order number -
 * FT-..." - with a link to it on Orders and, while it is being built, Cancel
 * order. Moved out of Build Resumes so every page that places an order says
 * it the same way.
 */

/** What a placed order reports back, before any of it has been built. */
export type PlacedOrder = {
  id: string;
  number: string;
  total: number;
  jobCount: number;
  profileCount: number;
  skippedNote: string;
  /** Set once Cancel on the receipt went through: what it stopped. */
  cancelled?: CancelOutcome;
  /**
   * Set once the order is over by any other way - built, failed, or cancelled
   * from Orders - as the receipt's poll (or a Cancel the server answered 409)
   * found it: no Cancel is offered for it any more.
   */
  ended?: { state: OrderState; built?: number };
};

/** The receipt for a submission the server filed as an order; null when it did not (no order number). */
export function placedOrderFrom(submitted: SubmitBatchResponse, skippedNote = ''): PlacedOrder | null {
  if (!submitted.orderId || !submitted.orderNumber) return null;
  return {
    id: submitted.orderId,
    number: submitted.orderNumber,
    total: submitted.total,
    jobCount: submitted.jobCount,
    profileCount: submitted.profileCount,
    skippedNote,
  };
}

/** How often the receipt asks whether its order is still being built: as often as /orders does. */
const RECEIPT_POLL_MS = 5000;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The receipt's order is over: it says how, and offers no Cancel - unless the receipt is another order's, or cancelled here. */
function markEnded(ended: Order) {
  return (current: PlacedOrder | null): PlacedOrder | null =>
    current && current.id === ended.id && !current.cancelled
      ? { ...current, ended: { state: ended.state, built: ended.counts.done } }
      : current;
}

/**
 * The receipt. It follows its order until it ends, reading it every few
 * seconds as /orders does - so it stops offering Cancel, and saying "being
 * built", for an order that has finished. It stops asking once the order is
 * over, cancelled from here, or the receipt is cleared.
 *
 * The page owns the receipt (`order`) - it clears it with the rest of its
 * outputs - and hears every change to it through `onChange`.
 */
export default function OrderReceipt({
  order,
  onChange,
  onCancelled,
  onError,
}: {
  order: PlacedOrder;
  /** The receipt as it now stands, given the one the page holds (null: cleared since). */
  onChange: (update: (current: PlacedOrder | null) => PlacedOrder | null) => void;
  /** Cancel went through: credit was refunded, so balances are worth re-reading. */
  onCancelled?: () => void;
  onError: (error: unknown) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  // Read through a ref by the poll, which must not restart with every render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const followed = !order.cancelled && !order.ended ? order.id : '';
  useEffect(() => {
    if (!followed) return;
    let stopped = false;
    const check = async () => {
      try {
        const latest = await ordersApi.get(followed);
        if (!stopped && !isOrderLive(latest)) onChangeRef.current(markEnded(latest));
      } catch {
        // Offline, or a restart in progress: the next tick asks again.
      }
    };
    const timer = window.setInterval(() => void check(), RECEIPT_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [followed]);

  /** Cancel on the receipt: what is left of it, refunded. */
  const cancel = async () => {
    if (!window.confirm(cancelOrderQuestion(order.number))) return;
    setCancelling(true);
    try {
      const outcome = await ordersApi.cancel(order.id);
      onChange((current) => (current && current.id === order.id ? { ...current, cancelled: outcome } : current));
      onCancelled?.();
    } catch (err) {
      // 409: there was nothing left to cancel - it finished between the poll
      // and the press. Not a failure to report: the receipt says how it ended.
      if (err instanceof ApiResponseError && err.status === 409) {
        const latest = await ordersApi.get(order.id).catch(() => null);
        if (latest) onChange(markEnded(latest));
        else
          onChange((current) =>
            current && current.id === order.id && !current.cancelled ? { ...current, ended: { state: 'done' } } : current
          );
      } else {
        onError(err ?? 'Could not cancel that order.');
      }
    } finally {
      setCancelling(false);
    }
  };

  return (
    // A status: what becomes of the order - built, cancelled - is announced as the receipt learns it.
    <Notice tone="success" role="status" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <p className="font-semibold">
          You ordered successfully: Order number - <span className="font-mono">{order.number}</span>
        </p>
        {order.cancelled ? (
          <p className="mt-1">
            Cancelled: {describeCancelOutcome(order.cancelled)} Anything already built is under{' '}
            <Link href={`/orders/${order.id}`} className="font-semibold underline underline-offset-2">
              Order status &amp; built resumes
            </Link>
            .
          </p>
        ) : order.ended ? (
          <p className="mt-1">
            {order.ended.state === 'cancelled' ? 'This order was cancelled' : 'This order has finished'}
            {order.ended.built !== undefined ? `: ${order.ended.built} of ${plural(order.total, 'resume')} built` : ''}{' '}
            - see{' '}
            <Link href={`/orders/${order.id}`} className="font-semibold underline underline-offset-2">
              Order status &amp; built resumes
            </Link>
            .
          </p>
        ) : (
          <p className="mt-1">
            {plural(order.total, 'resume')} for {plural(order.jobCount, 'job')} across{' '}
            {plural(order.profileCount, 'profile')} {order.total === 1 ? 'is' : 'are'} being built. You can close
            this page - they are waiting for you under{' '}
            <Link href={`/orders/${order.id}`} className="font-semibold underline underline-offset-2">
              Order status &amp; built resumes
            </Link>
            .{order.skippedNote}
          </p>
        )}
      </div>
      {!order.cancelled && !order.ended && (
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={cancelling}
          className="tl-button-quiet shrink-0"
          data-tone="danger"
          data-size="sm"
        >
          {cancelling ? 'Cancelling...' : 'Cancel order'}
        </button>
      )}
    </Notice>
  );
}
