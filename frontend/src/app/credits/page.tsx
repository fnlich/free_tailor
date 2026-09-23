'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import CreditLedger from '@/components/CreditLedger';
import Paginator, { PAGE_SIZES, type PageState } from '@/components/Paginator';
import BuyCreditsDialog from '@/components/credits/BuyCreditsDialog';
import { PRIMARY } from '@/components/credits/chrome';
import { creditsApi, type CreditStatus, type LedgerEntry } from '@/lib/credits';
import {
  formatAmount,
  paymentsApi,
  STATE_LABELS,
  STATE_STYLES,
  type Payment,
  type PaymentOptions,
} from '@/lib/payments';

const CARD =
  'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400';

function formatDate(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/**
 * The balance, what has been bought, and a button that opens the purchase.
 *
 * The amount used to be typed here, with one Pay button per method beside it -
 * so the method was chosen last, and the limits that apply to it could only be
 * discovered by being refused. Buying now happens in a dialog that asks for
 * the method first, and this page is what it always should have been: the
 * account's own record.
 */
export default function BuyCreditsPage() {
  const search = useSearchParams();
  const cancelled = search?.get('cancelled');

  const [options, setOptions] = useState<PaymentOptions | null>(null);
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [buying, setBuying] = useState(false);

  /*
   * The two histories page themselves, and they do it separately.
   *
   * One loader for all four requests is what this page used to have, and with
   * paging it would mean pressing Older on the payment list re-fetched the
   * payment options and blanked the balance - the one number somebody came
   * here for - while a provider call it does not need went out over the wire.
   */
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentPage, setPaymentPage] = useState<PageState>({ offset: 0, pageSize: PAGE_SIZES[0] });
  const [paymentTotal, setPaymentTotal] = useState(0);

  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerPage, setLedgerPage] = useState<PageState>({ offset: 0, pageSize: PAGE_SIZES[0] });
  const [ledgerTotal, setLedgerTotal] = useState(0);

  /*
   * One guard token per list, not one for the page.
   *
   * Each of these is its own race: pressing Older twice quickly leaves two
   * requests in flight and the slower one must not win. A single shared token
   * would also let a ledger request cancel a payments one, which is a list
   * that silently stops updating.
   */
  const latestRequest = useRef(0);
  const latestPayments = useRef(0);
  const latestLedger = useRef(0);

  const loadPayments = useCallback(async (page: PageState) => {
    const token = ++latestPayments.current;
    try {
      const response = await paymentsApi.list(page.offset, page.pageSize);
      if (token !== latestPayments.current) return;
      setPayments(response.payments);
      // Guarded, so an older server that does not send it cannot zero the
      // count and take the controls off the screen.
      if (typeof response.total === 'number') setPaymentTotal(response.total);
    } catch {
      /*
       * Left as it was, deliberately. A failed page is not an empty history,
       * and replacing the rows with nothing would say it was.
       */
    }
  }, []);

  const loadLedger = useCallback(async (page: PageState) => {
    const token = ++latestLedger.current;
    try {
      const response = await creditsApi.ledger(page.pageSize, page.offset);
      if (token !== latestLedger.current) return;
      setLedger(response.entries);
      if (typeof response.total === 'number') setLedgerTotal(response.total);
    } catch {
      /* As above. */
    }
  }, []);

  const load = useCallback(async () => {
    const token = ++latestRequest.current;
    try {
      // Settled rather than all: a payment provider being unreachable must not
      // blank out the balance, which is the thing somebody came here to see.
      const [optionsResult, statusResult] = await Promise.allSettled([
        paymentsApi.options(),
        creditsApi.status(),
      ]);
      if (token !== latestRequest.current) return;

      if (optionsResult.status === 'fulfilled') {
        setOptions(optionsResult.value);
      } else {
        setError('Could not load the payment options.');
      }
      if (statusResult.status === 'fulfilled') setStatus(statusResult.value);
    } finally {
      if (token === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadPayments(paymentPage);
  }, [loadPayments, paymentPage]);

  useEffect(() => {
    void loadLedger(ledgerPage);
  }, [loadLedger, ledgerPage]);

  const anyMethod = options?.targets.some((target) => target.available) ?? false;

  /*
   * Wider only once there is room for two columns, and `xl` rather than `lg`.
   *
   * At `max-w-3xl` throughout, a 1440px window put two histories in a 768px
   * column with half the screen empty beside them. But the split cannot happen
   * at `lg`: the rail takes 240px of the window, so a 1024px screen leaves a
   * 784px well and two 347px columns - narrow enough that every payment row
   * wraps its status pill onto a second line. Measured at 1280 the columns are
   * about 490px and the rows sit on one line, which is where the split earns
   * itself. Below that it stays one column and the rows stay readable.
   *
   * The balance card above needs no change of its own: it is already
   * `flex-wrap items-end justify-between`, so it reads correctly at any width.
   */
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8 xl:max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Buy credits</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
          One credit builds one resume. Previews are always free.
        </p>
      </div>

      {cancelled && (
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
          That payment was cancelled. Nothing was charged.
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className={CARD}>
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
        </div>
      ) : (
        <>
          <div className={CARD}>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className={LABEL}>Your balance</div>
                <div className="mt-1 text-3xl font-semibold text-gray-900 dark:text-white">
                  {status?.balance ?? 0}
                </div>
                {status && status.held > 0 && (
                  <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
                    {status.held} held by a run in progress.
                  </p>
                )}
              </div>
              {anyMethod && options && (
                <button type="button" onClick={() => setBuying(true)} className={PRIMARY}>
                  Buy credits
                </button>
              )}
            </div>
            {status?.exempt && (
              <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
                Administrators do not spend credits, so you do not need to buy any.
              </p>
            )}
          </div>

          {!anyMethod && (
            <div className={CARD}>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">
                No payment method is set up
              </p>
              <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
                This installation cannot take payments yet. An administrator can turn one on:
              </p>
              <ul className="mt-3 space-y-1 text-sm text-gray-600 dark:text-slate-300">
                {options?.methods.map((entry) => (
                  <li key={entry.method}>
                    <span className="font-medium">{entry.label}</span> &mdash; {entry.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-gray-600 dark:text-slate-300">
                Until then, an administrator can add credits to your account directly.
              </p>
            </div>
          )}

          {/*
            Side by side once there is room, stacked below it.

            `items-start` so a short column does not stretch to the height of a
            tall one - with both lists on the same page size they are usually
            level, but a run of long notes in the ledger makes them differ and a
            stretched card is a card with empty space inside its border.
          */}
          <div className="grid items-start gap-6 xl:grid-cols-2">
            {/*
              Rendered whether or not there is anything in it, where it used to
              appear only once a payment existed. A card that comes and goes
              takes its own paging controls with it and drops the grid to one
              column - and an account with no payments yet is worth saying out
              loud rather than leaving a gap where an explanation should be.
            */}
            <div className={CARD}>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">Payment history</h2>
              {payments.length === 0 ? (
                <p className="mt-3 text-sm text-gray-600 dark:text-slate-300">
                  No payments yet. Anything you buy will be listed here, with a link to the order.
                </p>
              ) : (
              <ul className="mt-3 divide-y divide-gray-200 dark:divide-slate-800">
                {payments.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <Link
                        href={`/credits/return?payment=${payment.id}`}
                        className="font-mono text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {payment.reference}
                      </Link>
                      <p className="text-xs text-gray-500 dark:text-slate-400">
                        {/*
                          What was GRANTED, falling back to what was quoted for
                          every row written before a fee could reduce it. The
                          two differ only when a fee was taken, and showing the
                          quote there would credit the account, on screen, with
                          credits it never received.
                        */}
                        {payment.creditsGranted || payment.credits} credits &middot;{' '}
                        {formatAmount(payment.amountCents, payment.currency)} &middot;{' '}
                        {formatDate(payment.createdAt)}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE_STYLES[payment.state]}`}
                    >
                      {STATE_LABELS[payment.state]}
                    </span>
                  </li>
                ))}
              </ul>
              )}
              <Paginator
                total={paymentTotal}
                offset={paymentPage.offset}
                pageSize={paymentPage.pageSize}
                noun="payments"
                onChange={setPaymentPage}
              />
            </div>

            <div className={CARD}>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">Credit history</h2>
              <div className="mt-3">
                <CreditLedger entries={ledger} />
              </div>
              <Paginator
                total={ledgerTotal}
                offset={ledgerPage.offset}
                pageSize={ledgerPage.pageSize}
                noun="movements"
                onChange={setLedgerPage}
              />
            </div>
          </div>

          {/*
            Mounted only while it is open, so the wizard's state - which step,
            which method, how many credits, which order is open at the provider
            - resets by unmounting rather than by a reset action somebody has to
            remember to dispatch on the second purchase.
          */}
          {buying && options && (
            <BuyCreditsDialog
              options={options}
              onClose={() => {
                setBuying(false);
                /*
                 * The page's own panels, which the auth refresh does not
                 * cover: YOUR BALANCE and the credit history are loaded here
                 * once on mount, so after a chain payment they kept showing
                 * the pre-purchase figures until a full reload.
                 *
                 * Back to the first page of both, not a refresh in place. The
                 * row a buyer wants to see is the one they just made, and it
                 * is at the top - refreshing page three would leave them
                 * looking at last month with a new balance above it. Setting
                 * the state to a fresh object re-runs the loader even when
                 * the offset was already zero, which is the case that matters.
                 */
                void load();
                setPaymentPage((page) => ({ offset: 0, pageSize: page.pageSize }));
                setLedgerPage((page) => ({ offset: 0, pageSize: page.pageSize }));
              }}
            />
          )}
        </>
      )}
    </main>
  );
}
