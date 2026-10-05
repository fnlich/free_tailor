'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ContactAdminLink } from '@/components/contact/ContactAdminDialog';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice, Notice, Pill, Status } from '@/components/ui/kit';
import { asksForAdministrator } from '@/lib/contactChannels';
import { formatMoney } from '@/lib/format';
import {
  cleanRefundReason,
  describeOpenRequest,
  describeRefundOffer,
  MAX_REFUND_REASON,
  REFUND_STATE_LABELS,
  REFUND_STATE_TONES,
  refundActionFor,
  refundReasonProblem,
} from '@/lib/refundDisplay';
import {
  refundRequestsApi,
  type RefundOption,
  type RefundRequest,
  type RefundSource,
} from '@/lib/refunds';

/** Where a person reads what they asked for. Also where every notice about it links. */
export const REFUND_REQUESTS_PATH = '/credits?tab=refunds';

type Options = { items: RefundOption[]; note: string | null };

/**
 * "Ask for refund": what would come back, and a reason - from a purchase on
 * the order history, a resume on an order's page, or a charge line of the
 * credit history.
 *
 * The amount is the server's, read from `/refund-requests/options` when this
 * opens and never sent back: a request names the thing and says why, and the
 * server measures it again. A credit history charge can name a whole run, so
 * when the answer holds several resumes this lists them and the person picks
 * one; every resume shows what it would give back, or why it cannot be asked
 * about (still building, refunded automatically, never charged), or the
 * request already open for it - one per item.
 *
 * Mounted only while open, so it reads the options afresh each time.
 */
export default function RefundRequestDialog({
  source,
  itemId,
  onClose,
  onRequested,
}: {
  source: RefundSource;
  /** Narrows an order's resumes to this one - the row whose button was pressed. */
  itemId?: string;
  onClose: () => void;
  onRequested?: (request: RefundRequest) => void;
}) {
  /*
   * The source as it was when this opened. Every caller writes it as an object
   * literal, which is a new object on each of their renders - and the order
   * page re-renders every few seconds while it polls - so depending on the
   * prop itself would re-read the options, and reset the choice, each time.
   */
  const [opened] = useState(source);
  const [options, setOptions] = useState<Options | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  /** Bumped to read the options again - after a refusal says something changed. */
  const [reload, setReload] = useState(0);
  const [picked, setPicked] = useState('');
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [sent, setSent] = useState<RefundRequest | null>(null);

  useEffect(() => {
    let alive = true;
    refundRequestsApi.options(opened).then(
      (answer) => {
        if (!alive) return;
        const items = itemId ? answer.items.filter((item) => item.itemId === itemId) : answer.items;
        setOptions({ items, note: answer.note });
        setLoadError(null);
      },
      (error: unknown) => {
        if (alive) setLoadError(error);
      }
    );
    return () => {
      alive = false;
    };
  }, [opened, itemId, reload]);

  const items = options?.items ?? [];
  /*
   * The resume being asked about: the one picked, or - until somebody picks -
   * the only one, or the first that can be asked about. Derived rather than
   * stored, so a reload that drops the picked one falls back by itself.
   */
  const chosen =
    items.find((item) => item.itemId === picked) ??
    (items.length === 1 ? items[0] : items.find((item) => refundActionFor(item).kind === 'ask')) ??
    null;
  const canAsk = Boolean(chosen && refundActionFor(chosen).kind === 'ask');
  const reasonProblem = refundReasonProblem(reason, 'requester');
  const reasonLength = cleanRefundReason(reason).length;

  const send = async () => {
    setAttempted(true);
    if (!chosen || !canAsk || reasonProblem) return;
    setSending(true);
    setSendError(null);
    try {
      const { request } = await refundRequestsApi.create({
        itemType: chosen.itemType,
        itemId: chosen.itemId,
        reason,
      });
      setSent(request);
      onRequested?.(request);
    } catch (error) {
      setSendError(error);
      // Something about the item changed since this opened - a request opened
      // in another tab, the resume refunded itself. Read it again so what is
      // shown is what is true now.
      setReload((value) => value + 1);
    } finally {
      setSending(false);
    }
  };

  const footer = sent ? (
    <button type="button" className="tl-button" onClick={onClose}>
      Done
    </button>
  ) : (
    <>
      <button type="button" className="tl-button-quiet" onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="tl-button"
        onClick={() => void send()}
        disabled={sending || !canAsk || (attempted && Boolean(reasonProblem))}
      >
        {sending ? 'Sending…' : 'Ask for refund'}
      </button>
    </>
  );

  return (
    <Dialog
      open
      title="Ask for a refund"
      subtitle={items.length === 1 ? items[0].label : undefined}
      width="md"
      onClose={onClose}
      footer={footer}
    >
      {sent ? (
        <div className="space-y-4">
          <Notice tone="success" role="status">
            Refund request {sent.reference} sent for {formatMoney(sent.amountMilli)}. An administrator will
            decide, and you will be told in your notifications.
          </Notice>
          <Link href={REFUND_REQUESTS_PATH} className="tl-link text-sm" onClick={onClose}>
            See your refund requests
          </Link>
        </div>
      ) : loadError ? (
        <ErrorNotice error={loadError} fallback="Could not check what can be refunded" />
      ) : !options ? (
        <div className="flex items-center gap-3 py-4 text-sm text-muted" role="status">
          <span className="tl-spinner" aria-hidden />
          <span>Checking what can be refunded…</span>
        </div>
      ) : items.length === 0 ? (
        <Notice tone="info">
          {options.note ?? 'There is nothing here that can be refunded.'}
          {options.note && asksForAdministrator(options.note) && (
            <>
              {' '}
              <ContactAdminLink />
            </>
          )}
        </Notice>
      ) : (
        <div className="space-y-5">
          {items.length > 1 && (
            <fieldset>
              <legend className="tl-label">Which resume?</legend>
              <div className="mt-2 space-y-2">
                {items.map((item) => (
                  <ItemChoice
                    key={item.itemId}
                    item={item}
                    on={chosen?.itemId === item.itemId}
                    onPick={() => setPicked(item.itemId)}
                  />
                ))}
              </div>
            </fieldset>
          )}

          {chosen && <ChosenItem item={chosen} />}

          {canAsk && (
            <div>
              <label htmlFor="refund-reason" className="tl-label">
                Why are you asking?
              </label>
              <textarea
                id="refund-reason"
                className="tl-input mt-2"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={4}
                autoFocus
                aria-invalid={attempted && Boolean(reasonProblem)}
                aria-describedby="refund-reason-hint"
              />
              <p id="refund-reason-hint" className="mt-2 flex justify-between gap-3 text-xs text-subtle">
                <span>An administrator reads this before deciding.</span>
                <span className="tabular-nums">
                  {reasonLength} / {MAX_REFUND_REASON}
                </span>
              </p>
              {attempted && reasonProblem && <Status tone="error">{reasonProblem}</Status>}
            </div>
          )}

          <ErrorNotice error={sendError} fallback="Could not send the refund request" />
        </div>
      )}
    </Dialog>
  );
}

/** One resume of a run, as a choice: what it would give back, or why it cannot be picked. */
function ItemChoice({ item, on, onPick }: { item: RefundOption; on: boolean; onPick: () => void }) {
  const action = refundActionFor(item);
  const pickable = action.kind === 'ask';
  return (
    <label className="tl-choice" data-on={on && pickable}>
      <input type="radio" name="refund-item" checked={on && pickable} disabled={!pickable} onChange={onPick} />
      <span className="min-w-0 text-sm">
        <span className="block break-words font-medium text-ink">{item.label}</span>
        <span className="mt-0.5 block text-muted">
          {action.kind === 'ask'
            ? `${formatMoney(item.refundableMilli)} back`
            : action.kind === 'open'
              ? describeOpenRequest(action.request)
              : action.kind === 'refunded'
                ? 'Refunded already.'
                : action.reason}
        </span>
      </span>
    </label>
  );
}

/** The thing being asked about: what would come back and where, or why nothing can be asked. */
function ChosenItem({ item }: { item: RefundOption }) {
  const action = refundActionFor(item);
  if (action.kind === 'ask') {
    return (
      <div className="tl-card p-4">
        <p className="text-sm text-muted">You would get back</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{formatMoney(item.refundableMilli)}</p>
        <p className="mt-2 text-sm text-muted">{describeRefundOffer(item)}</p>
      </div>
    );
  }
  if (action.kind === 'open') {
    return (
      <Notice tone="info">
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone={REFUND_STATE_TONES[action.request.state]}>{REFUND_STATE_LABELS[action.request.state]}</Pill>
          <span>{describeOpenRequest(action.request)}</span>
        </span>
        <Link href={REFUND_REQUESTS_PATH} className="tl-link mt-2 inline-block">
          See your refund requests
        </Link>
      </Notice>
    );
  }
  if (action.kind === 'refunded') return <Notice tone="neutral">This has been refunded already.</Notice>;
  return (
    <Notice tone="neutral">
      {action.reason}
      {/* "...Ask your administrator for a refund instead." - so offer the way to. */}
      {asksForAdministrator(action.reason) && (
        <>
          {' '}
          <ContactAdminLink />
        </>
      )}
    </Notice>
  );
}
