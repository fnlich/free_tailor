/*
 * A stand-in for Stripe and Coinbase Commerce, loaded into the real server.
 *
 * Run as `node --require ./fake-providers.js dist/index.js`, so this file is
 * evaluated before the app requires its integration modules and replaces every
 * function that reaches the network. NOTHING else is replaced: the routes,
 * the database, the webhook mount, the signature verification and the ledger
 * are the real ones, which is the whole point - the only thing faked is the
 * company at the other end of the wire.
 *
 * It also serves a hosted checkout page of its own, because a checkout the
 * browser cannot actually visit is not an end-to-end test of anything. Pay
 * sends a properly signed webhook to the server, exactly as the real provider
 * would, and then redirects the browser back to the success URL.
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const stripe = require(path.join(DIST, 'integrations', 'stripe.js'));
const coinbase = require(path.join(DIST, 'integrations', 'coinbaseCommerce.js'));
const cryptomus = require(path.join(DIST, 'integrations', 'cryptomus.js'));

const FAKE_PORT = Number(process.env.FAKE_PROVIDER_PORT || 4242);
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`;

/** Everything the fake has been asked for, so a test can assert on it. */
const ledger = {
  sessions: [],
  charges: [],
  refunds: [],
  webhooks: [],
  intents: [],
  customers: [],
  detached: [],
  transfers: [],
};
const byId = new Map();

let counter = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}${(counter += 1)}`;

stripe.createCheckoutSession = async (input) => {
  const id = nextId('cs_test');
  const record = { ...input, id, provider: 'stripe' };
  byId.set(id, record);
  ledger.sessions.push(record);
  /*
   * Elements mode: a client secret, not a URL.
   *
   * The real Payment Element is an iframe served by Stripe and cannot be
   * driven offline, so the hosted page below stands in for it. What it
   * reproduces faithfully is the part that matters to this server: pressing
   * Pay sends a SIGNED webhook, and the browser lands on the return_url.
   */
  return { id, client_secret: `${id}_secret`, url: `http://127.0.0.1:${FAKE_PORT}/checkout/${id}` };
};

stripe.getCheckoutSession = async (id) => {
  const record = byId.get(id);
  return { id, payment_status: 'paid', payment_intent: `pi_${id}`, metadata: record ? { paymentId: record.paymentId } : {} };
};

stripe.refundPaymentIntent = async (intent, paymentId) => {
  ledger.refunds.push({ intent, paymentId });
};

/* ------------------------------------------------------------ saved cards */

/*
 * The customer and payment-method side of Stripe.
 *
 * Kept as simple as it can be while still being wrong in the ways Stripe is
 * wrong: a saved-card charge returns a PAYMENT INTENT (`pi_`) and not a
 * session, so `provider_ref` holds two id spaces and anything that confuses
 * them breaks here rather than in production. The intent's webhook is
 * delivered on a tick of its own, because Stripe's arrives over a separate
 * connection and can beat or trail the HTTP response - a fake that settles
 * inline would hide every ordering bug this server has to survive.
 */
const customers = new Map();
const methods = new Map();

/** A card that exists at the fake provider, so a session can "save" it. */
function fakeCard(id) {
  if (!methods.has(id)) {
    methods.set(id, {
      id,
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 },
    });
  }
  return methods.get(id);
}

stripe.createCustomer = async (input) => {
  // Idempotent per account, exactly as the real one is through its key: two
  // tabs racing must not produce two customers holding half the cards each.
  const existing = customers.get(input.userId);
  if (existing) return { id: existing };
  const id = nextId('cus_test');
  customers.set(input.userId, id);
  ledger.customers.push({ id, userId: input.userId, email: input.email });
  return { id };
};

stripe.getPaymentIntent = async (intentId) => {
  /*
   * A session's intent is `pi_<sessionId>`, which is what getCheckoutSession
   * hands back, so the record behind it may be the session rather than an
   * intent of its own. Either way a payment method comes with it, so a card
   * can be recorded for reuse.
   */
  const record = byId.get(intentId) ?? byId.get(intentId.replace(/^pi_/, ''));
  const method = fakeCard(`pm_${intentId}`);
  return {
    id: intentId,
    status: 'succeeded',
    amount_received: record ? record.amountCents : undefined,
    currency: record ? record.currency : undefined,
    payment_method: method.id,
    /*
     * The buyer's own answer, coming back.
     *
     * Stripe copies `payment_intent_data.setup_future_usage` from the session
     * onto the intent, and the server reads it as consent to keep the card.
     * A fake that always returned it would hide the difference between a
     * buyer who ticked the box and one who did not - which is the whole
     * question this field answers.
     */
    setup_future_usage: record && record.saveCard ? 'off_session' : null,
  };
};

stripe.getPaymentMethod = async (methodId) => fakeCard(methodId);

stripe.detachPaymentMethod = async (methodId) => {
  methods.delete(methodId);
  ledger.detached.push(methodId);
};

stripe.chargeSavedCard = async (input) => {
  const id = nextId('pi_test');
  const record = { ...input, id, provider: 'stripe', kind: 'intent' };
  byId.set(id, record);
  ledger.intents.push(record);

  /*
   * Off session, so there is nobody to challenge - unless the test asks for
   * one. `FAKE_REQUIRE_ACTION=1` makes every saved-card charge come back
   * `requires_action`, which is the branch that hands a client secret to the
   * browser instead of waiting for a webhook.
   */
  if (process.env.FAKE_REQUIRE_ACTION === '1') {
    return { id, status: 'requires_action', client_secret: `${id}_secret`, currency: input.currency };
  }

  // Out of band, like the real thing. Failures are logged and not thrown: a
  // webhook that cannot be delivered is the provider's problem, not the
  // caller's, and throwing here would mark a charge failed that succeeded.
  setTimeout(() => {
    deliver(record, 'paid').catch((error) => {
      console.warn('[fake-provider] could not deliver an intent webhook', error);
    });
  }, 25);

  return { id, status: 'succeeded', amount_received: input.amountCents, currency: input.currency };
};

coinbase.createCharge = async (input) => {
  const code = nextId('CHG');
  const record = { ...input, id: code, provider: 'coinbase' };
  byId.set(code, record);
  ledger.charges.push(record);
  return { code, hosted_url: `http://127.0.0.1:${FAKE_PORT}/checkout/${code}` };
};

coinbase.getCharge = async (code) => ({ code, timeline: [] });

/*
 * Cryptomus, which is what a crypto checkout actually opens now.
 *
 * The same hosted page as everything else, because the shape is the same: a
 * URL to send the browser to, and a signed callback that settles. What it adds
 * is the one thing about Cryptomus that is genuinely different - the signature
 * travels INSIDE the body - so the real verifier in the server is exercised
 * rather than a stub of it.
 */
cryptomus.createInvoice = async (input) => {
  const uuid = nextId('inv');
  const record = { ...input, id: uuid, provider: 'cryptomus' };
  byId.set(uuid, record);
  ledger.charges.push(record);
  return { uuid, order_id: input.paymentId, url: `http://127.0.0.1:${FAKE_PORT}/checkout/${uuid}` };
};

/* ----------------------------------------------------------- the chains */

/*
 * A stand-in for four blockchains, and the one part of this file that could
 * not have been written any other way.
 *
 * The machine this was developed on cannot reach a single chain endpoint - the
 * egress policy refuses every one of them - so there is no "point it at a
 * testnet" option. What there is instead is this: the chain RPC seam replaced
 * with functions that serve from a small in-memory ledger, and an HTTP route
 * below that lets a test say "this transfer just landed".
 *
 * It is faithful about the things that have bitten this code:
 *   - an ERC-20 transfer is a LOG with the amount in `data` and the recipient
 *     as a 32-byte topic, not a field called `amount`;
 *   - TRON answers decimal strings from a REST index, not hex from an RPC;
 *   - Bitcoin answers an address history whose outputs must be summed;
 *   - and a transfer starts at zero confirmations and gets deeper, so the
 *     seen-then-credited path is exercised rather than skipped.
 */

const chainRpc = require(path.join(DIST, 'services', 'payments', 'chain', 'rpc.js'));
const { ASSETS, TRANSFER_TOPIC } = require(path.join(DIST, 'config', 'chainAssets.js'));
const watcher = require(path.join(DIST, 'services', 'payments', 'chain', 'watcher.js'));

/** Transfers a test has announced, per chain. */
const chainLedger = { ethereum: [], bsc: [], tron: [], bitcoin: [] };
/**
 * The current block height per chain, which a test can advance.
 *
 * Seeded ABOVE whatever the database already remembers having read, because a
 * fake chain's tip resets on every restart while the real cursor is persisted
 * - and a cursor ahead of the tip means the watcher correctly reads nothing,
 * for ever. That is right in production (a tip only grows, so it means the
 * endpoint is on the wrong network) and merely annoying here.
 */
const chainTips = { ethereum: 21_000_000, bsc: 44_000_000, tron: 66_000_000, bitcoin: 870_000 };

/*
 * Raised past the stored cursor the first time each chain is asked about.
 *
 * LAZILY, and that is the whole point: this file is loaded by `node --require`
 * before the app has even resolved its database directory, so reading the
 * cursor at load time reads nothing (or creates an empty database in the wrong
 * place). By the time a tip is actually wanted, the app is up.
 */
const seeded = new Set();

function tipFor(chain) {
  if (!seeded.has(chain)) {
    seeded.add(chain);
    try {
      const cursors = require(path.join(DIST, 'database', 'chainCursorRepository.js'));
      const stored = cursors.getCursor(chain);
      if (typeof stored === 'number' && stored >= chainTips[chain]) {
        chainTips[chain] = stored + 100;
        console.log(`[fake-provider] ${chain} tip raised to ${chainTips[chain]} past a stored cursor.`);
      }
    } catch {
      // No database yet, which is the ordinary first run.
    }
  }
  return chainTips[chain];
}

function topicFor(address) {
  return `0x${String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

chainRpc.rpcCall = async (endpoints, method, params) => {
  // Which EVM chain is being asked is decided by the endpoint list, exactly as
  // it is in production - the BNB routing lives in the reader, not here.
  const chain = String(endpoints[0] ?? '').includes('bsc') ? 'bsc' : 'ethereum';

  if (method === 'eth_chainId') return chain === 'bsc' ? '0x38' : '0x1';
  if (method === 'eth_blockNumber') return hex(tipFor(chain));

  if (method === 'eth_getLogs') {
    const filter = params[0] ?? {};
    const from = Number.parseInt(filter.fromBlock ?? '0x0', 16);
    const to = Number.parseInt(filter.toBlock ?? '0x0', 16);
    return chainLedger[chain]
      .filter((entry) => entry.height >= from && entry.height <= to)
      .filter((entry) => entry.contract.toLowerCase() === String(filter.address).toLowerCase())
      .map((entry) => ({
        address: entry.contract,
        topics: [TRANSFER_TOPIC, topicFor('0x00000000000000000000000000000000000000ff'), topicFor(entry.to)],
        data: `0x${BigInt(entry.amountAtomic).toString(16).padStart(64, '0')}`,
        blockNumber: hex(entry.height),
        transactionHash: entry.txid,
        removed: false,
      }));
  }

  if (method === 'eth_getTransactionReceipt') {
    const found = chainLedger[chain].find((entry) => entry.txid === params[0]);
    return found ? { blockNumber: hex(found.height), status: '0x1' } : null;
  }

  throw new Error(`the fake chain does not serve ${method}`);
};

chainRpc.getJson = async (endpoints, requestPath) => {
  if (requestPath.startsWith('/simple/price')) {
    // A plausible, fixed price. Fixed so a test can do the arithmetic itself.
    return { bitcoin: { usd: 50_000 }, ethereum: { usd: 3_000 }, binancecoin: { usd: 600 } };
  }

  if (requestPath === '/blocks/tip/height') return tipFor('bitcoin');

  const history = requestPath.match(/^\/address\/([^/]+)\/txs$/);
  if (history) {
    const address = decodeURIComponent(history[1]);
    return chainLedger.bitcoin
      .filter((entry) => entry.to === address)
      .map((entry) => ({
        txid: entry.txid,
        status: { confirmed: true, block_height: entry.height },
        vout: [
          { scriptpubkey_address: address, value: Number(entry.amountAtomic) },
          // Change going back to the sender, which must not be counted.
          { scriptpubkey_address: 'bc1qchangeaddressxxxxxxxxxxxxxxxxxxxxxxx', value: 123_456 },
        ],
      }));
  }

  const tx = requestPath.match(/^\/tx\/([^/]+)$/);
  if (tx) {
    const found = chainLedger.bitcoin.find((entry) => entry.txid === decodeURIComponent(tx[1]));
    return found
      ? { status: { confirmed: true, block_height: found.height } }
      : { status: { confirmed: false } };
  }

  const trc20 = requestPath.match(/^\/v1\/accounts\/([^/]+)\/transactions\/trc20/);
  if (trc20) {
    const address = decodeURIComponent(trc20[1]);
    return {
      data: chainLedger.tron
        .filter((entry) => entry.to === address)
        .map((entry) => ({
          transaction_id: entry.txid,
          token_info: { address: entry.contract, decimals: 6, symbol: 'USDT' },
          to: address,
          value: String(entry.amountAtomic),
        })),
    };
  }

  throw new Error(`the fake chain does not serve GET ${requestPath}`);
};

chainRpc.postJson = async (endpoints, requestPath, body) => {
  if (requestPath === '/wallet/getnowblock') {
    return { block_header: { raw_data: { number: tipFor('tron') } } };
  }
  if (requestPath === '/wallet/gettransactioninfobyid') {
    const found = chainLedger.tron.find((entry) => entry.txid === body.value);
    return found ? { blockNumber: found.height } : {};
  }
  throw new Error(`the fake chain does not serve POST ${requestPath}`);
};

/**
 * Announces a transfer, as if somebody had just sent coin.
 *
 * `depth` is how many confirmations it should already have, so a test can put
 * one just below the threshold to exercise `seen` and then deepen it.
 */
function announceTransfer({ asset, to, amountAtomic, txid, depth = 0 }) {
  const definition = ASSETS[asset];
  if (!definition) throw new Error(`no such asset ${asset}`);
  const chain = definition.chain;
  const height = tipFor(chain) - Math.max(0, depth - 1);

  chainLedger[chain].push({
    txid: txid || `0xfake${Math.random().toString(16).slice(2, 10)}`,
    to,
    amountAtomic: String(amountAtomic),
    contract: definition.contract ?? '',
    height,
  });
  ledger.transfers.push({ asset, to, amountAtomic: String(amountAtomic), depth });
  return chainLedger[chain][chainLedger[chain].length - 1];
}

/** Moves a chain forward, which deepens everything already on it. */
function advanceChain(chain, blocks) {
  chainTips[chain] = tipFor(chain) + blocks;
}

/* ------------------------------------------------------- the hosted page */

function stripeIntentEvent(record, type) {
  return JSON.stringify({
    id: nextId('evt'),
    type,
    data: {
      object: {
        id: record.id,
        // What the intent branch reads. `amount_received` and not
        // `amount_total`: the two events carry the figure under different
        // names, and reading the wrong one settles at zero.
        amount_received: type === 'payment_intent.succeeded' ? record.amountCents : 0,
        currency: record.currency,
        status: type === 'payment_intent.succeeded' ? 'succeeded' : 'requires_payment_method',
        /*
         * The metadata a real intent carries, INCLUDING the payment id.
         *
         * The server deliberately does not read it - an intent is settled by
         * provider reference alone, because an embedded checkout emits this
         * event too and its metadata names a payment already settled through
         * the session. Sending it anyway is what makes that hold provable
         * rather than merely stated.
         */
        metadata: { paymentId: record.paymentId, reference: record.reference, flow: 'saved-card' },
      },
    },
  });
}

function stripeEvent(record, type) {
  return JSON.stringify({
    id: nextId('evt'),
    type,
    data: {
      object: {
        id: record.id,
        payment_status: type === 'checkout.session.completed' ? 'paid' : 'unpaid',
        amount_total: record.amountCents,
        currency: record.currency,
        // The customer details a real Stripe event carries, so the redaction
        // this server does on the way into the database has something to bite.
        customer_email: 'e2e-buyer@example.com',
        customer_details: { email: 'e2e-buyer@example.com', address: { line1: '1 Test Street' } },
        metadata: { paymentId: record.paymentId, reference: record.reference },
      },
    },
  });
}

/**
 * A Cryptomus callback, signed the way Cryptomus signs one.
 *
 * `sign` is computed over the serialization of everything ELSE and then added
 * to it, so this builds the body twice on purpose - which is exactly the shape
 * the server has to unpick to verify it.
 */
function cryptomusBody(record, status) {
  const fields = {
    type: 'payment',
    uuid: record.id,
    order_id: record.paymentId,
    amount: (record.amountCents / 100).toFixed(2),
    payment_amount: (record.amountCents / 100).toFixed(2),
    currency: record.currency.toUpperCase(),
    status,
    is_final: true,
    // A real callback carries more than this. The extra field is here so the
    // signature is over something the server does not read, proving it signs
    // the whole body rather than the fields it happens to care about.
    additional_data: record.reference,
  };
  const json = JSON.stringify(fields);
  const sign = crypto
    .createHash('md5')
    .update(Buffer.from(json, 'utf8').toString('base64') + (process.env.CRYPTOMUS_PAYMENT_API_KEY || ''))
    .digest('hex');
  return JSON.stringify({ ...fields, sign });
}

function coinbaseEvent(record, type) {
  return JSON.stringify({
    event: {
      id: nextId('cbevt'),
      type,
      data: {
        code: record.id,
        pricing: { local: { amount: (record.amountCents / 100).toFixed(2), currency: record.currency.toUpperCase() } },
        metadata: { paymentId: record.paymentId, reference: record.reference },
      },
    },
  });
}

async function deliver(record, outcome, replayBody = null) {
  if (record.provider === 'cryptomus') {
    const status = outcome === 'paid' ? 'paid' : 'cancel';
    const body = replayBody ?? cryptomusBody(record, status);
    record.lastBody = body;
    const url = `${BACKEND}/api/payments/webhook/cryptomus`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await response.text();
    ledger.webhooks.push({ url, status: response.status, body: text, type: `payment.${status}` });
    return { status: response.status, text };
  }

  const isStripe = record.provider === 'stripe';
  // A saved-card charge is an intent, and intents have their own event names.
  const isIntent = record.kind === 'intent';
  const type = isStripe
    ? isIntent
      ? outcome === 'paid'
        ? 'payment_intent.succeeded'
        : 'payment_intent.payment_failed'
      : outcome === 'paid'
        ? 'checkout.session.completed'
        : 'checkout.session.expired'
    : outcome === 'paid'
      ? 'charge:confirmed'
      : 'charge:expired';

  const body =
    replayBody ??
    (isStripe
      ? isIntent
        ? stripeIntentEvent(record, type)
        : stripeEvent(record, type)
      : coinbaseEvent(record, type));
  record.lastBody = body;
  const headers = { 'content-type': 'application/json' };

  if (isStripe) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET || '')
      .update(`${timestamp}.${body}`)
      .digest('hex');
    headers['stripe-signature'] = `t=${timestamp},v1=${signature}`;
  } else {
    headers['x-cc-webhook-signature'] = crypto
      .createHmac('sha256', process.env.COINBASE_COMMERCE_WEBHOOK_SECRET || '')
      .update(body)
      .digest('hex');
  }

  const url = `${BACKEND}/api/payments/webhook/${isStripe ? 'stripe' : 'coinbase'}`;
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  ledger.webhooks.push({ url, status: response.status, body: text, type });
  return { status: response.status, text };
}

const PAGE = (record, note = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>Fake provider checkout</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#f6f7f9}
.card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 1px 8px rgba(0,0,0,.1);max-width:420px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;cursor:pointer;margin-right:8px}
.pay{background:#635bff;color:#fff}.cancel{background:#eee}
code{background:#f0f0f4;padding:2px 5px;border-radius:4px}</style></head>
<body><div class="card">
<h1>Fake ${record.provider} checkout</h1>
<p><strong>${record.credits} credits</strong> for ${(record.amountCents / 100).toFixed(2)} ${record.currency.toUpperCase()}</p>
<p>Reference <code id="reference">${record.reference}</code></p>
<p style="color:#666">${note}</p>
<form method="POST" action="/pay/${record.id}"><button class="pay" id="pay" type="submit">Pay</button></form>
<form method="POST" action="/cancel/${record.id}"><button class="cancel" id="cancel" type="submit">Cancel</button></form>
</div></body></html>`;

http
  .createServer(async (req, res) => {
    const [, action, id] = req.url.split('?')[0].split('/');
    const record = byId.get(id || '');

    if (action === 'state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ledger));
      return;
    }

    /*
     * `POST /chain/send?asset=..&to=..&amount=..&depth=..`
     *
     * How a test says "somebody just sent coin". There is no other way to do
     * it: this machine cannot reach a chain, so the only transfers that exist
     * are the ones a test announces.
     */
    /*
     * `POST /chain/advance?chain=ethereum&blocks=30` - bury what is on it.
     * `POST /chain/sweep?chain=ethereum`             - run one watcher pass.
     *
     * The sweep trigger exists because the watcher's real interval is thirty
     * seconds and a walkthrough that waited for it twice would take a minute
     * to prove something that happens instantly. It calls the SAME function
     * the timer calls - nothing about the settlement path is bypassed, only
     * the waiting.
     */
    if (action === 'chain' && (id === 'advance' || id === 'sweep')) {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      const chain = query.get('chain') ?? 'ethereum';
      try {
        if (id === 'advance') {
          advanceChain(chain, Number.parseInt(query.get('blocks') ?? '1', 10));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ chain, tip: tipFor(chain) }));
          return;
        }
        const credited = await watcher.sweepChain(chain);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ chain, credited }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (action === 'chain') {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      try {
        const sent = announceTransfer({
          asset: query.get('asset'),
          to: query.get('to'),
          amountAtomic: query.get('amount'),
          depth: Number.parseInt(query.get('depth') ?? '0', 10),
        });
        const blocks = Number.parseInt(query.get('advance') ?? '0', 10);
        if (Number.isFinite(blocks) && blocks > 0) {
          advanceChain(ASSETS[query.get('asset')].chain, blocks);
        }
        console.log(`[fake-provider] ${query.get('asset')} ${query.get('amount')} -> ${sent.txid}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sent));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (!record) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such checkout');
      return;
    }
    if (action === 'checkout') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(record));
      return;
    }
    if (action === 'replay') {
      // What a provider's retry is: the SAME event, signed afresh. A new
      // signature every attempt, but one event id - which is the thing the
      // server is supposed to recognise.
      const result = await deliver(record, 'paid', record.lastBody);
      console.log(`[fake-provider] replay ${record.reference} -> webhook ${result.status} ${result.text}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(result.text);
      return;
    }
    if (action === 'pay' || action === 'cancel') {
      const outcome = action === 'pay' ? 'paid' : 'expired';
      const result = await deliver(record, outcome);
      const target =
      action === 'pay'
        ? record.returnUrl || record.successUrl || record.redirectUrl
        : record.cancelUrl;
      console.log(`[fake-provider] ${action} ${record.reference} -> webhook ${result.status}`);

      /*
       * There is not always somewhere to go.
       *
       * With the form embedded, a Stripe session has no cancel URL at all -
       * cancelling is simply not confirming, and the customer never left our
       * page to begin with. The session still expires and still fires its
       * webhook, which is the half that matters here.
       */
      if (!target) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outcome, webhook: result.status }));
        return;
      }
      res.writeHead(303, { location: target });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(FAKE_PORT, '127.0.0.1', () => {
    console.log(`[fake-provider] listening on http://127.0.0.1:${FAKE_PORT}`);
  });

module.exports = { ledger, announceTransfer, advanceChain };
