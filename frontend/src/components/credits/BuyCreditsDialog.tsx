'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AmountStep from './AmountStep';
import OrderSummaryStep from './OrderSummaryStep';
import PaymentOptionsStep from './PaymentOptionsStep';
import PayDialog from './PayDialog';
import { PRIMARY, QUIET } from './chrome';
import { FIRST_STEP, wizardReducer, type Order, type Priced } from './order';
import { stripeFor } from './stripeLoader';
import { useTheme } from '@/lib/useTheme';
import {
  formatAmount,
  paymentsApi,
  type ChainInvoiceView,
  type PaymentOptions,
  type SavedCard,
} from '@/lib/payments';
import { CHAIN_POLL_MS } from './CryptoPanel';

/**
 * Buying credits, in three steps: what to pay with, how much, then what for.
 *
 * Mounted only while it is open, which is why there is no `open` prop and no
 * reset action: closing it unmounts it, and the next purchase starts from a
 * fresh reducer rather than from whatever the last one left behind. A reset
 * somebody can forget to dispatch is a bug waiting for the second purchase.
 *
 * Three pieces of state that are NOT in the reducer, because they are
 * asynchronous rather than navigational:
 *
 *  - `priced` is the server's price for the summary. Read-only: it records
 *    nothing and calls no provider, so opening the summary costs nothing.
 *  - `order` is a real payment row and a live session at the provider, and it
 *    exists only once the buyer commits to paying with a NEW card - which is
 *    the one path that needs a client secret before it can show anything. A
 *    card already kept opens its own payment when its button is pressed.
 *  - `cards` is the list of saved cards, trimmed in place on a delete rather
 *    than refetched, so removing one cannot make the list flash.
 */
export default function BuyCreditsDialog({
  options,
  onClose,
}: {
  options: PaymentOptions;
  onClose: () => void;
}) {
  const router = useRouter();
  // The live theme, so Stripe's iframe follows a toggle made while this is
  // open - it cannot see the page's CSS and has to be told.
  const { theme } = useTheme();

  const [step, dispatch] = useReducer(wizardReducer, FIRST_STEP);
  const [priced, setPriced] = useState<{ key: string; state: Priced } | null>(null);
  const [order, setOrder] = useState<{ key: string; order: Order } | null>(null);
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [cardsLoaded, setCardsLoaded] = useState(false);
  const [saveCard, setSaveCard] = useState(false);
  /**
   * Whether the buyer wants the new-card form.
   *
   * `null` means they have not said, and the answer is then "yes, unless they
   * have a card to reuse" - a first purchase should not need a click to reach
   * the only way it can be paid. Held as three values rather than a boolean so
   * that the default can be derived while the card list is still loading,
   * instead of being set from an effect once it lands.
   */
  const [wantsNewCard, setWantsNewCard] = useState<boolean | null>(null);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<ChainInvoiceView | null>(null);
  const [error, setError] = useState('');

  const cardsAvailable = options.targets.some(
    (target) => target.method === 'card' && target.available
  );
  const showNewCardForm = wantsNewCard ?? (cardsLoaded ? cards.length === 0 : false);

  /* ------------------------------------------------------------- saved cards */

  useEffect(() => {
    if (!cardsAvailable) return;
    void (async () => {
      try {
        const result = await paymentsApi.cards();
        setCards(result.cards);
      } catch {
        // A card list that will not load must not stop somebody buying with a
        // new one, so this is swallowed rather than shown. The list is an
        // affordance; the form below it is the purchase.
      } finally {
        setCardsLoaded(true);
      }
    })();
  }, [cardsAvailable]);

  /* ------------------------------------------------------------- the price */

  const target = step.name === 'options' ? null : step.target;
  const summaryKey =
    step.name === 'summary' ? `${step.target.id}|${step.credits}` : null;

  useEffect(() => {
    if (step.name !== 'summary' || summaryKey === null) return;
    if (priced?.key === summaryKey) return;

    const { target: chosen, credits } = step;
    void (async () => {
      setPriced({ key: summaryKey, state: { status: 'loading' } });
      try {
        const quote = await paymentsApi.quote({
          method: chosen.method,
          credits,
          ...(chosen.asset ? { asset: chosen.asset } : {}),
        });
        setPriced({ key: summaryKey, state: { status: 'ready', quote } });
      } catch (err) {
        setPriced({
          key: summaryKey,
          state: {
            status: 'failed',
            message: err instanceof Error ? err.message : 'That amount could not be priced.',
          },
        });
      }
    })();
  }, [step, summaryKey, priced]);

  /* ---------------------------------------------------------- the checkout */

  /**
   * An order is opened for the card FORM and for crypto, and for nothing else.
   *
   * The save-the-card answer is part of the key because Stripe decides whether
   * to keep the card from `setup_future_usage` on the session, which is set
   * when the session is created - so changing the answer needs another one.
   * The abandoned session is harmless in the way abandoning any checkout here
   * is: nothing credits it and it expires at the provider.
   */
  const needsOrder =
    step.name === 'summary' && (step.target.method === 'crypto' || showNewCardForm);
  const orderKey =
    step.name === 'summary' && needsOrder
      ? `${step.target.id}|${step.credits}|${saveCard ? 'save' : 'guest'}`
      : null;

  /*
   * A token, so a slow answer cannot land on a newer order.
   *
   * Flipping the save toggle twice quickly starts two checkouts; without this
   * the first one's response can arrive last and put a stale reference and a
   * stale client secret on screen - a form that charges to an order the buyer
   * is no longer looking at.
   */
  const startToken = useRef(0);

  useEffect(() => {
    if (step.name !== 'summary' || orderKey === null) return;
    // Already open, or already being opened, for exactly these terms.
    if (order?.key === orderKey) return;

    const { target: chosen, credits } = step;
    void (async () => {
      const token = ++startToken.current;
      setOrder({ key: orderKey, order: { status: 'starting' } });
      try {
        const started = await paymentsApi.checkout({
          method: chosen.method,
          credits,
          ...(chosen.asset ? { asset: chosen.asset } : {}),
          ...(chosen.method === 'card' && saveCard ? { saveCard: true } : {}),
        });
        if (token !== startToken.current) return;
        setOrder({ key: orderKey, order: { status: 'ready', started } });
        setInvoice(started.invoice ?? null);
      } catch (err) {
        if (token !== startToken.current) return;
        setOrder({
          key: orderKey,
          order: {
            status: 'failed',
            message: err instanceof Error ? err.message : 'Could not start that payment.',
          },
        });
      }
    })();
  }, [step, orderKey, order, saveCard]);

  /*
   * While a chain payment is open, the INVOICE is what changes.
   *
   * The payment itself moves once, at the very end, so a page watching only
   * the payment shows nothing at all for the several minutes a chain takes.
   * The invoice goes waiting -> seen -> credited, with a confirmation count in
   * between, and that is what somebody staring at the screen needs to see.
   *
   * Stops as soon as there is nothing left to wait for, so a finished order
   * does not keep a timer alive behind a dialog nobody has closed.
   */
  const paymentId = order?.order.status === 'ready' ? order.order.started.paymentId : null;
  const watching = invoice !== null && (invoice.state === 'waiting' || invoice.state === 'seen');

  useEffect(() => {
    if (!paymentId || !watching) return;

    let live = true;
    const poll = async () => {
      try {
        const result = await paymentsApi.get(paymentId);
        if (live && result.invoice) setInvoice(result.invoice);
      } catch {
        // A poll that fails changes nothing on screen and is tried again. The
        // buyer's money is on the chain either way.
      }
    };

    const timer = setInterval(() => void poll(), CHAIN_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [paymentId, watching]);

  /** Drop the order and the price so both are asked for again. */
  const retry = useCallback(() => {
    setOrder(null);
    setPriced(null);
    setInvoice(null);
    setError('');
  }, []);

  /* ------------------------------------------------------- a card on file */

  const payWithCard = async (cardId: string) => {
    if (step.name !== 'summary') return;
    setBusyCardId(cardId);
    setError('');
    try {
      const started = await paymentsApi.checkout({
        method: 'card',
        credits: step.credits,
        cardId,
      });

      if (started.clientSecret) {
        /*
         * The bank demanded authentication even for a card on file.
         *
         * This secret is a PAYMENT INTENT's, not a checkout session's, so it
         * is `handleNextAction` that finishes it - handing it to the Payment
         * Element instead would fail, because the two are different id spaces
         * with the same shape of name.
         */
        const stripe = await stripeFor(options.publishableKey);
        if (!stripe) throw new Error('Stripe could not be loaded to authorise this payment.');
        const result = await stripe.handleNextAction({ clientSecret: started.clientSecret });
        if (result.error) {
          throw new Error(result.error.message || 'Your bank did not authorise this payment.');
        }
      }

      /*
       * To the page that waits for the webhook, which is the only thing that
       * decides a payment either way. `busyCardId` is deliberately NOT cleared
       * on this path: the browser is navigating, and a button that springs
       * back to life mid-navigation invites a second charge.
       */
      router.push(`/credits/return?payment=${encodeURIComponent(started.paymentId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That card could not be charged.');
      setBusyCardId(null);
    }
  };

  const deleteCard = async (cardId: string) => {
    const card = cards.find((entry) => entry.id === cardId);
    if (!card) return;
    if (!window.confirm(`Remove the card ending in ${card.last4}?`)) return;

    setBusyCardId(cardId);
    setError('');
    try {
      await paymentsApi.deleteCard(cardId);
      setCards((current) => current.filter((entry) => entry.id !== cardId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That card could not be removed.');
    } finally {
      setBusyCardId(null);
    }
  };

  /* -------------------------------------------------------------- rendering */

  const title =
    step.name === 'options'
      ? 'Payment options'
      : step.name === 'amount'
        ? 'Credits amount'
        : 'Order summary';

  const subtitle =
    step.name === 'options'
      ? 'Choose how you would like to pay.'
      : step.name === 'amount'
        ? `Paying with ${step.target.label.toLowerCase()}.`
        : 'Check the order, then pay.';

  const footer =
    step.name === 'options' ? (
      <button type="button" onClick={onClose} className={QUIET}>
        Close
      </button>
    ) : (
      <>
        <button type="button" onClick={() => dispatch({ type: 'back' })} className={QUIET}>
          Back
        </button>
        {step.name === 'amount' ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'forward' })}
            className={PRIMARY}
          >
            {/*
              The CLAMPED count, which is what the next step will charge. The
              box on this step stays unclamped while it is being typed, so the
              two can differ for a moment - and a button quoting the unclamped
              figure would be the page inventing a price.
            */}
            Continue &mdash;{' '}
            {formatAmount(
              Math.min(Math.max(step.credits, step.target.minCredits), step.target.maxCredits) *
                options.unitPriceCents,
              options.currency
            )}
          </button>
        ) : (
          <button type="button" onClick={onClose} className={QUIET}>
            Close
          </button>
        )}
      </>
    );

  return (
    <PayDialog
      // Always open: this component is mounted only while it should be.
      open
      title={title}
      subtitle={subtitle}
      width={step.name === 'summary' ? 'wide' : 'md'}
      footer={footer}
      onClose={onClose}
    >
      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {step.name === 'options' && (
        <PaymentOptionsStep
          targets={options.targets}
          currency={options.currency}
          onChoose={(chosen) => dispatch({ type: 'choose', target: chosen })}
        />
      )}

      {step.name === 'amount' && (
        <AmountStep
          target={step.target}
          credits={step.credits}
          unitPriceCents={options.unitPriceCents}
          currency={options.currency}
          onCredits={(credits) => dispatch({ type: 'credits', credits })}
        />
      )}

      {step.name === 'summary' && target && (
        <OrderSummaryStep
          target={target}
          credits={step.credits}
          unitPriceCents={options.unitPriceCents}
          currency={options.currency}
          /*
           * Keyed, so a stale answer is never shown against a new amount.
           *
           * Both of these are set from an effect that runs AFTER the render in
           * which the step changed, so without the key check that one render
           * prints the previous order's reference and total beside the new
           * amount - briefly, and wrongly.
           */
          priced={priced?.key === summaryKey ? priced.state : { status: 'loading' }}
          order={
            orderKey !== null && order?.key === orderKey ? order.order : { status: 'none' }
          }
          cards={cards}
          showNewCardForm={showNewCardForm}
          onUseNewCard={() => setWantsNewCard(true)}
          onUseSavedCards={() => setWantsNewCard(false)}
          publishableKey={options.publishableKey}
          requireThreeDSecure={options.requireThreeDSecure}
          dark={theme === 'dark'}
          saveCard={saveCard}
          onSaveCard={setSaveCard}
          busyCardId={busyCardId}
          invoice={invoice}
          onPayWithCard={(cardId) => void payWithCard(cardId)}
          onDeleteCard={(cardId) => void deleteCard(cardId)}
          onBack={() => dispatch({ type: 'back' })}
          onRetry={retry}
        />
      )}
    </PayDialog>
  );
}
