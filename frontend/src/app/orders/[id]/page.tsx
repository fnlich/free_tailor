'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import RefundRequestDialog, { REFUND_REQUESTS_PATH } from '@/components/credits/RefundRequestDialog';
import OrderProgress, { OrderStatePill } from '@/components/orders/OrderProgress';
import {
  cancelOrderQuestion,
  FILE_KIND_LABELS,
  isOrderLive,
  orderFileUrl,
  orderZipUrl,
  ordersApi,
  type OrderDetail,
  type OrderItem,
  type OrderItemState,
} from '@/lib/orders';
import { formatDate, formatMoney } from '@/lib/format';
import { REFUND_STATE_LABELS, REFUND_STATE_TONES, refundActionFor, refundCellNote } from '@/lib/refundDisplay';
import { refundRequestsApi, type RefundOption } from '@/lib/refunds';
import {
  Card,
  ContactAdminFor,
  EmptyState,
  Field,
  Notice,
  Page,
  PageHeader,
  Pill,
  Spinner,
  StaticValue,
  type PillTone,
} from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';

/** The kit's pill colours, matching the order's own pill and the payments on /credits. */
const ITEM_STATE_TONES: Record<OrderItemState, PillTone> = {
  queued: 'grey',
  running: 'sky',
  done: 'green',
  failed: 'red',
  cancelled: 'amber',
};

const ITEM_STATE_LABELS: Record<OrderItemState, string> = {
  queued: 'Waiting',
  running: 'Building',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = typeof params?.id === 'string' ? params.id : '';

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);
  /** What each resume could be refunded, by item id. Null until read, or when it could not be. */
  const [refundOptions, setRefundOptions] = useState<Record<string, RefundOption> | null>(null);
  /** The resume whose "Ask for refund" was pressed. */
  const [asking, setAsking] = useState<string | null>(null);
  /** Bumped after a request is sent, so its row says Requested rather than offering a second. */
  const [refundsRead, setRefundsRead] = useState(0);

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
      setError(messageWithDetail(err, 'Could not load that order.'));
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

  /*
   * What each resume could be refunded - one read for the whole order. Again
   * whenever another resume settles (a finished one becomes refundable) and
   * after a request is sent, but not on every poll while the order runs.
   */
  const settled = order ? order.counts.settled : -1;
  useEffect(() => {
    if (!orderId || settled < 0) return;
    let alive = true;
    refundRequestsApi.options({ orderId }).then(
      (answer) => {
        if (alive) setRefundOptions(Object.fromEntries(answer.items.map((item) => [item.itemId, item])));
      },
      () => {
        // Not worth a banner over the order itself: the column simply offers nothing.
        if (alive) setRefundOptions(null);
      }
    );
    return () => {
      alive = false;
    };
  }, [orderId, settled, refundsRead]);

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
    if (!order || !window.confirm(cancelOrderQuestion(order.number))) return;
    setCancelling(true);
    try {
      await ordersApi.cancel(order.id);
      await load();
    } catch (err) {
      setError(messageWithDetail(err, 'Could not cancel that order.'));
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <Page>
        <Spinner />
      </Page>
    );
  }

  if (!order) {
    return (
      <Page>
        <EmptyState
          title="Order not found"
          action={
            <Link href="/orders" className="tl-button-quiet">
              Back to orders
            </Link>
          }
        >
          {error || 'It may have been removed, or it belongs to another account.'}
        </EmptyState>
      </Page>
    );
  }

  const expired = order.state === 'expired';

  return (
    <Page>
      <Link href="/orders" className="tl-link text-sm">
        &larr; All orders
      </Link>

      <div className="mt-4">
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="break-all">{order.number}</span>
              {/* Out of the heading's tight tracking, which a pill would inherit. */}
              <span className="tracking-normal">
                <OrderStatePill state={order.state} />
              </span>
            </span>
          }
          description={order.label}
          actions={
            readyItems.length > 0 &&
            !expired && (
              <a href={orderZipUrl(order.id)} className="tl-button" data-shape="pill">
                Download all as .zip
              </a>
            )
          }
        />
      </div>

      {error && (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      )}

      <Card>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Placed">
            <StaticValue>{formatDate(order.createdAt)}</StaticValue>
          </Field>
          <Field label={expired ? 'Files deleted' : 'Files kept until'}>
            <StaticValue>
              {formatDate(expired ? order.purgedAt ?? order.expiresAt : order.expiresAt)}
            </StaticValue>
          </Field>
          <Field label="Resumes">
            <StaticValue>{order.counts.total}</StaticValue>
          </Field>
        </div>

        <OrderProgress counts={order.counts} className="mt-6" />

        <div className="mt-6 flex flex-wrap gap-3 empty:hidden">
          {downloadable.length > 0 && (
            <a
              href={orderZipUrl(
                order.id,
                downloadable.map((item) => item.id),
                readyItems.length
              )}
              className="tl-button-quiet"
            >
              Download {downloadable.length} selected as .zip
            </a>
          )}
          {!expired && readyItems.length > 0 && (
            <button type="button" onClick={selectAllReady} className="tl-button-quiet">
              Select all ready
            </button>
          )}
          {isOrderLive(order) && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="tl-button-quiet"
              data-tone="danger"
            >
              {cancelling ? 'Cancelling...' : 'Cancel what is left'}
            </button>
          )}
        </div>

        {expired && (
          <Notice tone="neutral" className="mt-6">
            The files for this order have been deleted. What it built is still listed below.
          </Notice>
        )}
      </Card>

      {/*
        The same bordered table as the order list and /credits. Colours on a
        cell go on an inner element: `.tl-table td` is unlayered and beats a
        utility on the td itself.
      */}
      <div className="tl-table-box mt-8">
        <table className="tl-table">
          <thead>
            <tr>
              <th scope="col" className="w-12">
                <span className="sr-only">Select</span>
              </th>
              <th scope="col">Resume</th>
              <th scope="col">Status</th>
              <th scope="col">Files</th>
              <th scope="col">Charge</th>
              <th scope="col">Refund</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <OrderItemRow
                key={item.id}
                orderId={order.id}
                item={item}
                selected={selected.has(item.id)}
                onToggle={() => toggle(item.id)}
                refund={refundOptions?.[item.id] ?? null}
                onAskRefund={() => setAsking(item.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {asking && (
        <RefundRequestDialog
          source={{ orderId: order.id }}
          itemId={asking}
          onClose={() => setAsking(null)}
          onRequested={() => setRefundsRead((value) => value + 1)}
        />
      )}
    </Page>
  );
}

function OrderItemRow({
  orderId,
  item,
  selected,
  onToggle,
  refund,
  onAskRefund,
}: {
  orderId: string;
  item: OrderItem;
  selected: boolean;
  onToggle: () => void;
  /** What this resume could be refunded, as the server measured it. Null while unknown. */
  refund: RefundOption | null;
  onAskRefund: () => void;
}) {
  const selectable = item.available.length > 0;

  return (
    <tr>
      <td className="align-top">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={!selectable}
          aria-label={`Select ${item.companyName}`}
          className="tl-check disabled:opacity-40"
        />
      </td>
      <td className="min-w-56">
        <span className="block font-semibold text-ink">{item.companyName}</span>
        <span className="mt-0.5 block">
          {item.profileName}
          {item.role ? ` - ${item.role}` : ''}
          {typeof item.sourceRowNumber === 'number' ? ` - sheet row ${item.sourceRowNumber}` : ''}
        </span>
        {item.error && (
          <span className="tl-status mt-1 block" data-tone="error">
            {item.error}
            <ContactAdminFor text={item.error} />
          </span>
        )}
      </td>
      <td className="align-top">
        <Pill tone={ITEM_STATE_TONES[item.state]}>{ITEM_STATE_LABELS[item.state]}</Pill>
      </td>
      <td className="align-top">
        {item.files.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {item.files.map((file) =>
              file.removedAt ? (
                // Listed but not offered: the order still says what it built
                // after the files have been swept away.
                <Pill key={file.kind} tone="grey">
                  {FILE_KIND_LABELS[file.kind]} (deleted)
                </Pill>
              ) : (
                <a
                  key={file.kind}
                  href={orderFileUrl(orderId, item.id, file.kind)}
                  className="tl-button-quiet"
                  data-size="sm"
                >
                  {FILE_KIND_LABELS[file.kind]}
                </a>
              )
            )}
          </div>
        ) : (
          <span className="text-subtle">&mdash;</span>
        )}
      </td>
      <td className="whitespace-nowrap align-top tabular-nums">
        {typeof item.costMilli === 'number' ? formatMoney(item.costMilli) : <span className="text-subtle">&mdash;</span>}
      </td>
      <td className="align-top">
        <RefundCell option={refund} onAsk={onAskRefund} />
      </td>
    </tr>
  );
}

/**
 * One resume's refund: a button while it can be asked about, the open
 * request's state once it has been (one per resume), Refunded once given back,
 * "Refunded automatically" or "Not charged" where that is the reason - and
 * otherwise a dash, with the server's reason on hover (still building...).
 */
function RefundCell({ option, onAsk }: { option: RefundOption | null; onAsk: () => void }) {
  if (!option) return <span className="text-subtle">&mdash;</span>;
  const action = refundActionFor(option);
  if (action.kind === 'ask') {
    return (
      <button type="button" onClick={onAsk} className="tl-button-quiet whitespace-nowrap" data-size="sm">
        Ask for refund
      </button>
    );
  }
  if (action.kind === 'open') {
    return (
      <Link href={REFUND_REQUESTS_PATH} title={`Refund request ${action.request.reference}`}>
        <Pill tone={REFUND_STATE_TONES[action.request.state]}>
          {REFUND_STATE_LABELS[action.request.state]}
        </Pill>
      </Link>
    );
  }
  if (action.kind === 'refunded') return <Pill tone="green">Refunded</Pill>;
  const note = refundCellNote(option);
  if (note) {
    return (
      <span className="block text-xs text-muted" title={action.reason}>
        {note}
      </span>
    );
  }
  return (
    <span className="text-subtle" title={action.reason}>
      &mdash;
      <span className="sr-only"> {action.reason}</span>
    </span>
  );
}
