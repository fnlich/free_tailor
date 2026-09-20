import crypto from 'crypto';

/**
 * Stripe, over four calls and one signature.
 *
 * Hand-rolled against `fetch` rather than the SDK, for the same reasons
 * `integrations/googleSheets.ts` is: the surface actually used here is tiny -
 * open a Checkout Session, read one back, refund it, verify a webhook - and a
 * dependency that reaches the network is a dependency a test has to fake at the
 * module boundary anyway. This way the boundary is a plain object.
 *
 * Nothing in this file touches a card number. Checkout is hosted at Stripe, the
 * browser goes there, and what comes back to this server is a session id and a
 * signed webhook. That is the whole reason to use Checkout rather than build a
 * form.
 */

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** Stripe's tolerance for the timestamp in a webhook signature. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export class StripeError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
  }
}

export function stripeSecretKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRIPE_SECRET_KEY?.trim() ?? '';
}

export function stripeWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRIPE_WEBHOOK_SECRET?.trim() ?? '';
}

/**
 * Whether cards can be taken at all.
 *
 * Both halves are required, and that is not pedantry: a key without a webhook
 * secret is an install that can take money and can never hear that it did, so
 * every payment would sit pending for ever with the money gone. Refusing to
 * offer the method is much better than offering a broken one.
 */
export function isStripeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(stripeSecretKey(env)) && Boolean(stripeWebhookSecret(env));
}

/**
 * Stripe takes form encoding, including for nested fields.
 *
 * `metadata[paymentId]=pay_123`, `line_items[0][quantity]=1`. Flattened here
 * rather than by hand at each call site, because getting one bracket wrong
 * produces a request Stripe accepts and quietly ignores half of.
 */
function formEncode(value: unknown, prefix = '', into = new URLSearchParams()): URLSearchParams {
  if (value === null || typeof value === 'undefined') return into;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => formEncode(entry, `${prefix}[${index}]`, into));
    return into;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      formEncode(entry, prefix ? `${prefix}[${key}]` : key, into);
    }
    return into;
  }
  into.append(prefix, String(value));
  return into;
}

async function stripeFetch<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = { method: 'GET' }
): Promise<T> {
  const key = stripeSecretKey();
  if (!key) throw new StripeError('Card payments are not configured on this server.', 503);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // Stripe's own idempotency, separate from ours: it stops a retried request
  // creating a SECOND session or a second refund, which our database guard
  // cannot see because it happens before we hear anything back.
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: init.method,
    headers,
    ...(init.body ? { body: formEncode(init.body).toString() } : {}),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new StripeError(`Stripe replied with something that is not JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail = (parsed as { error?: { message?: string } })?.error?.message;
    throw new StripeError(detail || `Stripe refused the request (HTTP ${response.status}).`);
  }
  return parsed as T;
}

export type StripeSession = {
  id: string;
  url?: string;
  payment_status?: string;
  payment_intent?: string | { id?: string };
  metadata?: Record<string, string>;
  client_reference_id?: string;
};

export type CheckoutRequest = {
  paymentId: string;
  reference: string;
  credits: number;
  amountCents: number;
  currency: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
};

/**
 * One Checkout Session for one payment.
 *
 * The amount is sent as a single line item priced in the smallest currency
 * unit, which is what `unit_amount` means and why nothing here divides by a
 * hundred. `client_reference_id` and `metadata.paymentId` both carry our id,
 * because the webhook may quote either depending on the event.
 */
export async function createCheckoutSession(input: CheckoutRequest): Promise<StripeSession> {
  return stripeFetch<StripeSession>('/checkout/sessions', {
    method: 'POST',
    idempotencyKey: `checkout:${input.paymentId}`,
    body: {
      mode: 'payment',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.paymentId,
      customer_email: input.customerEmail,
      metadata: { paymentId: input.paymentId, reference: input.reference },
      // Repeated on the payment intent so a refund or a dispute opened from the
      // Stripe dashboard still carries the reference somebody would quote.
      payment_intent_data: {
        metadata: { paymentId: input.paymentId, reference: input.reference },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency,
            unit_amount: input.amountCents,
            product_data: { name: `${input.credits} credits`, description: input.reference },
          },
        },
      ],
    },
  });
}

export async function getCheckoutSession(sessionId: string): Promise<StripeSession> {
  return stripeFetch<StripeSession>(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

export async function refundPaymentIntent(paymentIntentId: string, paymentId: string): Promise<void> {
  await stripeFetch('/refunds', {
    method: 'POST',
    idempotencyKey: `refund:${paymentId}`,
    body: { payment_intent: paymentIntentId },
  });
}

/**
 * Verifies a webhook against the RAW bytes Stripe signed.
 *
 * Raw, not re-serialized: `JSON.parse` then `JSON.stringify` gives back a
 * string that is usually identical and occasionally is not - key order, unicode
 * escapes, a number that round-trips differently - and "usually" is not a
 * security property. This is why the webhook route is mounted with
 * `express.raw` ahead of the app-wide JSON parser.
 *
 * The timestamp check is what stops a replay: a signature stays valid for ever
 * otherwise, so anyone who ever saw one valid request could resend it.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!signatureHeader || !secret) return false;

  let timestamp = '';
  const candidates: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key?.trim() === 't') timestamp = value?.trim() ?? '';
    // v1 only. Stripe's older v0 scheme is not a fallback worth accepting: a
    // verifier that accepts the weaker of two schemes offers the weaker one.
    if (key?.trim() === 'v1' && value) candidates.push(value.trim());
  }
  if (!timestamp || candidates.length === 0) return false;

  const signedAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(signedAt)) return false;
  if (Math.abs(nowSeconds - signedAt) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  return candidates.some((candidate) => timingSafeEquals(candidate, expected));
}

/**
 * A comparison whose duration says nothing about how nearly right the input was.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * length, so the lengths are checked first and a mismatch is simply false -
 * the length of a hex SHA-256 digest is not a secret.
 */
export function timingSafeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
