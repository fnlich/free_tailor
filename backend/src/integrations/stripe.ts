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

/**
 * The API version this integration is written against, sent on every request.
 *
 * Not optional, and not cosmetic. Stripe pins each ACCOUNT to an API version at
 * its first call and never moves it, so a request with no `Stripe-Version`
 * header is resolved at whatever version that account happens to sit on.
 * `ui_mode: 'elements'` only exists from 2026-03-25.dahlia - before it the same
 * thing was called `custom`, and that value was REMOVED in the same release. An
 * account older than that would answer every checkout with a 400 on an enum
 * value, which reads like a bug in this app rather than a version mismatch.
 *
 * Stripe's own advice for an integration that does not use their SDK, which
 * this one does not: "update your API requests to include
 * Stripe-Version: 2026-03-25.dahlia".
 */
const STRIPE_API_VERSION = '2026-03-25.dahlia';

/** Stripe's tolerance for the timestamp in a webhook signature. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export class StripeError extends Error {
  readonly status: number;

  /**
   * Whether the request never got an answer, as opposed to being refused.
   *
   * The difference decides whether a payment can be closed. Stripe saying
   * "no" means no session exists and the payment is dead. A socket dropping
   * means the session may well have been created and somebody may still pay
   * it - closing that payment is how money gets taken for credits that are
   * never granted.
   */
  readonly transport: boolean;

  constructor(message: string, status = 502, transport = false) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.transport = transport;
  }
}

export function stripeSecretKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRIPE_SECRET_KEY?.trim() ?? '';
}

export function stripeWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRIPE_WEBHOOK_SECRET?.trim() ?? '';
}

/**
 * The key the payment form in the browser needs.
 *
 * Safe to publish - that is what "publishable" means - and it is served to the
 * page from the API rather than baked into the frontend bundle, so that every
 * Stripe value lives in one .env and changing one does not mean rebuilding the
 * frontend.
 */
export function stripePublishableKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
  if (!key) return '';

  /*
   * Checked, because this one value is deliberately broadcast.
   *
   * It is served to every browser that opens the buy page, which is fine for a
   * publishable key and catastrophic for a secret one - and the two sit next to
   * each other on the same dashboard page, under names a tired operator can
   * confuse at midnight. A key in the wrong slot is refused rather than
   * published, and the card method is then withheld exactly as it would be for
   * a missing key.
   */
  if (!key.startsWith('pk_')) {
    console.error(
      '[payments] STRIPE_PUBLISHABLE_KEY does not look like a publishable key (it must begin ' +
        '"pk_"). It was NOT used. If a secret key was pasted there, treat it as compromised and ' +
        'roll it in the Stripe dashboard.'
    );
    return '';
  }
  return key;
}

/**
 * Whether cards can be taken at all.
 *
 * All THREE are required, and that is not pedantry. A secret key without a
 * webhook secret is an install that can take money and can never hear that it
 * did, so every payment would sit pending for ever with the money gone. And
 * without the publishable key the payment form cannot mount in the browser at
 * all, so the button would lead to an empty box. Refusing to offer the method
 * is much better than offering a broken one.
 */
/**
 * Whether an inbound webhook can be JUDGED - which is a smaller question.
 *
 * Deliberately NOT `isStripeConfigured`. Verifying a signature needs the
 * webhook secret and nothing else: the publishable key mounts a form in a
 * browser and the secret key calls the API, and neither has any part in
 * deciding whether Stripe sent this request. Gating the webhook on all three
 * would mean an operator who removed the publishable key started answering 503
 * to Stripe, which retries for days and then disables the endpoint - taking
 * with it the events that credit people who have already paid.
 */
export function canVerifyStripeWebhooks(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(stripeWebhookSecret(env));
}

export function isStripeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    Boolean(stripeSecretKey(env)) &&
    Boolean(stripeWebhookSecret(env)) &&
    Boolean(stripePublishableKey(env))
  );
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
    'Stripe-Version': STRIPE_API_VERSION,
  };
  // Stripe's own idempotency, separate from ours: it stops a retried request
  // creating a SECOND session or a second refund, which our database guard
  // cannot see because it happens before we hear anything back.
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: init.method,
      headers,
      ...(init.body ? { body: formEncode(init.body).toString() } : {}),
    });
  } catch (error) {
    // Never reached Stripe, or never heard back. Marked as transport so the
    // caller does not treat "we do not know" as "it was refused".
    throw new StripeError(
      `Could not reach Stripe: ${error instanceof Error ? error.message : 'connection failed'}`,
      502,
      true
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The connection dropped while reading the answer. The session may exist.
    throw new StripeError(
      `Lost the connection to Stripe while reading its reply: ${
        error instanceof Error ? error.message : 'read failed'
      }`,
      502,
      true
    );
  }
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
  /** Present in `elements` mode: what the browser initialises the form with. */
  client_secret?: string;
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
  /** Where Stripe sends the browser back to AFTER an attempt. See the note below. */
  returnUrl: string;
};

/**
 * One Checkout Session for one payment, in ELEMENTS mode.
 *
 * `ui_mode: 'elements'` is the difference between a payment form on our own
 * page and a redirect to Stripe's. The session comes back with a
 * `client_secret` instead of a `url`, the browser initialises the Payment
 * Element with it, and the card details go straight from the iframe to Stripe -
 * this server still never sees a card number, which is the property worth
 * keeping from the hosted page.
 *
 * `return_url` replaces the success/cancel pair. It is NOT how a payment is
 * confirmed - only a signed webhook does that - but some payment methods leave
 * the page anyway: 3-D Secure and a stablecoin payment both bounce through
 * somebody else's domain and have to land somewhere on the way back.
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
      ui_mode: 'elements',
      return_url: input.returnUrl,
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

  // The bytes, not a string made from them. Identical for valid UTF-8, which
  // is everything Stripe sends - but a body with a stray byte would decode
  // lossily and be judged on something other than what was signed.
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]))
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
