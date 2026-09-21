import crypto from 'crypto';

import { getDb } from './sqlite';

/**
 * Cards somebody chose to keep.
 *
 * Nothing here is a card number, and nothing here can become one. What is
 * stored is the handle Stripe gave us for a payment method, plus the brand, the
 * last four digits and the expiry - the three things a person needs to pick
 * their own card out of a list of two. The handle only does anything when sent
 * with the secret key, which is not in this database.
 *
 * Deleting is soft, because a payment made with a card that has since been
 * removed still has to be explainable months later. A detached row is never
 * offered again.
 */

export type SavedCard = {
  id: string;
  userId: string;
  provider: string;
  customerRef: string;
  methodRef: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  createdAt: string;
  updatedAt: string;
};

type SavedCardRow = {
  id: string;
  user_id: string;
  provider: string;
  customer_ref: string;
  method_ref: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  detached_at: string | null;
  created_at: string;
  updated_at: string;
};

const CARD_COLUMNS =
  'id, user_id, provider, customer_ref, method_ref, brand, last4, exp_month, exp_year, ' +
  'detached_at, created_at, updated_at';

function now(): string {
  return new Date().toISOString();
}

function toCard(row: SavedCardRow): SavedCard {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    customerRef: row.customer_ref,
    methodRef: row.method_ref,
    brand: row.brand ?? '',
    last4: row.last4 ?? '',
    expMonth: row.exp_month ?? 0,
    expYear: row.exp_year ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type NewSavedCard = {
  userId: string;
  provider?: string;
  customerRef: string;
  methodRef: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
};

/**
 * Records a card, or leaves an existing one alone.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` on the method reference rather than a
 * SELECT first, for the reason every other conflicting write in this codebase
 * does it: the index decides, and two deliveries of the same saved card racing
 * each other both look new if you read before writing. The update refreshes
 * the display fields and clears a previous soft delete, which is what saving a
 * card you once removed should do.
 */
/**
 * Records a card, or refreshes what is known about one already recorded.
 *
 * `ON CONFLICT (provider, method_ref)` rather than a read followed by an
 * insert: the index is what decides, so two settlements for the same card
 * cannot both think they are the first.
 *
 * **`detached_at` is deliberately NOT cleared on a conflict.** Clearing it
 * looked tidy - "the card is back, so un-delete it" - and resurrected a card
 * the buyer had just removed: removing one detaches it at Stripe as well, so a
 * settlement landing a moment later would relist a card that cannot be charged
 * any more. A removed card stays removed; entering the same card again
 * produces a new payment-method id at the provider and so a row of its own.
 */
export function saveCard(input: NewSavedCard): SavedCard {
  const timestamp = now();
  const id = `sc_${crypto.randomUUID()}`;
  const provider = input.provider ?? 'stripe';

  getDb()
    .prepare(
      `INSERT INTO saved_cards (${CARD_COLUMNS})
       VALUES (@id, @userId, @provider, @customerRef, @methodRef, @brand, @last4,
               @expMonth, @expYear, NULL, @createdAt, @createdAt)
       ON CONFLICT (provider, method_ref) DO UPDATE SET
         brand = excluded.brand,
         last4 = excluded.last4,
         exp_month = excluded.exp_month,
         exp_year = excluded.exp_year,
         updated_at = excluded.updated_at`
    )
    .run({
      id,
      userId: input.userId,
      provider,
      customerRef: input.customerRef,
      methodRef: input.methodRef,
      brand: input.brand ?? '',
      last4: input.last4 ?? '',
      expMonth: input.expMonth ?? 0,
      expYear: input.expYear ?? 0,
      createdAt: timestamp,
    });

  return getCardByMethodRef(provider, input.methodRef)!;
}

export function getCardByMethodRef(provider: string, methodRef: string): SavedCard | null {
  const row = getDb()
    .prepare(`SELECT ${CARD_COLUMNS} FROM saved_cards WHERE provider = ? AND method_ref = ?`)
    .get(provider, methodRef) as SavedCardRow | undefined;
  return row ? toCard(row) : null;
}

/**
 * One account's usable cards, newest first.
 *
 * Scoped in the query rather than filtered by the caller. A route that forgot
 * the filter would list somebody else's cards, so the only listing function
 * there is takes the account as its first argument.
 */
export function listCardsForUser(userId: string): SavedCard[] {
  const rows = getDb()
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM saved_cards
       WHERE user_id = ? AND detached_at IS NULL
       ORDER BY created_at DESC, rowid DESC`
    )
    .all(userId) as SavedCardRow[];
  return rows.map(toCard);
}

/**
 * One card, by id and owner.
 *
 * Both, always. Looking a card up by id alone and checking the owner afterwards
 * is the same thing until somebody forgets the second half.
 */
export function getCardForUser(userId: string, cardId: string): SavedCard | null {
  const row = getDb()
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM saved_cards
       WHERE id = ? AND user_id = ? AND detached_at IS NULL`
    )
    .get(cardId, userId) as SavedCardRow | undefined;
  return row ? toCard(row) : null;
}

/** Soft-deletes a card. Returns false when it was already gone. */
export function detachCard(userId: string, cardId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE saved_cards SET detached_at = @at, updated_at = @at
       WHERE id = @id AND user_id = @userId AND detached_at IS NULL`
    )
    .run({ id: cardId, userId, at: now() });
  return result.changes > 0;
}
