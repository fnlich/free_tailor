/**
 * Links the SERVER hands a page, checked once more before an anchor carries
 * them.
 *
 * The server is the one that decides: a notification's `link` is an app path
 * it wrote (`/credits?tab=refunds`), and a contact channel's `href` is a link
 * it built from a value that passed its type's rule (services/contact.ts). The
 * page never builds either from text somebody typed. These checks are the
 * second lock on the same door - a row edited by hand, an older server, a
 * proxy that rewrote a body - so that what lands in an `href` here can only
 * ever be one of the shapes the server makes, never `javascript:`.
 *
 * Imports nothing at runtime, so backend/test can load it on its own.
 */

/**
 * An app path - one leading `/`, no second, no backslash, no spaces or
 * control characters - or null for anything else. The server's
 * `safeAppPath` (database/notificationRepository.ts), copied.
 */
export function safeAppPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return null;
  if (path.length > 300 || /[\s\u0000-\u001f\u007f]/.test(path)) return null;
  return path;
}

/**
 * A contact link the server built - `mailto:` an address, or an `http(s)` URL
 * with a host and no credentials (`https://t.me/...`, `https://wa.me/...`, an
 * administrator's own page) - or null, and the page shows the value as text.
 */
export function safeContactHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (/^mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/i.test(href)) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return href;
}

/** A web link opens in a new tab; a `mailto:` hands over to the mail app where it is. */
export function opensInNewTab(href: string): boolean {
  return /^https?:/i.test(href);
}

/**
 * What a notice's link says. Named for the pages the server links notices to
 * today, so the panel reads "See your refund requests" rather than a bare
 * "Open"; any other app path still works, under the plain word.
 */
const APP_LINK_LABELS: Record<string, string> = {
  '/credits?tab=refunds': 'See your refund requests',
  // A reporter's notices: a payout request decided or recorded, a reward taken back.
  '/credits': 'See your credits',
  '/admin/payments?tab=refunds': 'Open the refund queue',
};

export function appLinkLabel(path: string): string {
  return APP_LINK_LABELS[path] ?? 'Open';
}
