'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { ApiResponseError } from '@/lib/api';
import { keepPolling, pollDelay, SLOW_AFTER_MS, type PollOutcome } from '@/lib/paymentPoll';
import { describePurchase, isLegacyPurchase } from '@/lib/paymentDisplay';
import {
  isPaymentPending,
  type Payment,
  paymentsApi,
  STATE_LABELS,
  STATE_TONES,
} from '@/lib/payments';
import { EmptyState, Notice, Pill, Spinner } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';

/**
 * Where a provider sends the browser back to.
 *
 * It waits rather than congratulates, and that is the whole design. Arriving
 * here proves only that somebody followed a redirect - the page has no way to
 * know a payment succeeded, and it must not pretend otherwise, because the
 * thing that actually decides is a signed webhook arriving server-to-server.
 * So it polls the payment until the server says it was paid.
 *
 * Usually that is over before the redirect finishes. For crypto it can be
 * minutes, because the network has to confirm the transfer - which is why the
 * waiting copy says so rather than spinning silently. The poll slows down once
 * the copy changes, pauses while the tab is hidden, and stops for good on a
 * payment that is settled or that the server does not know (lib/paymentPoll).
 */
function ReturnBody() {
  const search = useSearchParams();
  const paymentId = search?.get('payment') ?? '';
  const { refresh } = useAuth();

  const [payment, setPayment] = useState<Payment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [waitedTooLong, setWaitedTooLong] = useState(false);

  const latestRequest = useRef(0);
  const load = useCallback(async (): Promise<PollOutcome> => {
    if (!paymentId) {
      setLoading(false);
      return 'gone';
    }
    const token = ++latestRequest.current;
    try {
      const response = await paymentsApi.get(paymentId);
      // Superseded by a newer look, which decides; this one asks for nothing more.
      if (token !== latestRequest.current) return 'settled';
      setPayment(response.payment);
      setError('');
      /*
       * Tell the rest of the app the balance moved.
       *
       * Nothing else has any reason to re-read the account: the webhook that
       * credited it is server-to-server and the browser never saw it, and
       * client-side navigation away from here does not help because the auth
       * context fetches on mount and the root layout never unmounts. Without
       * this the page says "credits added" while the top-bar pill, the balance
       * panel and the credit history all still show the pre-purchase figure
       * until a full reload.
       *
       * A paid payment is settled, so the poll below stops right after and
       * this fires once.
       */
      if (response.payment.state === 'paid') void refresh();
      return isPaymentPending(response.payment) ? 'pending' : 'settled';
    } catch (err) {
      if (token !== latestRequest.current) return 'settled';
      setError(messageWithDetail(err, 'Could not find that payment.'));
      // A 404 is final - no such payment, or not this account's. Anything
      // else (offline, a restart) is worth asking again.
      return err instanceof ApiResponseError && err.status === 404 ? 'gone' : 'retry';
    } finally {
      if (token === latestRequest.current) setLoading(false);
    }
  }, [paymentId, refresh]);

  /*
   * One look now, then a chain of timeouts rather than an interval: the next
   * look is booked only once this one has answered, at a pace set by how long
   * the page has waited. A hidden tab books nothing; coming back to it (the
   * tab shown again, or the window focused) looks at once and starts the
   * chain again. A settled or vanished payment ends it for good.
   */
  useEffect(() => {
    const startedAt = Date.now();
    let live = true;
    let finished = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const look = async () => {
      clearTimeout(timer);
      timer = undefined;
      if (!live || finished || inFlight) return;
      inFlight = true;
      const outcome = await load();
      inFlight = false;
      if (!live) return;
      if (!keepPolling(outcome)) {
        finished = true;
        return;
      }
      if (document.visibilityState === 'hidden') return;
      timer = setTimeout(() => {
        // Hidden since it was booked: wait for the tab to come back instead.
        if (document.visibilityState === 'hidden') {
          timer = undefined;
          return;
        }
        void look();
      }, pollDelay(Date.now() - startedAt));
    };
    const comeBack = () => {
      if (document.visibilityState !== 'hidden') void look();
    };

    void look();
    document.addEventListener('visibilitychange', comeBack);
    window.addEventListener('focus', comeBack);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', comeBack);
      window.removeEventListener('focus', comeBack);
    };
  }, [load]);

  // After two minutes, stop implying it is about to happen and say what to do.
  useEffect(() => {
    const timer = setTimeout(() => setWaitedTooLong(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  if (loading) {
    return (
      <div className="tl-card">
        <Spinner />
      </div>
    );
  }

  if (!payment) {
    return (
      <EmptyState
        title="Payment not found"
        action={
          <Link href="/credits" className="tl-button">
            Back to credits
          </Link>
        }
      >
        {error || 'It may belong to another account.'}
      </EmptyState>
    );
  }

  const waiting = isPaymentPending(payment);

  return (
    <div className="tl-card">
      <div className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="break-all text-2xl font-bold tracking-tight text-ink">
            {payment.reference}
          </h1>
          <Pill tone={STATE_TONES[payment.state] ?? 'grey'}>{STATE_LABELS[payment.state]}</Pill>
        </div>

        <p className="mt-2 text-base text-muted">
          {describePurchase(payment)}
        </p>

        {payment.state === 'paid' && (
          <Notice tone="success" className="mt-6">
            <p className="font-semibold">
              {/*
                An order from before credits were dollars is reached from the
                order table's Help link too, and its credits went with the
                reset - "on your balance" would be a claim about money that is
                no longer there.
              */}
              {isLegacyPurchase(payment)
                ? 'Paid. This was bought before credits became dollars, and its credits were reset to $0.000 then.'
                : 'Paid. Your credit is on your balance.'}
            </p>
            <p className="mt-1">
              <Link href="/" className="font-semibold underline">
                Start building
              </Link>{' '}
              or{' '}
              <Link href="/credits" className="font-semibold underline">
                buy more
              </Link>
              .
            </p>
          </Notice>
        )}

        {waiting && (
          <Notice tone="info" className="mt-6">
            <div className="flex items-start gap-3">
              {/* Said and drawn: this page is genuinely still waiting. */}
              <span className="tl-spinner mt-0.5 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="font-semibold">Waiting for the payment to be confirmed.</p>

                <p className="mt-1">
                  {/*
                    Careful not to promise. Landing here proves only that a browser
                    followed a redirect - somebody who started a 3-D Secure step and
                    abandoned it arrives at exactly this page, in exactly this
                    state, and telling them their credits are on the way would be
                    false. So the sentence is conditional, and the two-minute note
                    below says what to do when it stays that way.
                  */}
                  {payment.method === 'crypto'
                    ? 'A crypto payment has to be confirmed by the network, which usually takes a few minutes. If it went through, your credit will be added even if you close this page.'
                    : 'This usually takes a second or two. If the payment went through, your credit will be added even if you close this page.'}
                </p>
                {waitedTooLong && (
                  <p className="mt-2">
                    Still waiting. If you did not finish paying - closing the card&apos;s
                    confirmation step will do it - nothing was charged and you can{' '}
                    <Link href="/credits" className="font-semibold underline">
                      start again
                    </Link>
                    . If you were charged and this does not clear shortly, quote{' '}
                    <span className="font-mono font-semibold">{payment.reference}</span> to an
                    administrator.
                  </p>
                )}
              </div>
            </div>
          </Notice>
        )}

        {(payment.state === 'failed' || payment.state === 'expired') && (
          <Notice tone="error" className="mt-6">
            <p className="font-semibold">
              {payment.state === 'expired' ? 'That checkout expired.' : 'That payment did not go through.'}
            </p>
            {/*
              The server's own sentence, or nothing but the reassurance.

              This used to read "You were not charged." and then the sentence,
              which put a flat contradiction on the page for the one failure
              where money DID move: a crypto payment that arrived short is
              closed as failed, and the coin is at the provider. Every sentence
              the server writes now says what happened to the money itself, so
              printing it alone is both shorter and true. The fallback covers a
              row closed before those sentences existed.
            */}
            <p className="mt-1">{payment.failure || 'You were not charged.'}</p>
            <Link href="/credits" className="mt-2 inline-block font-semibold underline">
              Try again
            </Link>
          </Notice>
        )}

        {payment.state === 'refunded' && (
          <Notice tone="warn" className="mt-6">
            This payment was refunded.
          </Notice>
        )}
      </div>

      {/* The way back, ruled off below the state like a dialog's footer. */}
      <div className="flex justify-end border-t-[1px] border-[color:var(--line-subtle)] px-6 py-4 sm:px-8">
        <Link href="/credits" className="tl-button">
          Back to credits
        </Link>
      </div>
    </div>
  );
}

export default function PaymentReturnPage() {
  return (
    // Centred on the canvas, narrower than a page: this is one card saying one thing.
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-16 lg:px-8">
      {/* `useSearchParams` needs a Suspense boundary to prerender. */}
      <Suspense
        fallback={
          <div className="tl-card">
            <Spinner />
          </div>
        }
      >
        <ReturnBody />
      </Suspense>
    </main>
  );
}
