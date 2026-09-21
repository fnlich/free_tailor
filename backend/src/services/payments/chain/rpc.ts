/**
 * The one place this application talks to a blockchain or a price feed.
 *
 * Everything the watcher reads goes through here, for three reasons.
 *
 * **It is the seam.** Tests replace these functions by assignment after
 * `loadFresh`, exactly as the payment tests replace the Stripe boundary, so no
 * test ever touches a network. That matters more here than anywhere else in
 * the codebase: the machine this was written on cannot reach a single chain
 * endpoint (the egress policy refuses them), so a reader that could only be
 * exercised against a live node could not be exercised at all.
 *
 * **Endpoints are lists, tried in order.** `chainPayments.ts` holds two or
 * three URLs per chain because free public nodes rate-limit, lag, and go away.
 * A failure moves to the next one and then to the next tick.
 *
 * **Nothing here decides anything about a payment.** A refusal, a timeout and
 * an empty answer are all "we could not look", which is a different fact from
 * "nothing arrived" - and only the second one would ever be grounds for
 * closing an invoice. This module throws; it never marks.
 *
 * A note on the timeout, which the Stripe integration beside this one does not
 * have: a request somebody is waiting on fails visibly when it hangs, because
 * a person is watching a spinner. A request made by a background loop hangs
 * silently and takes the whole sweep with it, so every call here carries a
 * deadline.
 */

/** How long any one endpoint gets before the next one is tried. */
const REQUEST_TIMEOUT_MS = 12_000;

export class ChainRpcError extends Error {
  constructor(
    message: string,
    /** Every endpoint that was tried, and what each said. For the log. */
    readonly attempts: string[] = []
  ) {
    super(message);
    this.name = 'ChainRpcError';
  }
}

type JsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string };
};

async function fetchWithDeadline(url: string, init: RequestInit): Promise<Response> {
  /*
   * A controller rather than `AbortSignal.timeout`, so the timer can be
   * cleared. `AbortSignal.timeout` leaves a live timer per call, which on a
   * thirty-second loop across four chains is a slow accumulation of work the
   * process has to keep waking up for.
   */
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * A JSON-RPC call against the first endpoint that answers.
 *
 * `params` is passed through untouched. Every EVM read this application makes
 * is one of three methods, and none of them takes anything this function would
 * need to understand.
 */
export async function rpcCall(
  endpoints: string[],
  method: string,
  params: unknown[]
): Promise<unknown> {
  const attempts: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithDeadline(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });

      if (!response.ok) {
        attempts.push(`${endpoint} -> HTTP ${response.status}`);
        continue;
      }

      const body = (await response.json()) as JsonRpcResponse;
      if (body.error) {
        /*
         * An RPC-level error is still "could not look".
         *
         * A public node refusing eth_getLogs because the range is too wide, or
         * because that method is disabled on that host, looks exactly like a
         * chain with no transfers on it if this returned an empty result. It
         * must not: the next endpoint in the list may well serve it.
         */
        attempts.push(`${endpoint} -> ${body.error.message ?? `rpc error ${body.error.code}`}`);
        continue;
      }

      return body.result;
    } catch (error) {
      attempts.push(`${endpoint} -> ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  throw new ChainRpcError(`No endpoint answered ${method}.`, attempts);
}

/**
 * A JSON POST that is not JSON-RPC, for TronGrid's `/wallet/*` routes.
 *
 * Those are POST even when they take no arguments - `getnowblock` is posted an
 * empty object - and they answer a bare object rather than a JSON-RPC
 * envelope, so neither of the other two functions here fits them.
 */
export async function postJson(
  endpoints: string[],
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const attempts: string[] = [];

  for (const endpoint of endpoints) {
    const url = `${endpoint.replace(/\/+$/, '')}${path}`;
    try {
      const response = await fetchWithDeadline(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        attempts.push(`${url} -> HTTP ${response.status}`);
        continue;
      }

      return await response.json();
    } catch (error) {
      attempts.push(`${url} -> ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  throw new ChainRpcError(`No endpoint answered ${path}.`, attempts);
}

/** A plain GET returning JSON, for the REST APIs. Same list-in-order rule. */
export async function getJson(
  endpoints: string[],
  path: string,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const attempts: string[] = [];

  for (const endpoint of endpoints) {
    const url = `${endpoint.replace(/\/+$/, '')}${path}`;
    try {
      const response = await fetchWithDeadline(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
      });

      if (!response.ok) {
        attempts.push(`${url} -> HTTP ${response.status}`);
        continue;
      }

      return await response.json();
    } catch (error) {
      attempts.push(`${url} -> ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  throw new ChainRpcError(`No endpoint answered ${path}.`, attempts);
}
