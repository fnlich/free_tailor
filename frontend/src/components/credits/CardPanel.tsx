'use client';

import { IconTrash } from '@/components/icons';
import { MarkCardBrand } from '@/components/icons/marks';
import PayForm from './PayForm';
import { CHOICE, LABEL, PANEL, PRIMARY, QUIET } from './chrome';
import type { Order } from './order';
import { describeCard, formatAmount, type SavedCard } from '@/lib/payments';

/**
 * Step 3, card column: the form, and any card this account has kept.
 *
 * Two things here are less obvious than they look.
 *
 * **The form is mounted on request, not on arrival.** The Payment Element
 * cannot mount without a client secret, a client secret needs a checkout
 * session, and a checkout session is a payment row plus a live session at the
 * provider. Opening one the moment this screen appears meant a buyer paying
 * with a card they had already saved left an abandoned `pending` row in their
 * own payment history for having looked, and spent two of the twenty checkouts
 * an account may open in an hour on a single purchase. So a buyer with a card
 * on file sees their cards and a button; the form arrives when they ask for it.
 *
 * **Flipping the save toggle starts a new checkout.** Whether Stripe keeps the
 * card is decided by `setup_future_usage` on the session, which is set when the
 * session is created - so the toggle cannot be read at confirm time and has to
 * be known when the session is asked for. The abandoned session is harmless in
 * exactly the way abandoning any checkout here is: nothing credits it, and it
 * expires at the provider. The toggle is disabled while that is in flight, so
 * one flip costs one round trip and a fast double-click cannot cost two.
 */
export default function CardPanel({
  order,
  cards,
  showNewCardForm,
  onUseNewCard,
  onUseSavedCards,
  publishableKey,
  dark,
  saveCard,
  onSaveCard,
  busyCardId,
  onPayWithCard,
  onDeleteCard,
  onCancel,
  onRetry,
}: {
  order: Order;
  cards: SavedCard[];
  /** Whether the new-card form is wanted. See the note above. */
  showNewCardForm: boolean;
  onUseNewCard: () => void;
  onUseSavedCards: () => void;
  publishableKey: string;
  dark: boolean;
  saveCard: boolean;
  onSaveCard: (save: boolean) => void;
  /** The card currently being charged or removed, so its row can say so. */
  busyCardId: string | null;
  onPayWithCard: (cardId: string) => void;
  onDeleteCard: (cardId: string) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const starting = order.status === 'starting';

  return (
    <div className="space-y-4">
      {cards.length > 0 && (
        <section>
          <h3 className={LABEL}>Cards you have saved</h3>
          <div className="mt-2 space-y-2">
            {cards.map((card) => (
              <div key={card.id} className={`${CHOICE} flex items-center gap-3`}>
                <MarkCardBrand brand={card.brand} className="h-5 w-8 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {describeCard(card)}
                  </span>
                  <span className="block text-xs text-subtle">
                    Expires {String(card.expMonth).padStart(2, '0')}/{card.expYear}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onPayWithCard(card.id)}
                  disabled={busyCardId !== null}
                  className={`${PRIMARY} px-3 py-1.5`}
                >
                  {busyCardId === card.id ? 'Charging…' : 'Pay now'}
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${describeCard(card)}`}
                  onClick={() => onDeleteCard(card.id)}
                  disabled={busyCardId !== null}
                  className="tl-icon-button shrink-0 disabled:opacity-40"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-subtle">
            Removing a card here also removes it at the payment provider. Payments already made
            with it are not affected.
          </p>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className={LABEL}>{cards.length > 0 ? 'Or use a new card' : 'Card details'}</h3>
          {showNewCardForm && cards.length > 0 && (
            <button
              type="button"
              onClick={onUseSavedCards}
              className="text-xs font-medium text-accent underline"
            >
              Use a saved card instead
            </button>
          )}
        </div>

        {!showNewCardForm ? (
          <button type="button" onClick={onUseNewCard} className={`${QUIET} mt-2`}>
            Enter a new card
          </button>
        ) : (
          <>
            <label className="mt-2 flex items-start gap-2.5 text-sm text-muted">
              <input
                type="checkbox"
                checked={saveCard}
                disabled={starting}
                onChange={(event) => onSaveCard(event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Save this card for future purchases.
                <span className="block text-xs text-subtle">
                  Only the brand, the last four digits and the expiry are kept here. The card
                  itself stays with the payment provider.
                </span>
              </span>
            </label>

            <div className="mt-3">
              {(order.status === 'none' || order.status === 'starting') && (
                <div className={PANEL}>
                  <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-blue-600" />
                  <p className="mt-3 text-center text-sm text-muted">Preparing your order…</p>
                </div>
              )}

              {order.status === 'failed' && (
                <div className={PANEL}>
                  <p className="text-sm font-semibold text-ink">
                    This order could not be started.
                  </p>
                  <p className="mt-1 text-sm text-muted">{order.message}</p>
                  <p className="mt-1 text-xs text-subtle">Nothing was charged.</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={onRetry} className={`${PRIMARY} px-4 py-2`}>
                      Try again
                    </button>
                    <button type="button" onClick={onCancel} className={`${QUIET} px-4 py-2`}>
                      Change the amount
                    </button>
                  </div>
                </div>
              )}

              {order.status === 'ready' && order.started.processing && (
                <div className={PANEL}>
                  <p className="text-sm font-semibold text-ink">Your card is being charged.</p>
                  <p className="mt-1 text-sm text-muted">
                    Nothing more to do here. Your credits arrive as soon as the provider confirms
                    it, usually within a minute.
                  </p>
                </div>
              )}

              {order.status === 'ready' && order.started.clientSecret && (
                <PayForm
                  publishableKey={publishableKey}
                  clientSecret={order.started.clientSecret}
                  credits={order.started.credits}
                  amountCents={order.started.amountCents}
                  currency={order.started.currency}
                  dark={dark}
                  onCancel={onCancel}
                />
              )}

              {order.status === 'ready' &&
                !order.started.clientSecret &&
                !order.started.processing &&
                !order.started.redirectUrl && (
                  <div className={PANEL}>
                    <p className="text-sm font-semibold text-ink">
                      This order was recorded but no payment form came back.
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      Nothing was charged. Order{' '}
                      <span className="font-mono">{order.started.reference}</span> for{' '}
                      {formatAmount(order.started.amountCents, order.started.currency)} is left
                      unpaid and will expire on its own.
                    </p>
                    <button type="button" onClick={onRetry} className={`${PRIMARY} mt-3 px-4 py-2`}>
                      Try again
                    </button>
                  </div>
                )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
