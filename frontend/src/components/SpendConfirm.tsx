'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import Dialog from '@/components/ui/Dialog';
import { Status } from '@/components/ui/kit';
import { formatDate, formatMoney } from '@/lib/format';
import { browserStorage } from '@/lib/generationQueue';
import {
  confirmNeeded,
  confirmSkipped,
  IMMEDIATE_WARNING,
  skipConfirm,
  spendFigures,
  type SpendEstimate,
  type SpendKind,
} from '@/lib/spendConfirm';

/**
 * What is asked before anything spends credit (the owner's alert, with **Do
 * not show again**): Generate Immediately, every Order, and buying, switching
 * or keeping a subscription. It says what the action takes from the credit
 * balance and what is left after - or, when the balance is short, says so and
 * offers Buy credits instead of a Proceed that would only be refused - then
 * the kind's own paragraph: owner decision B4's warning for Generate
 * Immediately, where an order is collected, or what the subscription change
 * does. The decisions are lib/spendConfirm.ts's.
 *
 * Mounted only while open, so "Do not show again" starts unticked every time.
 * Through `useSpendConfirm`, which asks only when it should: never once
 * skipped for that kind in this browser, and - but for Generate Immediately,
 * which always asks - never for something that spends nothing.
 */

/** A question, as a page asks it: the kind, the dialog's title, and how to price it (asked only if needed). */
export type SpendRequest = {
  kind: SpendKind;
  title: string;
  /**
   * What it will take - `what` names what is paid for ("7 resumes at $0.023
   * each", "Premium+ for 30 days"), `detail` adds the kind's own paragraph.
   * Called only once skipping is ruled out.
   */
  price: () => Promise<{ estimate: SpendEstimate; what?: string | null; detail?: ReactNode }>;
};

const ORDER_NOTE =
  'It is built on the server whether or not this page stays open; collect the files on Orders. A resume that does not build is refunded.';

const IMMEDIATE_NOTE =
  'Each resume downloads to this browser as soon as it is built, so keep this page open until the run finishes. Resumes that had not started when it stopped are refunded.';

/** The sentence saying what is taken, and when. */
function SpendLine({ kind, estimate, what }: { kind: SpendKind; estimate: SpendEstimate; what: string | null }) {
  const figures = spendFigures(estimate);
  const forWhat = what ? `, for ${what}` : '';
  switch (figures.state) {
    case 'exempt':
      return <p className="text-sm text-muted">Administrators are never charged: nothing is taken from your credit.</p>;
    case 'free':
      return <p className="text-sm text-muted">This is free: nothing is taken from your credit.</p>;
    case 'unknown':
      return (
        <p className="text-sm text-muted">
          {kind === 'subscription'
            ? 'What this costs could not be worked out just now.'
            : 'What this costs could not be worked out just now. It is taken from your credit at the price per resume of the builder mode you chose.'}
        </p>
      );
    case 'later':
      return (
        <>
          <p className="text-base text-ink">
            Nothing is taken now. On {formatDate(estimate.chargedOn ?? '', { style: 'date' })},{' '}
            <span className="tabular-nums">{formatMoney(figures.costMilli ?? 0)}</span> is taken from your credit
            {forWhat}, and every 30 days after until you cancel.
          </p>
          {figures.shortMilli > 0 && estimate.balanceMilli !== null && (
            <p className="mt-2 text-sm text-muted tabular-nums">
              Your balance now, {formatMoney(estimate.balanceMilli)}, is {formatMoney(figures.shortMilli)} short of it:
              buy credits before then, or the subscription ends that day.
            </p>
          )}
        </>
      );
    default:
      return (
        <>
          <p className="text-base text-ink tabular-nums">
            This takes {formatMoney(figures.costMilli ?? 0)} from your credit{forWhat}.
            {figures.balanceAfterMilli !== null && !figures.blocks && (
              <> Your balance after: {formatMoney(figures.balanceAfterMilli)}.</>
            )}
          </p>
          {figures.blocks && estimate.balanceMilli !== null && (
            <Status tone="error">
              Your balance, {formatMoney(estimate.balanceMilli)}, is {formatMoney(figures.shortMilli)} short.{' '}
              <Link href="/credits" className="tl-link">
                Buy credits
              </Link>
            </Status>
          )}
        </>
      );
  }
}

export default function SpendConfirm({
  kind,
  title,
  estimate,
  what = null,
  detail = null,
  onCancel,
  onProceed,
}: {
  kind: SpendKind;
  title: string;
  estimate: SpendEstimate;
  what?: string | null;
  detail?: ReactNode;
  onCancel: () => void;
  /** `dontShowAgain`: remember, for this browser and this kind, not to ask again. */
  onProceed: (dontShowAgain: boolean) => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const { blocks } = spendFigures(estimate);

  return (
    <Dialog
      open
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel} className="tl-button-quiet">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onProceed(dontShowAgain)}
            disabled={blocks}
            className="tl-button"
            title={blocks ? 'Your balance does not cover this. Buy credits first.' : undefined}
          >
            Proceed
          </button>
        </>
      }
    >
      <div className="space-y-3" data-spend-kind={kind}>
        <SpendLine kind={kind} estimate={estimate} what={what} />
        {kind === 'immediate' && (
          <>
            <p className="text-base text-ink">{IMMEDIATE_WARNING}</p>
            <p className="text-sm text-muted">{IMMEDIATE_NOTE}</p>
          </>
        )}
        {kind === 'order' && <p className="text-sm text-muted">{ORDER_NOTE}</p>}
        {detail && <div className="text-sm text-muted">{detail}</div>}
      </div>
      <label className="mt-5 flex cursor-pointer items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={dontShowAgain}
          onChange={(event) => setDontShowAgain(event.target.checked)}
          className="tl-check"
        />
        Do not show again
      </label>
    </Dialog>
  );
}

type Open = SpendRequest & { estimate: SpendEstimate; what: string | null; detail: ReactNode; start: () => void };

/**
 * Asks before `start` spends credit - or starts it at once: when this kind
 * was skipped in this browser, and (but for Generate Immediately) when it
 * spends nothing. A second `ask` while one is pricing or open is ignored, so
 * a double press asks once. Render `dialog` once on the page; `pending` is
 * true while a price is being worked out.
 *
 * Nothing starts for a page that has gone while its price was worked out: a
 * dialog closed with Cancel or Escape in that moment unmounts the hook, and a
 * free or exempt action - which would have started without asking - is
 * dropped with it rather than placed behind the person's back.
 */
export function useSpendConfirm(): {
  ask: (request: SpendRequest, start: () => void) => Promise<void>;
  dialog: ReactNode;
  pending: boolean;
} {
  const [open, setOpen] = useState<Open | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ask = useCallback(async (request: SpendRequest, start: () => void) => {
    if (busy.current) return;
    if (confirmSkipped(request.kind, browserStorage())) {
      start();
      return;
    }
    busy.current = true;
    setPending(true);
    let priced: Awaited<ReturnType<SpendRequest['price']>>;
    try {
      priced = await request.price();
    } catch {
      // Not knowing the price is a reason to ask, never to charge silently.
      priced = { estimate: { costMilli: null, balanceMilli: null, exempt: false, chargedOn: null } };
    } finally {
      setPending(false);
    }
    if (!mounted.current) {
      busy.current = false;
      return;
    }
    if (!confirmNeeded(request.kind, priced.estimate)) {
      busy.current = false;
      start();
      return;
    }
    setOpen({ ...request, estimate: priced.estimate, what: priced.what ?? null, detail: priced.detail ?? null, start });
  }, []);

  const close = () => {
    busy.current = false;
    setOpen(null);
  };

  const dialog = open ? (
    <SpendConfirm
      kind={open.kind}
      title={open.title}
      estimate={open.estimate}
      what={open.what}
      detail={open.detail}
      onCancel={close}
      onProceed={(dontShowAgain) => {
        if (dontShowAgain) skipConfirm(open.kind, browserStorage());
        const { start } = open;
        close();
        start();
      }}
    />
  ) : null;

  return { ask, dialog, pending };
}
