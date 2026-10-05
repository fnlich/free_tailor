'use client';

import { useCallback, useState } from 'react';

import TablePager from '@/components/credits/TablePager';
import { usePagedList } from '@/components/credits/usePagedList';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice, Notice, Pill, Status } from '@/components/ui/kit';
import { ApiResponseError } from '@/lib/api';
import { formatDate, formatMoney, toDollarInput } from '@/lib/format';
import {
  adminRefundActions,
  amountSentProblem,
  byHandRefundBody,
  cleanRefundReason,
  describeDecision,
  describeRefundConfirmation,
  describeRefundMade,
  isStaleRefundRefusal,
  MAX_REFUND_REASON,
  REFUND_FILTERS,
  REFUND_STATE_LABELS,
  REFUND_STATE_TONES,
  refundReasonProblem,
  type AdminRefundAction,
} from '@/lib/refundDisplay';
import {
  adminRefundRequestsApi,
  type AdminRefundRequest,
  type RefundRequestCounts,
  type RefundStateFilter,
} from '@/lib/refunds';

const PAGE_SIZE = 25;

/**
 * The refund requests queue: what people have asked to have refunded, and the
 * three decisions an administrator makes about each.
 *
 *  - **Approve** (from Requested): accepted, no money moves; they are told.
 *  - **Decline** (from Requested or Approved): with a reason the person who
 *    asked will read. Final.
 *  - **Mark refunded** (from Requested or Approved): the refund happens in
 *    the same step - credit back for a resume, a partial Stripe refund for a
 *    card, and for crypto only once the administrator confirms they sent the
 *    money back by hand. Final.
 *
 * Every one of them is confirmed in a dialog that says what will happen
 * BEFORE the button - a crypto refund says "send it back first" there, not in
 * a refusal afterwards. A second press of the same decision is answered as
 * "already", never as an error, and moves nothing (the server's rule).
 */
export default function RefundQueue({
  filter,
  onFilter,
  onCounts,
}: {
  filter: RefundStateFilter;
  onFilter: (next: RefundStateFilter) => void;
  /** The per-state totals the list came with, for the tab's badge. */
  onCounts: (counts: RefundRequestCounts) => void;
}) {
  const [counts, setCounts] = useState<RefundRequestCounts | null>(null);
  const fetchPage = useCallback(
    async (offset: number, limit: number) => {
      const response = await adminRefundRequestsApi.list(offset, limit, filter);
      setCounts(response.counts);
      onCounts(response.counts);
      return { rows: response.requests, total: response.total, offset: response.offset };
    },
    [filter, onCounts]
  );
  const list = usePagedList<AdminRefundRequest>(fetchPage, PAGE_SIZE);

  const [deciding, setDeciding] = useState<{ action: AdminRefundAction; request: AdminRefundRequest } | null>(null);
  const [message, setMessage] = useState('');

  const filterLabel = (id: RefundStateFilter, label: string): string => {
    if (!counts) return label;
    if (id === 'all') return label;
    const count = id === 'open' ? counts.requested + counts.approved : counts[id];
    return `${label} (${count})`;
  };

  return (
    <section aria-labelledby="refund-queue-heading" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id="refund-queue-heading" className="text-xl font-semibold text-ink">
            Refund requests
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            What people have asked to have refunded, with their reason. Open requests are listed oldest
            first. Each decision is sent to the person who asked as a notification.
          </p>
        </div>
        <label className="block w-56 max-w-full">
          <span className="tl-label">Show</span>
          <select
            className="tl-input mt-2"
            value={filter}
            onChange={(event) => {
              setMessage('');
              onFilter(event.target.value as RefundStateFilter);
            }}
          >
            {REFUND_FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {filterLabel(entry.id, entry.label)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {message && (
        <Notice tone="success" role="status">
          {message}
        </Notice>
      )}

      {list.failed && (
        <Notice tone="warn" role="status">
          {list.loaded
            ? 'That page could not be loaded, so these are the rows from before.'
            : 'The refund requests could not be loaded.'}{' '}
          <button type="button" onClick={list.retry} className="font-semibold underline">
            Try again
          </button>
        </Notice>
      )}

      <div className="flex justify-end">
        <TablePager
          total={list.total}
          offset={list.shown}
          count={list.rows.length}
          pageSize={PAGE_SIZE}
          onChange={list.goTo}
        />
      </div>

      {/* `relative` holds the sr-only Actions heading inside the sideways scroll. */}
      <div className="tl-table-box relative">
        <table className="tl-table">
          <thead>
            <tr>
              <th scope="col">Asked</th>
              <th scope="col">Request #</th>
              <th scope="col">Account</th>
              <th scope="col">For</th>
              <th scope="col">Amount</th>
              <th scope="col">Their reason</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.loaded &&
              list.rows.map((request) => (
                <QueueRow
                  key={request.id}
                  request={request}
                  onDecide={(action) => {
                    setMessage('');
                    setDeciding({ action, request });
                  }}
                />
              ))}
          </tbody>
        </table>
        {list.loaded && list.rows.length === 0 && (
          <p className="p-6 text-center text-sm text-muted">
            {filter === 'open' ? 'Nothing is waiting for a decision.' : 'No refund requests here.'}
          </p>
        )}
        {!list.loaded && !list.failed && <p className="p-6 text-center text-sm text-muted">Loading…</p>}
      </div>

      {deciding && (
        <DecisionDialog
          action={deciding.action}
          request={deciding.request}
          onClose={() => setDeciding(null)}
          onDone={(said) => {
            setDeciding(null);
            setMessage(said);
            // The same page again, not the first: the row just decided may
            // move out of an Open list, and the next one should be where it was.
            list.retry();
          }}
          // Refused because the row is out of date - decided by another
          // administrator, refunded from the payments list, gone: the list
          // behind the dialog is read again, so closing it shows what is true.
          onStale={list.retry}
        />
      )}
    </section>
  );
}

/**
 * One request. The row is built to fit the content column at a desktop width
 * WITH its buttons, which are the only controls on the page: no minimum widths,
 * and every long unbroken run - an email address, a reference, a pasted link in
 * a reason - may break anywhere (`overflow-wrap: anywhere`, which, unlike
 * `break-words`, also lowers how narrow the column may get). Without that the
 * table was wider than the box at every common width and Approve, Decline and
 * Mark refunded sat past its right edge, reachable only by scrolling sideways.
 */
function QueueRow({
  request,
  onDecide,
}: {
  request: AdminRefundRequest;
  onDecide: (action: AdminRefundAction) => void;
}) {
  const actions = adminRefundActions(request.state);
  const now = request.refundableNowMilli;
  return (
    <tr>
      <td className="whitespace-nowrap">{formatDate(request.createdAt, { style: 'short' })}</td>
      <td>
        {/* Colours on inner elements: `.tl-table td` is unlayered and would beat a utility on the cell. */}
        <span className="block font-mono font-semibold text-ink">{request.reference}</span>
        <span className="mt-1 block text-xs text-subtle">
          {request.kind === 'purchase'
            ? `Purchase${request.paymentProvider ? ` · ${request.paymentProvider === 'stripe' ? 'card' : 'crypto'}` : ''}`
            : 'Resume'}
        </span>
      </td>
      <td className="[overflow-wrap:anywhere]">
        {request.accountEmail || <span className="text-subtle">Deleted account</span>}
      </td>
      <td className="[overflow-wrap:anywhere]">
        <span className="text-ink">{request.label}</span>
      </td>
      <td className="whitespace-nowrap tabular-nums">
        <span className="block text-ink">{formatMoney(request.amountMilli)}</span>
        {/* An open request is re-measured: a buyer who spent since asking gets back what is left. */}
        {now !== null && now !== request.amountMilli && (
          <span className="mt-1 block whitespace-normal text-xs text-muted">
            {now > 0 ? `${formatMoney(now)} now` : request.refundableNowReason || 'Nothing left now'}
          </span>
        )}
      </td>
      <td className="whitespace-pre-wrap [overflow-wrap:anywhere]">{request.reason}</td>
      <td className="[overflow-wrap:anywhere]">
        <Pill tone={REFUND_STATE_TONES[request.state] ?? 'grey'}>{REFUND_STATE_LABELS[request.state] ?? request.state}</Pill>
        {request.state === 'declined' && request.declineReason && (
          <span className="mt-1.5 block whitespace-pre-wrap break-words text-xs text-muted">
            {request.declineReason}
          </span>
        )}
        {request.state === 'refunded' && (
          <span className="mt-1.5 block text-xs text-muted tabular-nums">
            {formatMoney(request.refundedMilli)} {request.kind === 'resume' ? 'credited back' : 'returned'}
          </span>
        )}
        {request.attemptMilli !== null && request.state !== 'refunded' && (
          <span className="mt-1.5 block text-xs text-muted">
            A {formatMoney(request.attemptMilli)} card refund was sent and not confirmed, and its credit is held off
            the balance; Mark refunded sends the same again.
          </span>
        )}
      </td>
      <td className="text-right">
        {actions.length > 0 && (
          <div className="flex flex-col items-end gap-2">
            {actions.includes('approve') && (
              <button type="button" className="tl-button-quiet whitespace-nowrap" data-size="sm" onClick={() => onDecide('approve')}>
                Approve
              </button>
            )}
            {actions.includes('decline') && (
              <button
                type="button"
                className="tl-button-quiet whitespace-nowrap"
                data-size="sm"
                data-tone="danger"
                onClick={() => onDecide('decline')}
              >
                Decline
              </button>
            )}
            {actions.includes('refund') && (
              <button type="button" className="tl-button whitespace-nowrap" data-size="sm" onClick={() => onDecide('refund')}>
                Mark refunded
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * One decision, confirmed. The request is the row as the queue last read it;
 * the server checks the state again, so a decision somebody else made in the
 * meantime is reported rather than overwritten.
 */
function DecisionDialog({
  action,
  request,
  onClose,
  onDone,
  onStale,
}: {
  action: AdminRefundAction;
  request: AdminRefundRequest;
  onClose: () => void;
  onDone: (message: string) => void;
  onStale: () => void;
}) {
  const [reason, setReason] = useState('');
  const [sentByHand, setSentByHand] = useState(false);
  const [amountSent, setAmountSent] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /*
   * Set when the server answers `paid-by-hand-required` to a request this page
   * did not know was crypto: from then on the dialog asks for the by-hand
   * confirmation, at the amount the server named.
   */
  const [handAmount, setHandAmount] = useState<number | null>(null);

  const who = request.accountEmail || 'the person who asked';
  const confirmation = describeRefundConfirmation(request);
  const byHand = action === 'refund' && (confirmation.byHand || handAmount !== null);
  const handMilli = handAmount ?? confirmation.amountMilli;

  const reasonProblem = action === 'decline' ? refundReasonProblem(reason, 'admin') : null;
  const sentProblem = byHand ? amountSentProblem(amountSent, request.amountMilli) : null;
  const blocked = action === 'refund' ? confirmation.blocked : null;

  const run = async () => {
    setAttempted(true);
    if (reasonProblem || sentProblem || blocked) return;
    if (byHand && !sentByHand) return;
    setWorking(true);
    setError(null);
    try {
      if (action === 'approve') {
        const answer = await adminRefundRequestsApi.approve(request.id);
        onDone(describeDecision('approve', answer.request, answer.changed));
      } else if (action === 'decline') {
        const answer = await adminRefundRequestsApi.decline(request.id, reason);
        onDone(describeDecision('decline', answer.request, answer.changed));
      } else {
        const answer = await adminRefundRequestsApi.refund(
          request.id,
          byHand ? byHandRefundBody(amountSent, handMilli) : {}
        );
        onDone(describeRefundMade(answer.request, answer.outcome, answer.changed));
      }
    } catch (caught) {
      if (caught instanceof ApiResponseError && caught.code === 'paid-by-hand-required') {
        const named = caught.number('amountMilli');
        setHandAmount(typeof named === 'number' ? named : confirmation.amountMilli);
        setAttempted(false);
      } else if (
        caught instanceof ApiResponseError &&
        (isStaleRefundRefusal(caught.code) || (action === 'refund' && caught.status >= 500))
      ) {
        // Out of date - or a card refund Stripe did not confirm, which has
        // recorded what it sent: the row says so once the list is read again.
        onStale();
      }
      setError(caught);
    } finally {
      setWorking(false);
    }
  };

  const title =
    action === 'approve'
      ? `Approve ${request.reference}?`
      : action === 'decline'
        ? `Decline ${request.reference}?`
        : confirmation.title;

  const confirmLabel =
    action === 'approve'
      ? 'Approve'
      : action === 'decline'
        ? 'Decline'
        : byHand
          ? 'Mark refunded'
          : `Refund ${formatMoney(confirmation.amountMilli)}`;

  return (
    <Dialog
      open
      title={title}
      subtitle={`${request.label} · asked by ${who}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="tl-button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tl-button"
            data-tone={action === 'decline' ? 'danger' : undefined}
            onClick={() => void run()}
            disabled={working || Boolean(blocked) || (attempted && Boolean(reasonProblem || sentProblem))}
          >
            {working ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {action === 'approve' && (
          <p className="text-sm text-muted">
            The refund is accepted, and {who} is told so. No money moves yet: Mark refunded makes the refund
            when you are ready.
          </p>
        )}

        {action === 'decline' && (
          <div>
            <p className="text-sm text-muted">Declining is final. {who} reads your reason in their notifications.</p>
            <label htmlFor="decline-reason" className="tl-label mt-4">
              Reason for declining
            </label>
            <textarea
              id="decline-reason"
              className="tl-input mt-2"
              rows={4}
              value={reason}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={attempted && Boolean(reasonProblem)}
            />
            <p className="mt-2 text-right text-xs text-subtle tabular-nums">
              {cleanRefundReason(reason).length} / {MAX_REFUND_REASON}
            </p>
            {attempted && reasonProblem && <Status tone="error">{reasonProblem}</Status>}
          </div>
        )}

        {action === 'refund' && (
          <>
            <p className="text-sm text-muted">{confirmation.body}</p>
            {blocked && <Notice tone="warn">{blocked}</Notice>}
            {byHand && !blocked && (
              <div className="space-y-4">
                <label className="tl-choice" data-on={sentByHand}>
                  <input type="checkbox" checked={sentByHand} onChange={(event) => setSentByHand(event.target.checked)} />
                  <span className="min-w-0 text-sm">
                    <span className="block font-medium text-ink">
                      I have sent {formatMoney(handMilli)} back by hand
                    </span>
                    <span className="mt-1 block text-muted">
                      Nothing here can send crypto. This records that you did, and takes the same amount of credit
                      off their balance.
                    </span>
                  </span>
                </label>
                {attempted && !sentByHand && (
                  <Status tone="error">Confirm that you have sent the money back first.</Status>
                )}
                <label className="block">
                  <span className="tl-label">Amount actually sent ($), if different</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="tl-input mt-2"
                    value={amountSent}
                    onChange={(event) => setAmountSent(event.target.value)}
                    placeholder={toDollarInput(handMilli)}
                  />
                </label>
                {attempted && sentProblem && <Status tone="error">{sentProblem}</Status>}
              </div>
            )}
          </>
        )}

        <ErrorNotice error={error} fallback={action === 'refund' ? 'Could not make the refund' : 'Could not record that'} />
      </div>
    </Dialog>
  );
}
