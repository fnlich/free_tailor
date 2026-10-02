/**
 * The address this installation is reached at from outside.
 *
 * `APP_URL` is the one thing a single-origin deployment has to set. Everything
 * that needs an absolute public URL derives from it rather than asking the
 * operator to spell the same origin out three times - which is what the older
 * variables amounted to, and how an install ends up with the frontend, the API
 * and the payment return pointing at three different places.
 *
 * It is NOT required. Left unset, every caller keeps the fallback it had, so a
 * LAN or localhost install is unaffected.
 */

/**
 * An absolute http(s) origin, or null.
 *
 * Deliberately strict about the SCHEME. A bare `example.org` parses as a URL
 * with protocol `example.org:` rather than failing, so accepting anything the
 * URL constructor swallows would let a missing `https://` through and produce
 * return URLs that no browser can follow. Path, query and fragment are dropped:
 * this is an origin, and callers append their own paths to it.
 */
export function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

let warnedAboutAppUrl = false;

/**
 * `APP_URL`, normalized, or null when it is unset or unusable.
 *
 * A bad value warns rather than throwing. Refusing to boot over a malformed URL
 * would take an entire installation down for a value most of it does not need,
 * and the fallbacks below every caller still work - but it must be loud,
 * because the symptom otherwise is a payment redirect going somewhere odd weeks
 * later.
 */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.APP_URL?.trim();
  if (!raw) return null;

  const normalized = normalizeOrigin(raw);
  if (!normalized && !warnedAboutAppUrl) {
    warnedAboutAppUrl = true;
    console.warn(
      `[env] APP_URL is not an absolute http(s) URL and is being ignored: ${raw}\n` +
        '      It should look like https://example.org - scheme included, no path.'
    );
  }
  return normalized;
}

/** Test seam: the warning is once-per-process, which a test would otherwise only see once. */
export function resetPublicUrlWarning(): void {
  warnedAboutAppUrl = false;
}
