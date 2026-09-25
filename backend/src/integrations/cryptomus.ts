import crypto from 'crypto';
import { timingSafeEquals } from './stripe';

/**
 * Cryptomus, which is how this server takes crypto.
 *
 * The same shape as `stripe.ts`, and the shape the Coinbase module it
 * replaced also had: open a
 * hosted invoice, hand the browser a URL, and wait for a signed webhook to say
 * it was paid. Everything that makes crypto hard - exchange rates, which coin,
 * confirmation depth, underpayments, dust - happens on Cryptomus's side of that
 * URL, which is the entire reason to use a gateway rather than watch chains.
 *
 * Two things here are unlike every other integration in this repository, and
 * both are Cryptomus's design rather than a choice made here:
 *
 *  1. **One key does both jobs.** `CRYPTOMUS_PAYMENT_API_KEY` signs outbound
 *     requests AND verifies inbound webhooks. Stripe keeps those separate,
 *     which is what lets an installation stop offering a method while still
 *     settling what is already out there. That lever does not exist here:
 *     see `canVerifyCryptomusWebhooks`.
 *
 *  2. **The webhook signature travels INSIDE the JSON body**, as a `sign`
 *     field, rather than in a header. See `verifyWebhookSign`.
 *
 * NOTHING IN THIS FILE HAS EVER REACHED CRYPTOMUS. The machine this was
 * written on cannot resolve `api.cryptomus.com`, exactly as it cannot reach a
 * blockchain RPC. So the API surface is written from the published reference
 * and pinned by tests that assert the request SHAPE - the URL, the headers, the
 * field names and the signature formula - against a stubbed socket. That is
 * enough to catch a regression and not enough to prove the shape is right. The
 * README says the same thing in as many words, with the list of checks an
 * operator has to run for real before taking money.
 */

const CRYPTOMUS_API_BASE = 'https://api.cryptomus.com/v1';

/** How long a buyer has to pay a hosted invoice, in seconds. */
const INVOICE_LIFETIME_SECONDS = 3600;

export class CryptomusError extends Error {
  readonly status: number;

  /**
   * Whether the request never got an answer, as opposed to being refused.
   *
   * Carried for the reason `StripeError` carries it and `CoinbaseError` did
   * not: `startCheckout` closes a payment as failed on anything the provider
   * throws, so without this flag a dropped socket becomes a dead payment row
   * for an invoice that may well exist at Cryptomus with somebody about to pay
   * it. "We do not know" is not "it was refused".
   */
  readonly transport: boolean;

  constructor(message: string, status = 502, transport = false) {
    super(message);
    this.name = 'CryptomusError';
    this.status = status;
    this.transport = transport;
  }
}

export function cryptomusMerchantId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRYPTOMUS_MERCHANT_ID?.trim() ?? '';
}

export function cryptomusPaymentKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRYPTOMUS_PAYMENT_API_KEY?.trim() ?? '';
}

/**
 * Where Cryptomus should post the callback, when the operator says so here.
 *
 * Optional, and empty is a perfectly good answer: a callback URL can also be
 * set once in the Cryptomus dashboard, which is how most installations will do
 * it. Sending an EMPTY `url_callback` would be worse than sending none - it
 * overrides the dashboard with nothing - so an unset variable means the field
 * is omitted from the request entirely.
 *
 * It has to be this server, reachable from the internet, and it has to be the
 * API rather than the frontend: everything else in this feature points a
 * browser at the frontend, and pasting that origin here is the mistake to
 * expect. The README says so, and so does `.env.example`.
 */
export function cryptomusCallbackUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRYPTOMUS_CALLBACK_URL?.trim() ?? '';
}

export function isCryptomusConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(cryptomusMerchantId(env)) && Boolean(cryptomusPaymentKey(env));
}

/**
 * Deliberately the same predicate as `isCryptomusConfigured`, and that is the
 * point worth reading.
 *
 * Stripe splits this, because judging a webhook needs only the webhook secret:
 * an installation that had stopped offering the method could still settle the
 * payments already in flight, and the webhook endpoint answers 503 only when it
 * genuinely cannot judge anything. Cryptomus signs webhooks with the same key
 * it authenticates requests with, so there is nothing to split. It is a wrapper rather than a re-use of the other name so that the
 * webhook route reads like its siblings and the asymmetry is stated once, here,
 * instead of being discovered at the call site.
 */
export function canVerifyCryptomusWebhooks(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCryptomusConfigured(env);
}

/**
 * Cryptomus's signature, over a body that has already been serialized.
 *
 * `md5(base64(json) + key)`, hex. Taking the serialized string rather than an
 * object is the whole reason this is its own function: the bytes that are
 * signed have to be the bytes that are sent, and a function that stringified
 * its own argument would make that impossible to guarantee at the call site.
 *
 * MD5 is not a choice made here. It is what the provider verifies against, and
 * it is a shared-secret construction rather than a collision-resistance one -
 * an attacker who could forge this already has the key.
 */
export function signBody(json: string, key: string): string {
  return crypto
    .createHash('md5')
    .update(Buffer.from(json, 'utf8').toString('base64') + key)
    .digest('hex');
}

async function cryptomusFetch<T>(path: string, body: unknown): Promise<T> {
  const merchant = cryptomusMerchantId();
  const key = cryptomusPaymentKey();
  if (!merchant || !key) {
    throw new CryptomusError('Crypto payments are not configured on this server.', 503);
  }

  // Serialized ONCE, then signed and sent. Two calls to JSON.stringify would
  // usually agree and "usually" is not a signature.
  const json = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(`${CRYPTOMUS_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        merchant,
        sign: signBody(json, key),
        'Content-Type': 'application/json',
      },
      body: json,
    });
  } catch (error) {
    throw new CryptomusError(
      `Could not reach Cryptomus: ${error instanceof Error ? error.message : 'connection failed'}`,
      502,
      true
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The connection dropped while reading the answer. The invoice may exist.
    throw new CryptomusError(
      `Lost the connection to Cryptomus while reading its reply: ${
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
    throw new CryptomusError(
      `Cryptomus replied with something that is not JSON (HTTP ${response.status}).`
    );
  }

  const envelope = parsed as { state?: number; message?: string; errors?: unknown; result?: T };
  /*
   * Cryptomus answers 200 with `state: 1` for a refusal.
   *
   * So `response.ok` alone would accept "your amount is below the minimum" as
   * a successful invoice and hand the caller an undefined URL. Both conditions
   * are checked, and the message is preferred over the status either way.
   */
  if (!response.ok || envelope.state !== 0 || !envelope.result) {
    const detail = typeof envelope.message === 'string' ? envelope.message : '';
    throw new CryptomusError(detail || `Cryptomus refused the request (HTTP ${response.status}).`);
  }
  return envelope.result;
}

/**
 * Only `uuid` and `url` are read - the reference to store and the page to send
 * the buyer to. The other two are declared because they are what an invoice
 * reply contains, and a type that describes half of an answer is a type the
 * next reader has to go and check.
 */
export type CryptomusInvoice = {
  uuid: string;
  order_id: string;
  url: string;
  status?: string;
};

export type InvoiceRequest = {
  paymentId: string;
  reference: string;
  credits: number;
  amountCents: number;
  currency: string;
  returnUrl: string;
  cancelUrl: string;
};

/**
 * One hosted invoice for one payment.
 *
 * `amount` is a decimal STRING in the merchant's currency, not minor units -
 * the one place in this feature where money stops being an integer. It is
 * built from the integer rather than carried as a float.
 *
 * `order_id` is this server's payment id, which is what makes the webhook
 * attributable: it comes back untouched and becomes the payment hint. Cryptomus
 * treats it as unique per merchant, so a second invoice for the same payment is
 * refused rather than silently duplicated - which is the behaviour wanted.
 */
export async function createInvoice(input: InvoiceRequest): Promise<CryptomusInvoice> {
  const callback = cryptomusCallbackUrl();
  return cryptomusFetch<CryptomusInvoice>('/payment', {
    amount: (input.amountCents / 100).toFixed(2),
    currency: input.currency.toUpperCase(),
    order_id: input.paymentId,
    lifetime: INVOICE_LIFETIME_SECONDS,
    // Where the BUYER goes: back to the order either way. `url_return` is the
    // "I changed my mind" link on Cryptomus's own page, so it gets the cancel
    // URL; `url_success` is the redirect after paying.
    url_return: input.cancelUrl,
    url_success: input.returnUrl,
    ...(callback ? { url_callback: callback } : {}),
    additional_data: input.reference,
  });
}

export type CryptomusWebhook = {
  type?: string;
  uuid?: string;
  order_id?: string;
  status?: string;
  /**
   * A decimal string in the documented shape, and a number if the reference is
   * wrong about that. Both are read - see the note in `paymentWebhooks.ts`.
   */
  amount?: string | number;
  payment_amount?: string | number;
  currency?: string;
  /**
   * Cryptomus's own "this status will not change again", and deliberately not
   * read: `PAID_STATUSES` and `FAILED_STATUSES` decide what is final here, and
   * a provider flag that disagreed with them would be the wrong authority on
   * whether to hand out credits.
   */
  is_final?: boolean;
  sign?: string;
};

/**
 * Verifies a webhook whose signature is INSIDE the body.
 *
 * Every other provider here signs a header over the raw bytes, which is why
 * `paymentWebhooks.ts` states "verify before reading" as its first rule.
 * Cryptomus cannot be verified that way: `sign` is a field in the JSON, so the
 * body has to be parsed, `sign` removed, and the REST re-serialized before
 * anything can be checked. Re-serializing a parsed body is exactly what that
 * rule warns against, and there is no alternative - it is the provider's
 * scheme. What makes it acceptable rather than merely necessary:
 *
 *  - it happens once, here, rather than at the call site;
 *  - the parse cannot execute anything, and nothing is acted on until after
 *    the comparison;
 *  - the raw bytes are still what gets stored as the event payload, so the
 *    record of what arrived is the thing that arrived.
 *
 * The known way for this to fail against real Cryptomus is ESCAPING. PHP's
 * `json_encode` escapes a forward slash as `\/` by default, and callback bodies
 * carry URLs. If signatures verify in the tests and fail in production, that is
 * the first thing to try - it is a one-line change here and nowhere else.
 */
export function verifyWebhookSign(
  rawBody: Buffer,
  key: string
): { ok: boolean; body: CryptomusWebhook | null } {
  if (!key) return { ok: false, body: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, body: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, body: null };
  }

  const { sign, ...rest } = parsed as Record<string, unknown>;
  if (typeof sign !== 'string' || sign === '') return { ok: false, body: null };

  // Key order is preserved by JSON.parse, so this reproduces the order the
  // sender used - which the formula depends on, since it hashes a string.
  const expected = signBody(JSON.stringify(rest), key);
  if (!timingSafeEquals(sign, expected)) return { ok: false, body: null };
  return { ok: true, body: rest as CryptomusWebhook };
}

/**
 * The statuses worth acting on.
 *
 * `paid_over` is a buyer who sent MORE than the invoice, and it is still paid.
 * Nothing clamps what gets credited, and this said so for a while: the clamp
 * `creditPaid` used to carry went with the on-chain settler, and the webhook
 * does not trim a disagreeing amount either - it REFUSES it and holds the
 * payment. What makes `paid_over` safe is the field that gets compared:
 * `amount` is the invoice, which an overpayment does not change, while the
 * larger figure arrives as `payment_amount` and is never read. See the note in
 * `paymentWebhooks.ts` about which of the two is comparable.
 *
 * `wrong_amount` is the opposite - not enough arrived - and it closes the
 * payment rather than crediting a short one. It gets its own sentence below,
 * because "it did not go through" is not what happened: the coin left the
 * buyer's wallet and is at the provider.
 *
 * Everything else is a stage on the way, not an outcome. `check` and `process`
 * mean the money is somewhere between the buyer and confirmation, and crediting
 * there would hand out credits for a transfer that can still fail. So are
 * `wrong_amount_waiting`, `refund_process` and `refund_paid`: acknowledged,
 * recorded as events, and acted on by nobody here.
 */
export const PAID_STATUSES: ReadonlySet<string> = new Set(['paid', 'paid_over']);
export const FAILED_STATUSES: ReadonlySet<string> = new Set([
  'fail',
  'system_fail',
  'cancel',
  'wrong_amount',
]);

/**
 * What to tell the buyer about a failure, where the general answer is wrong.
 *
 * The return page prints this sentence, and above it the page used to say
 * flatly "You were not charged" - which for `wrong_amount` is false and
 * unhelpful at the same moment. Something left their wallet; it was less than
 * the invoice; nothing was credited; and nobody here can send it back, because
 * a `failed` payment is not refundable through this application at all. Saying
 * so is the least this can do, and it is also the sentence that tells an
 * operator where to look.
 *
 * Empty for every other status, which means the general sentence stands.
 */
export function failureFor(status: string): string {
  if (status === 'wrong_amount') {
    return (
      'Less arrived than the invoice asked for, so nothing was credited. The coin that was sent ' +
      'is at the payment provider - contact support with this reference to sort it out.'
    );
  }
  return '';
}
