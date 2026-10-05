import { redirect } from 'next/navigation';

/**
 * The old address of Settings > Subscription, from before the account tier was
 * renamed. Kept because it may be bookmarked or linked from an old email.
 *
 * `redirect()` in a page with nothing else in it: Next prerenders the address
 * as a redirect that the client router follows the moment the page hydrates,
 * replacing the history entry so Back does not land here and bounce. It is not
 * an HTTP 307 - by the time the page throws, the root layout's shell is already
 * on its way, so `next start` answers 200 either way (checked) - which is why
 * this is not `force-dynamic` either: rendering per request would buy nothing.
 * No hash to read, unlike app/account, so no client effect is needed.
 */
export default function RenamedSubscriptionPage(): never {
  redirect('/settings/subscription');
}
