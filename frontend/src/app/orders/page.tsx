'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import OrderProgress, { OrderStatePill } from '@/components/orders/OrderProgress';
import { isOrderLive, orderZipUrl, ordersApi, type Order } from '@/lib/orders';
import { formatDate } from '@/lib/format';
import { EmptyState, Notice, Page, PageHeader, Spinner } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';

const COLUMNS = ['Date', 'Order #', 'Label', 'Resumes', 'Status', 'Action(s)'];

/** Whether anything on the page is still moving, and therefore worth polling for. */
function anyLive(orders: Order[]): boolean {
  return orders.some(isOrderLive);
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
      setError(messageWithDetail(err, 'Could not load your orders.'));
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
    <Page>
      <PageHeader
        title="Orders"
        description="Every Google Sheet import is placed as an order. Files are kept for a few days, then deleted automatically - download anything you want to keep."
      />

      {error && (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      )}

      {loading ? (
        <Spinner />
      ) : orders.length === 0 ? (
        <EmptyState title="No orders yet">
          Import jobs from your Google Sheet on the{' '}
          <Link href="/" className="tl-link">
            Builder
          </Link>{' '}
          and the resumes will appear here as they are built.
        </EmptyState>
      ) : (
        /*
         * The same bordered table as the order history on /credits. A colour
         * on a cell goes on an inner span: `.tl-table td` is unlayered and
         * beats a utility on the td itself.
         */
        <div className="tl-table-box">
          <table className="tl-table">
            <caption className="sr-only">Order status &amp; built resumes</caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td className="whitespace-nowrap">
                    <span className="block text-ink">{formatDate(order.createdAt, { style: 'short' })}</span>
                    <span className="mt-0.5 block text-xs text-subtle">{describeExpiry(order)}</span>
                  </td>
                  <td className="whitespace-nowrap">
                    <Link
                      href={`/orders/${order.id}`}
                      className="font-medium text-accent-ink underline underline-offset-2"
                    >
                      {order.number}
                    </Link>
                  </td>
                  <td className="min-w-48">{order.label}</td>
                  <td>
                    <OrderProgress counts={order.counts} className="min-w-40" />
                  </td>
                  <td>
                    <OrderStatePill state={order.state} />
                  </td>
                  <td>
                    <div className="flex flex-col gap-2">
                      <Link href={`/orders/${order.id}`} className="tl-button-quiet">
                        View resumes
                      </Link>
                      {order.hasFiles && order.state !== 'expired' && (
                        <a href={orderZipUrl(order.id)} className="tl-button-quiet">
                          Download all as .zip
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
