'use client';

import { useState } from 'react';

import Dialog from '@/components/ui/Dialog';
import { ErrorNotice, Notice, Status } from '@/components/ui/kit';
import { formatMoney } from '@/lib/format';
import { cleanRefundReason, describePayoutAsk, MAX_REFUND_REASON, payoutNoteProblem } from '@/lib/refundDisplay';
import { payoutRequestsApi, type PayoutStatus, type RefundRequest } from '@/lib/refunds';

/**
 * A reporter's "Ask for Refund" (owner decision R1): a request that an
 * administrator pay out their earned balance.
 *
 * It asks for the WHOLE balance as it stands, never an amount the reporter
 * types - the server reads the balance itself and sends no figure back to be
 * edited - with an optional note (how they would like to be paid, say). The
 * administrator pays outside the app and records what they actually sent, up
 * to the balance then (R2). The balance shown is the one the page last read;
 * the request records the server's, which the confirmation names.
 */
export default function PayoutRequestDialog({
  balanceMilli,
  onClose,
  onRequested,
}: {
  balanceMilli: number;
  onClose: () => void;
  /** The request made, and the standing the server answered with - so the page needs no second read. */
  onRequested: (request: RefundRequest, status: PayoutStatus) => void;
}) {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<RefundRequest | null>(null);

  const noteProblem = payoutNoteProblem(note);

  const send = async () => {
    if (noteProblem || sending) return;
    setSending(true);
    setError(null);
    try {
      const answer = await payoutRequestsApi.create(note);
      setSent(answer.request);
      onRequested(answer.request, answer.status);
    } catch (caught) {
      // A request already open (another tab), or the balance paid out since:
      // the server's sentence says which, and the page reads its standing
      // again when this closes.
      setError(caught);
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
      <button type="button" className="tl-button" onClick={() => void send()} disabled={sending || Boolean(noteProblem)}>
        {sending ? 'Sending…' : 'Ask for payout'}
      </button>
    </>
  );

  return (
    <Dialog open title="Ask for a payout" subtitle="Your earned balance" onClose={onClose} footer={footer}>
      {sent ? (
        <Notice tone="success" role="status">
          Payout request {sent.reference} sent for {formatMoney(sent.amountMilli)}. An administrator will pay you
          and record it, and you will be told in your notifications.
        </Notice>
      ) : (
        <div className="space-y-5">
          <div className="tl-card p-4">
            <p className="text-sm text-muted">Your balance to pay out</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{formatMoney(balanceMilli)}</p>
            <p className="mt-2 text-sm text-muted">{describePayoutAsk(balanceMilli)}</p>
          </div>

          <div>
            <label htmlFor="payout-request-note" className="tl-label">
              Note for the administrator (optional)
            </label>
            <textarea
              id="payout-request-note"
              className="tl-input mt-2"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              autoFocus
              placeholder="How you would like to be paid, for example"
              aria-invalid={Boolean(noteProblem)}
              aria-describedby="payout-request-note-hint"
            />
            <p id="payout-request-note-hint" className="mt-2 flex justify-between gap-3 text-xs text-subtle">
              <span>An administrator reads this with the request.</span>
              <span className="tabular-nums">
                {cleanRefundReason(note).length} / {MAX_REFUND_REASON}
              </span>
            </p>
            {noteProblem && <Status tone="error">{noteProblem}</Status>}
          </div>

          <ErrorNotice error={error} fallback="Could not send the payout request" />
        </div>
      )}
    </Dialog>
  );
}
