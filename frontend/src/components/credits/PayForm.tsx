'use client';

import { useEffect, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  CheckoutElementsProvider,
  PaymentElement,
  useCheckoutElements,
} from '@stripe/react-stripe-js/checkout';
import { formatAmount } from '@/lib/payments';

/**
 * The payment form, on our own page.
 *
 * Embedded rather than a redirect to Stripe's hosted page - but the property
 * that made the hosted page worth using is kept: **no card number ever reaches
 * this server, or even this component.** The Payment Element renders inside an
 * iframe served by Stripe, and the details go from there straight to Stripe.
 * What we hold is a client secret, which identifies a checkout session and
 * authorises nothing on its own.
 *
 * And it still does not decide anything. `confirm()` returning without an error
 * is not payment - a signed webhook arriving server-to-server is. So a
 * successful confirm sends the customer to the page that waits for that
 * webhook, exactly as the redirect version did.
 */

/**
 * Stripe objects are cached per publishable key.
 *
 * `loadStripe` injects a script tag, so calling it on every render would add
 * one per render. The key arrives from our API rather than a build-time
 * constant, so this cannot be a module-level constant the way Stripe's own
 * samples write it - but it can be a module-level cache, which has the same
 * effect.
 */
const stripeByKey = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string): Promise<Stripe | null> {
  const existing = stripeByKey.get(publishableKey);
  if (existing) return existing;
  const created = loadStripe(publishableKey);
  stripeByKey.set(publishableKey, created);
  return created;
}

const PANEL =
  'rounded-xl border border-gray-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900';

function Inner({
  amountCents,
  currency,
  onCancel,
}: {
  amountCents: number;
  currency: string;
  onCancel: () => void;
}) {
  const state = useCheckoutElements();
  const [paying, setPaying] = useState(false);
  const [problem, setProblem] = useState('');

  if (state.type === 'loading') {
    return (
      <div className={PANEL}>
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  if (state.type === 'error') {
    return (
      <div className={PANEL}>
        <p className="text-sm text-red-700 dark:text-red-300">
          The payment form could not be loaded. {state.error.message}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Start again
        </button>
      </div>
    );
  }

  const pay = async () => {
    setPaying(true);
    setProblem('');
    /*
     * Reached only when confirming fails IMMEDIATELY.
     *
     * Anything else - a card needing 3-D Secure, a stablecoin payment, any
     * method that leaves the page - navigates the browser to the return_url set
     * on the session, so there is no "success" branch to write here. The page
     * that is waiting there polls until the webhook has landed.
     */
    const result = await state.checkout.confirm();
    if (result.type === 'error') {
      setProblem(result.error.message);
      setPaying(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className={PANEL}>
        <PaymentElement options={{ layout: 'tabs' }} />
      </div>

      {problem && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-100">
          {problem}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void pay()}
          disabled={paying}
          className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
        >
          {paying ? 'Paying…' : `Pay ${formatAmount(amountCents, currency)}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={paying}
          className="text-sm font-medium text-gray-600 hover:underline disabled:opacity-50 dark:text-slate-300"
        >
          Cancel
        </button>
      </div>

      <p className="text-xs text-gray-500 dark:text-slate-400">
        Card details are entered in a form served by Stripe and go straight to them. This server
        never sees them, and your credits arrive once the payment is confirmed.
      </p>
    </div>
  );
}

/** How long to wait for Stripe's script before admitting it is not coming. */
const SCRIPT_TIMEOUT_MS = 15_000;

export default function PayForm(props: {
  publishableKey: string;
  clientSecret: string;
  credits: number;
  amountCents: number;
  currency: string;
  dark: boolean;
  onCancel: () => void;
}) {
  const { publishableKey, clientSecret, dark, onCancel, ...rest } = props;

  /*
   * Resolved here rather than handed to the provider as a promise.
   *
   * `loadStripe` injects a script tag from js.stripe.com, and that can simply
   * not arrive: a blocker extension, a corporate proxy, a captive portal, an
   * offline moment. Passing the pending promise straight to
   * CheckoutElementsProvider makes every one of those failures look identical
   * to "still loading", and the customer watches a spinner for ever with
   * nothing to press. Owning the load means the failure can be said out loud.
   */
  const [stripe, setStripe] = useState<Stripe | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    const giveUp = setTimeout(() => {
      if (live) setUnavailable(true);
    }, SCRIPT_TIMEOUT_MS);

    stripeFor(publishableKey)
      .then((loaded) => {
        if (!live) return;
        // `null` is what loadStripe resolves to when there is no window to
        // load into; treat it the same as a failure rather than as success.
        if (loaded) setStripe(loaded);
        else setUnavailable(true);
      })
      .catch(() => {
        // Forget the rejected promise, or every later attempt replays the same
        // failure from cache and "Start again" can never actually start again.
        stripeByKey.delete(publishableKey);
        if (live) setUnavailable(true);
      });

    return () => {
      live = false;
      clearTimeout(giveUp);
    };
  }, [publishableKey]);

  if (unavailable) {
    return (
      <div className={PANEL}>
        <p className="text-sm font-semibold text-gray-900 dark:text-white">
          The payment form could not be loaded.
        </p>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
          Stripe&apos;s script did not load. A script blocker or an offline moment will do it -
          nothing was charged, and your card was never entered.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Start again
        </button>
      </div>
    );
  }

  if (!stripe) {
    return (
      <div className={PANEL}>
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-blue-600" />
        {/* A way out while it loads. Somebody who pressed Pay by mistake should
            not have to wait for a script they did not ask for. */}
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm font-medium text-gray-600 hover:underline dark:text-slate-300"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <CheckoutElementsProvider
      stripe={stripe}
      options={{
        clientSecret,
        // Stripe renders in an iframe and cannot see the page's own CSS, so a
        // dark page needs telling or the form lands as a white box on slate.
        elementsOptions: { appearance: { theme: dark ? 'night' : 'stripe' } },
      }}
    >
      <Inner {...rest} onCancel={onCancel} />
    </CheckoutElementsProvider>
  );
}
