const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * What this server actually sends Cryptomus, and what it will accept back.
 *
 * The reason this file exists at all: **no call in this repository has ever
 * reached Cryptomus.** The machine it was written on cannot resolve
 * `api.cryptomus.com`, the same way it cannot reach a blockchain RPC. So the
 * request is built from the published reference and pinned HERE, at the socket,
 * by stubbing `globalThis.fetch` and reading the bytes that would have gone out
 * - the same technique `threeDSecure.test.js` uses on Stripe, and for the same
 * reason: a test that replaces the whole integration proves the service asked
 * for something, not that the provider would have understood it.
 *
 * These tests cannot prove the shape is RIGHT. Only Cryptomus can do that, and
 * the README lists the checks an operator has to run once before taking money.
 * What they do prove is that the shape does not change by accident, and that
 * the signature is computed over exactly the bytes that are sent - which is the
 * half that fails silently rather than loudly.
 */

const MERCHANT = 'merchant-uuid';
const KEY = 'payment-api-key';

/** The formula, written out rather than imported, so a change fails a test. */
function expectedSign(json, key = KEY) {
  return crypto
    .createHash('md5')
    .update(Buffer.from(json, 'utf8').toString('base64') + key)
    .digest('hex');
}

/** Loads the module for real, with only the socket replaced. */
async function capture(run, { reply, status = 200 } = {}) {
  useTempStorage(`cryptomus-${Math.random().toString(36).slice(2)}`);
  process.env.CRYPTOMUS_MERCHANT_ID = MERCHANT;
  process.env.CRYPTOMUS_PAYMENT_API_KEY = KEY;
  delete process.env.CRYPTOMUS_CALLBACK_URL;

  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({
      url: String(url),
      headers: init?.headers ?? {},
      body: String(init?.body ?? ''),
      method: init?.method,
    });
    return new Response(
      JSON.stringify(
        reply ?? {
          state: 0,
          result: { uuid: 'inv-1', order_id: 'pay_1', url: 'https://pay.cryptomus.com/inv-1' },
        }
      ),
      { status, headers: { 'content-type': 'application/json' } }
    );
  };
  let thrown = null;
  try {
    await run(cryptomus);
  } catch (error) {
    thrown = error;
  } finally {
    globalThis.fetch = realFetch;
  }
  return { seen, thrown, cryptomus };
}

const INVOICE_INPUT = {
  paymentId: 'pay_1',
  reference: 'FT-PAY-1',
  credits: 100,
  amountCents: 5_000,
  currency: 'usd',
  returnUrl: 'https://app.example.com/credits/return?payment=pay_1',
  cancelUrl: 'https://app.example.com/credits?cancelled=pay_1',
};

/* ------------------------------------------------- what goes over the wire */

test('an invoice is a signed POST carrying the payment id as the order', async () => {
  const { seen } = await capture((cryptomus) => cryptomus.createInvoice(INVOICE_INPUT));
  assert.equal(seen.length, 1);
  const [call] = seen;

  assert.equal(call.url, 'https://api.cryptomus.com/v1/payment');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.merchant, MERCHANT);

  const body = JSON.parse(call.body);
  // The whole matching scheme: this comes back on the callback untouched and
  // is how an event finds its payment.
  assert.equal(body.order_id, 'pay_1');
  // A decimal string in the merchant's currency, built from the integer.
  assert.equal(body.amount, '50.00');
  assert.equal(body.currency, 'USD');
  assert.equal(body.url_success, INVOICE_INPUT.returnUrl);
  assert.equal(body.url_return, INVOICE_INPUT.cancelUrl);
});

test('the signature covers the exact bytes that are sent', async () => {
  const { seen } = await capture((cryptomus) => cryptomus.createInvoice(INVOICE_INPUT));
  const [call] = seen;
  /*
   * The claim that cannot be checked by eye.
   *
   * Signing an object and sending a separately-serialized one produces two
   * strings that agree almost always - different key order, a number formatted
   * differently - and the failure is a 401 from Cryptomus with nothing in it
   * that says why. So this asserts over `call.body` itself rather than over a
   * body rebuilt here.
   */
  assert.equal(call.headers.sign, expectedSign(call.body));
});

test('no callback URL is sent when none is configured', async () => {
  /*
   * An EMPTY url_callback would be worse than none: it overrides the address
   * set in the Cryptomus dashboard, which is where most installations will set
   * it, and the callbacks then go nowhere.
   */
  const { seen } = await capture((cryptomus) => cryptomus.createInvoice(INVOICE_INPUT));
  assert.equal('url_callback' in JSON.parse(seen[0].body), false);
});

test('and it is sent when one is', async () => {
  process.env.CRYPTOMUS_CALLBACK_URL = 'https://api.example.com/api/payments/webhook/cryptomus';
  const { seen } = await capture(async (cryptomus) => {
    process.env.CRYPTOMUS_CALLBACK_URL = 'https://api.example.com/api/payments/webhook/cryptomus';
    await cryptomus.createInvoice(INVOICE_INPUT);
  });
  assert.equal(
    JSON.parse(seen[0].body).url_callback,
    'https://api.example.com/api/payments/webhook/cryptomus'
  );
  delete process.env.CRYPTOMUS_CALLBACK_URL;
});

test('a refusal dressed as HTTP 200 is still a refusal', async () => {
  /*
   * Cryptomus answers 200 with `state: 1` when it will not do the thing. A
   * check on `response.ok` alone would hand the caller an invoice with no URL
   * on it, and the buyer would be sent to `undefined`.
   */
  const { thrown } = await capture((cryptomus) => cryptomus.createInvoice(INVOICE_INPUT), {
    reply: { state: 1, message: 'The amount is below the minimum.' },
  });
  assert.ok(thrown, 'the call resolved');
  assert.equal(thrown.name, 'CryptomusError');
  assert.match(thrown.message, /below the minimum/);
  // Refused, not unreachable - so the payment row above this may be closed.
  assert.equal(thrown.transport, false);
});

test('a connection that never answered is marked as transport', async () => {
  useTempStorage(`cryptomus-transport-${Math.random().toString(36).slice(2)}`);
  process.env.CRYPTOMUS_MERCHANT_ID = MERCHANT;
  process.env.CRYPTOMUS_PAYMENT_API_KEY = KEY;
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNRESET');
  };
  try {
    await assert.rejects(
      () => cryptomus.createInvoice(INVOICE_INPUT),
      (error) => {
        /*
         * The flag the payment service reads to decide whether a payment can
         * be closed. Without it a dropped socket closes a payment for an
         * invoice that exists at Cryptomus and that somebody may still pay -
         * money taken, nothing granted.
         */
        assert.equal(error.name, 'CryptomusError');
        assert.equal(error.transport, true);
        return true;
      }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unconfigured server refuses before it opens a socket', async () => {
  useTempStorage(`cryptomus-unset-${Math.random().toString(36).slice(2)}`);
  delete process.env.CRYPTOMUS_MERCHANT_ID;
  delete process.env.CRYPTOMUS_PAYMENT_API_KEY;
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('a socket was opened');
  };
  try {
    await assert.rejects(() => cryptomus.createInvoice(INVOICE_INPUT), /not configured/);
  } finally {
    globalThis.fetch = realFetch;
  }
  process.env.CRYPTOMUS_MERCHANT_ID = MERCHANT;
  process.env.CRYPTOMUS_PAYMENT_API_KEY = KEY;
});

/* ------------------------------------------------------- the signature itself */

test('signBody is md5 over base64 of the body plus the key', () => {
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  const json = '{"amount":"50.00"}';
  assert.equal(cryptomus.signBody(json, KEY), expectedSign(json));
  // A different key is a different signature, which is the entire point.
  assert.notEqual(cryptomus.signBody(json, KEY), cryptomus.signBody(json, 'other'));
});

test('a webhook signed the way Cryptomus signs one verifies, without its sign', () => {
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  const fields = { uuid: 'inv-1', order_id: 'pay_1', amount: '50.00', status: 'paid' };
  const raw = Buffer.from(JSON.stringify({ ...fields, sign: expectedSign(JSON.stringify(fields)) }));

  const result = cryptomus.verifyWebhookSign(raw, KEY);
  assert.equal(result.ok, true);
  assert.deepEqual(result.body, fields);
  // `sign` is stripped, so nothing downstream can mistake it for data.
  assert.equal('sign' in result.body, false);
});

test('a webhook that was edited after signing does not verify', () => {
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  const fields = { uuid: 'inv-1', order_id: 'pay_1', amount: '50.00', status: 'paid' };
  const tampered = { ...fields, amount: '0.01', sign: expectedSign(JSON.stringify(fields)) };

  const result = cryptomus.verifyWebhookSign(Buffer.from(JSON.stringify(tampered)), KEY);
  assert.equal(result.ok, false);
  // Nothing is handed back on a failure, so a caller cannot read a body it has
  // not proved - which is the rule this whole scheme makes awkward to keep.
  assert.equal(result.body, null);
});

test('a webhook with no signature, an empty key, or junk bytes does not verify', () => {
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  const fields = { uuid: 'inv-1', status: 'paid' };
  const signed = Buffer.from(
    JSON.stringify({ ...fields, sign: expectedSign(JSON.stringify(fields)) })
  );

  assert.equal(cryptomus.verifyWebhookSign(Buffer.from(JSON.stringify(fields)), KEY).ok, false);
  assert.equal(cryptomus.verifyWebhookSign(signed, '').ok, false);
  assert.equal(cryptomus.verifyWebhookSign(Buffer.from('not json'), KEY).ok, false);
  // A JSON array parses and has no fields. It must not be treated as a body.
  assert.equal(cryptomus.verifyWebhookSign(Buffer.from('[1,2,3]'), KEY).ok, false);
});

/* ----------------------------------------------------------- configuration */

test('both halves are needed, and they are the same halves for webhooks', () => {
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  const both = { CRYPTOMUS_MERCHANT_ID: MERCHANT, CRYPTOMUS_PAYMENT_API_KEY: KEY };

  assert.equal(cryptomus.isCryptomusConfigured(both), true);
  assert.equal(cryptomus.isCryptomusConfigured({ CRYPTOMUS_MERCHANT_ID: MERCHANT }), false);
  assert.equal(cryptomus.isCryptomusConfigured({ CRYPTOMUS_PAYMENT_API_KEY: KEY }), false);
  assert.equal(cryptomus.isCryptomusConfigured({}), false);

  /*
   * The asymmetry worth knowing about.
   *
   * Stripe and Coinbase can verify a webhook with only the webhook secret, so
   * an installation can stop OFFERING a method and still settle what is
   * already out there. Cryptomus signs callbacks with the key it authenticates
   * requests with, so there is no such state: unconfigure it and the endpoint
   * starts answering 503 to money that has already been sent.
   */
  assert.equal(cryptomus.canVerifyCryptomusWebhooks(both), true);
  assert.equal(cryptomus.canVerifyCryptomusWebhooks({ CRYPTOMUS_PAYMENT_API_KEY: KEY }), false);
});

test('whitespace around a pasted key is not part of the key', () => {
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  // Copied out of a dashboard with a trailing newline, which is how this
  // arrives in practice and how every signature would otherwise be wrong.
  assert.equal(cryptomus.cryptomusPaymentKey({ CRYPTOMUS_PAYMENT_API_KEY: ` ${KEY}\n` }), KEY);
  assert.equal(cryptomus.cryptomusMerchantId({ CRYPTOMUS_MERCHANT_ID: `${MERCHANT} ` }), MERCHANT);
});
