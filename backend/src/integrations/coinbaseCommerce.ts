import crypto from 'crypto';
import { timingSafeEquals } from './stripe';

/**
 * Coinbase Commerce, which is the crypto half of the same shape.
 *
 * Deliberately the same shape as `stripe.ts`: create a hosted checkout, hand
 * the browser a URL, and wait for a signed webhook to say it was paid. Taking
 * crypto any other way means owning exchange rates, confirmation depth,
 * underpayments and dust - four problems that are entirely about money and not
 * at all about this product.
 *
 * The important difference is TIME. A card either works or does not, in
 * seconds. A chain payment sits unconfirmed for minutes, so `charge:pending`
 * and `charge:confirmed` are different events and only the second one is worth
 * any credits.
 */

const COMMERCE_API_BASE = 'https://api.commerce.coinbase.com';
const COMMERCE_API_VERSION = '2018-03-22';

export class CoinbaseError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'CoinbaseError';
    this.status = status;
  }
}

export function coinbaseApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.COINBASE_COMMERCE_API_KEY?.trim() ?? '';
}

export function coinbaseWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.COINBASE_COMMERCE_WEBHOOK_SECRET?.trim() ?? '';
}

/** Both halves, for the reason given in `isStripeConfigured`. */
/** As for Stripe: judging a webhook needs the webhook secret, and no more. */
export function canVerifyCoinbaseWebhooks(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(coinbaseWebhookSecret(env));
}

export function isCoinbaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(coinbaseApiKey(env)) && Boolean(coinbaseWebhookSecret(env));
}

async function commerceFetch<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const key = coinbaseApiKey();
  if (!key) throw new CoinbaseError('Crypto payments are not configured on this server.', 503);

  const response = await fetch(`${COMMERCE_API_BASE}${path}`, {
    method: init.method,
    headers: {
      'X-CC-Api-Key': key,
      'X-CC-Version': COMMERCE_API_VERSION,
      'Content-Type': 'application/json',
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new CoinbaseError(`Coinbase replied with something that is not JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail = (parsed as { error?: { message?: string } })?.error?.message;
    throw new CoinbaseError(detail || `Coinbase refused the request (HTTP ${response.status}).`);
  }
  return (parsed as { data?: T }).data ?? (parsed as T);
}

export type CoinbaseCharge = {
  id: string;
  code: string;
  hosted_url?: string;
  metadata?: Record<string, string>;
  timeline?: Array<{ status?: string; time?: string }>;
};

export type ChargeRequest = {
  paymentId: string;
  reference: string;
  credits: number;
  amountCents: number;
  currency: string;
  redirectUrl: string;
  cancelUrl: string;
};

/**
 * One charge for one payment.
 *
 * `pricing_type: 'fixed_price'` in the local currency - Coinbase converts to
 * whichever coin the payer chooses and absorbs the rate movement for the life
 * of the charge. `local_price.amount` is a decimal STRING, not cents, which is
 * the one place in this feature where money is not an integer; it is built from
 * the integer rather than carried as a float.
 */
export async function createCharge(input: ChargeRequest): Promise<CoinbaseCharge> {
  return commerceFetch<CoinbaseCharge>('/charges', {
    method: 'POST',
    body: {
      name: `${input.credits} credits`,
      description: input.reference,
      pricing_type: 'fixed_price',
      local_price: {
        amount: (input.amountCents / 100).toFixed(2),
        currency: input.currency.toUpperCase(),
      },
      metadata: { paymentId: input.paymentId, reference: input.reference },
      redirect_url: input.redirectUrl,
      cancel_url: input.cancelUrl,
    },
  });
}

export async function getCharge(code: string): Promise<CoinbaseCharge> {
  return commerceFetch<CoinbaseCharge>(`/charges/${encodeURIComponent(code)}`, { method: 'GET' });
}

/**
 * Verifies a webhook against the RAW bytes Coinbase signed.
 *
 * A plain HMAC-SHA256 of the body with the shared secret, hex, in
 * `X-CC-Webhook-Signature`. Simpler than Stripe's scheme and missing its
 * timestamp, so there is no age to check here - replay protection comes
 * entirely from the UNIQUE event id in `payment_events`, which is why that
 * index is not optional.
 */
export function verifyCoinbaseSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEquals(signatureHeader.trim(), expected);
}
