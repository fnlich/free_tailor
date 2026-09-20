# Buying credits, end to end

The unit tests in `backend/test/*.test.js` prove each piece. These three files
prove the pieces are joined up: a real server on a real port, the real routers,
the real database, the real webhook mount, and a browser clicking the real
pages.

The only thing faked is the company at the other end of the wire. There is no
way around that — a real end-to-end run needs live provider keys and a webhook
that can reach this machine from the internet, which is the checklist at the
bottom rather than something a script can arrange.

## What is faked, and what is not

`fake-providers.js` is loaded with `node --require` **before** the app, and
replaces exactly four functions: `createCheckoutSession`, `getCheckoutSession`,
`refundPaymentIntent` and `createCharge`. Everything else is the shipping code.

It also serves a checkout page of its own on port 4242, because a redirect the
browser cannot follow is not a test of anything. Pressing **Pay** there signs a
webhook with the real HMAC scheme and posts it to the real endpoint, exactly as
Stripe or Coinbase would; the server's own verifier decides whether to believe
it.

## Running it

```bash
# 1. A .env with fake provider keys. A method is offered only when both of its
#    keys are set, and the values never leave this machine.
cat >> .env <<'EOF'
STRIPE_SECRET_KEY=sk_test_e2e_not_a_real_key
STRIPE_WEBHOOK_SECRET=whsec_e2e_local_secret
COINBASE_COMMERCE_API_KEY=cb_test_e2e_not_a_real_key
COINBASE_COMMERCE_WEBHOOK_SECRET=cb_whsec_e2e_local_secret
ADMIN_EMAILS=boss@example.com
EOF

# 2. The server, with the fake providers in front of it
cd backend && npm run build
node --require test/e2e/fake-providers.js dist/index.js

# 3. The API walkthrough, in another terminal
node test/e2e/walkthrough.js

# 4. The browser walkthrough, with the frontend running too
npm run start --prefix ../frontend
node test/e2e/browser.js          # needs playwright; PLAYWRIGHT_MODULE=<path> if it is not local
```

Both scripts exit non-zero on the first failing claim and print every check.

## Sign-in is seeded, deliberately

`services/auth/mailer.ts` refuses to pretend an email was sent, so there is no
offline path to a login code and no dev backdoor. Rather than add one, these
scripts write a session row directly and send its token as a Bearer token —
which is what the browser would be carrying anyway. Sign-in is not what these
scripts are testing.

## What they check

`walkthrough.js` — 36 claims over HTTP: both methods offered with the price
from settings; a request carrying its own price priced by the server anyway;
a checkout that credits nothing until the webhook lands; the return URL
visited before paying crediting nothing; card and crypto both crediting on a
signed event; a retried delivery crediting nothing further; a cancelled
checkout closing without crediting; another account's payment answering 404;
forged and unsigned webhooks refused; the admin list and a refund that reports
what it reversed; the amount the provider was actually asked for; and an
event payload that keeps the amount and drops the customer.

`browser.js` — the same purchase with a mouse: the buy page priced from the
server, the button reaching a checkout, the return page waiting for the
webhook rather than congratulating on arrival, the balance and the ledger
afterwards, a cancelled checkout, and an admin refunding from the UI.

## The part a script cannot do

Before taking real money, do this once against Stripe test mode on a machine
the internet can reach:

1. `stripe listen --forward-to localhost:3001/api/payments/webhook/stripe`,
   and put the signing secret it prints in `STRIPE_WEBHOOK_SECRET`.
2. Buy credits with `4242 4242 4242 4242`. Watch the balance move and a
   `Bought` row appear in the credit history.
3. `stripe trigger checkout.session.completed` for the same session, and
   confirm the balance does **not** move again.
4. Refund from the admin payments page, and check the refund in the Stripe
   dashboard.
5. Repeat 1-2 in the Coinbase Commerce sandbox.
