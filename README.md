<div align="center">

# ✨ Tailor

**AI-powered resume and cover letter generation with ATS optimization**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Express](https://img.shields.io/badge/Express-4-green?logo=express)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite)](https://sqlite.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)

</div>

---

## 📖 Overview

Tailor is a full-stack application that generates tailored resumes and cover letters for job applications. Paste a job description, and the AI analyzes it to optimize your resume with relevant keywords, rewrite experience sections, and craft a professional cover letter.

It runs on **subscription seats you already pay for**, never on metered API tokens: the backend runs a vendor's own command-line tool, signed in on the machine running the server - the `claude` binary on a Claude Pro/Max plan (the default), the `codex` binary on a ChatGPT Plus/Pro plan, or the `gemini` binary on a Google account. Generation costs nothing per request beyond the plan, and there is no API key anywhere: the app reads none, stores none, and strips every key from the CLIs' environment. Each seat needs only that its binary is installed and signed in, and all three sign in on a headless box.

### ✨ Features

| Feature | Description |
|---------|-------------|
| **Accounts** | Sign in with Google or a code emailed to you. Your profiles belong to your account and nobody else on the installation can see them |
| **Subscriptions** | Default (1 profile), Premium (5), Premium+ (25), Premium Max (unlimited). An administrator sets each account's subscription; there is no checkout for one |
| **Credits** | A credit is a dollar, to the thousandth (`$0.023`). Each resume costs the price an administrator set for the model it is built with, in steps of `$0.001`, or nothing on a free model. The builder shows what a run will cost before it starts. Charged before the first model call and given back for any resume that does not build, exactly, so credit spent always pays for resumes delivered. Previews are free; administrators are exempt. Every movement has a ledger row explaining it |
| **Roles** | User and Administrator. Admins manage accounts, prompts, models, templates, the skill library and settings - everything shared by everybody |
| **Single or Batch** | Generate for one profile, a group, or all profiles at once |
| **Order & Download** | A Google Sheet import is placed as an order and answers with an order number instead of making you wait. Track it under **Orders**, download one file or the whole order as a zip, and the files are deleted automatically after five days |
| **Profile import** | Move a profile between installs, restore one from a backup, or write one by hand: upload the JSON under Admin → Profiles |
| **ATS Optimization** | AI extracts keywords and tailors content for applicant tracking systems |
| **Templates** | Built-in professional templates plus manual and uploaded templates. Each says which Technical Skills layouts it can print, and a profile is offered only the ones that print its own |
| **Cover Letters** | Auto-generated PDF and DOCX cover letters with professional formatting |
| **Per-Profile Settings** | Each profile chooses its prompts, template, file naming and skill ordering, whether its Technical Skills print as one **Plain** list or **Grouped** under headings, and whether its resumes carry a **Soft Skills** and a **Strengths** section |
| **Live preview** | Editing a profile shows the resume it makes beside the form, redrawn as you type or pick a template - free, untailored, and nothing is saved until you press Save |
| **Admin Panel** | Manage accounts, groups, templates, prompts, skills, and the AI models - each with a display name, a seat, a model picked from that seat's own list, and a price per resume |
| **Plain messages** | A failure tells an ordinary account what it can do about it, never how the server is set up; anything else is a generic sentence with a reference such as `ERR-7F3A9C`, and the cause is in the server log under it. Administrators see the cause on the page as well |
| **PDF & DOCX** | Export resumes in both formats |

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌──────────────────────────┐
│   Next.js 16    │────▶│  Express API    │────▶│  services/ai             │
│   Frontend      │     │  Backend        │     │  ├── claude-cli  (seat)  │
│   (React 19)    │     │  (Port 3001)    │     │  ├── codex-cli   (seat)  │
└─────────────────┘     └─────────────────┘     │  └── gemini-cli  (seat)  │
                                 │              └──────────────────────────┘
                                 │
                                 ├── SQLite database  (/data/db) — all dynamic data
                                 ├── Static assets    (backend/static) — defaults only
                                 └── Generated files  (PDF/DOCX)
```

### The AI layer

Every model call in the app goes through `backend/src/services/ai`. A provider
is one directory implementing `AIProviderAdapter`; call sites never name a
transport, and the registry is keyed on the provider catalog so a missing entry
is a compile error rather than a silent fall-through.

Every provider is a **subscription seat**: a vendor's own CLI, installed and
signed in on the server's machine as the user the server runs as, run as one
subprocess per call. There is no API key anywhere - each seat's child process
has every key variable stripped (the Gemini seat's are pinned empty), so none
of them can fall back to billing per token.

| Provider id | Shown as | How it authenticates | Notes |
|---|---|---|---|
| `claude-cli` (default) | Claude (Subscription) | The `claude` CLI's own sign-in | A Claude Pro/Max plan. `claude auth status` must report `oauth_token`. A call the CLI starts on an API key anyway is stopped at its first event, which names the credential, and the seat is held as signed out so no further calls are made. |
| `codex-cli` | Codex (Subscription) | The `codex` CLI's own sign-in | A ChatGPT Plus/Pro plan. Headless-friendly: `codex login --device-auth` prints a code you approve from any other browser. A CLI signed in with an API key (`codex login --with-api-key`) reads as **not** signed in, and every call is refused before it runs. Its seeded model is `default`, meaning "whatever that account is configured with". |
| `gemini-cli` | Gemini (Subscription) | The `gemini` CLI's Google sign-in | A Google account. Sign in once with `NO_BROWSER=true gemini` - it prints a URL to open in any browser. Runs headless with no tools, pinned to the Google sign-in so it cannot use a key, and refuses any answer the CLI says it billed to paid AI Credits. Its seeded model is `auto`, which lets the CLI pick Pro or Flash per request. |

> **No real Google account has answered through the Gemini seat yet.** It was
> built against the real `@google/gemini-cli` 0.62.0 - its stream format, its
> exit codes, its sign-in errors and the settings files it reads - but the
> machine it was built on had no Google sign-in, so the successful turns in
> `backend/test/geminiCli.test.js` are the CLI's own envelopes around fake
> answers. Treat the first runs on a real account as the test, and watch the
> backend log while they happen.

Each seat has its own queue lane and its own process limit (`AI_CLI_CONCURRENCY`,
`AI_CODEX_CONCURRENCY`, `AI_GEMINI_CONCURRENCY`), so one seat's backlog never
holds up another. The job filter and the Bid Assistant run on the app's default
model, as a run that names no model does - the filter on its prompt's own model
override when an administrator has set one. A resume never does: its analysis,
tailoring and cover letter run on the model the run chose, because that is the
model it is charged at, so a prompt override cannot change what a resume costs
or runs on.

**Models are the administrator's to define.** Under **Admin → Models** each
model is a display name, a seat, a model name picked from that seat's own list,
a price per resume and a description - see **Admin Panel** below. An
ordinary account sees only the display names of the models that can run right
now, never a seat, a model name or a reason.

**Locked providers.** A lock means this installation cannot run a provider —
distinct from the admin's enable switch, which records what an operator wants.
**Nothing is locked out of the box.** A locked seat's models are offered to
nobody: the model menus list only what can run. The admin pages still show the
seat, behind a 🔒 with the reason. Nothing dispatches to a locked provider —
a request that names one of its models is refused with *That model isn't
available*, and an administrator is told why.

Lock one from `.env` when the machine cannot run it — a box where that CLI is
not installed or not signed in, or a shared install whose operator does not
want that subscription spent:

```env
AI_LOCKED_PROVIDERS=claude-cli
```

`AI_UNLOCKED_PROVIDERS` is the mirror, and wins when a provider is in both, so
it stays an escape hatch.

There is deliberately no button for either in the admin UI. A lock is a fact
about the machine, and only whoever set the machine up can know it has changed.

A lock moves the default with it. A fresh install defaults to the first seat
not locked - Claude, then Codex, then Gemini - and a stored default whose seat
is locked is served as the first model that can run. With **all three** locked
nothing can run: settings still read, users are told *AI generation isn't
available right now*, and the admin pages name the locks.

The `openrouter` provider was **replaced** by `claude-cli`. An existing database
is migrated on the next boot (its settings row is backed up first, and
`npm run ai:rollback` restores it); records that still name `openrouter` are
read as `claude-cli` whether or not that migration has run.

The two providers that drove claude.ai and chatgpt.com in a debug Chrome you
started yourself were **removed**, and nothing maps them onto another provider:
their records name a model called `chat`, which no seat has. An existing
database is migrated on the next boot, and anything that still names them is
read as the default whether or not that migration has run - see [Upgrading an
install that used browser chat](#5-upgrading-an-install-that-used-browser-chat).

The three metered providers - `claude` (the Anthropic API), `openai` and
`deepseek` - were **removed** the same way, with every API key, their
`*_BASE_URL` gateways and the switches that let a seat use a key. Nothing maps
them onto a seat either: an API model name is not a seat's, and moving a model
would change what a run costs behind its owner's back. See [Upgrading an
install that used the metered APIs](#6-upgrading-an-install-that-used-the-metered-apis).

### Credits

**A credit is a dollar**, counted to the thousandth: a balance reads `$3.977`, a
price `$0.023`, a purchase `$50.000`. Every amount is stored and moved as an
integer count of thousandths of a dollar (`23` is `$0.023`), so nothing ever
rounds - seven resumes at `$0.023` cost exactly `$0.161`, and two of them failing
give back exactly `$0.046`. Every API response carries money that way, in fields
ending `Milli` (`balanceMilli`, `costMilli`, `pricePerResumeMilli`...), and every
request takes it as dollars in fields ending `Usd` (`"0.023"`), read digit by
digit and refused with more than three decimals.

A resume - one profile against one job - costs **the price of the model it is
built with**, however many files that produces. Every model has a *price per
resume* in dollars, set under **Admin → Models** in steps of `$0.001`, from
`$0.000` (free) to `$1000.000`. A new model is priced by whoever adds it - there
is no default - and a model with no price (one a migration seeds, or one priced
before credits were dollars) reads as `$0.000`, which **Admin → Models lists in
red** for as long as any enabled model is free. A run asking for PDF and DOCX
plus a cover letter writes four files and costs one resume's price, because what
was asked for is one tailored resume.

The model is the one the resume actually runs on - the run's own choice, else
the profile's, else the app default (a prompt's model override does not apply
to a resume) - resolved at submit, and **its price is fixed then**. A resume
finalised from a preview is the preview model's work, so it is charged at the
model that WROTE the preview, whatever the model menu says by then: the preview
hands back a signed token naming it, and finalising sends it. Content sent
without one is charged at least what the profile's own model costs. Either
way the price is fixed at submit: each task carries what it was charged
(`costMilli`), so a price changed mid-run, a server restart, or a queued task
re-resolved after its model went away never re-prices it. A run across several
models is charged the sum, and the reservation in Credit History says how it
was made up - `4 resumes: 2 x Claude Opus @ $0.023, 2 x Claude Sonnet @ $0.010 = $0.066`.

The charge happens **at submit, before the first model call**, and every resume
that does not build gives back exactly what it was charged. So the invariant
is: *credit spent pays for resumes delivered*. A run that is cancelled refunds
everything that had not started; one that fails half way refunds the half that
failed.

**The builder says what a run will cost before it starts.** Beside the generate
button it shows the run's resumes, cost and the balance - *7 resumes × $0.023 =
$0.161* - priced by `POST /api/generation/quote` (`costMilli`, and
`pricePerResumeMilli` when every resume costs the same) - the batch request's own
body and its own model resolution, with nothing submitted and nothing reserved -
and fetched again when the profiles or the model change. It turns red with a
**Buy credits** link when the balance is short, and a run refused for want of
credit (a 402 carrying `neededMilli` and `balanceMilli`) says what it needed and
what you have. The price is not in the model menus: they show display names only.

Charging up front rather than on delivery is what makes a refusal mean
something. The batch endpoint returns a job id before any work runs, and by the
time a task starts running there is no request and no user attached to it - so
the only moment a charge can be both truthful and attributable is when the work
is asked for. It also means a run of thirty is refused as thirty, rather than
being refused on the thirtieth after twenty-nine resumes already exist.

- **Previews are free.** `/preview` and `/preview-all` write no file, and the
  tailored output they return is reused by the real run - charging both would
  bill the ordinary preview-then-generate flow twice for one piece of model work.
  A new account at `$0.000` can still paste a job description and see the
  result; what it cannot do is take the file away.
- **Administrators are exempt.** They can already set any balance, so metering
  them is a formality - the cost line tells them *Administrators are not
  charged*. A fresh install works on day one with nobody holding any credit.
- **Every movement is explainable.** The ledger is append-only and records the
  reserve, each refund, each grant and who made it. `users.balance_milli` is a
  cache of its sum, and a disagreement is reported at startup rather than
  quietly fixed - it would mean something wrote the balance outside the credit
  service.
- **A balance dips while a run is in flight.** The Credits page shows that as
  *held*, rather than hiding it and having the number appear to come back from
  nowhere.
- **History from before dollars reads as it happened.** Credits were once whole
  units bought at a price (50c by default), and the upgrade reset every balance
  to `$0.000` rather than pick a rate - see [Credits are
  dollars](#10-credits-are-dollars). Rows and payments from then are shown in the
  credits they were written in (`legacyCredits` in the API), never converted,
  and each account that held any - in its balance, or in a run still going -
  has a `reset` row explaining the jump.

A brand-new account starts at **$0.000**. Set `CREDIT_SIGNUP_GRANT` - in
**dollars**, e.g. `5` or `0.25` - to give an open installation a self-serve
trial, or let people buy their own.

### Buying credits

Two ways to pay, and **both work the same way underneath**: the server credits
the account only when a signed webhook arrives, whatever happened in the browser.

**What you pay is what you get.** A credit is a dollar and nothing comes out of
it: pay `$50` by card or by crypto and the balance rises by exactly `$50.000`.
There is no price per credit to set and no fee - the 2.2% the crypto row used to
keep is gone, and the provider's own fees are the operator's to absorb. Each
method has its own bounds in dollars, set under **Admin → Payments** (card
`$2.50`-`$100` and crypto `$50`-`$2000` out of the box), and a purchase is any
whole number of cents between them.

Buying is three steps, in a dialog: **which method** (a card, or a coin), then
**how much** (six preset amounts, or a slider or stepper bounded by that
method's own limits), then an **order summary** with the card form or the crypto
hand-off beside it. The method is chosen first on purpose - the page it replaced
put one Pay button per method next to the amount box, so the amount was typed
before anybody knew which limits applied to it, and a card minimum and a crypto
minimum that differ by a factor of twenty could only be discovered by being
refused.

The summary prices itself through `GET /api/payments/quote`, which runs the same
pricing a checkout runs but **records nothing and calls no provider**. That
matters for somebody paying with a card they have already saved: opening a real
checkout to fill in the summary left an abandoned `pending` row in their own
payment history for having looked, and spent two of the twenty checkouts an
account may open in an hour on one purchase. An order is opened when the buyer
asks for the card form, or presses Pay on a card they kept - not before.

**A card can be kept for next time**, if the buyer ticks the box. What is stored
here is the brand, the last four digits and the expiry; the card itself stays
with the provider, behind a customer id this server never serves to a browser.
Consent is read back from the provider rather than remembered locally - Stripe
returns `setup_future_usage` on the payment intent, which is the buyer's own
answer - so an account that saved a card once does not silently keep every card
it pays with afterwards. Removing one detaches it at the provider too, and a
settlement arriving later cannot bring it back.

| Method | Provider | Keys |
|---|---|---|
| Card | Stripe, embedded | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Crypto | **Cryptomus**, hosted invoice page | `CRYPTOMUS_MERCHANT_ID`, `CRYPTOMUS_PAYMENT_API_KEY` |

Crypto was taken two other ways before this one: into a wallet you held the
keys to, watched by this server across four blockchains, and through Coinbase
Commerce. Both have been **deleted**. Payments already made through either
still read, still render and still refund - `chain` and `coinbase` remain in
the provider union and an old row does not stop having been paid because the
code that took it is gone - but `CHAIN_*` and `COINBASE_COMMERCE_*` no longer
do anything, and no new payment can be started through either.

A method is offered **only when every one of its keys is set**. A secret key
without a webhook secret is an install that can take money and never hear that
it did - every payment would sit pending with the money gone - and without the
publishable key the form cannot mount in the browser at all, so the button would
lead to an empty box. A half-configured method is not offered.

The buy page lists what to set when NO method is configured at all. When one
method works and another does not, the working one is simply the only button -
which is the right behaviour for a customer and means an operator debugging a
half-configured method should look at the server's startup log rather than the
buy page.

#### Setting it up from scratch

Nothing below needs a company, a domain or a real card. Stripe's **test mode**
is a full copy of the product with its own keys, and it is what you should build
against - live keys are the last step, not the first.

**1. Make a Stripe account.** <https://dashboard.stripe.com/register>. Skip the
business questions; you only need them to go live.

**2. Check you are in test mode.** There is a **Test mode** toggle at the top
right of the dashboard. Every key and every payment you make while it is on is
fake and free, and test data is completely separate from live data.

**3. Copy the two API keys.** <https://dashboard.stripe.com/test/apikeys>

| On the page | Goes in `.env` as | Looks like |
|---|---|---|
| Publishable key | `STRIPE_PUBLISHABLE_KEY` | `pk_test_51ABC...` |
| Secret key (press *Reveal*) | `STRIPE_SECRET_KEY` | `sk_test_51ABC...` |

**Copy both in one visit, from the same page.** The secret key creates the
checkout session; the publishable key is what the browser then asks Stripe
about. A pair from two different Stripe accounts - or one test key with one live
key - produces `No such checkout.session` for a session that really does exist,
and the error never mentions the key. If in doubt, re-copy both together.

The secret key is a password: it can move money. The publishable key is not, and
is meant to be in the browser - this server hands it to the page deliberately,
so changing it needs no rebuild.

**4. Get the webhook secret.** This is the one that is not on the keys page, and
the one people skip. It matters more than the other two: **a webhook is the only
thing in this application that adds credits to an account.** The browser saying
"paid" adds nothing.

On your own machine, with no domain and no HTTPS, use Stripe's CLI:

```bash
# https://docs.stripe.com/stripe-cli - or: brew install stripe/stripe-cli/stripe
stripe login
stripe listen --forward-to localhost:3001/api/payments/webhook/stripe
```

It prints `Your webhook signing secret is whsec_...`. That is
`STRIPE_WEBHOOK_SECRET`. Leave it running while you test; every event Stripe
generates is forwarded to your machine.

On a deployed server, create the endpoint instead at
<https://dashboard.stripe.com/test/webhooks> pointing at
`https://your-server/api/payments/webhook/stripe`, and subscribe it to:

```
checkout.session.completed          a card payment succeeded
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired            nobody paid; the payment is closed
payment_intent.succeeded            a SAVED card was charged
payment_intent.payment_failed
payment_intent.canceled
```

The three `payment_intent.*` events are easy to miss and they are not optional:
a saved card is charged off-session, which emits those and never emits
`checkout.session.completed`. Without them a repeat purchase takes the money and
credits nothing. `stripe listen` forwards everything, so this list only applies
to an endpoint you create by hand.

**5. Write them into `.env`** - the one at the repository root, which both
halves read:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

**6. Restart the backend.** Keys are read at startup. It prints a readiness line
per payment method; a method with a key missing says which one.

**7. Buy something.** Open **Buy credits**, press the button, pick Card, pick an
amount, and pay with Stripe's test card:

| | |
|---|---|
| Number | `4242 4242 4242 4242` |
| Expiry | any future date |
| CVC | any 3 digits |
| Postcode | any |

`4000 0025 0000 3155` is the one that demands a 3-D Secure challenge, and
`4000 0000 0000 9995` is declined for insufficient funds - both are worth trying
once, because both are paths through this code that the happy path never
exercises. The full list is at <https://docs.stripe.com/testing>.

Your credits appear when the webhook lands, a second or two later - watch the
`stripe listen` terminal and the backend log together. If the payment sits at
*Waiting for payment*, the webhook is what to look at, not the form.

**Crypto** works the same way with Cryptomus: create a merchant account at
<https://cryptomus.com>, copy the **merchant id** from the dashboard and the
**payment API key** from the same account's API settings, and set the two
`CRYPTOMUS_*` variables. That second value does double duty - it signs the
requests this server makes *and* is the secret every incoming callback is
verified against - so there is no separate webhook secret to go looking for.

Point Cryptomus at `https://your-server/api/payments/webhook/cryptomus`, either
in its dashboard or by setting `CRYPTOMUS_CALLBACK_URL`. There is no
local-forwarding CLI, so testing the crypto path needs a reachable URL (an
`ngrok` tunnel is enough). Crypto is not offered at all until both keys are set,
so you can leave them empty and ship cards alone.

> **Nothing in this repository has ever called Cryptomus.** It was built on a
> machine that cannot reach `api.cryptomus.com`, so the request shape, the
> signature formula and the status vocabulary come from the published reference
> and are pinned by tests against a stubbed socket
> (`backend/test/cryptomus.test.js`). That catches a regression; it cannot prove
> the shape is right. `backend/test/e2e/README.md` lists the handful of checks
> to run against a real merchant account before taking money - do them.

**Going live**, when you get there: switch the dashboard out of test mode, copy
the `pk_live_`/`sk_live_` pair the same way, create a live webhook endpoint (its
secret is different from the test one), and read
`backend/test/e2e/README.md` - it lists the handful of things no script here can
prove and that have to be checked by hand against real money.

**The card form is on our own page**, not a redirect to Stripe: the Checkout
Session is created with `ui_mode: 'elements'` and the buy page mounts Stripe's
Payment Element with the `client_secret` it returns. The property that made the
hosted page worth using is kept - **no card number reaches this server, or even
the page's own JavaScript.** The form is an iframe served by Stripe and the
details go straight to them; what this app holds is a client secret, which
identifies a session and authorises nothing on its own.

The session still carries a `return_url`, because some payment methods leave the
page whatever we do: 3-D Secure hands the customer to their bank's domain and
they have to land somewhere coming back. That somewhere is the page that waits
for the webhook, and it is where a crypto buyer returns from Cryptomus too.

**Nothing the browser does adds credits.** Arriving at the return page is a GET
anybody can visit, so crediting there would be a free-credits button with an
inconvenient URL; confirming in the payment form does not decide anything
either. Only the server credits, and it has exactly two ways to learn that
money moved: a **webhook it has verified**, from Stripe or from Cryptomus. The
return page polls the payment until one has arrived, which is a second or two
for a card and can be minutes for crypto, because the network has to confirm
the transfer before Cryptomus will call it paid.

The card integration is pinned to Stripe API version `2026-03-25.dahlia` and
sends it on every request. `ui_mode: 'elements'` exists only from that version -
before it the same thing was called `custom` - and Stripe resolves a request at
the ACCOUNT's pinned version unless a header says otherwise. Without the pin the
integration would work on a new Stripe account and fail on an older one.

**The browser sends the amount it wants, and nothing else decides the charge.**
`POST /api/payments/checkout` takes `amountUsd` - dollars, read exactly, whole
cents only - and the server judges it against that method's own bounds before
asking the provider for it; no other figure in the request is read. The
provider is asked for that amount, the Stripe product reads `$X.XXX Tailor
credit`, and the payment records what it charged and what it will credit
(`amountMilli`, `creditMilli`), which are always equal. A payment made before
credits were dollars keeps its original figures - *N credits at $0.50* - under
`legacyCredits`, so its receipt still says what was sold.

**3-D Secure is a switch, not a default.** Under Admin → Payments, *Always ask
the cardholder's bank to authenticate* sets Stripe's `request_three_d_secure`
instead of leaving Stripe's own risk rules to decide. Turning it on is what
moves responsibility for a disputed payment to the bank that issued the card,
and it costs two things worth knowing in advance: a challenge is a step a buyer
can fail or abandon, and a card somebody has kept stops charging in one tap.
That second one is not a side effect but the only correct reading - a challenge
needs somebody present, so the charge is made on-session rather than claiming
nobody is at the keyboard, which Stripe would otherwise refuse outright. One
account may open twenty checkouts an hour; abandoning one is ordinary, but each
costs a call to a payment provider, so a loop is refused with a 429 rather than
run up somebody else's bill.

**Paying twice is guarded three times**, because the failure it prevents is
giving credits away: the provider's event id is UNIQUE in `payment_events`, the
payment only moves out of `pending` once, and the ledger entry carries a
deterministic `purchase:<id>` key. Any one would usually do.

**Paying once and getting nothing is guarded too**, which is the mirror failure
and the easier one to miss. Recording the event and adding the credits is a
single transaction: if anything fails in between, the event row goes back with
it, so the provider's retry is a first delivery rather than a duplicate the
guards above would refuse. A webhook that reports an amount other than the one
the payment was quoted at credits nothing and leaves the payment `pending` for
somebody to look at, and a checkout that is created at the provider is never
marked failed locally - somebody may still pay it.

**Before taking real money**, `backend/test/e2e/` runs the whole purchase over
HTTP and through a browser against a fake provider that signs its webhooks the
way the real ones do - and its README lists the five things only a live Stripe
test-mode run can prove. See that file.

**Refunds** are on the admin payments page, for card payments. They report three
numbers rather than a tick (`creditedMilli`, `reversedMilli`, `shortfallMilli`),
and the reason is arithmetic: a balance may not go negative, so refunding
somebody who has already spent what they bought returns all of their money and
reverses only what is left. The page says how much was actually reversed and
how much had already gone. A payment from before credits were dollars reverses
nothing: the credits it bought were reset with every balance, and taking dollars
bought since would take somebody's later purchase. A refund claims
the payment - `paid` to `refunding` - before it calls the provider, so two tabs
or two administrators cannot both report an outcome for one refund; the second
is refused rather than told that nothing could be reversed. Crypto cannot be
refunded automatically - crypto can only be sent back, not pulled - and
the app says so rather than pretending.

### Asking for a refund

Anybody can ask for money back, with a reason, about two kinds of thing - and
an administrator decides, in one queue (**Admin → Payments**, *Refund
requests*):

- **A purchase** gives back its **unspent part**: what is left of what it put
  on the balance - the balance, capped at what the purchase credited, the same
  measure the Refund button's reversal uses - rounded down to whole cents,
  because a card returns cents and a balance moves in tenths of one (`$39.993`
  left asks for `$39.990`; the `$0.003` stays as credit). It is measured when
  asked and again when refunded, and never goes above what was asked: somebody
  who spends after asking gets back what is left.
- **One resume's charge** comes back as **credit**, exactly what that resume
  was charged. A resume that did not build already gave its charge back on its
  own, and one still being built cannot be asked about yet. An administrator's
  resumes, and free ones, were never charged.

**Where to ask.** *Ask for refund* is on a purchase's row under **Credits →
Card** or **Crypto** (in its Action column), on a resume charge in **Credits →
Credit History** (a run's charge lists its resumes to pick from), and on each
resume of an order's page (**Orders → an order**). It opens a small dialog that
shows what would come back - measured by the server, never typed - and asks
why. **Credits → Refund Requests** lists what you have asked, with its state:
*Requested*, *Approved*, *Declined* with the administrator's reason, or
*Refunded* with what came back. Something that cannot be asked about says why
(still being built, refunded automatically because it did not build, never
charged), and something with a request already open shows that request instead
of a second button.

Each request moves through four states, set by an administrator:

| From | To | What happens |
|---|---|---|
| Requested | **Approved** | The refund is accepted. No money moves yet |
| Requested or Approved | **Declined** | A reason is **required**, written by the administrator and shown to the person who asked. Final |
| Requested or Approved | **Refunded** | The refund is made in the same step. Final |

*Refunded* is where the money moves, and it moves once however often the button
is pressed:

- a **resume**: its charge goes back on the balance as one `refund-request` row
  in the credit history (idempotency key `refund-request:<id>`), in the same
  database transaction as the state change, and against the run's own
  reservation - so no mixture of automatic and granted refunds can give a run
  back more than it took;
- a **card purchase**: a **partial Stripe refund** of the unspent part. The
  same amount comes off the balance FIRST, in the same step that marks the
  payment as being refunded, so it cannot be spent - or claimed by a second
  refund - while Stripe answers, and what goes back always equals what came
  off. The request turns *Refunded* only once Stripe has accepted it. If Stripe
  **refuses**, the credit goes back on the balance (a *Returned - the refund to
  your card did not go through* row) and the button can be pressed again,
  measuring afresh. If Stripe **does not answer**, the refund may or may not
  exist: the credit stays held, the row says a refund was sent and not
  confirmed, and pressing again sends the same amount under the same
  `Idempotency-Key: refund:<payment id>`, so Stripe answers with the refund it
  made, if it made one, and cannot refund twice. Until then the request cannot
  be declined, and the payments list's Refund is refused for that payment;
- a **crypto purchase**: nothing can pull crypto back, so *Mark refunded* first
  says how much to send and from where (*Send $X back from your Cryptomus
  merchant dashboard first*); the administrator sends it by hand, then confirms
  how much they sent - the amount named, or what they type, in whole cents and
  no more than was asked - and that much credit is reversed. The amount is
  recorded as sent, never measured again: if the buyer spent some in between,
  the reversal takes what is left and the answer reports the rest as a
  shortfall.

*Declined* is never set on money that moved: a decline is refused while the
purchase is being refunded (try again once it has finished) or holds a card
refund Stripe never confirmed, and a decline of a purchase already refunded
closes the request as *Refunded* instead and tells the person so.

A purchase refunded straight from the payments list closes any request still
open for it as *Refunded*, with the amount that went back.

**One open request per item.** A second request for something with a Requested
or Approved one is refused - by a partial UNIQUE index in the database, not only
by the page - and a declined request does not stop asking again. A refunded one
does: there is nothing left to give back.

**Which resume.** An ordered resume is named by its order item, which keeps
what it was charged after its batch is gone; a resume the builder built and
handed straight back (`POST /api/resume/generate`) by its charge, which was that
resume's alone; and a queued resume that
was not placed as an order by its task, for as long as the queue still holds
its run (up to an hour after it finishes - sooner on a busy install, since the
queue keeps only the twenty most recently finished runs of any account). After
that last one is gone it cannot be
picked any more - *This run's resumes are no longer listed* - and the person is
told to ask an administrator, who can grant credit from **Admin → Accounts**.

**Everybody concerned is told.** A new request puts a notice in every
administrator's bell; every change of state puts one in the bell of the person
who asked - and nobody else's: *Your refund request for … was approved*,
*… was declined: <the administrator's reason>*, *… was refunded ($0.161)*.

**Rolling back past this.** An older build reads every row of `notifications`
as an announcement for everybody: it has no idea some are addressed to one
account. Started on this database, it would show every account's bell the
notices written for one - each administrator's *New refund request* (which
names the requester's email, the amount and their reason) and each requester's
approved / declined / refunded notice. Before starting an older build, stop the
backend and delete them:

```bash
sqlite3 "$DB_DIR/free_tailor.db" "DELETE FROM notifications WHERE recipient_id IS NOT NULL;"
# or, without the sqlite3 shell, from the repository root:
node -e "new (require('./backend/node_modules/better-sqlite3'))(process.argv[1]).exec('DELETE FROM notifications WHERE recipient_id IS NOT NULL')" "$DB_DIR/free_tailor.db"
```

The requests themselves stay in `refund_requests`, which an older build
ignores, and announcements are untouched.

### Contacting the administrator

Under **Admin → Settings → General** an administrator lists how to reach them:
email, Telegram, Discord, WhatsApp, or anything else, each with a label. The
list is shown to **everybody** - the sign-in page and the account-disabled page
included, and wherever a message says *contact your administrator* - so it is
served without a session (`GET /api/contact`) and held to rules that keep a
link on those pages safe: every type has its own (an email address that a
`mailto:` can carry as it is, a Telegram username, a Discord name, a phone
number with its country code), the server builds every link itself -
`mailto:`, `https://t.me/<name>`, `https://wa.me/<digits>` - and an *other*
value becomes a link only as an `http(s)` address with no user name or password
in it. `javascript:`, `data:` and every other link scheme (`mailto:`, `tel:`,
`ftp://`...) are refused on save - anything else is shown as plain text, so
`Phone: +1 555 0100` and `Hours:9-5` are fine - and a stored row edited by hand
is checked again on every read. A Discord name is
shown to copy, never as a link.

**Contact admin** opens that list from the account menu, under the sign-in
form (*Trouble signing in?*), on the screen a disabled account is shown when it
tries to sign in, and after every message that tells its reader to contact the
administrator. *Preview what people see*, next to the editor's Save, opens it
as everybody sees it.

### Getting around

One shell owns the navigation on every page: a top bar, and a sidebar down the
left.

**Top bar** - the brand, then on the right: your **credit balance** (press it to
buy more), **notifications**, the **light/dark** switch, and your **account** -
name, email, subscription, credits and profile use, with Settings, Subscription,
Contact admin and sign-out under it - and **Templates** last, because everything before it acts on
the session you are in and that one navigates away.

**Sidebar** - your work at the top:

| | |
|---|---|
| **Profile** | the resume profiles you build from |
| **Groups** | batches of profiles, Premium and above |
| **Build Resumes** | the builder |
| **Orders** | what you ordered, and the files |

then, under a divider, the job pages: **Job Search**, **Job Filter**, **Bid
Assistant** and **Calendar**.

Pinned to the bottom: **Find Jobs**, which opens today's tab of your own job
sheet in a new tab; and for administrators, **Settings** and **Manage
Accounts**. Settings is one entry covering the eight shared-configuration pages,
which appear as a second row across the top once you are in it.

Below 768px the sidebar becomes a drawer behind the menu button in the top bar.

### What each account can reach

Not everything is for everybody, and the rule differs by section because the
reasons differ. A **role** says who may change things the whole installation
shares; a **subscription** says what an individual account includes. They are
separate checks and one is not a substitute for the other.

| Section | Who | Why |
|---|---|---|
| Build Resumes, Calendar, Job Search, Job Filter, Bid Assistant, Profile | anybody signed in | their own work |
| **Orders** | anybody signed in | their own orders only, by id - somebody else's answers 404, never 403, because the difference would confirm it exists |
| **Buy credits** | anybody signed in | their own payments only, by the same 404 rule |
| **Payments** (the list, refunds and the refund-request queue) | **administrators** | reconciliation against the provider's dashboard, and the only buttons in the product that move money outward |
| **Refund requests** (asking, and reading your own) | anybody signed in | about their own purchases and resumes only - somebody else's answers 404, never 403 |
| **Contact the administrator** | **everybody**, signed in or not | the people who most need it are the ones who cannot sign in. Editing the list is an administrator's, under Settings |
| **Find Jobs** | ordinary users | opens today's tab of their own job sheet in a new tab. Not shown to administrators, who manage the installation rather than work a job sheet |
| **Groups** | **Premium and above** | an entitlement, checked on the subscription alone |
| **Bid Assistant** (the shared parts) | **administrators** | the job board is shared, so deleting a job - which takes every account's saved answers for it - and the one Ask AI prompt template every account uses are an administrator's. Everybody else reads the template and may mark a job as an error; their saved sheet sources and their answers are their own, and a job reads as *Answered* only to an account that answered it |
| **Skill library** (adding, editing, deleting) | **administrators** | one library feeds every account's resumes. Confirming a skill found in use - the builder's prompt, a hard skill typed into a profile - adds it for anybody signed in |
| **Templates** (looking at them) | anybody signed in | the gallery and the full-page preview of each, from the top bar. Choosing a template is no use without seeing what it produces |
| **Templates** (adding, editing, disabling, deleting) | **administrators** | a template is shared - editing one changes how everybody's resumes look. A *disabled* template is an administrator's staging state and is not listed to anybody else |
| **Notifications** (reading them) | anybody signed in | the bell in the top bar, with an unread dot until it is opened: every announcement, and the notices written for that account alone (its refund requests; for an administrator, new ones) - never anybody else's |
| **Notifications** (posting them) | **administrators** | one notice goes to every account on the installation |
| **Test** | **administrators** | runs prompts directly and shows raw model output; a tool for whoever maintains the prompts |
| **Settings** (all of it) | **administrators** | every page under it changes something shared |

An entry nobody may use is not shown in the navigation, and the page behind it
explains itself if the URL is typed - a blank screen reads as a broken link.
**Hiding is not the protection**: every one of these is enforced by middleware on
the routes, so an old tab or a hand-made request is refused just the same.

One consequence worth knowing: because the group gate is on the subscription
alone, **an administrator on the Default subscription is refused Groups too**.
Every account starts on Default, so the first administrator has to be moved up
under **Admin → Accounts** before they can use them.

The same rule holds below the pages. The seats' health (`/api/admin/ai/health`),
the queue lanes (`/api/generation/queues`), the prompt tools
(`/api/prompts/validate`, `/preview`) and the prompt test
(`/api/resume/analyze-prompt-test`) answer administrators only. Elsewhere an
ordinary account gets a narrower answer than an administrator: models as id and
display name only, prompts as id and name, a payment method that cannot be used
as *Not available right now* without the reason, no queue lanes or seat in a
run's progress, and a health check without the PDF browser's details.

### When something fails

Most people using an installation do not run its server, so **a message never
tells them how the server is set up** - no seat, CLI, command, setting, path,
model name or third party's own error text. What they are told is one of two
things:

- **A specific sentence** when the failure is about something of theirs they can
  act on: a wrong sign-in code, a subscription's profile limit, too few credits for a
  run, a sheet tab that does not exist, a PDF that is too large.
- **Otherwise a generic one with a reference**: *Failed to queue the batch.
  Please try again, or contact your administrator. (Ref: ERR-7F3A9C)*. An AI
  failure is one of four fixed sentences instead - *AI generation is busy right
  now* (with `Retry-After` when the seat said when), *The request took too
  long*, *The AI request failed. Please try again*, or *AI generation isn't
  available right now. Please contact your administrator* - whichever seat it
  was.

**The reference is how an administrator finds the cause.** The server logs
every one once, on a line that starts with it:

```
[error ERR-7F3A9C] POST /api/generation/batches <the real error, with its stack>
```

so `grep 'ERR-7F3A9C'` over the backend's output finds it. An administrator
does not need the log for a request of their own: the same response carries
the cause as `detail`, which the page shows under the message. The server
decides that from the account's role - the page never does.

Errors that outlive their request - a resume that failed in a run, an order
item - are stored in the same form, the public sentence and its reference, with
the cause logged under it. Rows stored before this release held the raw error;
an ordinary account reads those as *This resume could not be built. Please try
again, or contact your administrator.*, and an administrator reads them as
stored.

### Editing a profile

**Profiles** in the sidebar lists your profiles. **New Profile** opens
`/admin/profiles/new` and a profile's name or **Edit** opens
`/admin/profiles/<id>` - a page of its own, so a profile can be linked to and
survives a reload. **Upload Resume PDF**, and an **Import JSON** of a single
profile, land in the new profile's editor. Despite the `/admin/` in the
address, every signed-in account edits its own profiles here.

The form is on the left and **the resume it makes is on the right**, redrawn as
you work: a template, a layout or a switch shows at once, and typing about
400 ms after the last key. Narrower than 1100px, the two are **Form** and
**Preview** tabs, and nothing is drawn while the preview tab is hidden. The page
on screen stays up while the next one draws, so typing never blanks it; a
failure says *Not updated* with the reason and **Try again**, and leaves the
last page up. A *Page 2* line marks roughly where the printed page breaks, and
**Full size** opens the page at its printed width. The page is scaled to the
pane as if a scrollbar were always there, so it holds still whether or not the
pane scrolls (see Troubleshooting for the shake this replaced).

What the preview is, exactly:

- **The server draws it** (`POST /api/profiles/preview`) through the same
  pipeline and the same template choice as a generated resume, so it is what
  the next PDF looks like before a job tailors it. It is **untailored** - your
  own words, no job.
- **It costs nothing and keeps nothing.** No profile is saved, no model is
  asked, no credit moves, and the subscription's profile limit is not consulted
  (the save checks it). Saving is still **Save**, and leaving through the page's own
  buttons, or closing the tab, with changes unsaved asks first.
- **It cannot run anything.** The document is framed in a sandbox with scripts
  off, and carries its own policy, `default-src 'none'; style-src
  'unsafe-inline'; img-src data:; font-src data:`, so nothing in it can fetch.
  A contact link reaches the page only as an `http`/`https` address -
  `javascript:` and every other scheme are dropped, in the PDF too.
- **Empty fields show a sample, and say so.** A field you have not filled is
  drawn with the template gallery's sample person, so a new profile previews as
  a whole resume rather than bare headings: per field for the name, title,
  contact details and summary (a typed name with no phone shows your name and
  the sample phone), and per section for experience, education and skills (one
  role typed replaces the whole sample list). Soft Skills and Strengths are
  sampled only while their box is ticked and the template has the section. The
  editor lists what is sample text above the page, and the response says which
  (`sampled`). **The sample is the preview's alone**: it is never saved, never
  printed into a PDF or DOCX, and never sent to a model - an empty field stays
  empty everywhere else.
- **It shows what you entered.** A Grouped preview puts only your own skills
  under the library's headings; a generated Grouped resume still fills those
  headings out from the library for the job (see below). Plain, and Grouped
  with no heading assigned by hand, draw only skills the shared skill library
  knows. A skill you add in the editor is added to the library as you add it;
  one that came in with an uploaded or imported profile and that the library
  has never heard of is left off - see Troubleshooting.

**Technical skills: Plain or Grouped.** The *Layout* choice under **Technical
skills** is stored as `technicalSkillsLayout`: **Grouped** (`categorized`, the
default) prints the skills under headings - Languages, Cloud and
Infrastructure, and so on - and **Plain** (`flat`) as one list with no headings.
While Grouped, each skill has a heading menu: *Work it out* lets the shared
library file it, and anything else puts it where you say. Plain keeps the
headings you assigned, so switching back restores them.

The **Template** picker lists only templates that can print the profile's
layout - see [Templates and the two skills
layouts](#templates-and-the-two-skills-layouts) - and says how many it left
out. A template another of your profiles uses is listed greyed out as *(used by
&lt;name&gt;)*, so a short list never looks short for no reason; the current
profile's own template is always selectable. Switching layout while the chosen
template cannot print the new one moves the profile to one that can - its
saved template if that fits, else `default` - and says so beside the control.

On a **tailored** resume the two layouts list different skills:

| Layout | What Technical Skills lists |
|---|---|
| **Grouped** | The posting's skills the library knows, under the library's headings, with those headings filled out from the library - as it always has |
| **Plain** | The posting's skills the library knows, plus **your own** skills that the posting names or that share a library heading with one it names (a posting asking for PostgreSQL makes your other databases relevant). No padding, so it is usually shorter. A posting that names no skill the library knows (a management role, say) gets your own library-known skills, as the editor's preview shows them, rather than an empty section |

Either way the code decides the list, never the model. *Job relevance*
ordering (**Prompts and files → Hard skill ordering**) only reorders it; it
used to drop names such as Node.js and Next.js and respell React as React.js,
and does not any more.

**Soft Skills and Strengths are switches**, `includeSoftSkills` and
`includeStrengths` in the profile's settings. Both are **off unless you tick
them** - which is exactly what every resume printed before they existed, so no
existing profile's output changes. Turning one off **hides its list and keeps
it**: the box then shows only the switch and what it keeps (*3 soft skills kept
with the profile*), nothing is deleted, the entries are saved as they were, and
ticking the box brings them back to print and edit.

| | On | Off |
|---|---|---|
| **Soft Skills** | A Soft Skills section: **your own list first**, in your order, then the soft skills the posting asks for that the library confirms, up to ten in all. A posting's skill already inside one of yours ("Communication" beside "Clear written communication") is left out. The stock list (Accountability, Adaptability, ...) only fills a profile that has none | No section, and the builder offers no soft skills to add to the library. The posting's soft skills that the library knows and the resume does not already mention go into the summary as one sentence, `Working style: ...` |
| **Strengths** | A Strengths section: the ones the model writes for the job (it is asked for two to four), and if it writes none, **your own**, exactly as typed - and still as typed when that preview is generated. Never invented - a strength the model writes with no title is dropped, and a sentence written from the employer's side is removed on its own | No section. The model is told to return none and not to use strengths as an overflow for keywords, and anything it returns anyway is discarded |

A section with nothing in it prints no heading, in the PDF and the DOCX alike.
Not every template has somewhere to put these: **Burgundy Rule, Navy Rule and
Charcoal Sidebar have neither section, and Ink Ledger has no Soft Skills**. The
editor says so under a ticked switch (*... has no Strengths section; ticking it
changes nothing here*), and the **Template** section shows which it has. On such
a template **the switch behaves exactly as off, everywhere**: the model is told
the section is off, the posting's soft skills go into the summary as
`Working style: ...`, and the DOCX leaves the section out too. The DOCX follows
one fixed layout whatever the template, but the template it is generated with
decides its sections: it gains *Key Strengths* after the summary and *Soft
Skills* after Technical Skills exactly when the PDF of the same generation has
them.

**A profile's soft skills** (`softSkills`) are names only: trimmed, the first
spelling kept when one is typed twice in different case, at most 50 of at most
100 characters. A save that leaves the list out keeps the stored one, and so
does a save that leaves out either switch - an older page cannot turn them off
by not knowing about them. The prompt that reads an uploaded resume PDF now
asks for the soft skills the resume states, and for strengths only from a
strengths section it actually has, where it used to make two or three up.

**The switches are enforced after the model, not only asked of it.** Content
tailored while a switch was one way and finalised after it changed - a builder
preview held across the change, a queued batch - is re-read against the
profile as it is now, and the renderer empties a switched-off section on every
path (preview, PDF, DOCX, the queue) whatever the content carries.

### Templates and the two skills layouts

**Every template says which Technical Skills layouts it prints**, as
`skillsLayouts` - `["categorized", "flat"]` or one of them. Seventeen of the
nineteen built-ins print both. **Burgundy Rule and Navy Rule** lay their skills
out as a grid of category cells, which has nothing sensible to do with one
plain list, so they are `["categorized"]`: a Plain profile is not offered them.
`default` prints both, and is where every fallback ends.

A template that does not say - an uploaded one, a PDF extraction, one stored
before this field existed - gets a list from its markup when it is
read, with no migration: a per-item `{{#each hardSkills}}` or `{{#each skills}}`
loop prints both; a template that reads only `{{#each skillCategories}}` is a
category design and prints Grouped only (an `{{#each skills}}` INSIDE that
loop is the category's own list and does not count); one with no skills at all
is offered for both. An import keeps the list the file states; the manual builder's
templates print both.

An administrator can reclassify any template with `PATCH /api/templates/:id`
and `{ "skillsLayouts": ["categorized"] }`. A built-in's goes into its override
row, beside its name, description and disabled flag, and its file stays as
shipped. Anything but a non-empty list of `categorized` and `flat` is refused
with a 400 that says so.

Two more things every template payload carries, worked out from the markup on
every read and never stored: `supportsSoftSkills` and `supportsStrengths` -
whether it has a section to put each in. The manual builder offers both
sections now, guarded so an empty one prints nothing.

**A resume never fails over a layout.** The template is the one asked for, else
the profile's own, else `default` - the first of those that is enabled and
prints the profile's layout; failing that, any enabled template that does; and
failing even that, the first enabled one as it is. A choice that no longer
fits, because an administrator reclassified it or the profile changed layout
while a run was queued, is logged once, as `[templates] Profile <id> uses the flat skills
layout, which template "<id>" does not offer; drawing it with "<id>" instead.`
The live preview, the builder's previews, generation and the queue all ask the
same question (`services/templateChoice.ts`), so the preview cannot show one
template while the PDF prints another; when it falls back, the preview says
*Drawn with ...* and why.

The gallery's preview takes the same choices a profile makes:
`GET /api/templates/:id/preview?layout=flat&softSkills=1&strengths=1`. With
none it is the usual Grouped sample without either section. It is served under
the same no-script policy as the profile preview, and a disabled template is a
404 for anybody but an administrator.

### Prompts and the section switches

The tailoring prompt (`tailor-resume`) is given the profile's three choices as
words, in three variables of its own:

| Variable | Values |
|---|---|
| `[[includeStrengths]]` | `yes` or `no` |
| `[[includeSoftSkills]]` | `yes` or `no` |
| `[[technicalSkillsLayout]]` | `grouped` or `plain` |

They are never inside `[[profileJson]]` - that is the candidate's record, and
these are how it is drawn - and the shipped prompt names them after it, in a
*RESUME SECTIONS* block, so the long start of the prompt that is the same for
every resume stays the same. Its strengths instructions apply only when the
Strengths section is `yes`; on `no` it asks for `"strengths": []`.

What the record holds does follow the switches: **with Strengths off, the
profile's strengths are not sent to the model at all** - not in
`[[profileJson]]` for tailoring, nor for the cover letter. They stay with the
profile, unsent, until the box is ticked. The profile's own soft skills are
never in it either way; the code lists them after the model has answered.

**A prompt edited before the switches existed still obeys them.** The code
appends a *FINAL SKILL OVERRIDE* to every tailoring turn, whichever prompt
record rendered it, and it states the same three facts - so an administrator's
edited copy, or a per-profile custom prompt that never heard of
`[[includeStrengths]]`, is told the switches all the same, and the
post-processing above enforces them again whatever the model returns. No
migration rewrites an administrator's text. **Admin → Prompts** marks such a
tailoring prompt: *This prompt predates the profile's Strengths and Soft Skills
switches; the app still enforces them.* Nothing needs fixing; referencing
`[[includeStrengths]]` in it clears the note.

**A feature's prompt may use only the variables its code supplies.** Admin →
Prompts lists every one a feature offers, and saving text that names any other
is refused - *Unknown prompt variables: includeSoftSkillz* - where it used to
save cleanly and then fail every resume that used it. `POST
/api/prompts/validate` and `/preview` name such a variable in
`unknownVariables`; a draft not saved yet says which feature it is for with
`featureKey`. A record that already holds one (written by hand into the
database, say) fails every resume that uses it, and the server log names it
under the reference: *Prompt "..." contains unknown variables: ...* - see
Troubleshooting.

### The job sheet

Every account gets **one Google spreadsheet of its own**, and inside it **one tab
per day**, named `MM/DD/YYYY`. The tab is created on the first sign-in of that
date and skipped on every sign-in after, so a day's rows stay together and a
quiet day costs nothing. A new tab opens with the job columns - `NO(DATE)`,
`Company`, `Job Title`, `Job Link`, `Job Description`, `Rate`, `note`,
`Job Finder`, `Filter Result`, `Filter Reason` - frozen, filtered and formatted.
The first eight are yours to fill in; the last two belong to the job filter.

Allocation is **fire-and-forget at sign-in**: a spreadsheet is a convenience and
being able to log in is not, so a Google outage must not become an outage of
logging in. Settings > Job Sheet ensures the same thing when it loads, which is what
covers an account whose sign-in ran while Google was down, and accounts created
before this feature existed - a paced backfill at startup takes care of the rest.

**Who owns them, and who can open them.** Every sheet is created in the Drive of
whichever Google account signed in with `npm run sheets:login` - the operator's,
normally - and each account is invited to its own sheet as an **editor**, by
email, without a notification mail.

New sheets are **public by default**, meaning anyone with the link can edit them.
The toggle under Settings > Job Sheet withdraws exactly that one grant and nothing else:
the owner's personal invitation stays, which is what still lets them open it. The
order matters and is enforced - the invitation is confirmed *before* the link is
taken away, and the request is refused outright if it cannot be, because
withdrawing the link from somebody who never got an invitation locks them out of
their own spreadsheet with no way back through the UI.

Either way the server keeps its own access, since the file belongs to the account
whose credentials it holds - so job links, company names and descriptions still
load after somebody goes private.

Nothing ties the credential to the app's administrator: sheets land in whichever
Drive consented, which may not be the address `ADMIN_EMAILS` or `SMTP_USER`
names. `npm run sheets:doctor` reports the owning account and says so when the
two differ.

**Who administers the installation.** Not whoever signs in first - on a server
anybody can reach, that handed the keys to the quickest stranger. It is
`ADMIN_EMAILS` when that is set, otherwise the `SMTP_USER` address: the mailbox
sign-in codes are sent *from* is a credential the operator had to configure, so
it identifies them. With neither set there is **no administrator at all**, and
startup says so loudly. An account named by either is promoted the moment it
exists - at boot or on its next sign-in - and nothing is ever demoted, so a typo
in `.env` cannot lock you out.

**When it will not work: `npm run sheets:doctor`.** Allocation fails with a 403
whose message is often only "The caller does not have permission" - true of a
disabled API, a narrow scope, a full Drive and a revoked key alike. The doctor
walks the same chain allocation walks, with the real API calls, and stops at the
first step that breaks with the remedy for that step. It creates one throwaway
spreadsheet and deletes it again.

```
cd backend
npm run sheets:doctor
npm run sheets:doctor -- --email you@example.com   # also tests sharing
npm run sheets:doctor -- --keep                    # leave the throwaway behind
```

**Which credential, and why it is not a service account.** The tidy arrangement
looks like a service account key, and on a **consumer Google project it cannot
work**: the service account is given a Drive quota of **zero bytes**, so it
authenticates perfectly and can never own a file - and creating a spreadsheet
means owning one. The failure is a 403 that blames permissions and means storage.

A Workspace **shared drive** is how a service account would normally get room,
and **this app cannot put files in one**: `createSpreadsheet` names no parent, so
the Sheets API always creates in the caller's own My Drive. Supporting a shared
drive would need a `parents` on that call and a drive id to point at - a code
change, not a configuration. Until then the service-account path only works where
the account itself has storage, which on a consumer project it never does.

So the app accepts either credential, and prefers the one that works:

```
cd backend
npm run sheets:login     # sign in as yourself, once
```

That saves `google-oauth-credentials.json`, and every account's sheet is then
created in **your** Drive and shared with its owner as an editor. It needs an
OAuth client from the Cloud console (Desktop app type) - the script says exactly
where to click if it cannot find one. `GOOGLE_CREDENTIALS_PATH` overrides where
credentials are looked for; a service account key at
`backend/service-account-key.json` is still read, but see the paragraph above
before counting on it.

Two things this needs from Google, and both are easy to miss:

- The **Drive API** enabled for the same Cloud project as the key, not just the
  Sheets API. Sharing is a Drive concept, and a missing Drive API produces a 403
  that blames the file rather than the setting.
- Room in the service account's own Drive, if you use one. Files it creates count
  against *its* quota, not against any person's - and pointing the key at a shared
  drive does not move them, because the create call names no parent. Use
  `npm run sheets:login` instead.

**Moving to another server.** Nothing is registered with Google a second time.
The Cloud project, the enabled Sheets and Drive APIs, the consent screen and the
OAuth client all belong to the Google account that consented - not to a machine -
so a new host inherits them by holding the same credential file. Copy
`backend/google-oauth-credentials.json` across and give it mode `0600`: the
refresh token inside is tied to an account, not to a host or an IP. Running
`npm run sheets:login` on the new machine is equivalent and mints a second
refresh token for the same account, both valid - but its redirect goes to
`127.0.0.1`, so it needs a browser on that machine, which a headless server has
not got.

**Copy the database too, with the backend stopped**, and this is the part that
does damage if it is missed. An account's row is the *only* record of which
spreadsheet is its own. Start a new server on an empty database and every
account looks like an account from before the feature existed, so the startup
backfill allocates each one a **brand-new spreadsheet** and the real ones are
left orphaned in the Drive that owns them - with a log line that reads like a
success. The file is `free_tailor.db` in `DB_DIR`, and the default differs by
platform, so a Windows-to-Linux move will never find the old one by accident:

```
Linux/macOS   /data/db/free_tailor.db
Windows       %LOCALAPPDATA%\free_tailor\db\free_tailor.db
```

`SHEET_BACKFILL=off` is how to bring the new host up *before* the database is in
place without it allocating anything.

`.env` does not travel with the repository and has to be written again -
`ADMIN_EMAILS`, the `SMTP_*` block, `DB_DIR`, `SHEET_TIMEZONE`,
`SHEET_BACKFILL`. Do not carry a relative `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`
across: it resolves from whatever directory the backend was started in on the
new machine, and it names a credential this setup no longer wants. Then
`cd backend && npm run sheets:doctor` on the new host, which walks the same
chain allocation walks and says which step is missing.

One thing to check that is neither the old server's nor the new one's: an OAuth
consent screen still in **Testing** expires its refresh tokens after seven days,
on every machine equally. Publish it.

**The job pages write into it.** Scraping jobs and filtering them used to make
you supply a spreadsheet id, a tab name and four column letters. They now default
to your own sheet, today's tab, and the layout above - `Company`, `Job Title`,
`Job Link` and `Job Description` for an export; the job link read back, with the
filter's verdict in `Filter Result` and its reason in `Filter Reason` - two
columns the filter owns, so `Rate`, `note` and `Job Finder` stay yours. Rows are appended after
what is already there, and jobs already in the tab are skipped.

**And the builder reads back out of it.** *Import from Sheets* on the builder
offers your own sheet first and by default, on today's tab, with `Company`,
`Job Title` and `Job Description` already mapped - because the layout is one
this app wrote. Each row's role is its own `Job Title`; a row with none is
built with the title the posting's analysis reads from its description, as a
manual build is. (The builder's *Fallback Role* field is gone: it put one
typed role on every untitled row, whatever each job was.) A saved source is somebody else's spreadsheet and keeps the
older column guesses. Only an administrator is offered the saved sources at all:
they are not a user-addressable sheet, so listing them for everyone did nothing
but offer a 404.

**Who may point them where.** A spreadsheet id supplied by a request is checked
rather than trusted: an ordinary account may address only its own sheet, and an
administrator may also address the shared sources they configured on the admin
page. Anything else is a 404. This matters more than it looks - the service
account *owns* every account's spreadsheet, so a route that took an id on trust
would read and overwrite anybody's for anyone who knew it, and a link-shared
sheet hands that id out in its URL.

`SHEET_TIMEZONE` decides which day a tab belongs to. A server running in UTC
rolls the day over at midnight UTC, which for a user in New York is seven in the
evening - so an evening's work would land on the next day's tab. Set it to the
zone the users actually live in.

### Order & Download

There are two ways to generate, and which one you get follows from where the
jobs came from rather than from a toggle.

**Building manually** is unchanged: one resume, built while you wait, downloaded
when it is done.

**A Google Sheet import is placed as an order.** Pressing *Generate* in the
import dialog answers immediately with

> You ordered successfully: Order number - `FT-20260920-0007`

and the page is then free. That is the point: three hundred rows is an hour of
work, and holding a browser tab open for it meant a reload part way through left
the files on the server with nothing offering them. The server now records what
was asked for and builds it whether or not anybody is watching. It stays free
when you come back, too: reopening **Build Resumes** picks up only a run you
started from the builder yourself - never an order (that is what **Orders** is
for), and never another account's, an administrator's included.

**Orders** in the navigation lists what you ordered, newest first, each with a
`122 of 300` progress bar. Open one and every resume is there as it lands:
download a single file, tick a few and take them as a zip, or take the whole
order as one archive. Failures show their reason in place rather than being
counted away - in words for the person who ordered, with a reference an
administrator can look up (see [When something fails](#when-something-fails)) -
and the bar counts *settled* work, so a run with failures still
reaches the end instead of stalling at 98% for ever.

**The order outlives the run that produced it**, and that is the reason it
exists as its own record. The generation queue evicts a finished batch an hour
after it settles and deletes its rows - right for a dispatcher, useless for
somebody coming back the next morning - so counts, items and file paths all come
from the order's own tables and keep reading correctly long afterwards.

**Files are deleted automatically after five days** (`ORDER_RETENTION_DAYS`).
The sweep runs at startup and every six hours (`ORDER_RETENTION_SWEEP_MS`); it removes the files, prunes the
folders it emptied, and **keeps the order**, marked *Files deleted*, so the list
still says what was built rather than going quietly blank. The expiry is stamped
on each order when it is placed, so shortening the window never reaches back and
deletes files somebody was already promised.

An order belongs to one account. Every route takes an id and checks it against
the caller; somebody else's order answers **404**, not 403, because the
difference between those two replies is itself an answer. The two older download
routes - `/api/generated` and `/api/resume/download` - now ask the same question
of any path an order owns: a fixed template makes an ordered path *derivable*
rather than merely guessable, and a signed-in-only check would otherwise hand
every account's resumes to anybody with a login. A path no order claims is a
manual build and is unaffected.

### Where data lives

| Data | Storage |
|------|---------|
| Profiles, groups, custom prompts, edited built-in prompts, app settings, skill library, bid-assistant jobs and answers | SQLite database in `DB_DIR` (default `/data/db/free_tailor.db`) |
| Accounts, live sessions, unused sign-in codes | The same database. Session tokens and codes are stored **hashed**, so a copy of the database yields no usable session |
| Which spreadsheet belongs to an account, and the last day tab prepared in it | The same database, on the account's row - along with `sheet_shared_at`, the moment the owner's invitation to their own sheet was confirmed. Recorded once, so sign-in retries the invitation until it works and then stops asking Drive at all; going private still asks live, because that is the one moment a grant revoked in Google's own UI would lock somebody out |
| Orders and what each one built | The same database, in `orders` and `order_items`, deliberately NOT in the generation batch that produced them: a batch is evicted an hour after it settles, so an order built on one would go blank exactly when somebody came back for their files. The file paths live on the item row; the files themselves are on disk under `outputBaseDir` |
| Payments, and every webhook that decided one | The same database, in `payments` and `payment_events`. Separate from the ledger because a ledger row is an accounting fact that is never rewritten, while a payment has a lifecycle. The event payload is kept, redacted: ids, amounts, currencies and statuses survive because a dispute months later is argued from them, while the customer's name, email, address and card details are replaced with `[redacted]` - this application never reads them, and a copy kept for ever in a plain file is a liability rather than evidence |
| Payment provider keys | `.env` only, like every other key in this project |
| Credit ledger and open reservations | The same database, in thousandths of a dollar. The ledger is append-only and `users.balance_milli` is a cache of the sum of its `delta_milli`; a disagreement between the two is reported at startup rather than silently repaired. The whole-credit columns beside them (`users.credits`, `credit_ledger.delta`, `credit_reservations.units`, `payments.credits`...) hold the history from before credits were dollars, and every row written since puts `0` in them |
| AI models and their prices | The same database, in the app settings row: each model's display name, seat, model name, price per resume (`pricePerResumeMilli`, thousandths of a dollar) and description. A run's price is copied onto each of its queued tasks (`costMilli`) when it is submitted |
| API keys | None, anywhere - every AI provider is a subscription seat signed in on the server, in that CLI's own home directory. A settings row upgraded from an older release has its stored keys deleted on first read, and says so in the log; migration 007 deletes them from the oldest settings snapshot too |
| Default prompts (one per feature) | `backend/static/prompts/*.json` |
| Skill library seed (loaded into the database on first run) | `backend/static/skills/skills.json` |
| Built-in resume templates | `backend/static/templates/*.json`, read from the file on every request - so an edited file shows at once, with no import. What an administrator changes about a built-in - its name, description, disabled flag and the layouts it is offered for - is an override row in the database (`template_overrides`) laid over the file, never the file itself |
| Templates an administrator saved - imported from JSON, extracted from a PDF, built in the manual editor | **Files**, in the same `backend/static/templates` directory: `<id>.json` in the shipped shape plus a `"source"` (`uploaded`, `extracted` or `manual`). A file with a `source` is a saved template, editable and deletable on **Admin → Templates**; a file without one is a built-in. Written to a temporary file and renamed into place, so a crash never leaves half a template. They are not gitignored: they show in `git status`, and committing one ships it to every install that pulls |

Nothing under `backend/static` is written to at runtime **except `static/templates`**, which also holds the templates administrators save (`TAILOR_STATIC_DIR` moves the whole directory, seeds and saved templates together). Every other edit made in the admin panel goes to the database. The backend prints the templates directory under `Database:` at startup, and says so if this user cannot write to it.

**Backing up** means two things now: the database file in `DB_DIR`, and `backend/static/templates` (or `$TAILOR_STATIC_DIR/templates`), which holds the saved templates. Copy them together - a profile names its template by id, and a database restored without the template files falls back to `default` for those profiles. An install upgraded from a release that kept templates in the database moved them to files on its first start, once (`schema_meta` key `templates_moved_to_files`), and left the old `templates` rows in the database as a backup it no longer reads - see [Saved templates are files](#9-saved-templates-are-files) for what that changed and for rolling back.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+, or 20+ for the Gemini seat (the same major version for
  installing and running - see the `NODE_MODULE_VERSION` row under
  Troubleshooting)
- **Windows 10/11, Ubuntu, or macOS.** Every command in this guide is the same
  on all three; where a default differs it is called out below.
- A writable database directory. Left unset, `DB_DIR` defaults to `/data/db` on
  Linux and macOS and to `%LOCALAPPDATA%\free_tailor\db` on Windows. The
  backend prints the resolved path at startup.
- **At least one subscription seat**, installed and signed in as the user the
  server runs as. Any one of the three will do - Claude Code, Codex or the
  Gemini CLI - but one has to be in place before anything can be generated.
  There is no API key to set: the app uses none.

- **Claude Code**, for the default provider: the Claude subscription seat.

  ```bash
  npm i -g @anthropic-ai/claude-code
  claude auth login
  claude auth status     # must print "loggedIn": true and "authMethod": "oauth_token"
  ```

  On Windows npm installs this as `claude.cmd`, which Node cannot spawn
  directly. The backend reads the shim and runs what it wraps - the package's
  `bin/claude.exe` today, a `cli.js` under an older release - so no extra
  configuration is needed. If that ever fails it says so and asks for
  `AI_CLI_BIN`.

  `oauth_token` is what a subscription looks like. Any other `authMethod` means
  the CLI found an API key; the backend says so loudly at startup and on the
  admin Settings page. A call the CLI runs on a key anyway is failed, and the
  seat is held as signed out so no further calls are billed.

- **Codex**, only if you want to run on a ChatGPT subscription seat. Same
  arrangement, different vendor - and `--device-auth` is why this one is
  comfortable on a server: it prints a code you approve from a browser on any
  other machine, so the box itself needs no display.

  ```bash
  npm i -g @openai/codex
  codex login --device-auth
  codex login status     # prints the account, or "Not logged in"
  ```

  Run it as the **same user the server runs as** - the sign-in lives in that
  user's `CODEX_HOME`, and a login as yourself is not one the service can see.
  Sign in with ChatGPT, not `codex login --with-api-key`: a CLI signed in with a
  key is reported as not signed in, because every call on it would be billed.

- **Gemini CLI**, only if you want to run on a Google account. It also signs in
  without a display on the server - it prints a URL you open in any browser and
  takes the code back:

  ```bash
  npm i -g @google/gemini-cli     # needs Node 20 or later
  NO_BROWSER=true gemini          # choose "Sign in with Google", then /quit
  ```

  Again as the **same user the server runs as**: the sign-in is saved as
  `~/.gemini/oauth_creds.json` in that user's home, which is what the health
  check reads - it never sends a prompt to find out. To keep the server's
  sign-in apart from a personal one, set `AI_GEMINI_HOME` to a directory of its
  own and run the sign-in with `GEMINI_CLI_HOME` set to the same directory; a
  personal `~/.gemini/GEMINI.md` would otherwise be added to every prompt the
  seat runs (the health check warns when it is not empty).

- **A Chrome to print with.** Resumes and cover letters are rendered by
  headless Chrome, and `npm install --prefix backend` downloads one
  automatically. Nothing further is needed unless that download is blocked -
  see `Could not find Chrome` under Troubleshooting. The backend prints which
  browser it resolved at startup, on a `[pdf]` line, and reports it from
  `GET /api/health` to an administrator.

### 1. Clone & Install

```bash
git clone <repo-url>
cd free_tailor

npm run install:all     # root, backend and frontend
```

Or the three on their own, which is what `install:all` runs:

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

**Already have a checkout?** Run `npm run install:all` again after every pull.
A pull brings new `package.json` entries but not the packages themselves, and
the symptom is a compile error naming a module that "cannot be found" - most
recently `nodemailer`, which v2 added for the emailed sign-in codes.

### 2. Environment Setup

Copy `.env.example` to `.env` in the project root and fill in the values you need. The important ones:

```env
HOST=0.0.0.0             # backend listens on every interface
PORT=3001
#DB_DIR=                 # SQLite database directory; see the note below
NEXT_PUBLIC_API_URL=http://localhost:3001/api

# One of these two, or nobody can sign in:
GOOGLE_CLIENT_ID=        # OAuth 2.0 Web application client id
SMTP_HOST=               # ...or SMTP, for emailed six-digit codes
SMTP_USER=
SMTP_PASS=
```

**Somebody has to be able to sign in.** Set up Google sign-in or SMTP. With
neither, the login page says only *Sign-in isn't available right now* - it is
read by somebody who is not signed in, so it names no setting - and the backend
says at startup what to set (`[auth] Nobody can sign in: ...`);
`cd backend && npm run mail:doctor` checks the SMTP path. The **first account
to sign in becomes the administrator**, because account management is
admin-only and an install whose first user was an ordinary one would have no
way to appoint one. Set `ADMIN_EMAILS` to decide in advance instead.

Upgrading an install that has profiles already? They have no owner, so they are
invisible to ordinary accounts and visible to administrators until the first
administrator signs in, at which point they are adopted automatically.

`DB_DIR` is commented out in `.env.example` on purpose, so a fresh checkout
picks the writable default for the platform it is on. Set it when you want the
data somewhere specific - `DB_DIR=./data/db` works on both Windows and Ubuntu
and is resolved from the directory the backend was started in.

Nothing else in `.env` is required for AI generation: every provider is a
subscription seat, which needs no key - only its CLI installed and signed in on
this machine, as under Prerequisites. The `AI_CLI_*` variables in
`.env.example` tune the Claude seat's model, concurrency and timeouts, and the
`AI_CODEX_*` and `AI_GEMINI_*` ones do the same for the Codex and Gemini seats.

The frontend swaps the hostname in `NEXT_PUBLIC_API_URL` for the hostname the page was loaded from, and the backend accepts requests from any origin on the same host as the API. That means you can open the app through `localhost`, a LAN IP, or a hostname without changing configuration.

### 3. Run

```bash
npm run dev
```

This starts the backend in watch mode and the frontend dev server. For a production-style frontend build use `npm run dev:poll` or run each side separately:

```bash
cd backend && npm run dev        # http://<server-ip>:3001
cd frontend && npm run dev:live  # http://<server-ip>:3000
```

The backend prints every address it is reachable on when it starts, followed by
a readiness line for each AI provider. A locked one is reported as locked
rather than probed:

```
[ai] claude-cli: Signed in on a Claude subscription (OAuth).
[ai] codex-cli: Locked in this installation. Needs the `codex` CLI installed and a ChatGPT subscription ...
[ai] gemini-cli: Signed in with Google as you@example.com.
```

The Gemini line names the signed-in Google account; it is in the server log and
on the admin Settings page, nowhere an ordinary account can see.

Both sides read the single `.env` at the repository root, on Windows as well as
macOS and Linux, and every npm script here runs under `cmd.exe` and PowerShell
as well as `bash`. If you set `DB_DIR=/data/db` on Ubuntu, create it and make it
writable first (`sudo mkdir -p /data/db && sudo chown "$USER" /data/db`); on
Windows that path means `C:\data\db` and needs an administrator, so leave
`DB_DIR` unset or point it at something local. A directory the backend cannot
create is the most common first-run failure, and it says exactly that.

### 4. Import data from the old JSON layout (optional)

If you are upgrading from a version that stored data as JSON files under `backend/data`, import it once:

```bash
cd backend
npm run migrate:legacy -- /path/to/old/backend/data
```

Existing database records are never overwritten.

### 5. Upgrading an install that used browser chat

The `claude-web` and `chatgpt-web` providers - **Claude (browser)**,
**ChatGPT (browser)**, and the **Default (browser)** entry that spread a run over
both - are gone, and nothing in the app drives a debug Chrome any more. On the
first start after upgrading, migration 006 tidies the database once:

- It removes their model records, their enable switches, and the browser-chat
  settings (the master switch and the registered debug ports).
- It repoints whatever named them. The stored default moves to the Claude
  seat's Sonnet - or, when that seat is locked on this machine
  (`AI_LOCKED_PROVIDERS`), to the Codex seat. That follows the locks as they
  are when the migration runs: lifting one later does not move the default
  back, so pick it again under Admin -> Settings if you want it. A profile's
  model choice and a prompt's model override are cleared, which means "use the
  default".
- An install that ran only on the browsers - every other provider unticked or
  locked here, or every other model switched off - gets one back: a seat this
  machine can run, switched on with its models. The backend log says which;
  review it under Admin -> Settings and Admin -> Models.
- 006 was written while the metered APIs were still here, and on a database
  that skipped straight to this release it can still land the default, or the
  model it switches back on, on a metered API model. Migration 007 runs right
  after it in the same start and moves anything like that onto a seat - see
  section 6.
- It keeps a copy of the settings row first, in `app_settings` under
  `app-settings.backup.pre-browser-chat-removal` - verbatim, except that an API
  key store an older release left in the row is not copied - and the prompt
  rows it changed in a side table,
  `prompts_backup_pre_browser_chat_removal`. The profile choices it cleared are
  listed in `migration-log.provider-schema-6`. Nothing restores these
  automatically - `npm run ai:rollback` is for the older provider migration -
  they are there to read.

Nothing depends on that migration having run, which matters because it can be
held back: it comes after the one that waits for the first administrator (an
account that `ADMIN_EMAILS` promotes at start-up lets it run at once), and it
waits as well while the settings row is not valid JSON. A record that still
names a browser provider - from a restored backup, a hand-edited row, or a page
left open from before the upgrade - is read as the default, never as an error,
and the backend log says so once per name. That includes an administrator's
own browser model, whose id the migration logs, so a page that still names it
works after a restart too.

An install left with nothing it can run is repaired the same way in memory,
until an administrator saves Settings: one seat this machine can run is read as
switched on and given its models - the seat migration 007 would pick, rank for
rank (section 6), so nothing changes seat when the migrations catch up. Saving
Settings keeps it. With every seat locked there is nothing to repair onto:
nothing can run until a seat is unlocked, ordinary accounts are told AI
generation is not available, and the admin pages name the locks. The same
repair covers a lock added after the upgrade, but only while the settings are
still what the latest removal migration left: once an administrator has changed
which providers or models are switched on, an install a later lock leaves with
nothing fails by name, pointing at the lock (an administrator sees that
sentence; anybody else, a generic one with a reference), as it does on an
install that never used browser chat.

A run that was queued across the upgrade still finishes: a resume that was
waiting for a browser is built on whatever its profile resolves to now - the
profile's own model, or the app default - and is not charged again.

`npm run browser:debug`, `npm run browser:doctor` and every `AI_WEB_*` variable
no longer exist. A leftover `AI_WEB_*` line in `.env` is ignored and can be
deleted. The Chrome that prints PDFs is a different thing and is unaffected -
see **A Chrome to print with** under Prerequisites.

Debug browsers you started with `npm run browser:debug` are still running, and
nothing uses them any more. Close those Chrome windows: each one listens on a
loopback remote-debugging port (9222 by default; the ports you registered are
in `browserChatEndpoints` in the settings snapshot above). Their profiles,
`~/.free-tailor-chrome-<port>` or the directory you gave `--profile`, are still
signed in to claude.ai and chatgpt.com - delete them.

### 6. Upgrading an install that used the metered APIs

The `claude` (Anthropic API), `openai` and `deepseek` providers are gone, and
with them every API key the app ever read. On the first start after upgrading,
migration 007 tidies the database once, the way 006 did for browser chat:

- It removes their model records and enable switches, the flat
  `claudeEnabled` / `openaiEnabled` / `deepseekEnabled` flags an older row
  carries, and any API key store still in the row.
- It repoints whatever named them. A default that named a removed model moves
  to the Claude seat's Sonnet when that can run, otherwise to the first model
  that can, in seat order. A profile's model choice and a prompt's model
  override that named one are cleared, which means "use the default" - an API
  model name is not a seat's, so nothing is mapped across.
- An install left with no seat switched on, or no model that can run, gets one
  back - never anything billed per token. The seat is one not locked here:
  first one the row explicitly switched on, then one it records nothing about
  (the Gemini seat, on any row older than this release), then one switched off;
  one with a model already switched on before one without; Claude, Codex,
  Gemini after that. It gets its missing shipped models, and failing that one
  of its own switched back on. With every seat locked the row is left as it is,
  and the log says nothing can run until a seat is unlocked.
- It keeps a copy of the settings row first, in `app_settings` under
  `app-settings.backup.pre-metered-removal` - verbatim except for the API key
  store, which is not copied - and the prompt rows it changed in a side table,
  `prompts_backup_pre_metered_removal`. What it removed and the profile choices
  it cleared are in `migration-log.provider-schema-7`; a later run adds to that
  log rather than replacing it.
- It deletes the API keys from `app-settings.backup.pre-claude-cli`, the
  snapshot the oldest provider migration took verbatim - the last plaintext
  copy of keys nothing can use. The rest of that snapshot is kept, so
  `npm run ai:rollback` still restores it, and 007 cleans what it brings back
  on the next start.

Like 006, it can be held back - it waits behind the migration that waits for the
first administrator, and while the settings row is not valid JSON - and nothing
depends on it having run. A record, profile, prompt or open page that still
names a metered provider or one of its shipped models is read as the default,
never as an error, and the backend log says so once per name. That includes an
administrator's own metered model, whose id 007 logs, and the model an older
release named after `OPENAI_MODEL`, `CLAUDE_MODEL` or `DEEPSEEK_MODEL` for as
long as that variable is still set. An install left with nothing it can run is
repaired in memory by the same rule as above until an administrator saves
Settings, exactly as in section 5.

A run queued across the upgrade still finishes: a resume that was waiting for a
metered provider is built on whatever its profile resolves to now, and is not
charged again.

An install that skips releases runs 006 and 007 in the same start. 006 is kept
as it was written, so on such an install it can still switch a metered API on,
or ask for its key - and 007 removes that provider in the next lines. Every such
note of 006's ends *(This release has no metered providers: migration 007, which
runs after this one, removes them ...)*: follow 007's note, not 006's.

**Delete the old variables from `.env`.** `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `CLAUDE_MODEL`, `OPENAI_MODEL`,
`DEEPSEEK_MODEL`, `CLAUDE_BASE_URL`, `OPENAI_BASE_URL`, `DEEPSEEK_BASE_URL`,
`CLAUDE_MAX_ATTEMPTS`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`,
`AI_CLI_ALLOW_API_KEY` and `AI_CODEX_ALLOW_API_KEY` are read by nothing. The
backend names whichever is still set, once, at startup - never its value:

```
[ai] OPENAI_API_KEY, AI_CLI_ALLOW_API_KEY are still set, and nothing reads them: ...
```

The seats strip any key from their CLI's environment either way, and the two
`*_ALLOW_API_KEY` switches no longer turn that off.

### 7. The Gemini model and the new model names

Migration 008 runs once on an install that has its own model list - a fresh
install, and a row that never saved one, read the shipped models and need
nothing:

- It adds the shipped Gemini model, **Gemini** (`gemini-cli-auto`, the `auto`
  model), unless the list already has a Gemini model. The
  Gemini seat has no switch in an older row and so reads as switched on; without
  this it would be on with nothing to pick. Its log line says whether users can
  pick it now: not while the seat is locked here (`AI_LOCKED_PROVIDERS`) or
  switched off under **Admin → Settings**.
- It drops "(subscription)" from the shipped display names nobody changed:
  *Claude Sonnet (subscription)* becomes *Claude Sonnet*, and so on for Opus,
  Haiku and *Codex (subscription)*. Only a name exactly as a release shipped it,
  on the model it was shipped for, is renamed; a name an administrator typed is
  theirs. A rename onto a name another model already has is skipped and logged
  (*Left "Claude Opus (subscription)" as it is ...*), since users would see two
  identical choices; rename one of the two under **Admin → Models**.

It leaves the default and the switches alone, and logs what it did in
`migration-log.provider-schema-8`. A model it adds has no price, and reads as
**free** (`$0.000`) until an administrator sets one - Admin → Models lists it in
red until then (see [Credits are dollars](#10-credits-are-dollars)).

### 8. Plans are now subscriptions

What used to be an account's **plan** - Default, Premium, Premium+, Premium
Max - is its **subscription** everywhere: on the pages, in the API and in the
database. What each one allows is unchanged.

- On the first start the backend renames the column `users.plan` to
  `users.subscription` in place, keeping every account's value, and logs
  `[db] Renamed users.plan to subscription: ...` once. It decides from the
  table itself rather than from a marker, so a second start does nothing, and a
  database renamed back for an older build (below) is renamed forward again.
- **Settings → Plan** is **Settings → Subscription** (`/settings/subscription`).
  `/settings/plan` still opens it, so a bookmark keeps working.
- In the API, an account's `plan`, `planLabel` and `planSummary` are
  `subscription`, `subscriptionLabel` and `subscriptionSummary`; the admin
  account list's `plans` is `subscriptions`; `GET /api/auth/plans` is
  `GET /api/auth/subscriptions`; `POST` and `PATCH /api/admin/accounts` take
  `subscription`; and a section the account's tier does not include answers 403
  `subscription-too-low` with `requiredSubscription`. There are no aliases,
  because the frontend ships with the backend. An Accounts page left open from
  before the upgrade has its subscription changes and invites refused rather
  than ignored, and must be reloaded: until then a subscription change breaks
  the page (so do a delete and any refused change, which reload a list the old
  page no longer reads), and an invite says to reload.

**Rolling back** to an older build: it reads `users.plan`, and against an
upgraded database every account read fails with `no such column: plan`. Stop
the backend and rename the column back before starting the older build:

```sh
sqlite3 "$DB_DIR/free_tailor.db" 'ALTER TABLE users RENAME COLUMN subscription TO plan;'
# or, without the sqlite3 shell, from the repository root:
node -e "new (require('./backend/node_modules/better-sqlite3'))(process.argv[1]).exec('ALTER TABLE users RENAME COLUMN subscription TO plan')" "$DB_DIR/free_tailor.db"
```

Upgrading again renames it forward. Rename it rather than adding a `plan`
column: with both present this build reads `subscription` and leaves `plan`
alone (see Troubleshooting).

### 9. Saved templates are files

The templates an administrator imports, extracts from a PDF or builds in the
manual editor used to be rows in the database's `templates` table. They are
files now: `<id>.json` in `backend/static/templates` (or
`$TAILOR_STATIC_DIR/templates`) beside the built-ins, with a `"source"` field
(see [Where data lives](#where-data-lives)). Back that directory up with the
database from now on.

- On its first start the backend writes every `templates` row out as a file,
  records what it did under the `schema_meta` key `templates_moved_to_files`,
  and leaves the rows in the database as a backup it no longer reads.
- Ids are lower-case letters, digits and hyphens now, and an older import kept
  upper case and underscores (`My_Template`, `Navy_Rule`, `_draft`). Such a row
  is filed under its folded id (`my-template`) when that is free, and under a
  fresh `u-` id when it is not - when it is a built-in's (`Navy_Rule` folds to
  the shipped `navy-rule`) or another template's, or no id at all (`_draft`).
  A row whose id already was a valid one always keeps it. The profiles naming
  a renamed row are changed to name the new id in the same step, and anything
  else still naming the old one - a queued resume, a page left open, a profile
  file exported earlier - finds the same template, so every profile is drawn
  with the design it was drawn with before. The log says
  `[templates] Template "<old>" is now <new>.json` for each.
- A row is left in the database only when a file of exactly its id is
  already there - a built-in, which hid that row from the older build too, or
  a different saved template - or its data cannot be read (see
  Troubleshooting).
- A row that could not be written - the directory is not writable, or a file
  in the way cannot be read - is tried again at each start until it is, and
  only it: a template that was moved and then deleted or edited stays as the
  administrator left it.
- A template file copied into the directory by hand is offered only under a
  name an id can have; the startup line names any that is not (see
  Troubleshooting).

**Rolling back** to an older build: it reads every file in `static/templates`
as a built-in. Saved templates still render there, but read-only - no edit or
delete, and an edit to a manual template goes to its database row, which the
file hides - and a renamed one is listed twice, under its old id as well. To
have them editable, stop the backend and move the files that carry a
`"source"` out of `static/templates` before starting the older build, which
then serves the database rows - except the files of renamed rows (the
`renamed` list in the record): their profiles now name the new id, and would
be drawn with `default` without the file. Templates created or edited since
the upgrade exist only in the files, not in the rows.

**Upgrading again** moves nothing on its own, because the move is recorded as
done. To bring forward what was created or changed under the older build, put
back any files you moved aside, delete the record, and start this build:

```sh
sqlite3 "$DB_DIR/free_tailor.db" "DELETE FROM schema_meta WHERE key = 'templates_moved_to_files'"
```

The move then runs over every row again. A row whose file is still there is
recognised - a renamed one is given the same new id as the first time - and
left as it is, unless the row was changed after the file was, in which case
it replaces the file; a row created under the older build is written out.

### 10. Credits are dollars

A credit was a whole unit bought at a price - 50c by default, so `$1` bought
two - and a model cost a whole number of them. **A credit is a dollar now**,
counted to the thousandth: balances, prices, charges and refunds are integer
thousandths of a dollar in **new columns** (`users.balance_milli`,
`credit_ledger.delta_milli`, `credit_reservations.units_milli`,
`payments.credit_milli`...), never the old ones reinterpreted. Purchases credit
exactly what they charge, with no price per credit and no crypto fee.

What was already there is **reset, not converted** - the owner's decision, since
credits bought at different prices have no one fair rate. On its first start
the backend, once:

- writes a `reset` row in each account's history taking its old balance to
  zero, in credits (an account whose balance predates the ledger gets the
  opening row migration 004 would have written first), and zeroes
  `users.credits`. Every balance starts at `$0.000`. An account whose credits
  were all held by a run in progress gets a `reset` row too, moving `0
  credits` and naming what was held, because that run stops refunding (below).
- closes every reservation still open in credits. A run in progress finishes
  on the credits it was paid with: its tasks are priced at `$0.000`
  (`payload.costMilli: 0`, the old `creditCost` kept beside it), so it is not
  charged again in dollars, and a resume of it that fails gives back nothing -
  the credits it would have given back were reset with the balance.
- stamps every **pending** payment with what it will credit: a checkout opened
  before the upgrade and paid after gets exactly what it charged, in dollars.
  Paid payments are history and keep their credit figures.
- leaves the model prices where they are in the settings row - they are in
  credits, and nothing reads them as a price any more. Every model reads as
  `$0.000` until it is priced under **Admin → Models**, which lists every free
  enabled model in red. Startup says *Every model is FREE until it is priced*.
  `creditPriceCents`, `creditMinCredits`, `creditMaxCredits` and the crypto
  `feeBps` are no longer read either. They stay in the row only until the
  first settings save of any kind - a price under Admin → Models, a payment
  limit, a General setting - which rewrites the whole row without them, every
  model's `creditsPerResume` included. The old figures are kept in the
  snapshot below (`models`, `pricing`).

It logs one line - `[credits] Credits are dollars now: ...` - and keeps
everything it changed, as it was, in `app_settings["migration-log.credits-to-dollars"]`
(balances and held credits per account, the reservations, the queued tasks, the
pending payments, the old model prices and pricing settings). It runs in
`getDb()`, not in the numbered chain, so an install waiting for its first
administrator switches too; `schema_meta.credit_unit = 'usd-milli'` records that
it ran, and a second start does nothing.

`CREDIT_SIGNUP_GRANT` is read as **dollars** now: an old `5`, five credits
(about `$2.50` of resumes), grants `$5.000`. Check it.

Pages loaded before the upgrade are refused rather than misread wherever they
would send money in the old unit - a price in credits, a balance or grant in
credits, payment limits in cents, a purchase as a count of credits - with
*This page is from an older version of the app. Reload it and try again.*

**Rolling back** to an older build: it reads only the old columns, so it sees
every balance at `0` credits and every reservation the switch closed as
closed. A checkout opened under this build carries `0` credits, so if it is
paid while the older build runs, that build holds it for a person instead of
crediting a guess. Dollars bought since the upgrade are invisible to it - they
are still in `balance_milli` when you upgrade again - and credits granted under
it are not carried forward: the switch has run, and does not run again.

Two things do not survive the round trip:

- **Dollars held by a run in flight are lost.** The older build sees a run
  started under this one as holding nothing (its whole-credit columns are 0):
  a resume of it that fails there refunds nothing, and its settle - or that
  build's 6-hour startup sweep - closes the reservation. Upgrading again does
  not give those dollars back, because a closed reservation takes no refund.
  **Let the queue drain, or cancel the runs, before stopping this build to
  roll back.**
- **Model prices in credits, after any settings save.** Once this build has
  saved the settings row (above), the older build finds no `creditsPerResume`
  on any model and prices every one at its default of 1 credit, and a credit
  at its default price. Put the old figures back by hand from
  `migration-log.credits-to-dollars` (`models`, `pricing`).

---

## 🌐 Serving it on your own domain

Everything above runs the app on a LAN address over plain http. Putting it on a
public domain means one reverse proxy in front of the two processes, which keeps
them on loopback and gives both halves the same origin — so the session cookie,
the CORS rule and the payment webhooks all line up without special cases.

```
                        yourdomain.com
                              │
                         ┌────┴────┐
                         │  Caddy  │  :443, certificate renewed for you
                         └────┬────┘
                  /api/*  ────┤────  everything else, and /api/calendars/*
                              │
              ┌───────────────┴───────────────┐
        Express :3001                   Next.js :3000
```

**Point the domain at the box first.** Caddy cannot get a certificate for a name
that does not resolve to it, so this is the step everything else waits on:

| Type | Host | Value |
|---|---|---|
| A | `@` | the server's public IPv4 |
| A | `www` | the same address, if you want `www` to work |
| AAAA | `@` | the server's IPv6, if it has one |

At a registrar that parks new domains — Namecheap plants a `www` CNAME and a URL
redirect — **delete those two first**; left in place they win over what you add.
Then `dig +short yourdomain.com` from somewhere else before going on. Open only
80 and 443 in the firewall: 3000 and 3001 stay on loopback.

**Behind Cloudflare, leave the proxy OFF.** This is the opposite of Cloudflare's
default and it is not a preference — the orange cloud is incompatible with how
generation works here.

Cloudflare's proxy read timeout is about **100 seconds on Free, Pro and Business,
and cannot be raised** (only Enterprise can). But `/api/resume/analyze`,
`/generate` and `/preview` run **inline** and wait: `/generate` awaits the job
analysis, then the tailoring, then the PDF and DOCX rendering, against budgets of
`AI_CLI_TIMEOUT_MS=180000` and `AI_CLI_TIMEOUT_MS_TAILOR=300000` — three to five
minutes per call, deliberately, because a subscription seat is not fast. Each of
those requests is a guaranteed **error 524** behind the proxy, on a server that is
working perfectly. A Job Search run is the same: the request waits for the Apify
run, for up to `APIFY_RUN_TIMEOUT_S` (300 seconds by default).

So set the `A` records to **DNS only** (grey cloud). Two consequences: the origin
IP is public, so the firewall above is doing real work; and Cloudflare's
**SSL/TLS mode is irrelevant** — traffic never reaches their edge, and Caddy's
Let's Encrypt certificate is the real one.

Wanting the CDN later means splitting the origin: the app on a proxied
`yourdomain.com`, the API on a **grey-clouded** `api.yourdomain.com`, with
`NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api` and
`FRONTEND_URL=https://yourdomain.com`. The session survives it — the cookie is
`sameSite: 'lax'` and a subdomain shares the registrable domain, so it is still
same-site — but CORS becomes real. If you do proxy, use **Full (strict)**, never
*Flexible* (plaintext to your origin, and a redirect loop against Caddy), and know
that **Bot Fight Mode blocks webhook POSTs** from Stripe and Cryptomus.

Last Cloudflare-specific trap, on the mail side: **do not enable Email Routing.**
It rewrites your MX records to Cloudflare's and silently takes delivery away from
whatever provider you set up below.

**The `.env` differences.** Bind both halves to loopback — the proxy is the only
thing that should be reachable — and name the public address once:

```bash
APP_URL=https://yourdomain.com           # the only domain value you need

HOST=127.0.0.1
PORT=3001
FRONTEND_HOST=127.0.0.1
FRONTEND_PORT=3000

DB_DIR=/opt/free_tailor/data/db          # absolute: a relative path follows the cwd
ADMIN_EMAILS=you@yourdomain.com
```

`APP_URL` is what the frontend's API base, the payment return address and the
allowed CORS origin are all derived from. The backend prints it at startup, so
the log says what it resolved to.

Two consequences worth knowing:

- **It is compiled into the frontend bundle.** Set it *before*
  `npm run build --prefix frontend`; changing it later needs another build, not
  a restart. Setting only `APP_URL` and restarting is the commonest way to see
  every action report an unreachable backend.
- **`NEXT_PUBLIC_API_URL`, `PAYMENTS_RETURN_URL` and `FRONTEND_URL` are now only
  for split deployments** — the frontend and API on different machines. Each
  still overrides what `APP_URL` derives, so an existing install that sets them
  keeps working exactly as it did.

`FRONTEND_URL` in particular is *not* needed here: the backend allows any origin
whose hostname matches the `Host` the request arrived on, plus `APP_URL`, and
Caddy passes `Host` through. Set it only if your proxy rewrites `Host`.

**The Caddyfile** — this is the whole of it:

```
yourdomain.com {
	encode zstd gzip

	# The calendar page's API routes are Next.js route handlers, not Express,
	# so they go to the frontend despite the /api prefix. Without this the
	# calendar page answers 404 on a domain.
	handle /api/calendars/* {
		reverse_proxy 127.0.0.1:3000
	}

	handle /api/* {
		reverse_proxy 127.0.0.1:3001
	}

	handle {
		reverse_proxy 127.0.0.1:3000
	}
}

# Only if you added the `www` A record above.
www.yourdomain.com {
	redir https://yourdomain.com{uri} permanent
}
```

**Both processes under systemd.** `/etc/systemd/system/tailor-api.service`:

```ini
[Unit]
Description=Tailor API
After=network.target

[Service]
User=tailor
WorkingDirectory=/opt/free_tailor/backend
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`tailor-web.service` is the same file with `WorkingDirectory` pointing at
`frontend`. Build both first (`npm run build --prefix backend`, then the
frontend), then `systemctl enable --now tailor-api tailor-web`.

**Chrome's shared libraries are not on a fresh server**, and puppeteer's
download does not bring them. Without these, PDF generation fails with a bare
"browser exited":

```bash
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2   libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1   libpango-1.0-0 libcairo2 libasound2t64
```

**Three consoles hold the old address** and need the new one:

| Where | What to set |
|-------|-------------|
| Google Cloud → Credentials → your Web application client | Add `https://yourdomain.com` to **Authorized JavaScript origins**. There is no redirect URI to add — sign-in verifies an ID token rather than redirecting. |
| Stripe → Webhooks | Endpoint `https://yourdomain.com/api/payments/webhook/stripe`, subscribed to all seven events listed in `.env.example`. Copy the new signing secret into `STRIPE_WEBHOOK_SECRET`. |
| Cryptomus dashboard, or `CRYPTOMUS_CALLBACK_URL` | `https://yourdomain.com/api/payments/webhook/cryptomus` — the **API**, not the frontend. |

**Install the subscription seats on the server** - the ones you mean to use;
one is enough. The default provider is the Claude seat, and all three work on a
headless box - none needs a display: Codex's device sign-in is approved from a
browser anywhere else, and Gemini prints a URL to open elsewhere and takes the
code back:

```bash
npm i -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli

sudo -u tailor -H claude auth login          # over SSH
sudo -u tailor -H codex login --device-auth  # prints a code you approve in ANY browser
sudo -u tailor -H env NO_BROWSER=true gemini # "Sign in with Google", paste the code, /quit
```

Lock any seat you do not set up (`AI_LOCKED_PROVIDERS=codex-cli,gemini-cli`),
so its models are not offered. Three things go wrong in this order:

- **Sign in as the user the service runs as.** The sign-in lives in that user's
  home (`CODEX_HOME` for Codex, `~/.gemini` - or `AI_GEMINI_HOME` - for Gemini),
  so `claude auth login` as root is invisible to a unit running as `tailor` -
  hence `sudo -u tailor -H`.
- **systemd gets a minimal `PATH`.** A seat that reports its CLI missing at
  startup or on the admin Settings page - `No "gemini" on the server PATH`,
  `spawn codex ... ENOENT`, "the Claude CLI is not installed" - wants
  `AI_CLI_BIN`, `AI_CODEX_BIN` or `AI_GEMINI_BIN` set to the full path from
  `which claude` / `which codex` / `which gemini`.
- **Each seat has its own queue lane**, sized by `AI_CLI_CONCURRENCY`,
  `AI_CODEX_CONCURRENCY` and `AI_GEMINI_CONCURRENCY`. They are counted
  separately; the defaults of 4, 4 and 2 are a fine place to start - Gemini's is
  lower because a Google account has per-minute limits on top of its daily
  quota.

**Mail from your own domain** is DNS first, then four values. Outgoing mail here
is only the sign-in codes, so there is nothing else to move.

Take the **MX and DKIM records from your mail provider's own setup wizard** — it
shows the records for your account and is the authority; anything written down
here is only for sanity-checking what it gives you. With Google Workspace that
is one MX record (`smtp.google.com`, priority 1; the older five `ASPMX…` records
still work, but use one form or the other and never both), SPF as a TXT record on
`@` (`v=spf1 include:_spf.google.com ~all`), and DKIM generated under Admin →
Apps → Google Workspace → Gmail → *Authenticate email*. Generating the DKIM key
without then pressing **Start authentication** is the usual half-finished state.
A DMARC TXT record on `_dmarc` is worth adding, starting at `p=none`: it reports
without rejecting, and going straight to `p=reject` with DKIM misconfigured bins
your own mail silently.

Then the app's four values. With Google Workspace, `SMTP_PASS` must be an **App
Password** — Google rejects the account password over SMTP, and App Passwords
only exist once 2-Step Verification is on:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@yourdomain.com
SMTP_PASS=the-16-character-app-password
SMTP_FROM=you@yourdomain.com
```

**Sending through a relay instead** — Resend, SendGrid, Brevo and the like — is the
free alternative to a paid mailbox, and it makes two variables that look optional
**mandatory**. Both of these produce an install that reads as configured and is
not:

- **`SMTP_FROM`.** It falls back to `SMTP_USER`, and a relay's username is not an
  address: Resend's is the literal word `resend`, SendGrid's is `apikey`. Without
  `SMTP_FROM` the server tries to send *from* `resend`.
- **`ADMIN_EMAILS`.** It falls back to `SMTP_USER` too, but only when that looks
  like an address - deliberately, so `apikey` is not promoted to administrator.
  With a relay it therefore names nobody, and an installation with no
  administrator cannot appoint one from the UI.

A relay needs its own DNS records to send as your domain, and a domain may hold
only **one** SPF record. If you are also forwarding inbound mail with something
that writes an SPF record of its own (Cloudflare Email Routing does), merge the
two into a single record rather than adding a second - two SPF records on one name
is invalid and breaks both. Most relays sidestep this by putting their records on
a `send.` subdomain, since an apex SPF policy does not apply to subdomains.

**Check the mail setup on its own, before anything else is involved:**

```bash
cd backend
npm run mail:doctor                          # config, the two relay traps, connect + auth
npm run mail:doctor -- --to you@example.com   # also sends one real message
```

It walks the same chain the sign-in flow walks and stops at the first break, naming
what to change — and it needs no server, no frontend and no domain pointed anywhere.
The step that matters most is the distinction between *connecting* and *sending*: a
relay authenticates fine and then refuses to send from a domain it has not verified,
which is the usual state mid-setup and the one the app's own error cannot express.

Then check the three things that can only be checked from outside:

```bash
curl https://yourdomain.com/api/health
cd backend && npm run sheets:doctor
```

and request a sign-in code in a browser, confirming it arrives from the new
address. A failure to send names itself in `journalctl -u tailor-api`; the code
itself is deliberately never in that log.

Two more worth doing once, because each fails quietly rather than loudly:

- **Open the page and watch the network tab.** API calls must go to
  `https://yourdomain.com/api/...`. If they go to `http://...:3001` the frontend
  was built before `APP_URL` was set - rebuild it, as above.
- **Send a mail from the new inbox to a Gmail address and open *Show original*.**
  SPF, DKIM and DMARC must all read **PASS**. Anything else means a DNS record is
  missing or DKIM was generated but never started.

## 📁 Project Structure

```
free_tailor/
├── backend/                 # Express API
│   ├── src/
│   │   ├── config/         # .env loading, operational settings table, provider catalog,
│   │   │                   #   each seat's model-name list, static asset paths
│   │   ├── database/       # SQLite connection, schema, repositories
│   │   ├── database/
│   │   │   └── migrations/ # One-time data migrations, run on first DB use
│   │   ├── routes/         # API routes
│   │   ├── services/
│   │   │   ├── ai/         # Provider-agnostic AI transport
│   │   │   │   ├── providers/cli/        # The shared spawn seam: runner, binary resolution
│   │   │   │   ├── providers/claudeCli/  # The `claude` CLI seat
│   │   │   │   ├── providers/codexCli/   # The `codex` CLI seat
│   │   │   │   └── providers/geminiCli/  # The `gemini` CLI seat
│   │   │   ├── resumeService.ts          # Resume/cover-letter domain logic
│   │   │   └── templateChoice.ts         # The one rule for which template a resume is drawn with
│   │   ├── generators/     # PDF, DOCX, cover letter generation
│   │   ├── middleware/     # Auth, uploads, and publicError.ts - what a failure may tell whom
│   │   ├── scripts/        # Legacy data import, provider-migration rollback
│   │   └── types/          # TypeScript types
│   ├── static/
│   │   ├── prompts/        # Default prompt per feature
│   │   ├── skills/         # Skill library seed
│   │   └── templates/      # Built-in templates
│   └── test/               # node:test suite
│       └── fixtures/       # CLI event streams: cli/ (claude), codex/, gemini/
├── frontend/               # Next.js app
│   └── src/
│       ├── app/            # Pages (/, /admin/*, /jobs, /bid-assistant, /calendar)
│       ├── components/     # Reusable UI components
│       │   ├── profile/    # The profile editor and its live preview, one file per group of sections
│       │   ├── shell/      # The app shell: top bar, sidebar, settings sub-nav
│       │   └── icons/      # The inline SVG icon set
│       └── lib/            # API client, userMessage.ts - one way to show a failure -
│                           #   and profileDraft.ts, the editor's form/payload/template rules
└── generated/              # Default output location for resumes and cover letters
```

---

## 📤 Output Structure

There are **two ways to generate, and they file their output differently.**

**Building manually** is one resume at a time, downloaded as soon as it is
built. It uses the output path template from the admin settings, for example:

```
{profile}/{date}/{company}/{role}/
├── {profile}.pdf
├── {profile}.docx
├── {profile}_cover_letter.pdf
└── {profile}_cover_letter.docx
```

File and folder names are templated per profile.

**Order & Download** is what a Google Sheet import does, and its layout is a
constant rather than a setting:

```
{account}/{date}/{order number}/{profile}/{company}/
```

Not configurable on purpose. These files are listed, downloaded, zipped and
eventually deleted *by path*, days after they were written - so a layout an
administrator edited in between would strand a live order's files and point the
purge at a directory that no longer holds them. The account comes first so that
everything one person ordered lives under one directory, which is what lets the
clean-up prune emptied folders without ever walking into somebody else's tree.

**The order number is there because nothing else in the tree is unique.**
Account, date, profile and company all repeat: import the same sheet twice in
one afternoon and every segment matches, so the second run would overwrite the
first - leaving the first order listing files that hold the second's contents,
and its earlier expiry deleting files the second still offers. The account
segment is no help either, since it is sanitized for the filesystem and
`john.smith@` and `john-smith@` both become `john_smith_`. An order number is
unique across the install, which settles all of it in one segment.

---

## ⚙️ Admin Panel

| Section | Purpose |
|---------|---------|
| **Accounts** | Every account on the installation, with its role, subscription, balance and profile use. Set a balance outright or add a delta, in dollars to `$0.001`, and read any account's ledger to see where a balance came from. Change any of them, disable an account, end all its sessions, or delete it. The last enabled administrator cannot be demoted, disabled or deleted - account management is admin-only, so that would leave nobody who could undo it - and no administrator can demote, disable or delete the account they are signed in with (another administrator can). Adding an account here sets somebody's subscription before they arrive; it is not a way in, since they still prove the address through Google or a code |
| **Profiles** | Create/edit candidate profiles - content, template, Technical Skills layout (Plain or Grouped), the Soft Skills and Strengths switches, prompts, file naming and hard-skill ordering - on a page of their own with the resume drawn live beside the form (see [Editing a profile](#editing-a-profile)). Three ways in: **New Profile**, **Upload Resume PDF** (an AI call reads the PDF), and **Import JSON** (no AI call - the file already is a profile); an upload, and an import that makes exactly one profile, open its editor. Each row shows the profile's template and layout |
| **Profile JSON import** | Takes one profile, a list of them, or `{ "profiles": [ ... ] }` - the shapes `GET /api/profiles/:id` hands out. An import never overwrites a profile you already have: an id that is free is kept, so a backup restored into an empty install keeps the ids its groups reference, and one that is taken gets a new profile instead. A file with one bad entry imports nothing rather than half |
| **Groups** | Group profiles for batch generation |
| **Credentials** | None to manage. Claude Code, Codex and the Gemini CLI run on subscription seats signed in on the server, and the app has no API key anywhere - nor a field to enter one |
| **Models** | Each model an account can pick: a **display name** (required, and the only part of it anybody else sees), a **provider** - Claude (Subscription), Codex (Subscription) or Gemini (Subscription), with a 🔒 on a seat locked here - a **model name** chosen from that provider's own list, which changes with the provider (Sonnet, Opus, Haiku, Fable for Claude; Account default, GPT-6.1-Sol, GPT-6-Astra, GPT-6-Luna and the rest for Codex; Auto, Pro, Flash, Flash-Lite and the Gemini ids for Gemini - each list overridable in `.env`), a **price per resume** in dollars (`0.023`, in steps of `$0.001` from `$0.000` to `$1000.000`, `0` shown as *Free*; required when a model is added, since there is no default), and a description. Every enabled model priced `$0.000` is listed in red above the table, so a free model is always a decision somebody can see. The list shows each model's provider, model, price and status. A model whose name has since left its provider's list is flagged *Not in model list* and keeps running. **Set Default** refuses a model that cannot run - switched off, on a locked seat, or on a provider switched off - rather than quietly substituting another. One model per provider and model name, and one per display name - compared trimmed and in any case, because the display name is all anybody else sees, and two models sharing one would be identical choices at different prices |
| **AI defaults per profile** | Each profile picks its own model; the builder shows that default and can override it for a single run. Both menus list only the models that can run right now, by display name - no provider, model name, price or lock. A profile whose model has since gone shows *Unavailable model* and runs on the default until the model is back - saving the profile for any other reason keeps the choice - and the server refuses a run, or a profile save that newly picks one, with *That model isn't available* |
| **Templates** | Open to everybody from the top bar to look at and preview; only an administrator can add, edit, disable or delete one. Nineteen built-in templates - Professional Two-Column, Classic Serif, Developer Mono, Structured Slate, Editorial Italic, Contrast Cards, Charcoal Sidebar, Timeline Bars, Indigo Band, Forest Chips, Slate Italic, Burgundy Rule, Navy Rule, Navy Gold, Amber Gradient, Ink Ledger, Dossier Panel, Framed Serif and Azure Stack - plus manual and uploaded ones. **View** renders any of them with a full sample resume in that template's own page box, read from its `@page` rule, so the preview and the printed PDF agree. Each template declares the Technical Skills layouts it prints (`skillsLayouts`) - Burgundy Rule and Navy Rule are Grouped only - and a profile's picker offers only those that print its layout; see [Templates and the two skills layouts](#templates-and-the-two-skills-layouts) |
| **Prompts** | Edit default prompts or add custom variants per feature, grouped into **Extracting Prompts** (a posting into keywords, a resume PDF into a profile, a scraped page into job attributes) and **Building Prompts** (the tailored resume content and the cover letter). The line is what a prompt produces, not what it reads. A prompt can pin its own model - a provider and a model name from the same lists as **Models**. Each feature's prompt may use only the variables its code supplies, all listed beside it; a name that is not one of them is refused on save. Admin-only to change, since one edit changes what every account gets; see [Prompts and the section switches](#prompts-and-the-section-switches) |
| **Notifications** | Post a notice to everybody on the installation. It appears in the bell in every account's top bar, with an unread dot until they open it. Editing one corrects the text without marking it unread again, so fixing a typo does not light the dot for people who have already read it. The notices the app writes for one account - a refund request decided - are not listed here and cannot be edited |
| **Payments** | Every purchase, with **Refund** for a card payment, and the **Refund requests** queue: approve, decline with a reason the person will read, or mark refunded - which makes the refund (see [Asking for a refund](#asking-for-a-refund)) |
| **Skills** | Maintain the hard/soft skill library |
| **Settings** | One entry in the sidebar covering General, Google Sheets, Prompts, Models, Skill Library, Notifications, Payments and Prompt Test, which appear as a second row once you are in it. General holds AI providers, the default model, output location, the **Contact** list - how people reach you, shown to everybody in *Contact admin* (see [Contacting the administrator](#contacting-the-administrator)) - and a live status card per seat that is not locked (sign-in, in-flight calls, and for Claude the usage window; Gemini's names the signed-in Google account). Each provider row shows what it reports right now. A provider this installation cannot run is marked 🔒 with the reason, and its checkbox is fixed at whatever the operator last chose. Prompt Test runs a prompt on a model you pick by name. Every page here shows the cause of a failure under its message |

---

## 🔧 Configuration

Everything is set in the one `.env` at the repository root; `.env.example` is
the annotated list, grouped by feature. The rules are the same for every
setting in it:

- **Empty means the default.** A bare `NAME=` is unset, and so is a commented
  `#NAME=value` line, which shows the default the server already uses. Every
  value written in `.env.example` is that default, so an unedited copy runs like
  an installation that sets nothing.
- **The unit is in the name**: `_MS` milliseconds, `_S` seconds, `_DAYS`,
  `_MB` megabytes, `_BYTES`. Plain digits only - `30s` is unreadable, not thirty
  seconds.
- **A bad value is not fatal** - `HOST` aside, which is passed to the operating
  system as written, so an address this machine does not have stops the server
  starting. Out of range is clamped to the nearest end of the range, anything
  unreadable is replaced by the default, and the backend says which, once, on an
  `[env]` line. (The older `AI_CLI_*` / `AI_CODEX_*`
  numbers, `AI_BATCH_CONCURRENCY` and `GENERATION_MAX_ATTEMPTS` read numbers
  more loosely and clamp without a word.)
- **A variable exported in the environment beats `.env`**, on both halves - a
  shell, a systemd `Environment=`, `docker run -e`. The file fills in only what
  the environment does not set, so `DB_DIR=/tmp/ft-db PORT=3001 node
  backend/dist/index.js` means what it says, and a bare `NAME=` in the file no
  longer blanks a value exported in your shell. A name set in both places with
  different values is reported once at startup, by name only:
  `[env] PORT, DB_DIR are set both in the environment and in .../.env; the environment's value is used.`
- **Each process reads `.env` once, at startup**, so a change needs a restart.
  *Startup* below marks a value that sizes something built once at boot;
  *rebuild* marks a `NEXT_PUBLIC_` value, which `next build` compiles into the
  bundle, so a restart alone keeps serving the old one.

At startup the backend prints one line naming every operational setting that is
not at its default, with the value actually in use after clamping - the answer
to "what is this install really running with":

```
[env] Non-default settings: SESSION_TTL_DAYS=7, UPLOAD_MAX_MB=25
```

Those settings - the timeouts, size caps, pool widths, model lists and actor ids
that used to be literals in the code - are defined in one table,
`backend/src/config/operational.ts`, with their defaults and ranges.
`backend/test/envExample.test.js` fails if `.env.example` or this table stops
matching it.

| Variable | Description |
|----------|-------------|
| `HOST` / `PORT` | Backend bind address and port (default `0.0.0.0:3001`). `HOST` is used as written, so one that is not an address of this machine stops the server starting. A `PORT` that is not a whole number from 1 to 65535 is reported and `3001` is used |
| `DB_DIR` | SQLite database directory. Default `/data/db` on Linux and macOS, `%LOCALAPPDATA%\free_tailor\db` on Windows |
| `SESSION_TTL_DAYS` | How long a sign-in lasts (default `30`, range 1-365). One setting for both the session's expiry and the cookie's lifetime. Stamped at sign-in and never extended, so a change affects new sign-ins only |
| `JSON_BODY_MAX_MB` | Largest JSON body any `/api` route accepts (default `10`, range 1-100) - batch requests and profile imports are what come near it. Two caps are separate and fixed, and this does not raise them: the template JSON import is a file upload of at most 2 MB, and the payment webhooks take at most 1 MB. *Startup* |
| `UPLOAD_MAX_MB` | Resume and template PDF uploads must be under this many MB (default `10`, range 1-100) - a file of exactly that size is refused, as it always was. Held in memory, never written to disk. The upload pages are told the number by `GET /api/auth/me`, so no frontend rebuild; a file at or over it gets a 413 naming it. *Startup* |
| `HTTP_REQUEST_TIMEOUT_MS` | How long Node allows for *receiving* one request (default `900000`, fifteen minutes; range 60000-3600000, never 0). Raise it with the two caps above for big uploads on slow links. A reverse proxy's own body and timeout limits must allow as much. *Startup* |
| `FRONTEND_URL` | Extra allowed CORS origins, comma separated (same-host origins are always allowed) |
| `FRONTEND_HOST` / `FRONTEND_PORT` | Frontend bind address and port (default `0.0.0.0:3000`) |
| `NEXT_PUBLIC_API_URL` | Frontend API base; the hostname is replaced at runtime. Leave unset to derive it from `PORT` - set it only to reach a different machine. *Rebuild* |
| `NEXT_PUBLIC_FALLBACK_API_URL` | One more API base the browser tries last, only when none of the others could be connected to at all. Unset, there is none. *Rebuild* |
| `NEXT_PUBLIC_ALLOWED_DEV_ORIGINS` | Extra **hostnames** - not origins - allowed to open the Next.js dev server, comma separated: `192.168.1.20`, `*.home.arpa`. Next compares the hostname alone, so `http://192.168.1.20:3000` matches nothing. `localhost` is always allowed. Read only by the dev server, when it starts |
| | *(the frontend is launched through `frontend/scripts/next.mjs`, which loads this root `.env` and passes the host and port to Next - Next itself only reads `.env` files inside its own directory. A `frontend/.env*` file still wins for any key it sets, and an exported shell variable wins over both.)* |
| `NEXT_PUBLIC_CALENDAR_SHARE_URL` | Optional default calendar share link. *Rebuild* |
| `NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE` | The calendar page's starting time zone, an IANA name (default `America/Los_Angeles`). A zone outside the five the page lists is added to its menu under its city's name; an unknown one falls back with a console warning. *Rebuild* |
| `CALENDAR_API_TIMEOUT_MS` / `CALENDAR_DETAIL_CONCURRENCY` | The calendar's own API routes, which run in the Next.js server: the timeout of each calendar.online request (default `12000`, range 1000-120000) and how many event-detail requests the link scan runs at once (default `12`, range 1-32). Server-only, not `NEXT_PUBLIC_`: restart the frontend, no rebuild |
| `ADMIN_EMAILS` | Who becomes an administrator, comma separated. Leave it empty and the `SMTP_USER` address is used instead; with neither set the install has **no administrator at all** and says so at startup. **When it is set it is the only rule** - if somebody not on the list signs in first, the install has no administrator until a listed address does, and the backend says so at startup |
| `CREDIT_SIGNUP_GRANT` | What a brand-new account starts with, **in dollars**, to `$0.001`: `5` is `$5.000`, `0.25` is `$0.250`. `0` by default; above `1000` clamps. It was a count of credits before credits became dollars, so an old `5` (about `$2.50` of resumes at 50c a credit) now grants `$5` - check it when upgrading. A value with more than three decimals warns once and grants nothing |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Web application client id, for Google sign-in |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Sending the emailed sign-in codes. Port 465 is treated as implicit TLS and everything else as STARTTLS; `SMTP_SECURE` overrides that, and `SMTP_FROM` defaults to `SMTP_USER` |
| `SMTP_CONNECTION_TIMEOUT_MS` / `SMTP_SOCKET_TIMEOUT_MS` / `SMTP_MAX_CONNECTIONS` | The pooled SMTP connection: connect and greeting timeout (default `10000`), idle socket timeout (default `20000`) - both range 1000-300000, never 0, because an unbounded wait is a sign-in that never returns - and the pool's width (default `2`, range 1-20). *Startup* |
| `AI_LOCKED_PROVIDERS` / `AI_UNLOCKED_PROVIDERS` | Seats this machine cannot run (`claude-cli`, `codex-cli`, `gemini-cli`), comma separated, and the mirror, which wins. A locked seat's models are offered to nobody, and the default moves to the first seat not locked. Nothing is locked by default |
| `AI_REQUEST_TIMEOUT_MS` | The wall-clock deadline of one AI call (default `300000`, range 5000-3600000). The outer bound on every seat - slot wait and CLI process included - so a CLI budget set above it never takes effect, and startup warns when one is |
| `AI_CLI_BIN` | Path to the `claude` binary when it is not on PATH |
| `AI_CLI_MODEL` | Default model alias (`sonnet`) |
| `AI_CLI_CONCURRENCY` | Simultaneous `claude` processes, process-wide (default `4`) |
| `AI_CLI_TIMEOUT_MS` / `AI_CLI_TIMEOUT_MS_TAILOR` | Per-call wall-clock budgets, each capped by `AI_REQUEST_TIMEOUT_MS` |
| `AI_CLI_ALLOW_OVERAGE` | Allow calls on the Claude plan's paid extra usage once the subscription window is spent. Off by default. There is no switch for an API key: every seat strips keys from its CLI's environment, always |
| `AI_CLI_EFFORT` | Reasoning effort passed to the `claude` CLI, installation-wide (default `low`). There is no per-run control by design: this is an operational default, not a per-request choice. An unrecognised value warns at startup and falls back |
| `AI_CLI_WORKDIR` / `AI_CODEX_WORKDIR` | The fixed, empty working directory each CLI runs in. Default `claude-cli-work` / `codex-cli-work` inside `DB_DIR` when `DB_DIR` is set, otherwise `.claude-cli-work` / `.codex-cli-work` in the directory the backend was started from |
| `AI_CLI_HEALTH_TIMEOUT_MS` / `AI_CODEX_HEALTH_TIMEOUT_MS` | Timeout of the seat health checks - `claude --version` and `claude auth status` (default `20000`), `codex login status` (default `15000`) - run at startup and by the admin Settings card. Range 1000-120000. Raise it where a CLI is slow to start |
| `AI_CLI_MAX_OUTPUT_BYTES` / `AI_CODEX_MAX_OUTPUT_BYTES` | Most output one CLI call may produce before it is cut off to protect memory (defaults `25000000` and `8000000`) |
| `AI_CLI_RECOVERY_S` | How long a model the service refused as unavailable is left alone before it is tried again (default `600`) |
| `AI_BATCH_CONCURRENCY` | Ships unset, and should usually stay so: a batch then offers the chosen seat exactly its own slot count (`AI_CLI_CONCURRENCY`, `AI_CODEX_CONCURRENCY` or `AI_GEMINI_CONCURRENCY`). Set, it overrides all of them |
| `AI_CODEX_BIN` | Path to the `codex` binary when it is not on PATH |
| `AI_CODEX_MODEL` | Default model (`default` means "pass no `-m`" and let the account decide) |
| `AI_CODEX_CONCURRENCY` | Simultaneous `codex` processes, and the size of the Codex queue lane (default `4`). Counted separately from `AI_CLI_CONCURRENCY` |
| `AI_CODEX_TIMEOUT_MS` / `AI_CODEX_TIMEOUT_MS_TAILOR` | Per-call wall-clock budgets, each capped by `AI_REQUEST_TIMEOUT_MS` |
| `AI_CLI_MODEL_OPTIONS` / `AI_CODEX_MODEL_OPTIONS` / `AI_GEMINI_MODEL_OPTIONS` | The model names **Admin → Models** offers each seat, comma-separated, in the order the form lists them (defaults `sonnet,opus,haiku,fable`, `default,gpt-6.1-sol,gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5` and `auto,pro,flash,flash-lite,gemini-2.5-pro,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.1-pro-preview`). Checked when a model is created or its provider or model name is changed, and when a prompt's model override is saved; a model already saved with a name the list no longer offers keeps running, and the admin list flags it. A list with an entry the seat's CLI would not run as written - for Claude anything but an alias or a full `claude-...` id, for Gemini anything but `auto`, `pro`, `flash`, `flash-lite`, `gemini-...` or `gemma-...` - is ignored with one warning and the default used |
| `AI_GEMINI_BIN` / `AI_GEMINI_MODEL` | Path to the `gemini` binary (default `gemini`, found on PATH) and the model a call uses when nothing names one (default `auto`, which lets the CLI pick Pro or Flash per request). *Startup* |
| `AI_GEMINI_CONCURRENCY` | Simultaneous `gemini` processes, and the size of the Gemini queue lane (default `2`, range 1-32). Lower than the other seats': a Google-account seat has per-minute limits on top of its daily quota. *Startup* |
| `AI_GEMINI_QUEUE_WAIT_MS` / `AI_GEMINI_FIRST_EVENT_MS` | The longest a call waits for a free slot (default `600000`, range 1000-3600000), and the longest a turn may print nothing before it counts as wedged (default `60000`, range 1000-300000 - the first event follows the CLI's token refresh and setup calls). *Startup* |
| `AI_GEMINI_TIMEOUT_MS` / `AI_GEMINI_TIMEOUT_MS_TAILOR` / `AI_GEMINI_TIMEOUT_MS_FILTER` | Per-call wall-clock budgets (defaults `180000`, `300000` and `60000`, range 5000-3600000), each capped by `AI_REQUEST_TIMEOUT_MS`; startup warns when one is set above it. *Startup* |
| `AI_GEMINI_HEALTH_TIMEOUT_MS` | Timeout of `gemini --version`, the Gemini seat's health check, run at startup and by the admin Settings card (default `15000`, range 1000-120000). The check sends no prompt; it reads the sign-in files instead |
| `AI_GEMINI_MAX_ATTEMPTS` / `AI_GEMINI_MAX_OUTPUT_BYTES` | Attempts the CLI itself makes on a 429 or a 5xx, counting the first (default `3`, range 1-10), and the most output one turn may produce before it is cut off (default `25000000`, range 1000000-500000000 - the CLI echoes the whole prompt before the answer). *Startup* |
| `AI_GEMINI_WORKDIR` / `AI_GEMINI_STATE_DIR` / `AI_GEMINI_HOME` | The fixed, empty working directory every turn runs in (default `gemini-cli-work` inside `DB_DIR`, else `.gemini-cli-work` where the backend started); where each turn's system prompt, the deny-all policy and temp files go, outside that directory on purpose (default `gemini-cli-state` beside it); and an optional dedicated sign-in home, passed to the CLI as `GEMINI_CLI_HOME` - the one way to keep an operator's personal `~/.gemini/GEMINI.md` out of every prompt. Sign in with `GEMINI_CLI_HOME` set to the same directory. *Startup* |
| `GENERATION_MAX_ATTEMPTS` | How many times one resume may be built before it is given up on (default `3`, counting the first go; `1` switches retrying off). A retry costs no extra credit. *Startup* |
| `GENERATION_RENDER_CONCURRENCY` | How many resumes the generation queue renders through Chrome at once, across every lane (default `4`, range 1-32). Sized by the machine's memory, one Chrome tab per render. *Startup* |
| `PDF_RENDER_TIMEOUT_MS` | How long one PDF render step, or starting Chrome for it, may take (default `30000`, puppeteer's own; range 5000-300000) |
| `GOOGLE_CREDENTIALS_PATH` | Where to look for Google credentials, overriding the search. Either `google-oauth-credentials.json` (from `npm run sheets:login`) or a service account key. **One set serves everything** - per-account sheets, the scrapers, the sheet filter, the range import and the bid assistant |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | The older name for the same thing, still honoured. Whichever credential is used, **both** the Sheets API and the Drive API must be enabled for its Cloud project |
| `SHEET_TIMEZONE` | IANA zone deciding which day a sheet tab belongs to (e.g. `America/New_York`). Defaults to the server's own |
| `SHEET_DEFAULT_VISIBILITY` | Whether a newly allocated spreadsheet is link-shared: `private` (default) or `public`. `public` means **anyone with the link may edit**. Only that exact string opens a sheet up - anything else resolves to `private` with a warning, because the unsafe value cannot be taken back once a link is out. The account holder's own access comes from a writer grant made at allocation either way, and each account can flip its own sheet under Settings > Job Sheet |
| `SHEET_BACKFILL` | Set to `off` to skip allocating spreadsheets for pre-existing accounts at startup |
| `SHEET_BACKFILL_PAUSE_MS` | Pause between two accounts in that startup backfill (default `250`, range 0-60000; `0` is no pause) - a throttle against your Cloud project's Drive and Sheets quota |
| `APIFY_API_TOKEN` | Required for every job scraper run, which bills your Apify account; without it a run fails naming this variable. `APIFY_API_KEY` is the older name, still read when this one is empty |
| `SCRAPER_DEFAULT_LOCATION` / `SCRAPER_COUNTRY` | The job market searched: the location used when the form's is empty, memo23's fixed location and the form's starting value (default `United States`, served to the page by the API), and the Indeed actor's country and memo23's proxy country (default `US`, a two-letter ISO code). Keep the two in agreement |
| `SCRAPER_MAX_RESULTS` | Most results one scraper run may return - the only bound on the Apify bill the browser cannot get round. Unset (the default) is no cap beyond each actor's own; set (range 1-10000), larger requests are clamped, the Results menu stops there, and Indeed's and memo23's fixed counts are held to it. Lever's results are trimmed after a run billed in full |
| `APIFY_PROXY_GROUPS` | Proxy group for the Job Board, Hiring Cafe and memo23 runs (default `RESIDENTIAL`, a paid Apify add-on). `auto` leaves the group out and lets Apify choose; empty means `RESIDENTIAL`, not none |
| `APIFY_RUN_TIMEOUT_S` | How long one Apify run may take, and so how long the Job Search request waits (default `300`, range 30-3600; the page shows it). A reverse proxy must let a response take this long - Cloudflare's proxy cannot |
| `APIFY_ACTOR_INDEED`, `APIFY_ACTOR_JOBBOARD`, `APIFY_ACTOR_WELLFOUND`, `APIFY_ACTOR_LEVER`, `APIFY_ACTOR_HIRINGCAFE`, `APIFY_ACTOR_HIRINGCAFE_CRAWLERBROS`, `APIFY_ACTOR_HIRINGCAFE_MEMO23` | Which Apify actor each scraper runs; defaults in `.env.example`. Only a drop-in fork with the **same input and output schema** works, because the filters and the result parsing are written per actor |
| `JOB_PAGE_FETCH_TIMEOUT_MS` / `JOB_PAGE_BROWSER_TIMEOUT_MS` / `JOB_PAGE_USER_AGENT` | The Job Filter reading each row's posting: the plain fetch's timeout (default `20000`, range 1000-120000), headless Chrome's page-load timeout for pages that need JavaScript (default `25000`, range 1000-180000), and the User-Agent both send (default in `.env.example`; one line of printable ASCII) - pinned to one Chrome release, so replace it when sites start refusing it |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Card payments through Stripe, with the form embedded in the buy page. All three are needed or the method is not offered: the publishable key is what the form mounts with, and the API serves it to the page so no frontend rebuild is needed to change it. The secret and publishable keys are on the dashboard's API keys page; the webhook secret is not - it comes from the webhook endpoint, or from `stripe listen`. The endpoint is `/api/payments/webhook/stripe` |
| `CRYPTOMUS_MERCHANT_ID` / `CRYPTOMUS_PAYMENT_API_KEY` | Crypto through Cryptomus, on its hosted invoice page. Both are needed or the method is not offered. The payment API key does double duty: it signs outgoing requests **and** is what every incoming callback is verified against, so there is no separate webhook secret. The endpoint is `/api/payments/webhook/cryptomus` |
| `CRYPTOMUS_INVOICE_LIFETIME_S` | How long a buyer has to pay a Cryptomus invoice (default `3600`; range 300-43200, Cryptomus's documented one, never checked against the live API from here) |
| `CRYPTOMUS_CALLBACK_URL` | Optional. Sends the callback address per invoice instead of relying on the one set in the Cryptomus dashboard. Must be this server's API, reachable from the internet. Left empty the field is omitted entirely - sending it blank would override the dashboard with nothing |
| `PAYMENTS_RETURN_URL` | Where a provider sends the browser back to after paying. Must be the frontend, not the API. Unset, it is `APP_URL`, then the first `FRONTEND_URL`, then the origin the buyer's own browser is on |
| `ORDER_RETENTION_DAYS` | How long an order's resumes are kept before the server deletes them (default `5`). Stamped on each order when it is placed, so a change applies to new orders only. `0` deletes on the next sweep |
| `ORDER_RETENTION_SWEEP_MS` | How often that sweep runs, besides once at startup (default `21600000`, six hours; range 60000-86400000). *Startup* |
| `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | The Chrome to print with, overriding puppeteer's download and any installed browser. `PUPPETEER_EXECUTABLE_PATH` wins when both are set. Honoured even when the file is missing, which startup reports |
| `TAILOR_STATIC_DIR` | Where the shipped seeds - default prompts, skill library, built-in templates - are read from, instead of `backend/static`. For tests and packaging. Nothing is written there except `templates/`, where the templates administrators save are kept beside the built-ins, so it must be writable for those and backed up with the database |
| `SMTP_USER` | Also the administrator's address when `ADMIN_EMAILS` is unset. Ignored for that purpose when it is a bare username rather than an email |

See `.env.example` for the full `AI_CLI_*` and `AI_CODEX_*` lists.

**Removed, and read by nothing:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`DEEPSEEK_API_KEY`, `CLAUDE_MODEL`, `OPENAI_MODEL`, `DEEPSEEK_MODEL`,
`CLAUDE_BASE_URL`, `OPENAI_BASE_URL`, `DEEPSEEK_BASE_URL`,
`CLAUDE_MAX_ATTEMPTS`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`,
`AI_CLI_ALLOW_API_KEY` and `AI_CODEX_ALLOW_API_KEY` - the metered providers and
the switches that let a seat use a key. Startup names any of them that is still
set, never its value; delete them.

**Two settings are not read from `.env` at all**, because they steer the Chrome
download that `npm install --prefix backend` runs before anything loads that
file. Export them in the shell, for the install and the server alike:

- `PUPPETEER_CACHE_DIR` - where puppeteer keeps its Chrome (default
  `~/.cache/puppeteer`). Puppeteer reads it again at runtime to find the
  browser, so putting it only in `.env` makes the server look in a directory the
  download never used.
- `BROWSER_INSTALL_TIMEOUT_MS` - how long the download may take before it is
  abandoned: five minutes during `npm install`, fifteen for
  `npm run setup:browser`.

---

## 🩺 Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| Coin arrived on the retired on-chain path and was never credited | The watcher and the admin queue that showed these are gone, but the records are not. An unattributable transfer, or one that arrived against an order it could not be credited to, is still in the database: `SELECT * FROM chain_orphans WHERE resolved_at IS NULL;` and `SELECT * FROM chain_invoices WHERE state = 'held';` against your `DB_DIR`. Each row carries the transaction id, the amount and why it was held. Settle it by hand and adjust the balance from the accounts page - nothing in the app will surface it for you any more. |
| The Crypto button is not offered, although `CRYPTOMUS_*` is set | Both variables are needed, not one, and they are read at startup - a `.env` edited while the server was running has not been seen yet. Restart the backend and, signed in as an administrator, read the buy page's own reason under the greyed-out button: it names which key is missing. Anybody else is told only *Not available right now*. |
| Cryptomus callbacks are refused with *Signature verification failed* | The key here and the key there disagree, and every callback is being dropped - so no crypto payment will ever credit. Check `CRYPTOMUS_PAYMENT_API_KEY` against the **payment** API key in the merchant account (Cryptomus issues more than one kind of key), and check for a trailing newline from pasting. If it is definitely right, the remaining suspect is JSON escaping: Cryptomus signs the serialized body, and PHP escapes `/` as `\/` by default while JavaScript does not. Callback bodies carry URLs. That one line lives in `verifyWebhookSign` in `backend/src/integrations/cryptomus.ts` and nowhere else. |
| A Cryptomus invoice was paid but nothing was credited | Read the backend log for that payment's reference. *"the provider reported N against M"* means the amount did not match what was quoted - the payment is deliberately left pending for a person rather than credited to a guess. *"a paid event arrived with no amount on it"* means the callback carried nothing comparable to what was quoted, and a signature alone is not evidence of how much arrived - so that one is held for a person too. *"already handled"* on every attempt means the callback was recorded before; the credits either landed or the row is not pending. Nothing at all means the callback never arrived: check the address set in the Cryptomus dashboard, or `CRYPTOMUS_CALLBACK_URL`, points at **this server's API** - `/api/payments/webhook/cryptomus` - and not at the frontend. |
| Every card payment suddenly asks the buyer to confirm with their bank | *Always ask the cardholder's bank to authenticate* is on under **Admin → Payments**. That is what it does - it asks on every payment rather than only when the provider's own rules call for it. Turn it off to go back to letting Stripe decide, and note that doing so also gives up the shift of chargeback liability to the issuing bank |
| A saved card used to charge in one tap and now needs a confirmation | The same setting. A challenge needs somebody present, so a kept card can no longer be charged off-session - the exemption it earned when it was first authenticated is given up deliberately. There is no way to have both; it is the trade the switch exists to make |
| `The payment form could not be loaded. No such checkout.session: 'cs_test_...'` | `STRIPE_PUBLISHABLE_KEY` and `STRIPE_SECRET_KEY` are not from the same Stripe account, or not from the same mode. The secret key created that session; the publishable key is what the browser asks Stripe about it, and Stripe answers "no such session" because it is looking in the other account. Re-copy BOTH from <https://dashboard.stripe.com/test/apikeys> in one visit, with the **Test mode** toggle in the position you mean, and restart the backend. Both halves must be `*_test_*` or both `*_live_*`. (A session also expires after 24 hours, so an old tab left open reports the same thing - reload the buy page first if that is possible.) |
| `The payment form could not be loaded. Stripe's script did not load.` | Different failure, despite the similar wording: `js.stripe.com` never arrived. A script blocker, an offline moment or a corporate proxy will do it. Nothing was charged and no card was entered. This is also what a sandbox with no outbound network shows, which is why `backend/test/e2e/buy-credits.js` accepts it as a pass - it asserts the form mounts **or says plainly that it could not**, because a spinner with nothing said is the failure being designed out. |
| A card payment says *Waiting for payment* for ever, but Stripe's dashboard shows it succeeded | The webhook is not arriving, and the webhook is the only thing in this application that adds credits. Locally: is `stripe listen --forward-to localhost:3001/api/payments/webhook/stripe` still running, and is `STRIPE_WEBHOOK_SECRET` the `whsec_...` **that command** printed? It is a different secret from the dashboard endpoint's. Deployed: open the endpoint in the Stripe dashboard and read its delivery attempts - they show the response this server gave. A 400 there means the signature did not verify, which is the wrong secret; a 404 means the URL is wrong. |
| A buyer with a card on file is told *Your bank wants to authenticate this payment* | Their issuer refused the off-session charge and demanded a challenge, which a kept card cannot answer on its own. Nothing was charged. They can pay with the card form in the same dialog, which puts them in front of the challenge; an operator who sees this often can turn on *Always ask the cardholder's bank to authenticate* under **Admin → Payments**, which makes every kept-card charge on-session and gets the challenge instead of the refusal. |
| **Mark refunded** (then **Refund $X**) on a card purchase's refund request answers *Could not make the refund. Please try again, or contact your administrator.* with a `Ref:`, and the request stays *Requested* (or *Approved*) | Stripe refused the partial refund - most often a charge disputed, too old to refund, or already refunded in the Stripe dashboard. No money moved: the credit the refund held off the balance while it asked is back (a *Returned - the refund to your card did not go through* row in the account's Credit History) and the request did not move. An administrator sees Stripe's own reason under the message, and `grep` for the `Ref` in the backend log finds it. Pressing **Mark refunded** again measures afresh; within 24 hours Stripe repeats its answer under the same `refund:<payment>` key. A charge already refunded in the Stripe dashboard (or disputed, or too old) cannot be refunded from here at all, and the payments list's **Refund** is no way round it: it asks Stripe for the whole charge under that same key, which Stripe refuses too. Decline the request with the reason instead - and if the money did go back through the dashboard, take back the credit it bought under **Admin → Accounts** (adjust the balance). |
| **Mark refunded** on a card purchase's refund request answers *Could not confirm the refund with Stripe. Its credit stays off the balance until it is…*, and the row then says *A $X card refund was sent and not confirmed* | Stripe did not answer - a dropped connection, a timeout - so the refund may or may not have been made. The credit it was for stays held off the buyer's balance (so it cannot be spent while the money may be on its way back), and the amount sent is written down. Press **Mark refunded** again: it sends the same amount under the same `Idempotency-Key: refund:<payment>`, so Stripe answers with the refund it made, if it made one, and never makes a second; the request then turns *Refunded*, or - if Stripe refuses - the credit goes back. Or check the payment in the Stripe dashboard first. Until it is settled the request cannot be declined and the payment cannot be refunded from the payments list (see the next row). |
| **Decline** on a purchase's refund request says *That purchase is being refunded right now*, or *A $X card refund was sent to Stripe for this request and never confirmed…*; or the payments list's **Refund** says *A refund request for this payment has a card refund that Stripe has not confirmed yet* | Expected: *Declined* tells the person no money moved, so it is refused while money is moving or may have moved. *Being refunded right now*: another administrator (or another tab) pressed **Mark refunded**, or **Refund** on the payments list, and Stripe has not answered yet - wait a moment and reload the queue; if the refund went through, the request is already *Refunded*. *Never confirmed*: see the row above - press **Mark refunded** again first, and decline only if Stripe refuses it. The payments list refuses its whole refund for the same reason: the request already holds that credit, and a whole refund on top would take it twice. A decline of a purchase that HAS been refunded closes the request as *Refunded* instead and tells the person. |
| **Mark refunded** on a crypto purchase's refund request says *Crypto cannot be refunded automatically. Send $X back from your Cryptomus merchant dashboard first, then confirm here that you have.* | Expected: nothing can pull crypto back. Send that amount to the buyer from the Cryptomus dashboard, then confirm - the dialog sends `paidByHand: true` with the amount it named, or what you typed in *Amount actually sent* (whole cents, no more than was asked); the server refuses a confirmation that names no amount (*Say how much you sent back*). Only then is the request set *Refunded*, recorded at what you sent, and that much credit reversed. If the buyer spent some between the request and the confirmation, the reversal takes what is left and the answer reports the rest as a shortfall. |
| A person's refund request is refused with *What this resume was charged is not on record*, or the resumes of a run show *This run's resumes are no longer listed* | The resume is from an order placed before refund requests existed (its item carries no charge) and its batch is gone, or it is a queued resume that was not placed as an order and the queue has since forgotten its run (an hour after it finished at most, or sooner once twenty newer runs on the install had finished). Nothing records what that one resume alone cost, so it cannot be named. Grant the amount by hand under **Admin → Accounts** - the run's reserve row in the account's Credit History says what each resume was charged. |
| **Mark refunded** on a resume's request says *That account no longer exists, so nothing can be credited back* | The account was deleted after asking. There is no balance left to credit: decline the request with the reason instead. |
| After rolling back to an older build, every account's bell shows other people's notices - *New refund request FT-RF-…* with somebody's email, amount and reason, *Refund request declined*, *Refund made* | This build writes notices for ONE account (`notifications.recipient_id` set), and an older build has no recipient filter: it reads every row as an announcement for everybody. Stop the backend and run `sqlite3 "$DB_DIR/free_tailor.db" "DELETE FROM notifications WHERE recipient_id IS NOT NULL;"` - announcements are untouched, and the requests themselves stay in `refund_requests`, which the older build ignores. Do it before starting an older build (see *Rolling back past this* under [Asking for a refund](#asking-for-a-refund)). |
| The contact dialog lists fewer channels than were saved, or none, and the backend log says `[contact] A stored contact channel no longer passes its check and is not shown.` (or *not valid JSON*) | The `contact` row in `app_settings` was edited outside the app, or holds a value a rule written since now refuses. Every read re-checks every channel and leaves out the ones that fail - a link on the sign-in page is never shown unchecked. Open **Admin → Settings → General**, fix or re-enter the channel, and save. |
| A refund says *Could not confirm the refund with Stripe* | The call went out and no answer came back, so this server does not know whether the refund exists - and it deliberately reversed no credits rather than guessing. Press **Refund** again: the request carries `Idempotency-Key: refund:<payment id>`, so Stripe cannot create a second refund for that payment, and the second attempt finishes the reversal. If you would rather look first, the payment in the Stripe dashboard shows whether a refund is there. |
| A payment closed with *This server could not start that payment* | Not the provider - this end. The settings row would not load, or the database refused a write, before anything was sent anywhere. Nothing was charged. Read the backend log for the reference: the real error is there, and it is usually `DB_DIR` becoming unwritable or a settings row saved as something that will not parse. |
| Buying with a card works, but paying with a SAVED card takes the money and never credits it | The webhook endpoint is not subscribed to `payment_intent.succeeded`. A saved card is charged off-session, which emits `payment_intent.*` and never `checkout.session.completed` - so the card path works and the saved-card path silently does not. Add `payment_intent.succeeded`, `payment_intent.payment_failed` and `payment_intent.canceled` to the endpoint's events. `stripe listen` forwards everything, so this only bites an endpoint created by hand. |
| The buy page says no payment method is set up, but the keys are in `.env` | A method is offered only when **every** one of its keys is set - for Stripe that is all three, including the webhook secret. Signed in as an administrator, the buy page lists which key each method is missing; anybody else is told only that purchasing is not available. Keys are read at startup, so a `.env` edited while the server was running has not been seen yet: restart the backend. |
| The page cannot reach the API but the backend is clearly running | Look for `[cors] Refused origin ...` in the backend output. A browser reports a refused origin as an unreachable server, so the page cannot tell the two apart - the backend log is the only place the reason appears. It names the origin and the `FRONTEND_URL` value that allows it. Behind a reverse proxy this should not happen at all — the rule allows any origin whose hostname matches the `Host` the request arrived on — so seeing it there means the proxy is rewriting `Host`, and `FRONTEND_URL=https://yourdomain.com` is the fix. |
| On a domain, the site loads over https but every action cannot reach the backend | The public address is missing or stale **in the built bundle**. It is compiled in, not read at runtime, so a restart changes nothing — only `npm run build --prefix frontend` does. With neither `APP_URL` nor `NEXT_PUBLIC_API_URL` set, the frontend keeps the default port and scheme and swaps only the hostname, asking an https page for `http://yourdomain.com:3001/api`: the wrong port, and blocked as mixed content besides. Set `APP_URL=https://yourdomain.com`, rebuild the frontend, then restart it. The frontend build also warns outright when `NEXT_PUBLIC_API_URL` is `http:` under an `https:` `APP_URL`. The browser console shows the mixed-content refusal; the network tab shows the port. |
| `Cannot reach the backend at ...` naming a port you did not expect | `NEXT_PUBLIC_API_URL` and `PORT` disagree. They must name the same port when both point at this machine. Delete `NEXT_PUBLIC_API_URL` from `.env` to derive it from `PORT`, or set the two to match. The backend and the frontend build both print an `[env]` line when they disagree. |
| `Cannot reach the backend at http://localhost:3001/api ...` in the UI | The frontend is running but nothing answered on the API port. The backend prints its own reason where it was started - the `backend` half of `npm run dev`, or its own terminal. Most often it exited at boot over the database directory or a native-module mismatch, both rows below. The two halves are independent: a crashed backend no longer takes the frontend down with it, so the page stays up to tell you. |
| `[browser] TypeError: executablePath.lastIndexOf is not a function` during `npm install` | The same puppeteer 24-vs-25 difference as the row below, hit by the postinstall script rather than the compiler: it reads the expected Chrome path out of `executablePath()`, which is a promise in 25. Handled now. It only ever skipped the Chrome download, so `npm run setup:browser` finishes the job on an install that hit it. |
| `Type '() => Promise<string> \| null' is not assignable to type '() => string \| null'` in `config/browser.ts` | The installed puppeteer is a major ahead of the one this project pins: `executablePath()` returns a string in puppeteer 24 and a promise in 25. The code now handles both, so this should not recur - but an install that far out of step with `package-lock.json` is worth correcting anyway with `npm ci --prefix backend`, which installs exactly the locked versions instead of re-resolving them. |
| `Cannot find module '<name>'` or `TS2307` right after pulling | A pull brings source, never packages - a commit that adds a dependency leaves `node_modules` a version behind, and the backend then fails to compile naming a module that is correctly listed in `package.json`. Run `npm run install:all`, or `npm install --prefix backend` for the backend alone. |
| `Could not find a declaration file for module 'better-sqlite3'` | Backend dev dependencies are not installed. Run `npm install --prefix backend` (not `--omit=dev`). This is the same symptom as the row above with a different cause: the packages were installed, but without the dev ones that carry the types. |
| Startup fails with *Could not rename users.plan to subscription in ...* | The first start after the plan-to-subscription rename could not change the database file: the file or its directory is read-only to this user, the disk is full, or another program - a `sqlite3` shell, a backup tool - holds a write lock on it past the five-second wait. The reason SQLite gave is at the end of the line. Nothing was changed; fix that and start again. This build cannot run on the old column name, which is why it stops here instead of failing on every sign-in. |
| On **Admin → Templates**, importing, extracting, building or editing a template answers *Template could not be saved. Please try again, or contact your administrator.* with a `Ref:` (or deleting one, *Template could not be deleted.*) | Saved templates are files in `backend/static/templates` (or `$TAILOR_STATIC_DIR/templates`), and the server could not write there: the directory is read-only to the user the backend runs as - a checkout owned by somebody else, a read-only container layer - or the disk is full. The startup line under `Database:` says so as `Templates: <dir> is NOT writable (<reason>)`; the backend log line carrying the same `Ref` names the file and the error, and an administrator sees it under the message. Give that user write access to the directory (or point `TAILOR_STATIC_DIR` at a writable copy of `backend/static`) and try again. A failed save leaves the template as it was and no temporary file behind. Renaming, disabling or reclassifying a **built-in** still works meanwhile, because those go to the database. |
| After upgrading, a template that was there before is missing from **Admin → Templates**, and the backend log says `[templates] Template "<id>" was left in the database and is not offered: ...` or `... could not be written to a file and is not offered until it is` | This release keeps saved templates as files, and the first start moved every template out of the database (see [Saved templates are files](#9-saved-templates-are-files)). *Could not be written* means the templates directory was not writable at that start, or a file in the way could not be read: fix it as in the row above and restart - that template, and only it, is tried again. *Left in the database* is for good, and happens only when a file of exactly that id was already there - a built-in, which hid the row before the upgrade too, or a different saved template, which a profile naming that id is drawn with - or when the row's data cannot be read. The row is still in the database: `sqlite3 "$DB_DIR/free_tailor.db" "SELECT data FROM templates WHERE id = '<id>'" > template.json`, then import `template.json` under **Admin → Templates**, which gives it a new id if its own is taken, and pick it again on the profiles that should use it. A log line *Template "Navy_Rule" is now u-1a2b3c4d.json* (or *... is now my-template.json*) is not a problem: ids are lower case with hyphens now, so a row whose id was not one got a new id - its folded one when that was free, else a fresh `u-` one, never a built-in's or another template's - and the profiles naming it were changed to name it. |
| A template file copied into `backend/static/templates` by hand is not offered any more, a profile that used it is drawn with `default`, and the startup line under `Database:` ends *Not offered, because a template file is named <id>.json with an id of lower-case letters, digits and hyphens: Company_Brand.json* | A template's id is its file name, and ids are lower-case letters, digits and hyphens now; an older release offered a file under any name. Rename the file to its id - `Company_Brand.json` to `company-brand.json` - and it is offered at the next request, with no restart; a profile naming `Company_Brand` finds it again, because a lookup folds case and `_`. What an administrator had changed about it as a built-in on **Admin → Templates** - its name, description, disabled flag and layouts - was recorded under the old id, so set those again there. |
| After rolling back to an older build, the saved templates show as built-ins that cannot be edited or deleted, or one is listed twice; or, after upgrading again, a template created or changed under the older build is missing | The older build reads every file in `static/templates` as a built-in, and this build moves the database's templates to files only once. [Saved templates are files](#9-saved-templates-are-files) says which files to move aside before rolling back, and how to have the move run again - put the files back and delete the `templates_moved_to_files` record from `schema_meta` - before upgrading again. |
| Startup warns *users has both "plan" and "subscription"; reading "subscription" and leaving "plan" alone* | A `plan` column was ADDED back by hand - usually to roll back to an older build - instead of renaming `subscription` back (see [Plans are now subscriptions](#8-plans-are-now-subscriptions)). This build reads `subscription`; anything an older build wrote to `plan` since is not read. To keep those values, stop the backend and run `UPDATE users SET subscription = plan; ALTER TABLE users DROP COLUMN plan;` against `free_tailor.db` in your `DB_DIR`; to keep this build's, just drop `plan`. |
| After rolling back to an older build, every sign-in fails and its log shows `no such column: plan` | The database was upgraded: this release renamed `users.plan` to `users.subscription`, and the older build only knows the old name. Rename it back before starting the older build - the one-line command is in [Plans are now subscriptions](#8-plans-are-now-subscriptions). |
| After rolling back to an older build and upgrading again, an account is short the dollars a run had taken, and that run's failed resumes gave nothing back; or, while rolled back, every model costs 1 credit | Credits became dollars, and an older build reads only the whole-credit columns. A run started under this build holds `0` credits as far as the older build can see, so a resume of it that fails there refunds nothing, and its settle - or that build's 6-hour startup sweep - closes the reservation; this build never refunds against a closed one. And once this build has saved the settings row at all, no model carries its old `creditsPerResume`, so the older build prices every one at 1 credit. Grant back what the failed resumes cost under Admin → Accounts - the run's reserve row in the account's Credit History says what each resume was charged - and put the old prices back by hand from `app_settings["migration-log.credits-to-dollars"]` (`models`). Next time, let the queue drain before rolling back - see [Credits are dollars](#10-credits-are-dollars). |
| On **Admin → Accounts** after an upgrade, changing a row's subscription, deleting an account, or any change the server refuses (demoting the last administrator, say) turns the page into *Application error: a client-side exception has occurred*; or **Add an account** answers *This page is from an older version of the app. Reload it and try again.* | The page was loaded before the upgrade that renamed plans to subscriptions. It sends the tier as `plan`, which this build refuses rather than ignores, and it reloads the account list expecting the old `plans` field, which is now `subscriptions` - so anything in the table that reloads the list breaks the page, and only the invite form, which does not reload after a refusal, gets as far as the sentence. Reload the page. A subscription change or invite was refused, not half-made: an invite meant for Premium would otherwise have created a Default account. A delete names no tier, so it did go through; the reloaded page shows it. |
| `Cannot create the database directory`, `SQLITE_CANTOPEN`, or a permission error on startup | `DB_DIR` points somewhere this user cannot write. On Ubuntu the usual cause is `/data/db` not existing; create it, or set `DB_DIR=./data/db`. On Windows a `DB_DIR=/data/db` copied from an older `.env` means `C:\data\db` and needs an administrator - unset it to get `%LOCALAPPDATA%\free_tailor\db`, or point it at a folder you own. |
| `NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 137` | `better-sqlite3` is a native module compiled for a different Node version than the one now running (127 is Node 22, 137 is Node 24). Run `npm rebuild better-sqlite3 --prefix backend`, or switch back to the Node version you installed with. |
| How a run of many resumes is actually scheduled | The backend owns a queue. One request carries every resume - thirty sheet rows and three profiles is ninety tasks - and the request returns a batch id straight away, before any of them has run. Each lane takes tasks off the head of its line as its slots come free, so with `AI_CLI_CONCURRENCY=4` four resumes are built at once on the Claude seat and the moment one finishes the next task starts. A second request appends behind the first. There is a lane per real resource - one per subscription seat: Claude, Codex and Gemini - so no seat can hold up another. |
| A run survives the server restarting | The queue is on disk, in the same SQLite database as everything else, so `npm run dev` reloading on a file save no longer costs you an hour of generation. On boot the server picks up any unfinished batch: resumes already built come back built and are not rebuilt, and whatever was mid-build at the moment the process died is built again - nothing completed it, so its file does not exist. Repeating one is safe because the output path is derived from the profile, company and row, so it overwrites rather than adding a second copy. A batch is kept for an hour after it finishes and then pruned. Its credits stay as charged: the startup sweep that hands back reservations older than six hours (`[credits] Released $X from N run(s) that never finished.`) skips every batch the restore brought back - an older build released a long order's whole charge here and then built the rest of it for free - and a batch that had finished just before the stop is settled on the spot, its failures refunded and its built resumes kept charged. |
| A run keeps going after the page is closed | It does now, and that is deliberate. The work belongs to the queue rather than to the request that submitted it, so closing or reloading the page does not stop it and files keep landing. Reopening the builder picks the run back up and shows live progress - it remembers the batch in this browser, and failing that asks the server what is still running. To actually stop a run, cancel it: queued resumes are dropped and the ones running are aborted. |
| Behind a reverse proxy, a long batch's progress bar says *Finished 4 of 30* while the server goes on building | The page follows a running batch over one long-lived response, and a proxy closes a connection that has been quiet for a while - nginx's `proxy_read_timeout` and an AWS load balancer after 60 s by default, Cloudflare after about 100 s - while one resume can take minutes. Each cut cost the page one of its twenty reattaches, so a long healthy batch ran out of them and stopped following. The stream now sends a bare newline every 25 s, which keeps those proxies from seeing it as idle, and the page gives up only after twenty attaches in a row that brought nothing, or at once when the server says the batch is gone (restarted or expired). A proxy with an idle limit under 25 s still cuts it - raise that limit for `/api/generation/batches/*/stream`. |
| A batch of profiles or a sheet import runs one at a time | Fixed. Every batch endpoint now runs its items in parallel, as wide as the chosen seat can actually take: its own slot count (`AI_CLI_CONCURRENCY`, `AI_CODEX_CONCURRENCY`, `AI_GEMINI_CONCURRENCY`). The queues were already there - a freed slot is handed to the head of its line the moment it is released - the batch just was not offering them enough work. `AI_BATCH_CONCURRENCY` still overrides the whole thing. The backend logs the width and the reason at the start of each batch. |
| Generation feels like it sends more than it needs to | It used to. The profile is now projected before it goes to the model: contact details, this database's ids and timestamps, and the whole of `profileSettings` (your prompt choices, file-name templates and which model you pay for) are left out, and the JSON is compact rather than pretty-printed. Measured on a five-role profile: 9,365 characters down to 6,942. Nothing the prompt reads was removed. The three choices the prompt does need - the layout and the two section switches - travel as three words of their own, and the profile's own soft skills are not sent at all, because the code lists them. |
| The same job posting is analysed over and over | It is not any more. An analysis is deterministic, so the answer is kept for six hours keyed on the posting, the model, and the prompt's own text - a preview followed by a generate, or a sheet re-run after fixing one row, now costs one call instead of two. Editing the prompt invalidates it, so an admin never sees a stale answer from the version they just changed. A profile's layout and section switches are not in the key, on purpose: the analysis reads the posting, not the profile, so one analysis serves every profile in a batch. |
| Technical Skills shows headings you do not want | Choose **Plain** under **Technical skills → Layout** in the profile's editor. The headings you assigned are kept, not deleted, so switching back to **Grouped** restores them. If the profile's template prints Grouped only (Burgundy Rule, Navy Rule), the editor moves the profile to one that prints Plain and says which. |
| A skill is filed under the wrong heading | The shared skill library guesses a heading per skill, and it cannot know that your Vault is infrastructure rather than a library. With the profile on **Grouped**, pick that skill's heading from the menu beside it under **Technical skills** instead of *Work it out*; the rest keep being worked out. A profile's own headings are used exactly as written and are never padded out to a count. |
| A template is missing from a profile's template picker | The picker lists only templates that print the profile's Technical Skills layout, and the hint under it says how many it left out. **Burgundy Rule and Navy Rule print Grouped only**, so a Plain profile is not offered them; an uploaded template that reads only `{{#each skillCategories}}` is Grouped only the same way. A template an administrator disabled is not listed to anybody. An administrator who knows a template prints both can say so with `PATCH /api/templates/:id` and `{ "skillsLayouts": ["categorized", "flat"] }`. |
| A template in the picker is greyed out with *(used by ...)* | Another of your profiles uses it, and the editor offers each template to one profile of an account at a time. Pick another, or move the other profile off it first. The profile's own current template is always selectable. |
| The profile preview says *Drawn with ...: ... has no Plain layout* (or *Grouped*), or *the template this profile names is not offered any more* | The profile's template cannot print its layout - an administrator reclassified it - or was disabled or deleted. Resumes for it fall back exactly as the preview did: the profile's own template, then `default`, then any enabled template that prints the layout. Pick a template in the editor to choose for yourself. The backend logs the fallback once, as `[templates] Profile <id> uses the flat skills layout, which template "<id>" does not offer; drawing it with "<id>" instead.` |
| The profile preview, or a resume, says *No resume template is available right now. Please contact your administrator.* | No enabled template could be found to draw with: every template is disabled, `default` included - or the profile's own template and `default` are, and every template left enabled prints only the other layout. Under **Admin → Templates**, enable `default`, which prints both layouts and so serves every profile. The `Ref:` in the message finds the line in the backend log. |
| The profile preview says *Not updated* | Its last request failed; the sentence under it says why, and **Try again** sends it again. The page shown is the last one that rendered, not the current draft. Nothing is lost - the form is unsaved until **Save**, whatever the preview does. |
| The page in the profile preview shakes - shrinks and grows by a few percent, many times a second - with nothing being typed (it looked like every template but one) | An older build: a loop through a scrollbar. The page was scaled to the room beside it, and where scrollbars take space (Windows and Linux Chrome, macOS set to always show them) a one-page resume just taller than that room brought a scrollbar in, was scaled down to fit beside it, let the scrollbar go, grew back, and so on every frame. At 1920x937 that was every one-page document; a template whose page ran to a second page kept its scrollbar and stood still, which is why one looked fine. The same happened in the narrow layout's **Preview** tab through the window's scrollbar, in a window just the page's height. The pane and the window now keep the scrollbar's strip whether or not it is showing, and the scale is taken as if it always were. Still shaking: reload, since the page may be from before the upgrade; a browser without `scrollbar-gutter` (Chrome before 94, Firefox before 97, Safari before 18.2) settles after one step instead of none. `backend/test/e2e/preview-vibration.js` measures it. |
| An unticked **Soft skills** or **Strengths** box shows only *N ... kept with the profile* | That is the switch working: off hides the list and keeps it. Nothing was deleted - tick the box to see, print and edit the entries again. |
| The **Admin → Accounts** row marked *(you)* has its role, **Disable** and **Delete** greyed out | An administrator cannot demote, disable or delete the account they are signed in with; the server refuses all three, so the page does not offer them. Another administrator can - and the last enabled administrator cannot be removed by anybody. |
| A skill on the profile does not show in the preview | The preview draws only skills the shared skill library knows - in Plain, and in Grouped unless you assigned headings by hand - and this one came in with an uploaded or imported profile the library has never heard of. A skill added in the editor goes into the library as it is added, so remove it and add it again, or ask an administrator to add it under **Admin → Skills**. A tailored Plain resume still lists it when the posting names it. |
| Soft Skills or Strengths do not appear on a resume, although the profile has them (or the prompt asks for them) | In order: the switch is **off** - both are off until ticked under **Soft skills** and **Strengths** in the profile's editor, and an off switch empties the section whatever the prompt or the model says; the **template has no such section** - Burgundy Rule, Navy Rule and Charcoal Sidebar have neither, Ink Ledger has no Soft Skills, and the editor says so under the switch; the DOCX of that generation leaves it out too, since the template it was generated with decides both files; or **the list is empty** - a section with nothing in it prints no heading. With Strengths on, a resume whose model wrote none uses the profile's own, so a missing Strengths section with the switch on means the profile has none either. |
| The summary ends with *Working style: ...* | The profile's **Soft Skills** switch is off - or on, with a template that has no Soft Skills section (Burgundy Rule, Navy Rule, Charcoal Sidebar, Ink Ledger), which counts as off - so the posting's soft skills that the resume does not already mention are worked into the summary instead of a section of their own. Tick the switch and the next resume lists them in its Soft Skills section instead, without the sentence. Content tailored before this release said *Strengths include ... across changing engineering contexts.*; finalising it now rewrites that the same way. |
| A Plain Technical Skills list is shorter than the Grouped one for the same job | By design. Plain lists the posting's skills the library knows plus your own related skills, and pads nothing. Grouped fills the library's headings out from the library for the job, as it always has. |
| Saving a prompt under **Admin → Prompts** says *Unknown prompt variables: ...* | The text names a `[[variable]]` the feature's code never supplies - often a typo. The variables it can use are listed beside the prompt; correct the name. This used to save, and then fail every resume that used the prompt. |
| Every resume built with one prompt fails with a `Ref:`, and the backend log under it says *Prompt "..." contains unknown variables: ...* | The stored prompt names a variable nothing supplies - written straight into the database, or saved before saves were checked. Open it under **Admin → Prompts**, where the name is reported, and correct or remove it. |
| **Admin → Prompts** says *This prompt predates the profile's Strengths and Soft Skills switches; the app still enforces them.* | The tailoring prompt's text never mentions `[[includeStrengths]]` - it was edited before the switches existed. Nothing is broken: the code appends the switches to every tailoring turn and enforces them after the model. To make the text say so too, add the shipped prompt's *RESUME SECTIONS* block (`[[includeStrengths]]`, `[[includeSoftSkills]]`, `[[technicalSkillsLayout]]`); the note then goes. |
| An exported set of templates will not import | Fixed. The JSON upload now takes one template, a list of them, or `{ "templates": [ ... ] }`, works `sections` out from the markup when the file names none, and says which entry is wrong rather than failing the file. It saves all of them or none, and never overwrites a template already here. |
| An uploaded profile lost its skills | It should not now: a flat list, a `{ "Languages": [ ... ] }` map, a list of `{ category, skills }` groups, and a mix of names and groups all import to the same profile. Every grouped skill also lands in the flat list the tailoring prompt reads. |
| A model is missing from the model menus | The menus list only models that can run right now. Under **Admin → Models**, it is either *Disabled*, on a provider switched off under Admin → Settings (*Provider off*), or on a seat locked in this installation (*🔒 Locked*, with the reason). Nothing is locked by default, so a lock means `AI_LOCKED_PROVIDERS` in `.env` names it; remove it there and restart. |
| *That model isn't available. Choose another, or contact your administrator.* | A run, or a profile save, named a model that cannot run: switched off, deleted, on a locked seat or on a provider switched off. It is refused rather than replaced, because another model could cost a different price. An administrator's response carries the reason underneath. A profile that already stored such a model is not refused - it shows *Unavailable model* and runs on the default, and the server log says so once. |
| *AI generation isn't available right now. Please contact your administrator.* | What anybody but an administrator is told when the seat a run needs cannot answer: its CLI is signed out or not installed, the account cannot use that model, the provider is locked or switched off - or every seat is locked, so nothing can run at all. An administrator sees the cause under the same sentence; the startup `[ai]` lines and the seat cards on Admin → Settings say which seat and why. The other three AI sentences are for the person to act on: *busy* (a usage limit - wait), *took too long* (ask for less) and *failed* (try again). |
| **Claude (browser)**, **ChatGPT (browser)** or **Default (browser)** is missing from the model menus | Removed, along with the debug Chrome they drove - see [Upgrading an install that used browser chat](#5-upgrading-an-install-that-used-browser-chat). A stored default, profile or prompt that named one now runs on the default model, which is the Claude seat unless that is locked here, and the backend log says so once per name. Debug Chrome windows started for them are still running on a remote-debugging port, and their `~/.free-tailor-chrome-<port>` profiles are still signed in: close the windows and delete the profiles. `npm run browser:debug`, `npm run browser:doctor` and the `AI_WEB_*` variables no longer exist; a leftover `AI_WEB_*` line in `.env` is ignored. |
| The Anthropic API, OpenAI or DeepSeek models are gone from every menu | Removed, with every API key - see [Upgrading an install that used the metered APIs](#6-upgrading-an-install-that-used-the-metered-apis). A stored default, profile or prompt that named one now runs on the default model, and the backend log says so once per name. Startup warns `[ai] OPENAI_API_KEY, ... are still set, and nothing reads them` for any of the old variables left in `.env`: delete them. |
| `Could not find Chrome (ver. ...)`, or `PDF rendering needs a Chrome to print with` | Puppeteer's Chrome was never downloaded - an `npm install --ignore-scripts`, a proxy blocking the download, or a cleaned cache. Run `npm run setup:browser`, which fetches exactly the build puppeteer expects. If that download cannot get through, point the server at a browser you already have instead: `CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe` in `.env` (Chrome, Edge, Chromium and Brave all work - same engine). The server also finds an installed browser on its own when the download is missing, so this only comes up when there is neither. |
| `Could not start ... - but there is no file there` at startup | `CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH` names a path that does not exist. An explicit setting is never silently overridden, so fix the path or unset it to fall back to the downloaded browser. |
| `The Claude CLI is not installed or is not on the server PATH` (an administrator's detail, or the startup line) | Either it genuinely is not installed, or the server process has a different PATH than your shell - common under systemd and Docker, which get a minimal one. Set `AI_CLI_BIN` to the full path from `which claude` (`where claude` on Windows). On Windows npm installs the CLI as `claude.cmd`, a shim wrapping `node_modules\@anthropic-ai\claude-code\bin\claude.exe`; the server follows the shim to that binary on its own, so `AI_CLI_BIN` is only needed if that fails, and then it should name the `.exe`, not the `.cmd`. |
| A Codex turn fails with `spawn codex ... ENOENT` | Same two causes as the row above, one vendor along: either `@openai/codex` is not installed, or this process has a different PATH than your shell (common under systemd and Docker). Set `AI_CODEX_BIN` to the full path from `which codex`. |
| Codex says `Not logged in`, or a turn fails with an auth error | Run `codex login --device-auth` **as the user the server runs as** - it prints a code you approve from a browser anywhere, so the server needs no display. The sign-in lives in that user's `CODEX_HOME`, so a login as yourself is invisible to a service running as someone else. `codex login status` prints the account; note it exits 0 either way, so read the text rather than the exit code. Then check **Admin → Settings**, which shows this seat's own readiness card. |
| Codex reports *Signed in with an API key, not a ChatGPT subscription* | The CLI was signed in with `codex login --with-api-key` (or a Bedrock key), and every call on that would be billed per token - so the seat counts as not signed in, and refuses every call without running it (an administrator's detail says *signed in with an API key, so this call would be billed per token*; users are told to contact you) until it is signed in with ChatGPT again. The check is cached for a minute, so the first calls after the fix may still be refused. Run `codex logout`, then `codex login --device-auth` as the user the server runs as, and sign in with ChatGPT. Keys in the environment are a different matter and already handled: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` are always stripped from the child, and there is no longer a switch to let them through. |
| `[ai] gemini-cli: No "gemini" on the server PATH.` | Either `@google/gemini-cli` is not installed (`npm i -g @google/gemini-cli`; it needs Node 20 or later), or this process has a different PATH than your shell (common under systemd and Docker). Set `AI_GEMINI_BIN` to the full path from `which gemini`. On Windows npm installs a `.cmd` shim around `bundle/gemini.js`, which the server runs under its own Node; `AI_GEMINI_BIN` is only needed if that fails. Lock the seat (`AI_LOCKED_PROVIDERS=gemini-cli`) if you do not mean to use it. |
| `[ai] gemini-cli: Not signed in: there is no Google sign-in at .../.gemini/oauth_creds.json`, or a Gemini turn fails with an auth error | Run `NO_BROWSER=true gemini` **as the user the server runs as**, choose *Sign in with Google*, open the URL it prints in any browser, paste the code back and `/quit`. The file the check names is where the server looks: with `AI_GEMINI_HOME` set, sign in with `GEMINI_CLI_HOME` set to that same directory, or the sign-in lands in a home the server never reads. *has no refresh token, so it stops working within the hour* means the same fix. A failed sign-in holds the whole seat for 30 minutes (`[ai] Holding off the Gemini seat ...`) so calls stop failing one by one; after signing in, open **Admin → Settings** - its seat check sees a sign-in written after the hold and lifts it (`[ai] Lifting the hold on the Gemini seat ...`). A restart lifts it too. While a sign-in is still on disk, the CLI's refusal is first read as *could not validate its Google sign-in* and held for only two minutes: the CLI checks its token with `oauth2.googleapis.com` on every start, and a refused connection or a proxy fault there ends in exactly the signed-out error. Check that the server can reach that host; the third such failure in a row is taken as a revoked token and gets the 30-minute hold and the sign-in action. With `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` the check cannot read the sign-in and says so - the first call is the test. |
| A seat still says it is not signed in after you signed its CLI back in - users see *AI generation isn't available right now*, an administrator's detail says *not signed in* or *Invalid authentication. Please run /login* | A failed sign-in holds the Claude or Gemini seat for 30 minutes (`[ai] Holding off the Claude subscription ...`, `... the Gemini seat ...`) so calls stop failing one by one - and a hold is normally lifted by the next success, which the hold itself turns away. Open (or reload) **Admin → Settings**: its seat check runs fresh, and lifts a sign-in hold when it finds the seat signed in - the Claude seat on the subscription (`authMethod: "oauth_token"`), the Gemini seat by a sign-in file written after the hold, since a token Google revoked still reads as signed in from the file. The log says `[ai] Lifting the hold on ...`. Otherwise wait out the 30 minutes, or restart the backend. A usage-limit hold is not lifted this way; signing in does not refill a window. Codex keeps no hold: it asks `codex login status` before every turn, cached for a minute. Before this, a held Claude call whose CLI had said *Invalid authentication* was reported as the usage limit being reached. |
| A Gemini turn is refused: *the Gemini CLI billed this call to the account's paid AI Credits* (an administrator's detail; users see *busy*) | The workspace this server writes for the CLI says `billing.overageStrategy: "never"`, so something that outranks it turned paid credits on - a system settings file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `/etc/gemini-cli`). The answer is thrown away and the seat held, so the next calls are not billed the same way. Remove that setting, or wait for the free quota to reset. |
| A Gemini turn fails with *the model called N tool(s)* | The seat runs with no tools and a deny-all policy, so a tool call means something re-enabled them for every workspace - a system settings file again (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `/etc/gemini-cli`) adding tools. MCP servers and extensions cannot be the cause: every turn passes `--allowed-mcp-server-names __tailor_none__ --extensions none`, so neither the service user's `~/.gemini` servers and extensions nor a system file's are loaded. Nothing that turn produced is used. |
| `[ai] gemini-cli: ... GEMINI.md is not empty, and the CLI appends it to every prompt this seat runs` | The service user's personal `~/.gemini/GEMINI.md` - notes the CLI adds to every prompt, whatever the app sends, with no way to turn it off. Empty it, or give the server a home of its own with `AI_GEMINI_HOME` and sign in there. |
| A Gemini model fails with *The signed-in Google account cannot use model "..."* | The account's plan does not offer that model (a preview, or Pro on a plan without it), and that model is left alone for 10 minutes. Pick another model name for that record under **Admin → Models** - `auto` lets the CLI choose one the account can use. |
| A resume built on Gemini comes back cut short, or a Gemini build is retried with *the answer opened @@BEGIN_JSON@@ and never closed it* in its log (an administrator's detail; users see *The AI request failed*) | A known limit of the Gemini CLI's stream format: an answer cut off at the model's output limit arrives marked as a success, and the CLI names no finish reason once any text was written. A structured answer - the analysis, the tailored resume - gives itself away: this seat has no JSON mode, so it is asked to wrap the document in `@@BEGIN_JSON@@` / `@@END_JSON@@`, and one that opened the first and never wrote the second was cut off. That is refused as truncated, without holding the seat, and built again (`GENERATION_MAX_ATTEMPTS`). It used NOT to fail: the JSON reader found the first complete object inside the cut-off document - one experience entry, say - and took it for the whole answer. A prose answer, such as a cover letter, has no such marker and can still arrive short. If it recurs on long resumes, use another model or seat for them. |
| Generating a resume fails with Cloudflare **error 524**, but the backend log shows it finishing | The request went through Cloudflare's proxy, whose read timeout is ~100s on Free/Pro/Business and is not adjustable, while `/api/resume/analyze`, `/generate` and `/preview` run inline and wait: `/generate` alone awaits the job analysis, then the tailoring, then the PDF and DOCX rendering, against a 3-5 minute per-call budget. The server is fine; the proxy hung up. Set the site's `A` records to **DNS only** (grey cloud). `curl -sI https://yourdomain.com \| grep -i ^server:` answering `cloudflare` means a record is still proxied. Keeping the CDN means splitting the API onto a grey-clouded `api.` subdomain via `NEXT_PUBLIC_API_URL`. A Job Search run hits the same wall: its request waits for the Apify run, up to `APIFY_RUN_TIMEOUT_S` (300 seconds by default). |
| A resume failed but the run shows it building again | Expected: a failed build is retried, up to `GENERATION_MAX_ATTEMPTS` (default 3, counting the first go). The progress line says how many are retrying. It costs nothing extra - the resume's price is taken once at submission and returned only if the resume never delivers. A cancelled batch and a task kind this build does not know are **not** retried. |
| One seat's work queues while another sits idle | Each seat has its own queue lane, sized by its own variable - `AI_CLI_CONCURRENCY` for Claude, `AI_CODEX_CONCURRENCY` for Codex, `AI_GEMINI_CONCURRENCY` for Gemini. They are deliberately not pooled: one shared lane across independently-sized process pools either strands the larger or lets tasks blocked on the smaller hold slots another seat needs. Raise the variable for the seat that is waiting, and restart. |
| Somebody opened their sheet link and Google said they need access | Expected since sheets became private by default: the link alone no longer works, and the person it belongs to opens it through the grant their own Google account holds. If they want a link others can use, Settings > Job Sheet has a sharing toggle - or set `SHEET_DEFAULT_VISIBILITY=public` to go back to link-shared for new sheets, knowing that means anyone with the URL may edit. If the OWNER cannot open their own sheet, that is different: the writer grant failed, almost always because the Drive API is not enabled for the server's Google project. It is retried on their next sign-in, and `npm run sheets:doctor` names the cause. |
| A setting is plainly in `.env` and plainly not in effect | Run `npm run mail:doctor` (or `sheets:doctor`) in `backend/` - its first step prints the absolute path of the file it read, the file's size and encoding, and which keys it found, names only - split into those in effect, those **present but empty**, and those **in the file but overridden by the environment**. A bare `NAME=`, which is how `.env.example` ships the keys and addresses you fill in, sets the variable to empty - unless the environment sets it, because a variable exported in your shell, a systemd unit or a container beats the file (the backend's startup line `[env] NAME is set both in the environment and in ...` names any such variable whose two values differ; unset the export, or change it, to use the file's). A line still commented out (`#NAME=value`, how `.env.example` ships every tuning setting) is not read at all: remove the `#`. For the operational settings, the backend's own startup line `[env] Non-default settings: ...` lists exactly what is in effect, after clamping. Four causes look identical without that: the loader read a **different** file - the path resolves from the compiled module, so it is always the **repository root** and never `backend/.env`, whichever directory you ran from; a **later duplicate** of the same key silently won, because the last assignment wins; the **encoding** did not decode, which happens to a UTF-16 file written without a byte-order mark and PowerShell's `>` writes UTF-16; or the editor never saved. |
| Startup prints `[env] PORT, DB_DIR are set both in the environment and in .../.env; the environment's value is used.` (the frontend prints the same line) | Those variables are exported where the process starts - a shell, a systemd unit, a container's environment - **and** set in the repository `.env`, with different values. The environment wins on both halves, so the file's line for them is not in effect. Only the names are printed, never the values. It was not always so: the backend used to let the file win while the frontend let the environment win, so `PORT=4000` exported in a shell moved the frontend's derived API address to port 4000 while the backend stayed on the file's 3001, and every call failed with nothing to say why. If the file's value is the one you want, unset the export (`unset PORT`, or remove it from the unit); `npm run mail:doctor` and `sheets:doctor` list which of their settings are overridden this way. |
| In the Bid Assistant, a saved Google Sheet source has no Edit or Delete, or saving it answers *This Google Sheet source was saved before sources had owners, so only an administrator can change it.* | Sources now belong to the account that saves them: each account sees its own, and another account's are neither listed nor reachable. A source saved before that has no owner, so it is still listed for everybody and only an administrator can rename or delete it. Likewise the Ask AI prompt template is one for every account and is an administrator's to change (everybody else reads it), and deleting a job off the shared board - which deletes every account's saved answers for it - is an administrator's too. Saved answers are read and deleted only through your own profiles, and are deleted with the profile. A deleted account's sources are listed to administrators only, to rename or delete - until then their labels stay taken. |
| Somebody reports an error ending *(Ref: ERR-7F3A9C)* | Every failure that is not about something of their own gets a generic sentence and a reference, and the cause is logged once under it: `grep 'ERR-7F3A9C'` over the backend's output finds a line `[error ERR-7F3A9C] <METHOD /api/path> <the real error>` - or `task <id> (batch <id>)` for a resume that failed in a run. Signed in as an administrator you rarely need the log: the same responses carry the cause as `detail`, shown under the message. See [When something fails](#when-something-fails). |
| The sign-in page says *Sign-in isn't available right now. Please contact your administrator.*, or startup warns `[auth] Nobody can sign in: neither Google sign-in (GOOGLE_CLIENT_ID) nor emailed codes (... missing) are configured` | Neither sign-in path is configured: `GOOGLE_CLIENT_ID` is empty and the `SMTP_*` block is incomplete - the startup line names the SMTP variables that are missing. The page names no setting, because whoever reads it is not signed in. Set one of them (see `.env.example`), restart, and check SMTP with `cd backend && npm run mail:doctor`. `GET /api/auth/options` says which paths are available. |
| Sign-in emails are not arriving and the log says only `Could not send the sign-in email via …` | That one sentence covers a missing variable, a wrong key, a blocked port and an unverified sending domain. Run `npm run mail:doctor` in `backend/` - it walks the same chain in order and stops at the first break with what to change. Add `-- --to you@example.com` to include a real send, which is the only step that catches an unverified domain. |
| Sign-in works for your own address but fails for everyone else, with a 403 from the relay | The relay is still sandboxed: most of them refuse to send to anybody but your own account address until the sending domain is **verified** in their dashboard. It is not a bug in the app, and the failure reaches the page as a 502 with the relay's own wording. Finish the DNS records the relay asked for, wait for it to read *Verified*, then retry. Test with a second address afterwards - your own inbox is the one case that works either way, so it proves nothing. |
| The sign-in email arrives with no sender name, just the address | Expected: `From` is whatever `SMTP_FROM` says, verbatim. Set it to the display-name form to fix it - `SMTP_FROM="Tailor <login@yourdomain.com>"`, quoted because the value contains spaces. It is the only branding on the only email this app sends. |
| Sign-in emails try to send from `resend`, `apikey` or another bare username | `SMTP_FROM` is unset and fell back to `SMTP_USER`, which on a relay is not an address. Set `SMTP_FROM` to a real address on your domain. |
| Nobody is an administrator, and the UI offers no way to appoint one | `ADMIN_EMAILS` is unset. The fallback is `SMTP_USER`, and it is used **only** when that value looks like an email address - so a relay username (`resend`, `apikey`) names nobody. Fix: set `ADMIN_EMAILS` to the address you sign in with, restart, and sign in again. An account that already exists is promoted on the way in, so there is no need to delete it and start over. |
| Admin → Models refuses a model: *"..." is not one of the Claude (Subscription) models: sonnet, opus, haiku, fable.* | The model name must be one the seat's list offers - the form's select only shows those, so this is an older tab or a hand-made request. To offer another name, add it to that seat's list in `.env` (`AI_CLI_MODEL_OPTIONS`, `AI_CODEX_MODEL_OPTIONS`, `AI_GEMINI_MODEL_OPTIONS`) and restart. A list with an entry the CLI would not run as written is ignored whole, with one `[env]` warning, and the default list is used. |
| A model shows *Not in model list* | Its model name is not in its seat's list any more - the list was overridden in `.env` since it was saved. It keeps running exactly as before; the flag only says the form cannot offer that name again. Editing its name or price keeps it, while changing its model means picking one from the list. |
| *Set Default* is refused with *"..." cannot be the default* or *is switched off* | The model cannot run, and a default nobody can run would only fail every run that names no model: switch it on under Admin → Models, switch its provider on under Admin → Settings, or unlock its seat (`AI_LOCKED_PROVIDERS`). Nothing is quietly substituted. |
| *This needs $0.161 of credit and the account has $0.023* | The run costs the sum of each resume's model price, and the balance is short. Buy credit, generate fewer at once, or pick a model with a lower price per resume - the builder's cost line shows the total before the run starts. An administrator can grant credit under Accounts, and is never charged. |
| Every balance is `$0.000` after upgrading, and Credit History ends with a *reset* row | Credits became dollars, and the owner's decision was to reset rather than convert: a credit was bought at a price (50c by default), so no one rate would be right for every balance. The `reset` row shows the old balance in credits; the old rows and payments are kept as they were, read-only. What every account held is in `app_settings["migration-log.credits-to-dollars"]` if you want to grant some of it back - in dollars, under Accounts. See [Credits are dollars](#10-credits-are-dollars). |
| Admin → Models lists models in red as *free*, and runs on them cost nothing | Every enabled model priced `$0.000` is listed: after the upgrade that is all of them, since their old prices were in credits and were reset, and a model a migration adds arrives unpriced. Set a price per resume on each. `0` is a valid price - a deliberately free model stays listed, so nobody gives resumes away without seeing it. Startup says *Every model is FREE until it is priced* once, on the upgrade. |
| Admin → Models, Accounts or Payments refuses a save with *This page is from an older version of the app. Reload it and try again.* | The page was loaded before credits became dollars and sent an amount in the old unit - a price in credits (`creditsPerResume`), a balance or grant in credits (`credits`, `amount`), payment limits in cents, or a purchase as a count of credits. Read as dollars it would have moved money by the wrong amount, so nothing was saved. Reload the page. |
| A price, balance or grant is refused: *... can have at most three decimal places: $0.001 is the smallest step* | Amounts are exact to a thousandth of a dollar, and anything finer is refused rather than rounded either way - `0.023` is fine, `0.0235` is not. A purchase must be a whole number of cents (`12.50`, not `12.505`), because that is all a card or an invoice can charge. |
| Startup logs `[sheets] Could not load the Google credentials` / `invalid_grant: Token has been expired or revoked` | The saved Google consent is dead. **Not fatal** - the server starts and serves; what stops working is per-account sheet allocation, the job export and filter pages, *Import from Sheets* and the bid assistant's sheet reads. If you did not revoke it yourself, the cause is an OAuth consent screen still in **Testing**, where Google expires every refresh token after seven days. Fix: `cd backend && npm run sheets:login`, which re-consents and rewrites `google-oauth-credentials.json` - it re-uses the client id and secret already in that file, so the originally-downloaded `client_secret*.json` does not have to still be around. Then `npm run sheets:doctor` to confirm the whole chain. To stop it recurring, publish the consent screen **before** signing in again - a consent given while it is in Testing keeps the seven-day limit: Cloud console -> Google Auth Platform -> Audience -> Publish app (older consoles: APIs \& Services -> OAuth consent screen -> PUBLISH APP). With the restricted Drive scope Google then shows a "Google hasn't verified this app" screen at sign-in; for your own install that is expected - Advanced -> Go to the app. A Google Workspace project can choose user type Internal instead, which has neither the expiry nor the warning. `deleted_client`, `disabled_client` or `invalid_client` instead of `invalid_grant` means the OAuth client itself is gone, and signing in again would re-use it: a deleted one can be restored for 30 days under Google Auth Platform -> Clients; otherwise make a new Desktop app client, download it into `backend/` and run `npm run sheets:login -- --client <that file>` - naming it, because an older `client_secret*.json` left there can otherwise be picked. If `GOOGLE_CREDENTIALS_PATH` names the credential, `sheets:login` re-uses the client from that file and says so if the app will keep reading a different one from the file it just saved. `SHEET_BACKFILL=off` in `.env` silences the startup attempt meanwhile, at the cost of not allocating sheets for older accounts until each next signs in. |
| A script ends with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` (Windows) | A Node.js bug, not this app's: calling `process.exit()` just after network I/O races Node's own teardown on Windows ([nodejs/node#56645](https://github.com/nodejs/node/issues/56645)). Everything printed above it is complete and correct - read the report, not the crash; the only casualty was the exit code. The doctors and `sheets:login` now let the process end on its own, which avoids it on every Node version. Node itself fixed it in 24.20.0 and 26.7.0 ([nodejs/node#61999](https://github.com/nodejs/node/pull/61999)), and 22.x never got the fix, so a current 24 LTS is worth having anyway. |
| Startup warns the sign-in is not a subscription | `claude auth status` reports something other than `authMethod: "oauth_token"`, so the CLI may have found an API key. A call it starts on one is stopped at its first event - `system/init` names the credential before the model answers - and the seat is held as signed out for 30 minutes so no further calls are billed. Run `claude auth login` as the user the server runs as, and remove whatever supplies the key - an `apiKeyHelper` in the CLI's own settings, say; `ANTHROPIC_API_KEY` in the environment is stripped from the child already. Then open **Admin → Settings**: its seat check lifts the hold once `claude auth status` reports the subscription, and a key still in the way is caught at the next call's first event again. |
| Generation returns 429 with a `Retry-After`, and users see *AI generation is busy right now* | A seat's usage limit is spent: the Claude subscription's window, the ChatGPT plan's, or the Google account's quota. The Settings page shows the Claude window and its reset time; generation resumes on its own. The Gemini seat holds itself off for as long as Google's error asked - from 30 seconds up to 30 minutes, five when it named no delay - and logs `[ai] Holding off the Gemini seat for about ...`. |
| Startup prints `[env] NAME="..." is not a whole number; using ...` or `[env] NAME=... is outside a..b; using ...` | A value in `.env` could not be used as written, and the server is running on the value that line names instead - the default for an unreadable one, the nearest end of the range for one too big or too small (except `PORT`, which falls back to 3001 rather than becoming port 1 or 65535). Deliberately not fatal: a server that refused to start over a timeout typo would hide every other diagnostic it prints. Write plain digits with the unit taken from the name (`AI_REQUEST_TIMEOUT_MS=600000`, not `10m` or `600s`), keep it inside the range `.env.example` gives, and restart. Each variable is reported once per start, however often it is read. |
| Startup warns `[ai] AI_CLI_TIMEOUT_MS_TAILOR=... is longer than AI_REQUEST_TIMEOUT_MS=...` | A CLI budget was raised above the deadline that bounds every AI call, so it can never take effect - the call is cut off at `AI_REQUEST_TIMEOUT_MS` (300000 by default) whatever the budget says. Raise `AI_REQUEST_TIMEOUT_MS` to at least the budget, and restart. The same holds for every `AI_CLI_TIMEOUT_MS*`, `AI_CODEX_TIMEOUT_MS*` and `AI_GEMINI_TIMEOUT_MS*`. Each is read as its seat reads it - the Claude and Codex budgets loosely, so `600000ms` counts as 600000, and the Gemini ones strictly, like every newer setting; a budget left at its own default - older copies of `.env.example` wrote the first six out - is never reported, since lowering the deadline below it is a deliberate cap. |
| A PDF upload is refused with *... is N MB or larger; this server accepts PDFs under N MB* (the page's check names the file, the server's 413 says *That PDF*) | The file is at or over `UPLOAD_MAX_MB` (10 by default) - a file of exactly N MB is refused too. Raise it in `.env` and restart the backend - the upload pages read the new number from the API, so the frontend needs no rebuild, and a page left open re-checks it before refusing. A big file over a slow link may also need `HTTP_REQUEST_TIMEOUT_MS` raised, and a reverse proxy in front has a body limit of its own (nginx's is 1 MB unless `client_max_body_size` says otherwise). |
| A large batch or profile import fails with `request entity too large` | The JSON body is over `JSON_BODY_MAX_MB` (10 by default). Raise it and restart the backend. A reverse proxy's body limit applies on top. |
| A template JSON import fails with *File too large* | The template import is a file upload with its own fixed 2 MB cap - `JSON_BODY_MAX_MB` does not raise it. Split a file of several templates into smaller ones. |
| Job Search fails with *The job search could not run right now* - for an administrator, with `APIFY_API_TOKEN is required to run the ...` under it | The scrapers run on your Apify account and there is no token. Set `APIFY_API_TOKEN` in `.env` (Apify Console -> Settings -> API & Integrations) and restart the backend. The same sentence covers any other scraper failure; the reference in it finds the cause in the backend log. |
| The calendar page works locally but answers 404 on the domain | The reverse proxy sends `/api/calendars/*` to Express, which has no such route: the calendar's API is made of Next.js route handlers in the frontend. Add the `handle /api/calendars/*` block from the Caddyfile under [Serving it on your own domain](#-serving-it-on-your-own-domain), above `handle /api/*`, and reload Caddy. |
| A changed `NEXT_PUBLIC_*` value - the calendar's time zone, the API URL - has no effect after a restart | `NEXT_PUBLIC_` values are compiled into the frontend bundle by `next build`. Run `npm run build --prefix frontend`, then restart the frontend. The calendar's `CALENDAR_API_TIMEOUT_MS` and `CALENDAR_DETAIL_CONCURRENCY` are not `NEXT_PUBLIC_` and need only the restart. |
| Shortening `SESSION_TTL_DAYS` did not sign anybody out | Expected: a session's expiry is stamped when it is created and never extended, so a change applies to new sign-ins only. To end an account's sessions now, press **Sign out** on its row under Admin -> Accounts. |

## 🧪 Tests

```bash
npm test
```

Runs the backend `node:test` suite against temporary SQLite databases and static directories.

The three seats are covered by `backend/test/claudeCli.test.js`,
`codexCli.test.js` and `geminiCli.test.js`, which replay event streams from the
real CLIs (`backend/test/fixtures/cli`, `codex` and `gemini`) through an
injected runner — so the suite needs no network, no `claude`, `codex` or
`gemini` binary, and spawns no subprocess. A fixture's name says what it is:
`recorded-` is a real capture, `constructed-` a real envelope around an answer
that could not be captured here.

The two skills layouts and the two section switches are pinned per template:
`backend/test/templateLayouts.test.js` renders every built-in in each layout it
declares and with each switch on and off, and checks the capability flags
against the markup. The live preview's access rules and its lack of side
effects are in `profilePreview.test.js`, run with every seat locked so a 200
also proves no model was asked; the prompt variables and their drift check in
`promptVariables.test.js`.

Refund requests are pinned in `refundRequests.test.js` - every allowed and
refused state change, a double-pressed *Refunded* moving money once, a card's
partial Stripe refund of the unspent part with its credit held before Stripe
is asked (two refunds of one account, or the buyer spending, while Stripe is
held open cannot pay out more than was unspent; a refusal puts the credit back;
no answer keeps it held and the retry sends the same), a Decline refused while
the refund is with Stripe, crypto only after the by-hand confirmation and at
the amount sent, one open request per item in SQL, and each notice reaching
only the account it is for (`notificationRecipients.test.js`) - and the contact
channels' rules, `javascript:` and `data:` included, in `contact.test.js`.
`frontendRefunds.test.js` also parses every page and fails on a sentence that
asks for an administrator with no Contact admin link after it.

Money is pinned in `credits.test.js` (exact thousandths: seven `$0.023`
resumes reserve `$0.161`, two refunds give back `$0.046`), `money.test.js` (the
one dollar parser and formatter, and a guard that no money path floors,
truncates or float-parses an amount), `paymentFees.test.js` (a purchase credits
exactly what it charges, by card and by crypto) and `dollarSwitch.test.js`,
which builds a database the way the build before dollars left it - balances, a
run in progress, a queued order, a pending checkout - and boots this one on it.

The frontend has no test runner, so its decisions that need no browser are
small modules the backend suite transpiles and tests
(`frontendHelpers.test.js`, `frontendEditorHelpers.test.js`). What does need
one is in `backend/test/e2e/`, run by hand against servers that are already up:
`shell.js` walks every page as both roles, and `preview-vibration.js` opens the
profile editor with real scrollbars (puppeteer hides them by default) and
watches the preview's size every frame for each template, at the window sizes
where it used to shake.

The documentation is checked too. `backend/test/envExample.test.js` reads
`.env.example` and this README against the table in
`backend/src/config/operational.ts`, and fails when a setting there is missing
from either, ships uncommented, or is shown with a default, a range or a
read-timing tag the code no longer matches.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 |
| **Backend** | Express, TypeScript, better-sqlite3 |
| **AI** | Subscription seats only: Claude Code CLI (default), Codex CLI, Gemini CLI |
| **PDF** | Puppeteer |
| **DOCX** | html-to-docx |
| **Templates** | Handlebars |

---

## 📄 License

ISC
