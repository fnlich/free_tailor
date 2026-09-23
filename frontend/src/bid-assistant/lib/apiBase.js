import { getPreferredApiBase, getToken } from '@/lib/api';

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
