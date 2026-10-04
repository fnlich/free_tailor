'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { MarkCardBrand } from '@/components/icons/marks';
import { Notice, Section, SettingsPage, Status } from '@/components/settings/SettingsParts';
import { formatDate } from '@/lib/format';
import { describeCard, paymentsApi, type SavedCard } from '@/lib/payments';

type CardsState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; cards: SavedCard[] };

/**
 * Past its expiry month. A card is good through the END of the month printed
 * on it, so March 2026 is still valid on the 31st and expired on April 1st.
 */
function hasExpired(card: SavedCard, now = new Date()): boolean {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return card.expYear < year || (card.expYear === year && card.expMonth < month);
}

/**
 * Settings > Payment Methods: the cards this account has kept, and removing
 * them.
 *
 * Nothing is added here. A card is kept by ticking "save this card" while
 * paying on /credits - Stripe decides whether it may be reused when the
 * checkout is opened, so there is no standalone "add a card" this page could
 * honestly offer.
 */
export default function PaymentMethodsSettingsPage() {
  const [state, setState] = useState<CardsState>({ status: 'loading' });
  /** The card whose row is asking "are you sure". One at a time. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** The card being removed right now; every Remove waits while it is. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<{ id: string; message: string } | null>(null);

  // Starts from 'loading' already, so the first call sets nothing before it
  // awaits; a retry says 'loading' itself before calling it again.
  const load = useCallback(async () => {
    try {
      const result = await paymentsApi.cards();
      setState({ status: 'ready', cards: result.cards });
    } catch (caught) {
      setState({
        status: 'failed',
        message: caught instanceof Error ? caught.message : 'Your saved cards could not be loaded.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = () => {
    setState({ status: 'loading' });
    void load();
  };

  const remove = async (card: SavedCard) => {
    setBusyId(card.id);
    setRemoveError(null);
    try {
      await paymentsApi.deleteCard(card.id);
      // Trimmed in place rather than refetched, the same as the purchase
      // dialog does, so removing one cannot make the list flash.
      setState((current) =>
        current.status === 'ready'
          ? { ...current, cards: current.cards.filter((entry) => entry.id !== card.id) }
          : current
      );
      setConfirmingId(null);
    } catch (caught) {
      // The row stays open on its question, so trying again is one press.
      setRemoveError({
        id: card.id,
        message: caught instanceof Error ? caught.message : 'That card could not be removed.',
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsPage>
      <Section
        title="Saved Payment Methods"
        description="Cards kept for one-tap purchases. Remove one to stop it being offered."
      >
        {state.status === 'loading' && (
          <p className="text-sm text-muted" role="status">
            Loading your saved cards...
          </p>
        )}

        {state.status === 'failed' && (
          <Notice tone="error" role="alert">
            <p>{state.message}</p>
            <button type="button" onClick={retry} className="tl-button-quiet mt-3">
              Try again
            </button>
          </Notice>
        )}

        {state.status === 'ready' && state.cards.length === 0 && (
          <Notice>
            No saved cards. A card is kept when you choose to save it while buying credits.{' '}
            <Link href="/credits" className="font-medium text-accent-ink underline">
              Buy credits
            </Link>
          </Notice>
        )}

        {state.status === 'ready' && state.cards.length > 0 && (
          <>
            <ul className="tl-rows">
              {state.cards.map((card) => {
                const label = describeCard(card);
                const expiry = `${String(card.expMonth).padStart(2, '0')}/${card.expYear}`;
                const expired = hasExpired(card);
                const confirming = confirmingId === card.id;
                const busy = busyId === card.id;
                return (
                  <li key={card.id}>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                      <MarkCardBrand brand={card.brand} className="h-6 w-9 shrink-0" />
                      <div className="min-w-0 flex-1">
                        {/* Wrapped, never truncated: the last four digits are
                            the only thing telling two cards of one brand apart,
                            and truncation cuts from the end. */}
                        <p className="text-sm font-medium text-ink">{label}</p>
                        <p className="text-sm text-subtle">
                          {expired ? `Expired ${expiry}` : `Expires ${expiry}`}
                          {card.createdAt && ` · Saved ${formatDate(card.createdAt, { style: 'date' })}`}
                        </p>
                      </div>
                      {!confirming && (
                        <button
                          type="button"
                          aria-label={`Remove ${label}`}
                          disabled={busyId !== null}
                          onClick={() => {
                            setConfirmingId(card.id);
                            setRemoveError(null);
                          }}
                          className="tl-button-quiet"
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    {/*
                      Asked in the row rather than in a browser dialog: the
                      question then sits beside the card it is about, and can
                      say what removal does as well as ask.
                    */}
                    {confirming && (
                      <div className="mt-4 rounded-lg bg-surface-muted p-4">
                        <p className="text-sm font-medium text-ink">Remove {label}?</p>
                        <p className="mt-1 text-sm text-muted">
                          It is removed at the payment provider too, and will not be offered at
                          checkout again. Payments already made with it are not affected.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void remove(card)}
                            className="tl-button"
                            data-tone="danger"
                          >
                            {busy ? 'Removing...' : 'Remove card'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setConfirmingId(null);
                              setRemoveError(null);
                            }}
                            className="tl-button-quiet"
                          >
                            Keep it
                          </button>
                        </div>
                        {removeError?.id === card.id && (
                          <Status tone="error">{removeError.message}</Status>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="text-sm text-subtle">
              Only the brand, the last four digits and the expiry are kept here. The card itself
              stays with the payment provider.
            </p>
          </>
        )}
      </Section>
    </SettingsPage>
  );
}
