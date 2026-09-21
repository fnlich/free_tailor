'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import OrderProgress, { OrderStatePill } from '@/components/orders/OrderProgress';
import {
  FILE_KIND_LABELS,
  isOrderLive,
  orderFileUrl,
  orderZipUrl,
  ordersApi,
  type OrderDetail,
  type OrderItem,
  type OrderItemState,
} from '@/lib/orders';

const CARD =
  'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400';
const VALUE = 'mt-1 text-sm text-gray-900 dark:text-white';

const ITEM_STATE_STYLES: Record<OrderItemState, string> = {
  queued: 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
  cancelled: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
};

const ITEM_STATE_LABELS: Record<OrderItemState, string> = {
  queued: 'Waiting',
  running: 'Building',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function formatDate(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString();
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = typeof params?.id === 'string' ? params.id : '';

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);

  // Kept in a ref, and written in an effect rather than during render, so the
  // polling interval below does not have to be torn down and rebuilt on every
  // refresh just to see whether there is still anything to poll for.
  const live = useRef(false);
  useEffect(() => {
    live.current = order ? isOrderLive(order) : false;
  }, [order]);

  /**
   * Sequenced, so a slow reply cannot overwrite a newer one.
   *
   * Three hundred items take long enough to serialize that two polls can be in
   * flight at once, and without a token the older one resolving last makes the
   * counts visibly jump backwards.
   */
  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    if (!orderId) return;
    const token = ++latestRequest.current;
    try {
      const next = await ordersApi.get(orderId);
      if (token !== latestRequest.current) return;
      setOrder(next);
      setError('');
    } catch (err) {
      if (token !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : 'Could not load that order.');
    } finally {
      if (token === latestRequest.current) setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polled while the work is moving, and not at all once it has stopped. See
  // the note on the list page for why this does not follow the batch stream.
  useEffect(() => {
    const timer = setInterval(() => {
      if (live.current) void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [load]);

  /** Every item with a file, and the subset of those the caller has ticked. */
  const readyItems = useMemo(
    () => (order ? order.items.filter((item) => item.available.length > 0) : []),
    [order]
  );
  const downloadable = useMemo(
    () => readyItems.filter((item) => selected.has(item.id)),
    [readyItems, selected]
  );

  const toggle = (itemId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const selectAllReady = () => {
    setSelected(new Set(readyItems.map((item) => item.id)));
  };

  const handleCancel = async () => {
    if (!order) return;
    setCancelling(true);
    try {
      await ordersApi.cancel(order.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel that order.');
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className={CARD}>
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className={CARD}>
          <p className="text-lg font-semibold text-gray-900 dark:text-white">Order not found</p>
          <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
            {error || 'It may have been removed, or it belongs to another account.'}
          </p>
          <Link
            href="/orders"
            className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Back to orders
          </Link>
        </div>
      </main>
    );
  }

  const expired = order.state === 'expired';

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <Link
          href="/orders"
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          &larr; All orders
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold text-gray-900 dark:text-white">
            {order.number}
          </h1>
          <OrderStatePill state={order.state} />
        </div>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">{order.label}</p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-100">
          {error}
        </div>
      )}

      <div className={CARD}>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <div className={LABEL}>Placed</div>
            <div className={VALUE}>{formatDate(order.createdAt)}</div>
          </div>
          <div>
            <div className={LABEL}>{expired ? 'Files deleted' : 'Files kept until'}</div>
            <div className={VALUE}>{formatDate(expired ? order.purgedAt ?? order.expiresAt : order.expiresAt)}</div>
          </div>
          <div>
            <div className={LABEL}>Resumes</div>
            <div className={VALUE}>{order.counts.total}</div>
          </div>
        </div>

        <OrderProgress counts={order.counts} className="mt-5" />

        <div className="mt-5 flex flex-wrap gap-2">
          {readyItems.length > 0 && !expired && (
            <a
              href={orderZipUrl(order.id)}
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Download all as .zip
            </a>
          )}
          {downloadable.length > 0 && (
            <a
              href={orderZipUrl(
                order.id,
                downloadable.map((item) => item.id),
                readyItems.length
              )}
              className="rounded-xl border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200"
            >
              Download {downloadable.length} selected as .zip
            </a>
          )}
          {!expired && readyItems.length > 0 && (
            <button
              type="button"
              onClick={selectAllReady}
              className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
            >
              Select all ready
            </button>
          )}
          {isOrderLive(order) && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="rounded-xl border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-gray-400 dark:border-red-500/40 dark:bg-slate-800 dark:text-red-300"
            >
              {cancelling ? 'Cancelling...' : 'Cancel what is left'}
            </button>
          )}
        </div>

        {expired && (
          <p className="mt-4 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700 dark:bg-slate-800 dark:text-slate-200">
            The files for this order have been deleted. What it built is still listed below.
          </p>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <ul className="divide-y divide-gray-200 dark:divide-slate-800">
          {order.items.map((item) => (
            <OrderItemRow
              key={item.id}
              orderId={order.id}
              item={item}
              selected={selected.has(item.id)}
              onToggle={() => toggle(item.id)}
            />
          ))}
        </ul>
      </div>
    </main>
  );
}

function OrderItemRow({
  orderId,
  item,
  selected,
  onToggle,
}: {
  orderId: string;
  item: OrderItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const selectable = item.available.length > 0;

  return (
    <li className="flex flex-wrap items-start gap-4 p-4">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        disabled={!selectable}
        aria-label={`Select ${item.companyName}`}
        className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 disabled:opacity-40"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-gray-900 dark:text-white">{item.companyName}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${ITEM_STATE_STYLES[item.state]}`}
          >
            {ITEM_STATE_LABELS[item.state]}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-slate-300">
          {item.profileName}
          {item.role ? ` - ${item.role}` : ''}
          {typeof item.sourceRowNumber === 'number' ? ` - sheet row ${item.sourceRowNumber}` : ''}
        </p>
        {item.error && (
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{item.error}</p>
        )}

        {item.files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {item.files.map((file) =>
              file.removedAt ? (
                // Listed but not offered: the order still says what it built
                // after the files have been swept away.
                <span
                  key={file.kind}
                  className="rounded-lg border border-dashed border-gray-300 px-3 py-1 text-xs text-gray-400 dark:border-slate-700 dark:text-slate-500"
                >
                  {FILE_KIND_LABELS[file.kind]} (deleted)
                </span>
              ) : (
                <a
                  key={file.kind}
                  href={orderFileUrl(orderId, item.id, file.kind)}
                  className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {FILE_KIND_LABELS[file.kind]}
                </a>
              )
            )}
          </div>
        )}
      </div>
    </li>
  );
}
