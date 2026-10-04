import { ApiResponseError, getPreferredApiBase, getToken } from '@/lib/api';

export function getBidAssistantApiUrl(path) {
  const normalizedPath = path.replace(/^\/api\/?/, '').replace(/^\//, '');
  return `${getPreferredApiBase().replace(/\/$/, '')}/bid-assistant/${normalizedPath}`;
}

/**
 * Every bid-assistant request, carrying the session.
 *
 * This client predates accounts: it was written when the API was open, and it
 * kept issuing bare `fetch` calls afterwards. Every backend route under
 * `/api/bid-assistant` now sits behind `requireUser`, so all of them answered
 * 401 and the page painted its chrome around nothing - for administrators as
 * well, because the problem was never a permission.
 *
 * The BEARER token rather than the cookie, which is what the rest of the app
 * sends too. The API is a different ORIGIN - port 3001 against the page's
 * 3000 - so a same-site session cookie is not attached to these requests at
 * all, and `credentials: 'include'` would need the server to allow credentials
 * for that origin. The header crosses without any of that.
 *
 * Headers already on the call are kept: several sites set a content type.
 */
export function bidAssistantFetch(path, options = {}) {
  const token = getToken();
  return fetch(getBidAssistantApiUrl(path), {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

/**
 * The failure a refused response stands for, ready to throw.
 *
 * The same `ApiResponseError` the rest of the app's `apiFetch` throws, body and
 * all, so a catch here can hand it to `messageWithDetail` (lib/userMessage.ts)
 * and get what every other page shows: the server's sentence and its
 * reference, plus - for an administrator only - the detail the server attaches.
 * A plain `new Error(data.error)` kept the sentence and dropped the rest.
 *
 * `fallback` is for a body with no sentence in it: an HTML error page from a
 * proxy, or no body at all.
 */
export async function readError(response, fallback) {
  return responseError(response, await response.json().catch(() => null), fallback);
}

/** `readError` for a caller that has already parsed the body. */
export function responseError(response, parsed, fallback) {
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const said = typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
  return new ApiResponseError(said, response.status, response.url, body);
}
