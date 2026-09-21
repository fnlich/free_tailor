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

It replaces five exports in all - `createCheckoutSession`, `getCheckoutSession`,
`refundPaymentIntent`, `createCharge` and `getCharge` - and serves a checkout
page of its own on port 4242. Pressing **Pay** there
signs a webhook with the real HMAC scheme and posts it to the real endpoint,
exactly as Stripe would; the server's own verifier decides whether to believe
it.

### What a fake cannot do, now the form is embedded

The card form is Stripe's Payment Element, an iframe served by js.stripe.com. It
will not mount against a made-up publishable key, so **no script here can type a
card number** - that needs a live test-mode key and a network. `browser.js` is
honest about the boundary: it proves the part that the embedding was for (that
pressing Pay navigates nowhere, and the amount field is replaced by the payment
panel in place), then drives the payment to paid from the provider's side, which
is what a real confirmation ends up doing anyway - a signed webhook, server to
server.

It also asserts the form either mounts **or says plainly that it could not**. A
sandbox with no route to js.stripe.com must not leave a customer watching a
spinner, and that assertion is what keeps it from regressing.

## Running it

```bash
# 1. A .env with fake provider keys. A method is offered only when both of its
#    keys are set, and the values never leave this machine.
cat >> .env <<'EOF'
STRIPE_SECRET_KEY=sk_test_e2e_not_a_real_key
STRIPE_PUBLISHABLE_KEY=pk_test_e2e_not_a_real_key
STRIPE_WEBHOOK_SECRET=whsec_e2e_local_secret
COINBASE_COMMERCE_API_KEY=cb_test_e2e_not_a_real_key
COINBASE_COMMERCE_WEBHOOK_SECRET=cb_whsec_e2e_local_secret
ADMIN_EMAILS=boss@example.com
EOF

# 2. The server, with the fake providers in front of it
cd backend && npm run build
node --require ./test/e2e/fake-providers.js dist/index.js

# 3. The API walkthrough, in another terminal
node test/e2e/walkthrough.js

# 4. The browser walkthroughs, with the frontend running too
npm run start --prefix ../frontend
node test/e2e/buy-credits.js      # the three-step purchase dialog; puppeteer
node test/e2e/browser.js          # the OLD buy page; needs playwright, which may not be installed
```

Every script exits non-zero on the first failing claim and prints every check.
`buy-credits.js` uses puppeteer, which the backend already installs for PDF
rendering, so it runs anywhere this project does; `browser.js` needs playwright
and will not run on a checkout without it.

## Sign-in is seeded, deliberately

`services/auth/mailer.ts` refuses to pretend an email was sent, so there is no
offline path to a login code and no dev backdoor. Rather than add one, these
scripts write a session row directly and send its token as a Bearer token —
which is what the browser would be carrying anyway. Sign-in is not what these
scripts are testing.

## What they check

`walkthrough.js` — 37 claims over HTTP: both methods offered with the price
from settings; a request carrying its own price priced by the server anyway;
a checkout that credits nothing until the webhook lands; the return URL
visited before paying crediting nothing; card and crypto both crediting on a
signed event; a retried delivery crediting nothing further; a cancelled
checkout closing without crediting; another account's payment answering 404;
forged and unsigned webhooks refused; the admin list and a refund that reports
what it reversed; the amount the provider was actually asked for; and an
event payload that keeps the amount and drops the customer.

`buy-credits.js` — 50 claims over the three-step dialog, half of them through
HTTP first because the browser half needs what they leave behind. Over HTTP:
each method judged by its own bounds and presets that fall inside them; an
`asset` naming a method, or a coin this build has never heard of, refused
before anything is recorded; a purchase that asks to keep the card keeping it,
and one that does not, not - even for an account that already has a customer;
a saved card that is the owner's alone to charge or delete, and answering 404
to anybody else; and an off-session charge settling through
`payment_intent.succeeded` against a `pi_` reference and crediting exactly
once. Then with a mouse: only what the installation can serve offered; a
preset agreeing with the server's own figure; a count above the ceiling priced
AT the ceiling and saying so; Back preserving the amount; the summary pricing
itself without opening a checkout, so looking at it costs the buyer nothing;
the order appearing when the new-card form is asked for; the form mounting or
saying plainly that it could not; Escape closing; and nothing hanging off the
side at 1440 or 390, in either theme. It screenshots each step.

`buy-credits.js` also drives a whole on-chain payment: a coin per button with
its network named, an address matching the configured one, a second buyer told
to wait when they ask for an amount already reserved, a transfer announced
below the confirmation depth reported as `seen` and crediting nothing, and the
same transfer crediting once it is buried - with the fee coming out of the
credits rather than the amount sent.

`browser.js` — the same purchase with a mouse, now that the form is embedded:
the buy page priced from the server; pressing Pay navigating NOWHERE and the
dialog opening in place; the form either mounting or saying plainly that it
could not; the return page waiting for the webhook rather than congratulating
on arrival; the balance and the ledger afterwards; backing out of a payment;
and an admin refunding from the UI.

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
5. Tick **Save this card**, buy, and confirm the card is listed afterwards.
   Then buy again WITHOUT ticking it and confirm no second card appears - the
   consent check reads `setup_future_usage` back from Stripe, and only a real
   Stripe can prove that field arrives as this code expects.
6. Press **Pay now** on that saved card. It charges off-session, so the event
   is `payment_intent.succeeded` and not `checkout.session.completed`: if the
   balance does not move, the webhook endpoint is missing that event. Then use
   `4000 0025 0000 3155` as the saved card to exercise the branch where the
   bank demands authentication anyway and the browser has to finish it.
7. Repeat 1-2 in the Coinbase Commerce sandbox, if you use it.
8. **One real payment per crypto asset, at the smallest amount your limits
   allow.** This is the row that matters most on this list. No reader in this
   repository has ever contacted a live chain, so every response shape is
   pinned by tests against recorded bodies and confirmed by nothing else.
   Check, for each asset: that the amount the buy page quotes is the amount
   your wallet sends; that the payment moves to `seen` within a block or two;
   and that it credits at the confirmation count `chainAssets.ts` names.
9. **Send a deliberately wrong amount once**, a few percent short, and confirm
   it either credits in proportion or appears in the *needs attention* list
   under Admin -> Payments. Both are correct outcomes; silence is not.
10. The decimals are keyed on `(chain, contract)` because USDT is 6 decimals on
    Ethereum and **18** on BNB Chain - a factor of a trillion on a token with
    the same ticker. If you enable `bsc:USDT`, test it separately from
    `ethereum:USDT`. Getting that one wrong means a customer's money arrives
    and is never credited.
