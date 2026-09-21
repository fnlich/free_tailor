import { loadStripe, type Stripe } from '@stripe/stripe-js';

/**
 * Stripe objects, cached per publishable key.
 *
 * `loadStripe` injects a script tag, so calling it on every render would add
 * one per render. The key arrives from our API rather than a build-time
 * constant, so this cannot be the module-level constant Stripe's own samples
 * write - but it can be a module-level cache, which has the same effect.
 *
 * Shared by the two things that need a Stripe object, and deliberately ONE
 * cache between them: the Payment Element for a new card, and
 * `handleNextAction` for a saved card whose bank demanded authentication.
 * Two caches would mean two script loads on a page that shows both.
 */
const stripeByKey = new Map<string, Promise<Stripe | null>>();

export function stripeFor(publishableKey: string): Promise<Stripe | null> {
  const existing = stripeByKey.get(publishableKey);
  if (existing) return existing;
  const created = loadStripe(publishableKey);
  stripeByKey.set(publishableKey, created);
  return created;
}

/**
 * Forget a rejected load.
 *
 * Without this every later attempt replays the same failure from cache and
 * "Start again" can never actually start again.
 */
export function forgetStripe(publishableKey: string): void {
  stripeByKey.delete(publishableKey);
}
