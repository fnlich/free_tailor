'use client';

import { MarkCardTrio, MarkCoinTrio } from '@/components/icons/marks';
import CardPanel from './CardPanel';
import CryptoPanel from './CryptoPanel';
import PolicyPanels from './PolicyPanels';
import { LABEL, PANEL } from './chrome';
import type { Order, Priced } from './order';
import {
  formatAmount,
  type PaymentTarget,
  type SavedCard,
} from '@/lib/payments';

/**
 * Step 3: exactly what is being bought, beside how to pay for it.
 *
 * Two columns, following `ResumePreview.tsx` - the app's existing wide modal
 * body - and they stack on a phone with the summary first, because the summary
 * is what somebody checks before they reach for a card.
 *
 * **Every number in the left column comes from the order the server recorded.**
 * Not one of them is worked out here. That is not fastidiousness: the fee and
 * the granted credit count are derived from settings that an administrator can
 * change while this dialog is open, and a browser recomputing them would show
 * a figure that disagrees with the charge. Until the order is back, the table
 * says so rather than filling itself in with a guess.
 */

function Row({
  label,
  value,
  strong,
  hint,
}: {
  label: string;
  value: string;
  strong?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <div className="min-w-0">
        <span className={`text-sm ${strong ? 'font-semibold text-ink' : 'text-muted'}`}>
          {label}
        </span>
        {hint && <span className="block text-xs text-subtle">{hint}</span>}
      </div>
      <span
        className={`shrink-0 tabular-nums ${
          strong ? 'text-base font-semibold text-ink' : 'text-sm text-ink'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function Mark({ target }: { target: PaymentTarget }) {
  // Two marks, because there are two buttons. There was a per-coin one until
  // the on-chain path went: the coin is chosen on the provider's page now, and
  // the trio is the honest picture of "some cryptocurrency, decided later".
  return target.mark === 'card' ? <MarkCardTrio /> : <MarkCoinTrio />;
}

export default function OrderSummaryStep({
  target,
  credits,
  unitPriceCents,
  currency,
  priced,
  order,
  cards,
  showNewCardForm,
  onUseNewCard,
  onUseSavedCards,
  publishableKey,
  requireThreeDSecure,
  dark,
  saveCard,
  onSaveCard,
  busyCardId,
  onPayWithCard,
  onDeleteCard,
  onBack,
  onRetry,
}: {
  target: PaymentTarget;
  /** What was ASKED for. The quote says what is actually granted. */
  credits: number;
  unitPriceCents: number;
  currency: string;
  priced: Priced;
  order: Order;
  cards: SavedCard[];
  showNewCardForm: boolean;
  onUseNewCard: () => void;
  onUseSavedCards: () => void;
  publishableKey: string;
  requireThreeDSecure: boolean;
  dark: boolean;
  saveCard: boolean;
  onSaveCard: (save: boolean) => void;
  busyCardId: string | null;
  onPayWithCard: (cardId: string) => void;
  onDeleteCard: (cardId: string) => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  const started = order.status === 'ready' ? order.started : null;
  const pending = '—';

  /*
   * The ORDER'S figures when there is one, the quote's otherwise.
   *
   * They are the same arithmetic on the same settings, so they agree - but
   * once a payment row exists its recorded figures are what will actually be
   * charged, and those are the ones to print. Neither is computed here.
   */
  const money = started ?? (priced.status === 'ready' ? priced.quote : null);

  /*
   * The fee is INSIDE the amount charged, not added to it.
   *
   * `applyFee` takes the fee out of what the buyer pays and grants the credits
   * the remainder buys, so the total is unchanged and the count goes down.
   * Presenting it the other way round - a total plus a fee - would state a
   * figure nobody is charged. Hence a fee row that is informational and a
   * separate line for what the account actually receives.
   */
  const fee = money?.feeCents ?? 0;
  const granted = money?.credits ?? null;
  const shortfall = granted !== null && granted < credits ? credits - granted : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <div className={PANEL}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={LABEL}>Paying with</div>
              <div className="mt-1 text-sm font-semibold text-ink">{target.label}</div>
            </div>
            <Mark target={target} />
          </div>

          <div className="mt-3 border-t border-line pt-1">
            <Row
              label="Order"
              // Allocated when a payment row is created, which for a card the
              // buyer already has is the moment they press Pay now - so before
              // then there is honestly no reference to print.
              value={started ? started.reference : 'Assigned when you pay'}
            />
            <div className="border-t border-line" />
            <Row
              label={`${credits} ${credits === 1 ? 'credit' : 'credits'}`}
              hint={`${formatAmount(unitPriceCents, currency)} each`}
              value={money ? formatAmount(money.amountCents, money.currency) : pending}
            />
            {fee > 0 && (
              <Row
                label="Processing fee"
                hint="Taken out of the amount above, not added to it"
                value={formatAmount(fee, money?.currency ?? currency)}
              />
            )}
            <div className="border-t border-line" />
            <Row
              label="Total to pay"
              strong
              value={money ? formatAmount(money.amountCents, money.currency) : pending}
            />
            <Row
              label="Credits added"
              strong
              hint={
                shortfall > 0
                  ? `${shortfall} fewer than asked for, because of the fee above`
                  : undefined
              }
              value={granted === null ? pending : String(granted)}
            />
          </div>
        </div>

        {priced.status === 'failed' && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-semibold text-red-700">This amount cannot be bought.</p>
            <p className="mt-1 text-xs text-red-700">{priced.message}</p>
            <button
              type="button"
              onClick={onBack}
              className="mt-2 text-xs font-semibold text-red-700 underline"
            >
              Choose a different amount
            </button>
          </div>
        )}

        <PolicyPanels method={target.method} />
      </div>

      <div>
        {target.method === 'card' ? (
          <CardPanel
            order={order}
            cards={cards}
            showNewCardForm={showNewCardForm}
            onUseNewCard={onUseNewCard}
            onUseSavedCards={onUseSavedCards}
            publishableKey={publishableKey}
            requireThreeDSecure={requireThreeDSecure}
            dark={dark}
            saveCard={saveCard}
            onSaveCard={onSaveCard}
            busyCardId={busyCardId}
            onPayWithCard={onPayWithCard}
            onDeleteCard={onDeleteCard}
            onCancel={onBack}
            onRetry={onRetry}
          />
        ) : (
          <CryptoPanel order={order} target={target} onCancel={onBack} onRetry={onRetry} />
        )}
      </div>
    </div>
  );
}
