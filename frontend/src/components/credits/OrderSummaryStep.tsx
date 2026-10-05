'use client';

import { MarkCardTrio, MarkCoinTrio } from '@/components/icons/marks';
import CardPanel from './CardPanel';
import CryptoPanel from './CryptoPanel';
import PolicyPanels from './PolicyPanels';
import { LABEL, PANEL } from './chrome';
import type { Order, Priced } from './order';
import { formatMoney } from '@/lib/format';
import type { PaymentTarget, SavedCard } from '@/lib/payments';

/**
 * Step 3: exactly what is being bought, beside how to pay for it.
 *
 * Two columns, following `ResumePreview.tsx` - the app's existing wide modal
 * body - and they stack on a phone with the summary first, because the summary
 * is what somebody checks before they reach for a card.
 *
 * **Every number in the left column comes from the server**: the order it
 * recorded, or until there is one its quote. Not one of them is worked out
 * here. A credit is a dollar and nothing is taken out, so the charge and the
 * credit are the same figure - and the summary still prints both from the
 * server's answer, because an amount the server refuses (a bound moved while
 * this dialog was open) must not be shown as bought. Until that answer is
 * back, the table says so rather than filling itself in with a guess.
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
  amountMilli,
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
  /** What was ASKED for, in thousandths of a dollar. The quote says what is charged and credited. */
  amountMilli: number;
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
   * They are the same pricing on the same settings, so they agree - but once
   * a payment row exists its recorded figures are what will actually be
   * charged, and those are the ones to print. Neither is computed here.
   */
  const money = started ?? (priced.status === 'ready' ? priced.quote : null);

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

          {/* `border-t-[1px]`: the bare `border-t` is one the dark-mode shim recolours. */}
          <div className="mt-3 border-t-[1px] border-[color:var(--line-subtle)] pt-1">
            <Row
              label="Order"
              // Allocated when a payment row is created, which for a card the
              // buyer already has is the moment they press Pay now - so before
              // then there is honestly no reference to print.
              value={started ? started.reference : 'Assigned when you pay'}
            />
            <div className="border-t-[1px] border-[color:var(--line-subtle)]" />
            <Row
              label={`${formatMoney(amountMilli)} of credit`}
              hint="A credit is a dollar"
              value={money ? formatMoney(money.amountMilli) : pending}
            />
            <div className="border-t-[1px] border-[color:var(--line-subtle)]" />
            <Row
              label="Total to pay"
              strong
              value={money ? formatMoney(money.amountMilli) : pending}
            />
            <Row
              label="Credit added"
              strong
              hint="All of it: nothing is taken out"
              value={money ? formatMoney(money.creditMilli) : pending}
            />
          </div>
        </div>

        {priced.status === 'failed' && (
          <div className="tl-notice" data-tone="error">
            <p className="font-semibold">This amount cannot be bought.</p>
            <p className="mt-1 text-xs">{priced.message}</p>
            <button type="button" onClick={onBack} className="mt-2 text-xs font-semibold underline">
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
