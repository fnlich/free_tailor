'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { useSpendConfirm } from '@/components/SpendConfirm';
import { ErrorNotice, Field, Notice, Section, SettingsPage, StaticValue } from '@/components/settings/SettingsParts';
import SubscriptionCards from '@/components/subscription/SubscriptionCards';
import SubscriptionStatus from '@/components/subscription/SubscriptionStatus';
import Dialog from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { ApiResponseError, isInsufficientCredits } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import {
  subscriptionApi,
  type SubscriptionChange,
  type SubscriptionTierView,
  type SubscriptionView,
} from '@/lib/subscriptionBilling';
import {
  buyQuestion,
  cancelQuestion,
  changeMessage,
  dayText,
  statusSummary,
  type CardAction,
  type SubscriptionChangeKind,
} from '@/lib/subscriptionDisplay';

/**
 * Where a change was asked for: a card, or the "Current subscription" block
 * (Cancel, Keep). What it did is said there, and brought into view.
 */
type ChangeFrom = 'cards' | 'status';

/**
 * Settings > Subscription: the account buys its own subscription here, from
 * its credit balance, 30 days at a time (services/subscriptions on the
 * server). Cards side by side, as Claude's and ChatGPT's pages have them -
 * Subscribe, Upgrade for what it takes now, Switch at renewal, Keep - then
 * the subscription the account is on, with Cancel, and the balance it is
 * paid from.
 *
 * Every amount and offer is the server's (`GET /api/subscription`). Buying,
 * switching and keeping ask first (components/SpendConfirm.tsx, kind
 * `subscription`, with "Do not show again") - a purchase the unused days
 * cover too, which takes nothing now but starts 30 days that renew
 * (`buyQuestion`); a purchase sends back the amount shown, and one the server
 * works out differently since - a new price, a day gone by - is refused (409
 * `charge-changed`), the page reads the subscription again and says so:
 * nobody is charged an amount they did not see. Cancel asks in a dialog of its
 * own: it spends nothing.
 *
 * What a change did, or why it was refused, is said in the section it was
 * asked from - a card's above the cards, Cancel's and Keep's under them - and
 * scrolled to and focused once it is known: on a phone the four cards stand
 * between the two, and the button pressed may be gone by then.
 *
 * An administrator is never charged, so the page is read-only for them.
 */
export default function SubscriptionSettingsPage() {
  const { account, refresh } = useAuth();
  const spend = useSpendConfirm();
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState('');
  /** The price or the days left moved between showing an amount and confirming it. */
  const [repriced, setRepriced] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resultFrom, setResultFrom] = useState<ChangeFrom>('cards');
  /** Bumped when a change has been answered, to bring what it did into view. */
  const [answered, setAnswered] = useState(0);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await subscriptionApi.get());
      setLoadError(null);
    } catch (err) {
      setLoadError(err ?? 'Could not load your subscription.');
    }
  }, []);

  useEffect(() => {
    void load();
    // The profile count is stale the moment somebody adds one on another
    // page, and this is where it is read most carefully.
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (answered === 0) return;
    const block = resultRef.current;
    if (!block) return;
    block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    block.focus({ preventScroll: true });
  }, [answered]);

  /** Sends a change, and shows the subscription as it stands after it. */
  const send = async (
    kind: SubscriptionChangeKind,
    from: ChangeFrom,
    request: () => Promise<SubscriptionChange>
  ) => {
    setBusy(true);
    setError(null);
    setSuccess('');
    setRepriced(false);
    setResultFrom(from);
    try {
      const result = await request();
      setView(result);
      setSuccess(changeMessage(kind, result));
      // The top bar's balance, and the tier every other page reads.
      void refresh();
    } catch (err) {
      if (err instanceof ApiResponseError && err.code === 'charge-changed') {
        setRepriced(true);
        await load();
      } else {
        setError(err ?? 'Could not change your subscription.');
        // The balance or the subscription may have moved under the page.
        void load();
      }
    } finally {
      setBusy(false);
      setAnswered((count) => count + 1);
    }
  };

  const onCardAction = (tier: SubscriptionTierView, action: Exclude<CardAction, { kind: 'state' }>) => {
    if (!view) return;
    const current = view.tiers.find((entry) => entry.offer === 'current');
    if (action.kind === 'buy') {
      void spend.ask(
        { kind: 'subscription', title: action.title, price: async () => buyQuestion(tier, action, view, Date.now()) },
        () => void send('subscribe', 'cards', () => subscriptionApi.subscribe(tier.id, action.chargeMilli))
      );
      return;
    }
    if (action.kind === 'switch') {
      void spend.ask(
        {
          kind: 'subscription',
          title: action.title,
          price: async () => ({
            estimate: { costMilli: action.priceMilli, balanceMilli: view.balanceMilli, exempt: false, chargedOn: action.on },
            what: tier.label,
            detail: `You keep ${current?.label ?? 'your subscription'} until ${dayText(action.on)}; then ${tier.label} starts, and so do its limits. Keep undoes it until then.`,
          }),
        },
        () => void send('downgrade', 'cards', () => subscriptionApi.downgrade(tier.id))
      );
      return;
    }
    keepCurrent(action, 'cards');
  };

  const keepCurrent = (action: Extract<CardAction, { kind: 'keep' }>, from: ChangeFrom) => {
    if (!view) return;
    void spend.ask(
      {
        kind: 'subscription',
        title: action.title,
        price: async () => ({
          estimate: { costMilli: action.priceMilli, balanceMilli: view.balanceMilli, exempt: false, chargedOn: action.on },
          what: statusSummary(view).headline,
          detail: 'It renews as it is, and any switch or cancel you chose is undone.',
        }),
      },
      () => void send('resume', from, () => subscriptionApi.resume())
    );
  };

  if (!account) return null;

  if (!view) {
    return (
      <SettingsPage>
        <Section title="Subscription">
          {loadError ? (
            <ErrorNotice error={loadError} fallback="Could not load your subscription">
              <button type="button" onClick={() => void load()} className="tl-button-quiet mt-4">
                Try again
              </button>
            </ErrorNotice>
          ) : (
            <Spinner label="Loading your subscription..." />
          )}
        </Section>
      </SettingsPage>
    );
  }

  const summary = statusSummary(view);
  const exempt = view.source === 'exempt';

  /** What the last change did, or why it was refused - drawn in the section it was asked from. */
  const result =
    success || error || repriced ? (
      <div ref={resultRef} tabIndex={-1} className="space-y-3 outline-none" data-subscription-result={resultFrom}>
        {success && (
          <Notice tone="success" role="status">
            {success}
          </Notice>
        )}
        {repriced && (
          <Notice tone="warn" role="alert">
            The price changed since this page showed it, so nothing was taken. Check the new amount and confirm
            again.
          </Notice>
        )}
        <ErrorNotice error={error} onDismiss={() => setError(null)}>
          {isInsufficientCredits(error) && (
            <p className="mt-2">
              <Link href="/credits" className="font-semibold underline underline-offset-2">
                Buy credits
              </Link>
            </p>
          )}
        </ErrorNotice>
      </div>
    ) : null;

  return (
    <SettingsPage>
      <Section
        title="Choose a subscription"
        description={
          exempt
            ? "Administrators have every subscription's features and are never charged, so there is nothing to buy here."
            : 'Every subscription is paid from your credit balance, 30 days at a time. Move up any time; moving down takes effect at renewal.'
        }
      >
        {resultFrom === 'cards' && result}
        {summary.warning && (
          <Notice tone="warn">
            {summary.warning.sentence}{' '}
            <Link href="/credits" className="font-semibold underline underline-offset-2">
              Buy credits
            </Link>
          </Notice>
        )}
        <SubscriptionCards view={view} busy={busy || spend.pending} onAction={onCardAction} />
      </Section>

      <Section title="Current subscription" description="What your account is on, where it came from, and when it renews.">
        <SubscriptionStatus
          view={view}
          account={account}
          busy={busy || spend.pending}
          onCancel={() => setCancelling(true)}
          onKeep={(action) => keepCurrent(action, 'status')}
        />
        {resultFrom === 'status' && result}
      </Section>

      <Section
        title="Credits"
        description={
          exempt
            ? 'Administrators are never charged, for a subscription or for a resume, so nothing is taken from this balance.'
            : 'Your subscription is paid from this balance, and so is every resume - each at the price of the build mode you choose. Every charge is a row in Credit History.'
        }
      >
        <Field label="Balance">
          <StaticValue>{formatMoney(view.balanceMilli)}</StaticValue>
        </Field>
        <div>
          <Link href="/credits" className="tl-button-quiet">
            Go to Credits
          </Link>
          <p className="mt-2 text-sm text-subtle">Buying more, and every purchase and spend, are on the Credits page.</p>
        </div>
      </Section>

      <Dialog
        open={cancelling}
        title={`Cancel ${summary.headline}?`}
        onClose={() => setCancelling(false)}
        footer={
          <>
            <button type="button" onClick={() => setCancelling(false)} className="tl-button-quiet">
              Keep it
            </button>
            <button
              type="button"
              className="tl-button"
              data-tone="danger"
              disabled={busy}
              onClick={() => {
                setCancelling(false);
                void send('cancel', 'status', () => subscriptionApi.cancel());
              }}
            >
              Cancel subscription
            </button>
          </>
        }
      >
        <p className="text-base text-ink">{cancelQuestion(view)}</p>
      </Dialog>

      {spend.dialog}
    </SettingsPage>
  );
}
