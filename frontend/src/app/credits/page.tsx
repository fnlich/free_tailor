'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import BuyCreditsDialog from '@/components/credits/BuyCreditsDialog';
import CreditHistory from '@/components/credits/CreditHistory';
import OrderHistory from '@/components/credits/OrderHistory';
import { creditsApi, type CreditStatus } from '@/lib/credits';
import { paymentsApi, type PaymentOptions } from '@/lib/payments';

type Tab = 'card' | 'crypto' | 'history';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'card', label: 'Card' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'history', label: 'Credit History' },
];

/** Anything the page does not recognise is the default tab, not an error. */
function readTab(value: string | null | undefined): Tab {
  return value === 'crypto' || value === 'history' ? value : 'card';
}

/**
 * The balance, what has been bought, and a button that opens the purchase.
 *
 * Buying happens in a dialog that asks for the method FIRST, so the limits that
 * apply to it are known before an amount is typed. This page is the account's
 * own record and nothing else.
 */
function CreditsBody() {
  const router = useRouter();
  const search = useSearchParams();
  const cancelled = search?.get('cancelled');
  /*
   * The tab lives in the URL and only there, so a link to ?tab=history lands
   * on it, and so does following one while already on this page - local state
   * initialised from the URL would miss the second case and show one tab under
   * an address that names another.
   */
  const tab = readTab(search?.get('tab'));

  const [options, setOptions] = useState<PaymentOptions | null>(null);
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [buying, setBuying] = useState(false);
  /*
   * Bumped when the purchase dialog closes, which sends the visible list back
   * to its first page and reloads it - see `usePagedList`. The histories page
   * themselves, SEPARATELY from this: one loader for everything would mean
   * pressing Next on the order list refetched the payment options and blanked
   * the balance, the one number somebody came here for.
   */
  const [epoch, setEpoch] = useState(0);

  const latestRequest = useRef(0);
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
        setError('');
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

  const selectTab = useCallback(
    (next: Tab) => {
      // Every other parameter is kept; only `tab` is this control's to change.
      const params = new URLSearchParams(search?.toString() ?? '');
      if (next === 'card') params.delete('tab');
      else params.set('tab', next);
      const query = params.toString();
      router.replace(query ? `/credits?${query}` : '/credits', { scroll: false });
    },
    [router, search]
  );

  // Arrow keys move along the row, as the ARIA tabs pattern expects.
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    tabRefs.current.get(TABS[next].id)?.focus();
    selectTab(TABS[next].id);
  };

  const anyMethod = options?.targets.some((target) => target.available) ?? false;
  const purchaseBlocked = loading
    ? 'Loading the payment options.'
    : !options
      ? 'The payment options could not be loaded.'
      : !anyMethod
        ? 'No payment method is set up on this installation yet.'
        : '';

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-10 gap-y-5">
        <h1 className="text-3xl font-bold tracking-tight text-ink">Credits</h1>

        {/* `border-l-4` is not one of the shim's names; the bare `border-l` is. */}
        <div className="border-l-4 border-coin pl-4">
          <p className="text-sm text-ink">Current Balance</p>
          {loading ? (
            <div className="mt-1 h-7 w-16 animate-pulse rounded bg-surface-muted" role="status" aria-label="Loading balance" />
          ) : (
            <p className="text-xl font-semibold tracking-wide text-ink tabular-nums">
              {/* Unknown is not zero: a balance that failed to load says so. */}
              {status ? status.balance : '—'}
            </p>
          )}
          {status && status.held > 0 && (
            <p className="mt-0.5 text-xs text-muted">{status.held} held by a run in progress.</p>
          )}
        </div>

        <div className="ml-auto">
          {/*
            Always on screen, disabled with the reason when it cannot work. The
            reason for the operator - which keys are missing - is in the card
            below; the title is the short form for whoever hovers here.
          */}
          <button
            type="button"
            className="tl-button"
            data-shape="pill"
            onClick={() => setBuying(true)}
            disabled={Boolean(purchaseBlocked)}
            title={purchaseBlocked || undefined}
          >
            Purchase Credits
          </button>
        </div>
      </div>

      <div className="mt-6 space-y-3 empty:hidden">
        {cancelled && (
          <p className="rounded-lg bg-accent-soft px-4 py-3 text-sm text-accent-ink">
            That payment was cancelled. Nothing was charged.
          </p>
        )}

        {error && (
          <p className="tl-notice" data-tone="error" role="alert">
            {error}
          </p>
        )}

        {status?.exempt && (
          <p className="rounded-lg bg-accent-soft px-4 py-3 text-sm text-accent-ink">
            Administrators do not spend credits, so you do not need to buy any.
          </p>
        )}

        {/*
          Only once the options have actually arrived. When they failed to load
          the error above says so, and "this installation cannot take payments"
          would be a claim nobody checked.
        */}
        {options && !anyMethod && (
          <div className="tl-card p-6">
            <p className="text-lg font-semibold text-ink">No payment method is set up</p>
            <p className="mt-2 text-sm text-muted">
              This installation cannot take payments yet. An administrator can turn one on:
            </p>
            <ul className="mt-3 space-y-1 text-sm text-muted">
              {options.methods.map((entry) => (
                <li key={entry.method}>
                  <span className="font-medium text-ink">{entry.label}</span> &mdash; {entry.reason}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted">
              Until then, an administrator can add credits to your account directly.
            </p>
          </div>
        )}
      </div>

      <div role="tablist" aria-label="Credits" className="tl-tabs mt-8">
        {TABS.map((entry, index) => {
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              ref={(node) => {
                if (node) tabRefs.current.set(entry.id, node);
                else tabRefs.current.delete(entry.id);
              }}
              type="button"
              role="tab"
              id={`credits-tab-${entry.id}`}
              aria-selected={active}
              aria-controls="credits-panel"
              tabIndex={active ? 0 : -1}
              data-active={active}
              className="tl-tab"
              onClick={() => selectTab(entry.id)}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {/*
        Only the active tab's list is mounted, so only it loads. Keyed on the
        tab, so switching starts the other list fresh on its first page.
      */}
      <div id="credits-panel" role="tabpanel" aria-labelledby={`credits-tab-${tab}`} className="mt-8">
        {tab === 'history' ? (
          <CreditHistory key="history" epoch={epoch} />
        ) : (
          <OrderHistory key={tab} method={tab} epoch={epoch} />
        )}
      </div>

      {/*
        Mounted only while it is open, so the wizard's state - which step,
        which method, how many credits, which order is open at the provider -
        resets by unmounting rather than by a reset action somebody has to
        remember to dispatch on the second purchase.
      */}
      {buying && options && (
        <BuyCreditsDialog
          options={options}
          onClose={() => {
            setBuying(false);
            /*
             * The page's own panels, which the auth refresh does not cover: the
             * balance and the histories are loaded here, so after a purchase
             * they kept showing the pre-purchase figures until a full reload.
             *
             * Back to the first page, not a refresh in place. The row a buyer
             * wants to see is the one they just made, and it is at the top -
             * refreshing page three would leave them looking at last month
             * with a new balance above it.
             */
            void load();
            setEpoch((value) => value + 1);
          }}
        />
      )}
    </main>
  );
}

export default function CreditsPage() {
  return (
    // `useSearchParams` needs a Suspense boundary to prerender.
    <Suspense fallback={<main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8" />}>
      <CreditsBody />
    </Suspense>
  );
}
