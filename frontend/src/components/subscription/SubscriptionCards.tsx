'use client';

import { ContactAdminLink } from '@/components/contact/ContactAdminDialog';
import { IconCheck } from '@/components/icons';
import type { SubscriptionTierView, SubscriptionView } from '@/lib/subscriptionBilling';
import { cardAction, priceText, type CardAction } from '@/lib/subscriptionDisplay';
import css from './subscription.module.css';

/**
 * Every subscription as a card, side by side, the way Claude's and ChatGPT's
 * upgrade pages lay theirs out: the name (and Current), the price for 30
 * days, what it is for, the one thing to do - Subscribe, Upgrade for the
 * amount it takes now, Switch at renewal, Keep - or the words where there is
 * nothing to press, and what it includes. Four across, two, or one, by the
 * width the cards have - never three and one (subscription.module.css).
 *
 * Every offer and amount is the server's (`GET /api/subscription`); the words
 * are lib/subscriptionDisplay.ts's. A press goes to the page (`onAction`),
 * which asks first (components/SpendConfirm.tsx) and then sends it.
 */
export default function SubscriptionCards({
  view,
  busy,
  onAction,
}: {
  view: SubscriptionView;
  /** A change is on its way: every button waits. */
  busy: boolean;
  onAction: (tier: SubscriptionTierView, action: Exclude<CardAction, { kind: 'state' }>) => void;
}) {
  return (
    <div className={css.cardsBox}>
      <ul className={css.cards} aria-label="Subscriptions">
        {view.tiers.map((tier) => {
          const action = cardAction(tier, view);
          const current = tier.offer === 'current';
          const priced = tier.priceMilli !== null && tier.priceMilli > 0;
          return (
            <li
              key={tier.id}
              className={css.card}
              data-current={current}
              data-subscription-card={tier.id}
              aria-current={current ? 'true' : undefined}
            >
              <div className={css.cardHead}>
                <h3 className={css.cardName}>{tier.label}</h3>
                {current && <span className={css.badge}>Current</span>}
              </div>

              <p className={css.price}>
                <span className={css.priceFigure}>{priceText(tier)}</span>
                {priced && <span className={css.pricePeriod}>/ {view.periodDays} days</span>}
              </p>

              <p className={css.summary}>{tier.summary}</p>

              <div className={css.action}>
                {action.kind === 'state' ? (
                  tier.offer === 'not-offered' ? (
                    <p className="text-sm text-muted">
                      Not offered on this installation. Ask your administrator if you need it. <ContactAdminLink />
                    </p>
                  ) : (
                    action.text && <p className={css.actionState}>{action.text}</p>
                  )
                ) : (
                  <>
                    <button
                      type="button"
                      className={action.kind === 'buy' ? 'tl-button' : 'tl-button-quiet'}
                      disabled={busy}
                      onClick={() => onAction(tier, action)}
                    >
                      {action.label}
                    </button>
                    {action.kind === 'buy' && action.prorationNote && (
                      <p className={css.actionNote}>{action.prorationNote}</p>
                    )}
                  </>
                )}
              </div>

              <ul className={css.features} aria-label={`${tier.label} includes`}>
                {tier.features.map((feature) => (
                  <li key={feature}>
                    <IconCheck className="h-4 w-4" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
