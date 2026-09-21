'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import OrderProgress, { OrderStatePill } from '@/components/orders/OrderProgress';
import { isOrderLive, orderZipUrl, ordersApi, type Order } from '@/lib/orders';

const CARD =
  'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400';

/** Whether anything on the page is still moving, and therefore worth polling for. */
function anyLive(orders: Order[]): boolean {
  return orders.some(isOrderLive);
}

function formatDate(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Days left, in the words somebody reading a list actually wants. */
function describeExpiry(order: Order): string {
  if (order.state === 'expired') return 'Files deleted';
  const remainingMs = new Date(order.expiresAt).getTime() - Date.now();
  if (Number.isNaN(remainingMs)) return '';
  if (remainingMs <= 0) return 'Files go in the next clean-up';
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  return days === 1 ? 'Files go tomorrow' : `Files kept ${days} more days`;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Held in a ref, and written in an effect rather than during render, so the
  // polling interval does not have to be torn down and rebuilt on every
  // refresh just to see whether there is still anything worth polling for.
  const live = useRef(false);
  useEffect(() => {
    live.current = anyLive(orders);
  }, [orders]);

  /**
   * Sequenced, so a slow reply cannot overwrite a newer one.
   *
   * A three-hundred-item order takes long enough to serialize that two polls
   * can be in flight at once, and without a token the older one resolving last
   * makes the counts visibly jump backwards.
   */
  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    const token = ++latestRequest.current;
    try {
      const response = await ordersApi.list();
      if (token !== latestRequest.current) return;
      setOrders(response.orders);
      setError('');
    } catch (err) {
      if (token !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : 'Could not load your orders.');
    } finally {
      if (token === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Polled, not streamed.
   *
   * The generation stream belongs to the batch, and a batch is evicted an hour
   * after it finishes - so a page that followed one would lose its connection
   * exactly when somebody came back for their files. Polling asks the order,
   * which is still there, and stops entirely once nothing is moving.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      if (live.current) void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Order status &amp; built resumes
        </h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
          Every Google Sheet import is placed as an order. Files are kept for a few days, then
          deleted automatically - download anything you want to keep.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-100">
          {error}
        </div>
      )}

      {loading ? (
        <div className={CARD}>
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
        </div>
      ) : orders.length === 0 ? (
        <div className={CARD}>
          <p className="text-lg font-semibold text-gray-900 dark:text-white">No orders yet</p>
          <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
            Import jobs from your Google Sheet on the{' '}
            <Link href="/" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
              Builder
            </Link>{' '}
            and the resumes will appear here as they are built.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <div key={order.id} className={CARD}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className={LABEL}>Order number</div>
                  <Link
                    href={`/orders/${order.id}`}
                    className="mt-1 block font-mono text-sm font-semibold text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {order.number}
                  </Link>
                  <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">{order.label}</p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                    Placed {formatDate(order.createdAt)} &middot; {describeExpiry(order)}
                  </p>
                </div>
                <OrderStatePill state={order.state} />
              </div>

              <OrderProgress counts={order.counts} className="mt-4" />

              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href={`/orders/${order.id}`}
                  className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                >
                  View resumes
                </Link>
                {order.hasFiles && order.state !== 'expired' && (
                  <a
                    href={orderZipUrl(order.id)}
                    className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    Download all as .zip
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
