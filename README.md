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
| **Credits** | A credit is a dollar, to the thousandth (`$0.023`), shown without trailing zeros (`$1`, `$4.1`). Each resume costs the price an administrator set for the model it is built with, in steps of `$0.001`, or nothing on a free model. The builder shows what a run will cost before it starts. Charged before the first model call and given back for any resume that does not build, exactly, so credit spent always pays for resumes delivered. Previews are free; administrators are exempt. Every movement has a ledger row explaining it |
| **Roles** | User, Reporter and Administrator. Users build resumes. Reporters add job postings to the installation's job lake and are paid per job accepted, with no resume builder. Admins manage accounts, prompts, models, templates, the skill library and settings - everything shared by everybody. See [Roles](#roles) |
| **Single or Batch** | Generate for one profile, a group, or all profiles at once |
| **Order & Download** | Two ways to build. **Generate Immediately** follows the run on the page and downloads each resume as it lands; closing the tab stops it and refunds what had not started. **Order** answers with an order number instead of making you wait: track it under **Orders**, download one file or the whole order as a zip, and the files are deleted automatically after five days |
| **Payouts, refunds and Contact admin** | A reporter can **ask for a payout** of their earned balance (*Ask for Refund*), and an administrator records what they sent, approves or declines it from one queue - where refund requests made before asking was removed are still decided; every step reaches the person's bell. Users and administrators no longer ask for refunds in the app. **Contact admin** lists how to reach the administrator, on every page and on the sign-in screen |
| **Job analysis, once** | Each job posting is read once, ever - its keywords, title, job field, industry and stated salary - and every profile, model, retry and run after reuses it. Every account has a job sheet of its own, with an **All** and a **Temp For AI** tab, where the analysis is written into six columns only the program can edit |
| **Job Data Lake** | One shared record of who is hiring for what. **Reporters** add jobs from their own job sheets and are paid per job accepted; administrators merge in what builds analysed, search it by field, job type, clearance, industry and more, and push a search into their own sheet to build from; every job added is copied to an administrators' spreadsheet |
| **Several sign-ins per seat** | An administrator can add more **providers** of a seat - another Claude, Codex or Gemini account signed in at a folder of its own - each with its own limit and queue, and resumes spread over them. Building again for an unchanged profile, posting and model reuses the tailoring with no model call |
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

## 🆕 What changed in this release

Support for older builds - upgrading their databases, reading their data,
rolling back to them - and the Apify Job Search are removed, and the server now
refuses at startup a database an older build never finished upgrading (see
[Upgrading](#4-upgrading)).

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
| `claude-cli` (default) | Claude (Subscription) | The `claude` CLI's own sign-in | A Claude Pro/Max plan. `claude auth status` must report `authMethod` `claude.ai` (what `claude auth login` saves) or `oauth_token` (a token the CLI was handed), with no `apiKeySource` beside it. A call the CLI starts on an API key anyway is stopped at its first event, which names the credential, and the seat is held as signed out so no further calls are made. |
| `codex-cli` | Codex (Subscription) | The `codex` CLI's own sign-in | A ChatGPT Plus/Pro plan. Headless-friendly: `codex login --device-auth` prints a code you approve from any other browser. A CLI signed in with an API key (`codex login --with-api-key`) reads as **not** signed in, and every call is refused before it runs. Its seeded model is `default`, meaning "whatever that account is configured with". |
| `gemini-cli` | Gemini (Subscription) | The `gemini` CLI's Google sign-in | A Google account. Sign in once with `NO_BROWSER=true gemini` - it prints a URL to open in any browser. Runs headless with no tools, pinned to the Google sign-in so it cannot use a key, and refuses any answer the CLI says it billed to paid AI Credits. Its seeded model is `auto`, which lets the CLI pick Pro or Flash per request. |

> **No real Google account has answered through the Gemini seat yet.** It was
> built against the real `@google/gemini-cli` 0.62.0 - its stream format, its
> exit codes, its sign-in errors and the settings files it reads - but the
> machine it was built on had no Google sign-in, so the successful turns in
> `backend/test/geminiCli.test.js` are the CLI's own envelopes around fake
> answers. Treat the first runs on a real account as the test, and watch the
> backend log while they happen.

Each provider has its own queue lane and its own process limit, so one
provider's backlog never holds up another - see [Several providers of one
type](#several-providers-of-one-type) for what a provider is. The Bid Assistant runs on the app's default model, as a run
that names no model does, or on its prompt's own model override when an
administrator has set one. A resume never does: its tailoring and cover letter
run on the model the run chose, because that is the model it is charged at, so
a prompt override cannot change what a resume costs or runs on. A **job
analysis** runs on the administrator's **analysis model**, once per posting for
everybody (see [Job analysis: once per posting](#job-analysis-once-per-posting)),
and the job filter makes no model call of its own - it judges that analysis.

#### Several providers of one type

A **provider** is one place a seat runs: a CLI of one of the three types,
signed in at a folder of its own. Every install has three - the **built-in**
provider of each type, whose id is the type's (`claude-cli`, `codex-cli`,
`gemini-cli`) and which reads `.env` exactly as before:

| Type | Binary | Sign-in folder (reaches the CLI as) | Limit |
|---|---|---|---|
| Claude | `AI_CLI_BIN` | `CLAUDE_CONFIG_DIR` | `AI_CLI_CONCURRENCY` |
| Codex | `AI_CODEX_BIN` | `CODEX_HOME` | `AI_CODEX_CONCURRENCY` |
| Gemini | `AI_GEMINI_BIN` | `AI_GEMINI_HOME` (as `GEMINI_CLI_HOME`) | `AI_GEMINI_CONCURRENCY` |

An administrator can **add** providers under **Admin → Models → Providers**: a
name, a type, a sign-in folder - so it can be a different account - and,
optionally, a binary of its own and its own `concurrency_max_requests` (1-32).
The same page can override the built-in ones' binary, folder and limit; a value
set there wins over `.env`, and the page says which is in effect. The checks are
strict: absolute paths only, the folder must exist and be a directory, the
binary must exist and be executable by the server's user, nothing may be
inside one of the app's own directories (the checkout, `DB_DIR`, the static and
output directories), and a folder another provider of the same type already
signs in at is refused - one account with two limits is not two accounts. Sign
the CLI in there first, as the server's user:

```bash
CLAUDE_CONFIG_DIR=/srv/claude-team-b claude auth login
CODEX_HOME=/srv/codex-team-b codex login --device-auth
GEMINI_CLI_HOME=/srv/gemini-team-b NO_BROWSER=true gemini
```

The health card of an added provider that is signed out says exactly that
command, with its own folder: the bare `claude auth login` signs in the
server's default folder, which is the built-in provider's. An added provider
also runs in a working directory of its own, beside its seat's
(`<AI_CLI_WORKDIR>-<provider id>`, likewise for Codex, and for Gemini its state
directory too), so two providers never share a turn's files.

**Models pool by type.** A model still names a type, and its price is still
the model's. Its runs are spread over every provider of that type that is
switched on, signed in and not held, each through **its own queue and limit**:
two Claude providers with limits 1 and 2 build three Claude resumes at once. A
resume waits in the lane of the provider with the most free capacity, and an
idle provider takes work waiting on a busier one of its type. When a provider is
held (a usage limit, a sign-in), signed out or switched off, its **waiting**
resumes move to another provider of its type; what it is building finishes or
fails as before, on that provider. A hold on **one model** counts for that
model's resumes only: a Claude account at its weekly Opus limit gets no Opus
work while another Claude provider can build it, and still builds Sonnet. A
resume that failed is tried again on **another** provider of its type when one
can take it, so a provider that fails fast cannot spend all of a resume's
attempts. Lowering a provider's limit while it is busy starts nothing new there
until it is back under the new limit. With **no** provider of a type able to
take work, its resumes wait - and the log says so once, `[queue] Work for
claude-cli is waiting: no provider of that type can take work now` - until one
can. Every call outside the queue (a preview, a job analysis, the Bid Assistant)
picks a provider of its type the same way, for its model, at the moment it is
made. A batch of previews or analyses is offered as many items at once as every
switched-on provider of the type has slots, added together (unless
`AI_BATCH_CONCURRENCY` says otherwise).

Each provider is its own seat in every other respect too: its holds, its health
check and its minute's status cache are its own, so one signed out says nothing
about another, and the health cards on the admin pages are **one per provider**.
`AI_LOCKED_PROVIDERS` still locks a **type**, and every provider of it. Which
provider built a resume is in the log (`[queue] Ada / Acme (task tsk_...) is
running on ...`) and, for an administrator, on the order's page; nobody else is
told.

A provider building something cannot be removed - switch it off, and remove it
once that finishes; its waiting work moves at once. A built-in provider cannot
be removed at all (every stored model names its type), only switched off; a
type whose every provider is switched off runs nothing, and the last provider
that leaves anything runnable cannot be switched off.

#### The tailoring cache

Generating again for the **same unchanged profile, posting, model and tailoring
prompt** reuses the tailored resume - and, separately, the cover letter - from
the last time, with **no model call**; the resume is **charged as usual**. The
key is everything the answer was made from: the whole profile (one character
changed is another key), its section switches and layout as its template allows
them, the template, the posting's stored analysis, the model record and its
model name, the prompt's text, and what the prompt is filled in with - so an
administrator's prompt edit, another model or an edited profile is asked
afresh, and so is a posting whose skills checklist changed because somebody
added or confirmed a skill in the shared library that it names (one it does not
name changes nothing). Only the model's answer is stored, and only an answer
the model asked for wrote: when the seat reports that a **fallback** model
answered instead (Claude's `AI_CLI_FALLBACK_MODELS` taking an overloaded
model's turn, Gemini switching Pro to Flash), that answer is used for that
build and not kept - the log says `[tailor-cache] Not keeping this tailoring:
it was written by ...` - and the next build asks again. Everything done with an
answer afterwards (the section switches, the skills) runs again each time. Rows
are kept `TAILOR_CACHE_DAYS` (30 days by default) and pruned at startup and
daily, in the `tailor_cache` table.

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

Older builds also had an OpenRouter provider, two that drove claude.ai and
chatgpt.com in a browser, and three billed per token (the Anthropic API,
OpenAI and DeepSeek). None of them is mapped onto a seat - their model names
are not a seat's, and moving a model would change what a run costs behind its
owner's back. A request naming one of their models is refused with *That model
isn't available*, and a prompt's model override naming one of them is ignored,
with one line in the log.

### Credits

**A credit is a dollar**, counted to the thousandth: a balance reads `$3.977`, a
price `$0.023`, a purchase `$50`. Every amount is stored and moved as an
integer count of thousandths of a dollar (`23` is `$0.023`), so nothing ever
rounds - seven resumes at `$0.023` cost exactly `$0.161`, and two of them failing
give back exactly `$0.046`. An amount is **shown with every digit that matters
and no trailing zeros** - `$1`, `$4.1`, `$0.023`, `$0`, `$1,234.5`, `-$0.046` -
never rounded (the thousandth a charge moved is always there) and never padded
(`$1.000` read as a thousand dollars). Notes already stored in a history keep
the text they were written with, so older rows may still read `$0.050`. Every
API response carries money as integers, in fields ending `Milli`
(`balanceMilli`, `costMilli`, `pricePerResumeMilli`...), and every request takes
it as dollars in fields ending `Usd` (`"0.023"`), read digit by digit and
refused with more than three decimals.

A resume - one profile against one job - costs **the price of the model it is
built with**, however many files that produces. Every model has a *price per
resume* in dollars, set under **Admin → Models** in steps of `$0.001`, from
`$0` (free) to `$1,000`. A new model is priced by whoever adds it - there
is no default - and a model with no price (a shipped one nobody has priced
yet) reads as `$0`, which **Admin → Models lists in red** for as long as any
enabled model is free. A run asking for PDF and DOCX
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
was made up - `4 resumes: 2 x Claude Opus @ $0.023, 2 x Claude Sonnet @ $0.01 = $0.066`.

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
  A new account at `$0` can still paste a job description and see the
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
  units bought at a price (50c by default), and the switch to dollars reset
  every balance to `$0` rather than pick a rate. Rows and payments from then are
  shown in the credits they were written in (`legacyCredits` in the API), never
  converted, and each account that held any - in its balance, or in a run still
  going - has a `reset` row explaining the jump.

A brand-new account starts at **$0**. Set `CREDIT_SIGNUP_GRANT` - in
**dollars**, e.g. `5` or `0.25` - to give an open installation a self-serve
trial, or let people buy their own.

### Buying credits

Two ways to pay, and **both work the same way underneath**: the server credits
the account only when a signed webhook arrives, whatever happened in the browser.
Users and administrators buy; a reporter cannot (their balance is earnings,
paid out by hand - see [Roles](#roles)), and every `/api/payments` route
answers them 403 `role-not-allowed`.

**What you pay is what you get.** A credit is a dollar and nothing comes out of
it: pay `$50` by card or by crypto and the balance rises by exactly `$50`.
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

Crypto was once taken two other ways: into a wallet watched by this server, and
through Coinbase Commerce. Both are gone, and no payment can be started through
either; one already made through them still reads and renders under its own
name (`chain`, `coinbase`), and refunding it says to send the funds back from
wherever it was taken, then adjust the balance on Admin → Accounts.

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

### Refund and payout requests

**Only a reporter asks, and only to be paid out.** Users and administrators do
not ask for refunds of purchases or resumes in the app (the owner's decision):
there is no *Ask for refund* on purchases, Credit History or orders, and no
route to ask through - somebody who thinks they are owed one contacts the
administrator. An administrator can still give money or credit back directly -
the payments list's Refund, or the **+/-** beside a balance on Admin → Accounts.
**Credits → Refund Requests** still lists what an account asked before,
read-only, and every request still open from before stays in the administrators'
queue and is decided exactly as below.

**A payout request.** A reporter's **Credits** page has **Ask for Refund**
where a user's has *Purchase Credits*. It asks an administrator to pay out the
earned balance - the whole balance as it stands, never an amount the reporter
types - with an optional note (how they would like to be paid, say). One
request may be open at a time, and none at `$0`. Every administrator gets a
notice (*New payout request FT-RF-…*), and the request joins the same queue
(**Admin → Payments**, *Refund requests*), marked *Payout* with the reporter's
balance now. There an administrator **Records the payout** with what they
actually sent outside the app - prefilled with the smaller of what was asked
and the balance now, and anything up to the balance at that moment, more than
was asked included (earnings since asking count) - and a note saying how. That
writes one `reporter-payout` row in the reporter's history, keyed by the request
(`payout:<account>:<request id>`, so a double press records once), and turns the
request *Paid out* in the same step; the reporter is told (*Payout recorded:
$X*). Above the balance, an account no longer a reporter, or one deleted since
is refused and moves nothing - decline the request instead. Recording a payout
from **Admin → Accounts** while a request is open closes that request as paid
in the same step, so it cannot be paid twice.

The older kinds still in the queue are:

- **A purchase** gives back its **unspent part**: what is left of what it put
  on the balance - the balance, capped at what the purchase credited, the same
  measure the Refund button's reversal uses - rounded down to whole cents,
  because a card returns cents and a balance moves in tenths of one (`$39.993`
  left asks for `$39.99`; the `$0.003` stays as credit). It is measured when
  asked and again when refunded, and never goes above what was asked: somebody
  who spends after asking gets back what is left.
- **One resume's charge** comes back as **credit**, exactly what that resume
  was charged.

Each request moves through four states, set by an administrator:

| From | To | What happens |
|---|---|---|
| Requested | **Approved** | The refund is accepted. No money moves yet |
| Requested or Approved | **Declined** | A reason is **required**, written by the administrator and shown to the person who asked. Final |
| Requested or Approved | **Refunded** (*Paid out* for a payout) | The refund - or, for a payout, the record of what was sent - is made in the same step. Final |

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

**What the invoice says.** A refunded purchase's invoice (**Credits → Card** or
**Crypto** → *Invoice*) shows the money that actually went back as *Amount
Refunded* - the whole charge from the payments list's Refund, the unspent part
from a request, what was sent by hand for crypto - and how much credit came off
the balance. After a partial refund the rest is described as *not reversed: it
had been spent, or is still on the balance*, because a request leaves the
fraction of a cent below its whole cents on the balance and the payment alone
cannot tell that from what was spent; the payments list says the same, with
the amount returned.

**One open request per item.** A second request for something with a Requested
or Approved one is refused - by a partial UNIQUE index in the database, not only
by the page - and a declined request does not stop asking again. For a payout
the item is the reporter's account, so each reporter has at most one open
payout request, and may ask again once it is paid out or declined.

**Which resume.** A queued resume - an order's, or a Generate Immediately
run's, which is filed with an order record of its own that **Orders** never
lists - is named by its order item, which keeps what it was charged after its
batch is gone and after the run's files are deleted; a resume built by the older
synchronous `POST /api/resume/generate` by its charge, which was that resume's
alone. A request an older build made for a builder run's resume named its
queued task instead (`task:`), which this build cannot measure, so the queue
says so and offers only Decline: *This request names something this version of
the app cannot measure, so it cannot be refunded here. Decline it, and refund
by hand from Accounts if it is owed.*

**Everybody concerned is told.** A new request puts a notice in every
administrator's bell; every change of state puts one in the bell of the person
who asked - and nobody else's: *Your refund request for … was approved*,
*… was declined: <the administrator's reason>*, *… was refunded ($0.161)*; for
a payout, *Your payout request FT-RF-… was approved* or *… was declined: …*,
and *Payout recorded: $X*.

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
left. What is in it depends on the account's [role](#roles).

**Top bar** - the brand (press it to go home: Build Resumes, or Report Jobs for
a reporter), then on the right: your **credit balance** (press it for Credits,
where you buy more), **notifications**, the **light/dark** switch, and your
**account** - name, email, subscription, credit and profile use, with Settings,
Subscription, Contact admin and Log out under it (and Manage accounts for an
administrator).

**Sidebar** - your work at the top:

| | |
|---|---|
| **Profiles** | the resume profiles you build from |
| **Find Jobs** | the All tab of your own job sheet, in a new tab - once the server has one for you |
| **Build Resumes** | the builder |
| **Orders** | what you ordered, and the files |
| **Credits** | your balance, buying more, and the history of both |

then, under an *Assistant* divider, **Job Filter**, **Bid Assistant** and
**Calendar**; and pinned to the bottom, **Templates** and **Settings**.
Settings is your account's own tabs - Profile, Job Sheet, Payment Methods,
Subscription - and for an administrator one more, **Administration**, whose
ten shared-configuration pages appear as a second row once you are in it.
Groups (`/admin/groups`, Premium and above) has no entry of its own; it is
reached by its address.

**A reporter's** shell is three rows: **Report Jobs** (their home), **Credits**
(what they have earned and the payouts recorded against it) and **Settings**,
with only the Profile and Job Sheet tabs. Their balance in the top bar is
earnings, and their account menu holds a link to their own job sheet,
Settings, Contact admin and Log out - no subscription. Any other address -
an old bookmark, a link in a notice - takes them to Report Jobs instead of
opening a page their account would be refused.

Below 768px the sidebar becomes a drawer behind the menu button in the top bar.

### Roles

Every account holds exactly one role, and an administrator changes it on
**Admin → Accounts**:

| Role | Who | What they reach |
|---|---|---|
| **User** | every new sign-in | the resume builder and everything around it: profiles, templates, Build Resumes, Orders, groups (by subscription), the job pages and buying credits |
| **Reporter** | made by an administrator - by changing a user's role, or by adding the account as a Reporter before its first sign-in | **Report Jobs**, **Credits** (their earnings, payouts and **Ask for Refund** - a payout request), a link to their own job sheet, **Settings → Profile** and **Job Sheet**, notifications and **Contact admin**. No resume builder, no buying credits |
| **Administrator** | the addresses in `ADMIN_EMAILS` (else `SMTP_USER`), and anybody an administrator promotes | everything, including what the whole installation shares |

A reporter adds job postings to the installation's job lake from their own
job sheet and is paid for each job the lake accepts: at their own **rate per
job** when an administrator has set one on Admin → Accounts (dollars, in
steps of `$0.001`; empty means the installation's global rate), otherwise at
the global rate. Earnings land on their balance like any credit. They are
**paid outside the app** - by bank transfer or however the operator pays
people - and the administrator records each payment with **Record payout**:
an amount and a note saying how it was paid, which takes it off the balance
and shows in the reporter's history and bell. A payout is never more than the
balance, and only a reporter has one. A reporter can ask for one with **Ask for
Refund** on their Credits page - a payout request in the administrators' queue
(see [Refund and payout requests](#refund-and-payout-requests)). A reporter
cannot buy credits.

Changing a role keeps everything the account owns - profiles, orders,
balance - out of reach of the routes the new role cannot use. An Order
already queued finishes; a Generate Immediately run of a user made a reporter
stops within about a minute, because their tab can no longer follow it, and
the resumes it had not started are refunded. The change takes effect on the
account's next request, and an open page catches up with it: a user made a
reporter is taken to Report Jobs by the first thing their page asks that a
reporter may not, and any other change shows at the next reload.

**An address in `ADMIN_EMAILS` stays an administrator** - and so does
`SMTP_USER`'s, on an install that sets no `ADMIN_EMAILS`. It can be made a
user or reporter on the Accounts page, which says so beside it and names the
setting, but it is promoted back at its next sign-in and at every restart -
the configuration outranks the page, so a typo on the page cannot lock the
operator out. Take it out of `ADMIN_EMAILS` (and restart) to make the change
last; for `SMTP_USER`'s address, set `ADMIN_EMAILS` to the administrators you
do mean.

### What each account can reach

Not everything is for everybody, and the rule differs by section because the
reasons differ. A **role** says who may change things the whole installation
shares, and who builds resumes at all; a **subscription** says what an
individual account includes. They are separate checks and one is not a
substitute for the other. *Users* below means users and administrators -
everybody but a reporter.

| Section | Who | Why |
|---|---|---|
| Build Resumes, Calendar, Job Filter, Bid Assistant, Profile | users | their own work. A reporter is refused every one, with 403 `role-not-allowed` |
| **Orders** | users | their own orders only, by id - somebody else's answers 404, never 403, because the difference would confirm it exists |
| **Buy credits** (and saved cards, purchase history) | users | their own payments only, by the same 404 rule. Never a reporter: their balance is earnings, paid out by hand |
| **Credits** (balance and history) | anybody signed in, reporters included | their own. A reporter's history is their earnings and payouts |
| **Your account** (Settings → Profile, Job Sheet) | anybody signed in, reporters included | their own name and their own job sheet |
| **Report Jobs** | reporters (administrators may open it) | adding jobs from their own sheet to the job lake |
| **Payouts** (Record payout, the rate per job) | **administrators** | on Admin → Accounts, for a reporter's row, and on a payout request in the refund queue |
| **Payout requests** (asking) | **reporters** | for their own earned balance (`GET`/`POST /api/refund-requests/payout`). An administrator is refused (409 `not-a-reporter`): their balance is not earnings |
| **Job Lake** (the lake, its merge, Push to Google Sheet, the global rate and duplicate window, the admin sheet) | **administrators** | the lake is shared, and what a job pays is the installation's decision - see [The Job Data Lake](#the-job-data-lake) |
| **Payments** (the list, refunds and the refund-request queue) | **administrators** | reconciliation against the provider's dashboard, and the only buttons in the product that move money outward |
| **Refund requests** (asking) | nobody | removed: there is no route to ask through any more. Somebody who thinks they are owed a refund contacts the administrator |
| **Refund requests** (reading your own) | anybody signed in | an account made a reporter after asking still sees how its request ended |
| **Contact the administrator** | **everybody**, signed in or not | the people who most need it are the ones who cannot sign in. Editing the list is an administrator's, under Settings |
| **Find Jobs** | anybody signed in | opens the All tab of their own job sheet in a new tab: from the sidebar for users and administrators, from the account menu and Report Jobs for a reporter |
| **Groups** | **Premium and above**, and administrators | an entitlement, checked on the subscription - a group is a way to build for several profiles at once |
| **Building for several profiles** (Multiple, All profiles, Specific group, Select Group) | **Premium and above**, and administrators | a Default subscription supports one profile. The run, its quote and the multi-profile preview answer 403 `subscription-too-low`; a single-profile run - Generate Immediately or Order - is open to everybody |
| **Bid Assistant** (the shared parts) | **administrators** | the job board is shared, so deleting a job - which takes every account's saved answers for it - and the one Ask AI prompt template every account uses are an administrator's. Everybody else reads the template and may mark a job as an error; their saved sheet sources and their answers are their own, and a job reads as *Answered* only to an account that answered it |
| **Skill library** (adding, editing, deleting) | **administrators** | one library feeds every account's resumes. Confirming a skill found in use - the builder's prompt, a hard skill typed into a profile - adds it for any user |
| **Templates** (looking at them) | users | the gallery and the full-page preview of each, from the sidebar. Choosing a template is no use without seeing what it produces |
| **Templates** (adding, editing, disabling, deleting) | **administrators** | a template is shared - editing one changes how everybody's resumes look. A *disabled* template is an administrator's staging state and is not listed to anybody else |
| **Notifications** (reading them) | anybody signed in, reporters included | the bell in the top bar, with an unread dot until it is opened: every announcement, and the notices written for that account alone (its refund and payout requests, its payouts; for an administrator, new requests) - never anybody else's |
| **Notifications** (posting them) | **administrators** | one notice goes to every account on the installation |
| **Test** | **administrators** | runs prompts directly and shows raw model output; a tool for whoever maintains the prompts |
| **Settings** (the shared configuration - General, Accounts, Models...) | **administrators** | every page under it changes something shared |

An entry nobody may use is not shown in the navigation, and the page behind it
explains itself if the URL is typed - a blank screen reads as a broken link. A
reporter is sent to Report Jobs from any page that is not theirs. **Hiding is
not the protection**: every one of these is enforced by middleware on the
routes, so an old tab or a hand-made request is refused just the same - a
reporter with *That part of the app is not available for your account. Ask
your administrator if you need it.*, code `role-not-allowed`. The rule is
written the safe way round: the builder's check admits users and
administrators by name, so a route added later is closed to reporters until
somebody decides otherwise, and `backend/test/routeAccess.test.js` holds the
decision for every router the server mounts.

**Administrators are exempt from the subscription checks** - Groups, and
building for several profiles - whatever their own subscription, as they are
from credits and the profile cap. (An administrator on Default used to be
refused Groups until somebody moved them up.) It is the role that exempts: the
same account made an ordinary user is held to its subscription like anybody
else.

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
the cause logged under it. Rows stored before references existed held the raw error;
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

**A section switched off goes whole - heading included - and nothing else goes
with it.** The renderer finds it, at compile time and never by rewriting the
stored file, by the `section-strengths` / `section-soft-skills` class every
built-in and the manual builder put on it; else by a `data-section="strengths"`
(or `"softSkills"`) attribute; else, for markup with neither - an uploaded
template, typically - from where the list is printed, a `{{#each strengths}}`
loop or an inline `{{join softSkills ", "}}`: the nearest element around it
that holds the section and nothing else (its heading, the list, a divider), or
the list's container (with any `{{#if strengths.length}}` right around it)
plus the heading element before it, past a divider or a line break
(`<h2>Strengths</h2><hr>`, `<b>Strengths</b><br>`). So *Strengths* over an
emptied list no longer survives in an uploaded template, in the live preview
or the PDF (the DOCX draws its own sections from the gated lists, so it never
printed one). An element is taken whole only when the section is ALL it
holds: a sidebar that also holds a photo, an icon, a *References* block or any
line of text keeps all of that and loses only the heading and the list, and
soft skills drawn inside the Technical Skills block lose their items and leave
the block's heading. Switched on with nothing in it, the same section is
guarded, so it prints no empty heading either. A heading the finder cannot
tell from the template's other content - bare text beside other data, a label
inside its own `{{#if}}`, a picture between the heading and the list - stays
over an emptied list; the Troubleshooting table says how to mark the section
so it goes whole. And if finding a section would leave markup that no longer
compiles (a Handlebars block that opens inside the section's element and
closes outside it), the template is drawn with less found rather than not at
all, and the backend says so once.

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

**Every tailoring prompt must use all three.** They are the feature's
*required* variables: saving a tailoring prompt - the built-in edited, or a
variant a profile picks - that leaves one out is refused, *Missing required
prompt variables: includeSoftSkills. Every Tailor Resume prompt must use
[[includeStrengths]], [[includeSoftSkills]] and [[technicalSkillsLayout]].*
A record stored without them (written before the rule, or by hand) is never
run: **Admin → Prompts** marks it *Needs update*, names what it lacks, and the
built-in tailoring prompt runs in its place - the administrator's edit of it
when that is complete, else the shipped text - until it is updated; the
backend log says so once (*[prompts] The prompt "..." (...) does not use
[[includeStrengths]], which every Tailor Resume prompt must; the built-in
Tailor Resume prompt runs instead until it is updated under Admin ->
Prompts.*). Whichever record runs, the code also appends a *FINAL SKILL
OVERRIDE* to every tailoring turn stating the same three facts, and the
post-processing above enforces them again whatever the model returns.

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

### Job analysis: once per posting

Every resume starts by reading the job posting - its keywords, its title, and
now its **job field**, the **salary** it states and the facts the job filter
judges. That reading is made **once per posting, ever**, and stored: not once
per profile, per model, per run, per retry or per restart, and the job filter
does not make a reading of its own. Whoever needs a posting's analysis first -
Generate, an Order, Generate Immediately, the job filter - causes the one call;
everybody after gets the stored one.

- **What makes two postings the same.** Its job link (host case, `#fragment`,
  `utm_*`/`gclid`/`fbclid`/`ref`-style tracking and a trailing slash do not
  count) **or** its text (spacing does not count). So the same job pasted from
  two sheets with slightly different text is still one posting when the link
  is the same.
- **One model reads every posting**, so job fields stay consistent: the
  **analysis model** under **Admin → Settings → General**. Left empty it is
  the app's default model. A model chosen there that stops running (switched
  off, its seat locked) is replaced by the default with a warning in the log.
- **Changing it, or editing the Analyze Job Description prompt, reaches only
  postings never analysed before.** There is no "re-analyse": an analysis is
  never replaced. The prompt has one version - a profile no longer chooses its
  own analysis prompt, and a variant cannot be added or activated - and the
  Prompt Test page shows the posting's stored analysis, or makes it.
- **The builder holds the analysis it was given.** Under the job description
  it says what the posting was analysed as - its title, job field and salary -
  and so do the previews. Changing the company, the role, the profile or the
  model builds on that same analysis, sent by its id, without asking for it
  again; editing the description itself is another posting.
- **The job field** is one of the owner's list of software development fields
  at bullet level (Backend, DevOps, ML engineering...), by a fixed id; the
  computer-science foundations are not offered. A posting that fits none - or
  an answer that names a field not in the list - is **Unclassified**.
  `GET /api/resume/job-fields` lists them.
- **The salary** is only what the posting states - its numbers, currency,
  period and words - never an estimate.
- **The industry** is one of a closed list - Healthcare, Finance, Insurance,
  Military, Government, Education, Retail & E-commerce, Technology,
  Consulting, Media & Entertainment, Logistics & Transportation, Energy &
  Utilities, Manufacturing, Telecommunications, Legal, Real Estate,
  Hospitality & Travel, Nonprofit, Other - by a fixed id. An answer that names
  none of them is **Other**; a posting that gives nothing to tell it by has
  none (a blank cell).
- **Job type** (Remote, Hybrid, Onsite, or blank when the posting does not
  say) and **clearance** (required or not) come from the facts the job filter
  judges. A clearance counts as required unless the posting says none or says
  nothing - an unfamiliar clearance word included, as the filter treats it.
- **A posting analysed before industries existed is not analysed again** for
  one. Its industry is worked out from what its analysis already holds every
  time it is read - its company category, else its own industry word
  ("SaaS", "fintech", "Healthcare IT"), else none - and nothing is written
  back into it.
- **A call that fails stores nothing**, so the next request is the first real
  analysis. That is the only way a posting is ever sent to a model twice.

**In your own job sheet**, the analysis is written into the row once - all
six of G to L: Job Field, Salary, Job Type, Clearance (TRUE/FALSE), Industry
and the whole analysis as JSON in **Analysis** (cut with a marker at Google's
50,000-character cell limit). Values are written as plain values, never
formulas. A row that already has its analysis is **not analysed again**: a
build from the sheet - Order or Generate Immediately - and a reporter's run read
the rows' analysis cells themselves, in one call per run, and use the stored
analysis each names. That is only safe because nobody else can write those
cells, and because a cell is only ever a pointer into the database:

- The six columns are a **protected range**, header included, editable only by
  the server's Google identity. Anybody else - including the account the sheet
  belongs to - gets Google's protected-cell refusal on edit, paste, clear or
  fill; the rest of the row stays theirs.
- The protection is checked every time the app checks the tab, and put back if
  it was missing or changed - **with the Analysis column below the header
  cleared in the same step**, because anybody with the link could have typed
  into it meanwhile. In that run the tab's analysis cells are not trusted;
  those rows are read from the database, or analysed, and each row's cells are
  written again from the database on its next run. So an Analysis cell is only
  ever trusted once the program has written it under the protection.
- **A cell is used only as a pointer to the database.** It names its stored
  analysis by id, and the build uses that stored analysis - never what the
  cell holds - and only when it is the row's posting, by the posting's link or
  text. Paste another posting into a row, or sort the job columns (the
  protected ones cannot move with them), and the cell left behind is not used
  for the new posting - which is found in the database, or analysed once - and
  the app writes the right analysis over it. A cell naming an analysis this
  database does not have - copied from another install, left from a database
  restored from an older backup, or text that only looks like the program's -
  is ignored the same way (the log says the row's *Analysis cell names an
  analysis this store does not have*), and rewritten.
- Before writing, the app re-reads the row's company and link, so a sheet
  sorted or trimmed since the run started is not written into the wrong row.
- **With `npm run sheets:login`** the server's Google identity is the
  operator's own account, and that one account can still edit the columns by
  hand in the browser. A **service account** key leaves no person able to;
  prefer one if that matters to you.

Only the app's own job sheets get the columns, and in them only **job tabs** -
a tab whose first row starts with Date, NO(DATE), Company, Job Title, Job Link,
Job Description, or a tab with nothing in it at all (see [The job
sheet](#the-job-sheet)). Any other tab - one you made yourself, say - keeps
its own header and its own columns: the app never re-heads, protects or writes
it, and the job pages do not offer it.

### The job sheet

Every account gets **one Google spreadsheet of its own**, with two tabs of the
app's: **All**, first, which every job page reads and writes unless you pick
another tab, and **Temp For AI**, second - a job tab like All, and the one
**Push to Google Sheet** on Admin → Job Lake replaces with the jobs of a
search, for the administrator who pushes (see [The Job Data
Lake](#the-job-data-lake)). Both open with the job columns,
frozen, filtered and formatted, every row 21 px high with long text clipped
rather than wrapped:

| | A | B | C | D | E | F | G | H | I | J | K | L |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | Date | NO(DATE) | Company | Job Title | Job Link | Job Description | Job Field | Salary | Job Type | Clearance | Industry | Analysis |

**A to F are yours** to fill in (Push to Google Sheet fills them in Temp For
AI). **G to L are the job analysis's, and protected**: only the server's own
Google identity can edit them, and the app fills all six from a posting's one
analysis - Job Type is Remote, Hybrid or Onsite (empty when the posting does not
say), Clearance a real TRUE/FALSE, and the Analysis cell the whole analysis,
which is what lets a later build skip analysing the row (see [Job analysis: once
per posting](#job-analysis-once-per-posting)).

A **job tab** is a tab whose row 1 starts with those six user headers - or a
tab with **nothing in it at all**, under any name, which is laid out as one the
first time the app uses it. Every other tab is left exactly as it is: the app
never re-heads, protects, clears, reads or writes it. That includes a tab with
data under an empty row 1. To use a job listed in such a tab, copy its
Company, Job Title, Job Link and Job Description into C to F of All.
If the sheet already has a tab called All or Temp For AI that is not a job tab,
that tab is left alone and Settings > Job Sheet says so; rename it and reload the
page, and the app adds its own. The same page puts back an All or Temp For AI
deleted or renamed in Google Sheets: it is the one page that looks at the
sheet's tabs again each time it loads (so does Push to Google Sheet), while
every other page links to the tabs as they were recorded.

Allocation is **fire-and-forget at sign-in**: a spreadsheet is a convenience and
being able to log in is not, so a Google outage must not become an outage of
logging in. Settings > Job Sheet ensures the same thing when it loads, which is what
covers an account whose sign-in ran while Google was down - and a paced
backfill at startup allocates one for every account still without a sheet.

**Who owns them, and who can open them.** Every sheet is created in the Drive of
whichever Google account signed in with `npm run sheets:login` - the operator's,
normally - and each account is invited to its own sheet as an **editor**, by
email, without a notification mail.

New sheets are **private by default** - only their owner, by that invitation -
and `SHEET_DEFAULT_VISIBILITY=public` makes them link-shared instead, meaning
anyone with the link can edit them. The toggle under Settings > Job Sheet turns
that one link grant on or off for the owner's own sheet and touches nothing
else: the owner's personal invitation stays, which is what still lets them open it. The
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
account has no spreadsheet on record, so the startup
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

**The job pages use it, and only it.** Build Resumes, the Job Filter, Report
Jobs and the range importer read and write the signed-in account's own sheet
and nothing else - an administrator's included.
A spreadsheet id a request names is checked rather than trusted, and any id
but your own is a 404, decided before Google is asked. This matters more than
it looks - the server's Google identity *owns* every account's spreadsheet, so
a route that took an id on trust would read and overwrite anybody's for anyone
who knew it, and a link-shared sheet hands that id out in its URL.

- **The Job Filter** reads Company, Job Title and Job Link (C to E) of the tab,
  judges every row that has a link on its posting's one analysis - a posting
  already analysed costs no page fetch and no AI call - and shows each row's
  Pass or Fail and the reason **on the page**. It writes nothing into the
  sheet.
- **Build Resumes** offers your own sheet's tabs, All selected; a tab that is
  not a job tab is listed greyed out as *(not a job tab)* and cannot be picked.
  The Job Filter and Report Jobs list the tabs the same way. There is no sheet
  to choose and no column mapping: the rows' C to F are read, and G to L beside
  them to show which rows already hold their analysis. Each row's role is its
  own `Job Title`; a row with none is built with the title the posting's
  analysis reads from its description, as a manual build is.
- **Admin -> Google Sheets** (the range importer) reads and writes a range of
  the administrator's own sheet, and refuses a write into **G to L of a job
  tab** - those cells are the program's, and the server's identity is the only
  editor the protection lets through, so a write from here would be the one
  way past it. (Even an Analysis cell written past it could not change an
  analysis: a build uses only the stored analysis a cell names.)

`SHEET_TIMEZONE` decides which day a row the app writes is dated, and so
numbered - Push to Google Sheet dates each row by the day its job was last
updated, in that zone. A server running in UTC rolls the day over at midnight
UTC, which for a user in New York is seven in the evening - so an evening's rows
would be dated, and counted, as the next day's. Set it to the zone the users
actually live in.

### The Job Data Lake

The **job lake** is the installation's shared record of who is hiring for
what: one row per **job** - a company hiring in a job field - not per posting.
Reporters fill it from their own job sheets and are paid for each job it
accepts; administrators also merge in the jobs that builds analysed. It lives
in the database (`job_lake`, with full-text search), and every job it adds is
also appended to an **admin sheet**, a spreadsheet the server keeps for the
administrators.

**What makes two jobs the same.** The company and the job field - the field
from the posting's [analysis](#job-analysis-once-per-posting), by its id. The
company is compared loosely: Unicode-normalised, lower case, punctuation and
symbols dropped, a trailing legal suffix dropped (Inc, LLC, Ltd, Corp,
Corporation, Co, Company, GmbH, PLC, S.A., AG, B.V., Pty Ltd, Co. Ltd. and a
few more), then every space removed - so *OpenAI, Inc.*, *Open AI LLC* and
*openai* are one company, and *Acme Corp* and *Acme Labs* are two. The lake
keeps the values as they were reported; what it compares is a SHA-256 **job
hash** of the normalised pair, versioned so that changing these rules later is
a deliberate re-hash rather than a silent split. A posting with no field from
the list (*Unclassified*), or no company, has no hash: it is never added and
never paid for.

**What a job records.** Its company, job field, title, salary and link as
reported, who reported it and when - and its **job type**, **clearance** and
**industry**, taken from the posting's [analysis](#job-analysis-once-per-posting)
and never from what anybody typed.

**Duplicates and the window.** When a job comes in whose hash the lake
already holds:

- the lake row was added (or last replaced) **within the duplicate window** -
  60 days by default - it is a **duplicate**: painted red in the reporter's
  sheet, not paid, and the row's *seen* count goes up;
- the lake row is **older** than that, the new report **replaces** it and
  counts as **added**: paid, the row now says who reported it and when, and the
  old version is kept in the row's history.

The window is `JOB_LAKE_DUPLICATE_WINDOW_DAYS` in `.env`, and an
administrator's value on **Admin → Job Lake** wins over it; that page says
which is in effect and where it came from. The decision is made on the
database alone - two reporters adding the same job at the same moment get one
*added* and one *duplicate* - and never by reading a sheet.

**Reported before.** The lake also remembers every posting each reporter
reported, and what became of it the first time (*Added*, *Replaced*,
*Duplicate* or *Unclassified*). The same reporter reporting the same posting
again - the same row, another row, another tab, a row it was sorted or moved
to - is **Reported before**: skipped, with that first outcome, never paid or
counted again, and never a duplicate of itself, inside the window or after
it. Another reporter's report of it is a duplicate like any other. The same
posting **twice in one run** is a duplicate the second time, painted red. A
row whose company was missing is not remembered, so it is reported once the
company is filled in. Deleting a job from the lake (Admin → Job Lake) forgets
the reports that reached it, so it can be reported again; an *Unclassified*
report reached no job, so no delete forgets it - its analysis is final, and it
would come out unclassified again.

**Reporting (Report Jobs).** A reporter picks a job tab of their own job
sheet - All is chosen for them - and a range of rows (up to 500 at a time),
presses **Preview rows** to see the rows that hold a job and which of them a
run will skip because they were reported before (with what became of them
then), and presses **Add to job lake**. The page opens with what a job pays
them (their own rate, or the global one), what they have earned today against
any daily cap, their balance and how many of the lake's jobs are theirs. The run goes on in the background, with a
progress bar - the page may be left and come back to, and shows the last run
for an hour after it ends; for each row:

1. a row whose posting this reporter **reported before** is skipped - *Reported
   before (Added)*, or whichever outcome it had - so running the same rows
   again pays nothing and analyses nothing. The database decides it, by the
   posting - nothing in the row says it: a row moved or copied elsewhere is
   still skipped, and a new posting pasted over an old row's is reported like
   any other;
2. its posting's analysis is found, sheet first: the stored analysis the
   row's own **Analysis** cell names, else the stored analysis of the posting,
   else **one** model call (written back into the row) - a posting analysed
   before costs nothing;
3. the job is merged: **added**, **replaced** or **duplicate**, as above.

Then the run paints the duplicates' rows red in the sheet (a row whose posting
was a duplicate the first time too) - and writes nothing else into a row but
its analysis columns: each row's outcome - *Added*, *Replaced*, *Duplicate*,
*Unclassified*, *Skipped* or *Reported before* - is on the page, and in the
database - and ends with *N out of M was added, your current credit is $X* -
M being the rows it took to the lake, a row reported before not counted - over
every row's outcome, the duplicates red there as well. *Skipped* means the
row could not be reported this time - no company, or no description long
enough to read a job field from - and the next run tries it again once the row
is filled in. A row whose analysis failed (a seat down) is tried again next
time. A run reads only a job tab - All, Temp For AI, or another laid out the
same way - and refuses any other before touching it. The reporter's own rows
only: nothing in the page or the request can name another spreadsheet.

**Rewards.** Paid the moment a job is added, in the same database transaction
as the lake row - at the reporter's own **rate per job** if an administrator
set one on Admin → Accounts, otherwise at the **global rate** set on Admin →
Job Lake (`$0` until somebody sets it: nobody is paid by default), in steps
of `$0.001`. The rate in effect is recorded on the reward, so changing a rate
reaches the next job, never one already paid. Duplicates, unclassified jobs and
skipped rows pay `$0`, and a replaced job pays again - but the same version of a
job never twice. An optional **daily cap** limits what one reporter earns per
UTC day; a job past it is still added, and paid only what is left of the day.
An administrator who reports is never paid, and nor is anybody for a merge.
An administrator may **revoke** a reward - on its own, or when deleting the
job - which takes it back off the reporter's balance, never below `$0`
(earnings already paid out are not a debt), and tells them in the bell.
Earnings are paid outside the app and recorded with **Record payout** (see
[Roles](#roles)).

**Merge (administrators).** **Admin → Job Lake → Merge** lists the jobs that
**builds** analysed and nobody has merged yet - with a job field from the list
and a company on record (the builder's analysis names no company, so a
posting that was only previewed is offered once a build, a job filter run or a
report names its company). **Merge selected** or **Merge all** (1,000 at a
time) adds them through the same rules, reports the duplicates, and pays
nobody: the lake records the account whose build produced each one as having
asked for it. No model is asked, and no sheet is read.

**The admin sheet.** The first time the lake has a job to send, the server
creates a spreadsheet of its own, *Tailor - Job Data Lake*, stores it in the
settings and shares it - as an editor - with every enabled administrator's
email; an administrator added later is added at the next sync (**Retry now**
does it at once, with nothing to send). Every job the
lake **adds** is appended as a new line (Company, Job Field, Title, Salary,
Link, Requested By, Updated At, Job Hash, Job Type, Clearance, Industry -
Clearance a real TRUE/FALSE); a replacement is a new line too, so the sheet is
a log of everything the lake ever accepted. An admin sheet made before Job
Type, Clearance and Industry gets its header row rewritten once, just before
its next line is appended; the lines already there keep those three columns
blank (**Create a new admin sheet** sends the whole lake again, with them).
The database is the record and the sheet follows it: a job is committed first, then appended in
batches - right after each report run and merge, and at every start - and an
append that fails never undoes anything; the job waits, the page shows how
many are waiting and why, and **Retry now** sends them. Taking an
administrator off the sheet is done in Google, by hand. If the spreadsheet is
deleted in Google, **Create a new admin sheet** makes another and sends it the
whole lake.

**Admin → Job Lake** (a tab of Settings → Administration) has three tabs of
its own. **Lake** lists the lake - newest first, with each job's type,
clearance and industry - filtered, when **Search** is pressed, by *Updated
from* and *Updated to* (UTC days), *Requested by*, *Job field*, *Job type*
(Remote, Hybrid, Onsite), *Clearance* (Required or Not required), *Industry*,
*Company* (compared as above), a salary range (*Salary from*, *Salary to*) and
*Full text* over company, title and description, in that order - and
**Details** opens a row with its description and history, where **Revoke
reward** takes the reward back and **Delete** removes the job (it can then be
reported again, as a new one), with **Also revoke the reward** to take its
reward back in the same step. **Push to Google Sheet**, beside Search, writes
the jobs of the search on the page - newest first, at most
`JOB_LAKE_PUSH_MAX_ROWS` of them - into the *Temp For AI* tab of the pushing
administrator's OWN job sheet, replacing what that tab held below its header
(columns A to L, a duplicate's red paint included; another tab, or a column
past L, is never touched). It pushes the search on the page, never boxes
changed since, and asks first - naming how many jobs go, and saying so when
the boxes were changed - then links to the tab, and says when the cap cut the
search short. Each row is dated by the day its job was last updated, numbered
in NO(DATE) within that day, and carries the six analysis cells of its
posting's stored analysis, so building resumes from *Temp For AI* analyses
none of them again - a description longer than a cell's 50,000 characters
included: it is written cut, ending *...[cut at 50,000 characters]*, and that
cut copy is still read as its posting, link or no link, as long as it is not
edited. **Merge** is the merge above.
**Settings** holds the global rate per job (dollars, in `$0.001` steps), the
duplicate window - with where the value in effect comes from: set there, `.env`
or the built-in 60 - and the daily cap; and the admin sheet: its link, who it
is shared with, how many jobs wait to be appended and why the last attempt
failed, **Retry now**, and **Create a new admin sheet**. **Admin → Accounts**
names the global rate in every empty per-reporter rate box.

### Order & Download

Every build is queued on the server, and there are two ways to start one -
two buttons, chosen by what you want to wait for:

| | **Generate Immediately** | **Order** |
|---|---|---|
| Where | Manual mode (one profile, or Multiple) and sheet mode | Sheet mode, and manual **Multiple** |
| While it runs | Follow it on the page, with progress and a **Stop** button | The page is free at once; follow it on **Orders** |
| Files | Each resume **downloads by itself** as it lands | Kept on the server for five days; download one, a few, or all as a zip |
| Closing the tab | **Stops the run** - at once, or after a short grace when it is the connection that went | Nothing - it runs whether or not anybody is watching |
| On the seat | Goes ahead of orders waiting for the same seat | Waits its turn |

**Who may build for how many profiles.** A Default subscription supports one
profile, so the choices that build for more than one - **Multiple**, **All
profiles**, **Specific group**, **Select Group**, in manual and sheet mode
alike - need Premium or higher. Everything else is open to every
subscription: sheet mode, a single profile, Generate Immediately and **Order**
(a Default account orders for its one profile, with no row limit).
Administrators are exempt whatever their own subscription. The builder shows
the locked choices greyed out with a *Premium* pill; the server is the real
lock - a run, a quote or a multi-profile preview for more than one profile (or
for all of them) is refused with 403 `subscription-too-low`.

**Sheet mode reads a job tab of your own sheet.** Pick the **Tab** (every tab
is listed, All selected, and one that is not a job tab greyed out with why)
and the rows; *Load rows* shows the jobs found before anything is built, then
**Generate Immediately** or **Order**. The table's **Analysis** column says
what each row's build will do about its analysis, read from the row's
protected **Analysis** cell (column L, beside Job Field and Salary in G and H):
*Skips analysis*, with the job field and salary the row holds, for a row whose
cell names its posting's stored analysis; *When built* for a row whose posting
is analysed the first time a build needs it (or found already stored); *Cell
unreadable* for a cell the program cannot use. The server reads those cells
again itself when the run starts - the page's table is a preview, never
something the server is sent - and trusts one only for the stored analysis it
names (see [Job analysis: once per posting](#job-analysis-once-per-posting)).

**Generate Immediately is tied to its tab.** The first click asks *"If you
close the tab or the network drops, the run can be stopped. Would you like to
proceed?"* (with *Don't show again*, remembered by the browser). While the page
is open it follows the run, with progress and **Stop**, and each finished
resume - resume and cover letter, in the formats the run asked for - downloads
by itself, once. The run's files are also listed under the progress (*This
run's files*), to download again if the browser held one back.

Leaving the page stops the run at once: closing or reloading the tab (the
browser asks first), or leaving Build Resumes inside the app (the page asks
first). Resumes that had not started are refunded, and the one being built is
stopped - and refunded, unless it finished first. A page that could not say
it was leaving - a dropped connection, a laptop that slept, a browser that was
killed - is given `IMMEDIATE_TAB_GRACE_MS` (30 seconds by default): the same
tab reconnecting inside it carries on without downloading anything twice, and
otherwise the run is cancelled the same way. A connection that vanished
without closing - the lid shut, the network gone - is noticed too: the server
ends the run's progress stream every 20 seconds and a page that is still there
attaches again at once, so a tab that does not is counted gone within 20
seconds, and the grace starts then. Back on Build Resumes in the same
tab, the page downloads whatever the stopped run had finished that this tab
had not, while the server still keeps it, and says how the run ended. A
second tab - a duplicated one included - never follows, stops or downloads
another tab's run.

Its files are filed per account under the same tree as an order's - so two
accounts can never write one file - served only to their owner, and **deleted
`IMMEDIATE_FILE_RETENTION_MS` after the run ends** (ten minutes by default),
whether or not they were downloaded: the download is the delivery. A
downloaded resume stays charged either way. An immediate run never appears on
**Orders**, and a request for a resume of one made before asking was removed
is still decided in the queue (see [Refund and payout
requests](#refund-and-payout-requests)).

**An Order answers immediately** with

> You ordered successfully: Order number - `FT-20260920-0007`

and the page is then free. That is the point: three hundred rows is an hour of
work, and holding a browser tab open for it meant a reload part way through left
the files on the server with nothing offering them. The server records what
was asked for and builds it whether or not anybody is watching. It stays free
when you come back, too: reopening **Build Resumes** picks up only a run you
started from that tab - never an order (that is what **Orders** is for), never
another tab's, and never another account's, an administrator's included.
**Cancel** on the receipt, on each live row of **Orders** and on the order
itself stops what is left: resumes not yet started are refunded, and one
already being built is stopped and refunded - unless it finishes first, when it
is delivered and charged. The receipt follows its order, and once the order has
finished it says so and stops offering **Cancel**.

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
of any path an order (or a Generate Immediately run) owns: a fixed template
makes such a path *derivable* rather than merely guessable, and a signed-in-only
check would otherwise hand every account's resumes to anybody with a login. The
question is asked of the path as the server opens it, not as it was typed -
`a//b`, `./a/b` or `x/../a/b`, a symlink, or (on Windows and macOS) another case
of the same name all reach the same file and get the same answer - and a file
counts as the run's from the moment it is written into the run's folder, not
only once its resume is recorded as finished. A path nothing claims is a resume
built by the older synchronous `POST /api/resume/generate`, filed by the
administrator's output template, and is unaffected.

For a page or a script, the queue's contract is:

| Call | What it does |
|---|---|
| `POST /api/generation/batches` | Queues a run. `mode: "immediate"` (the default) or `"order"` (`asOrder: true` is the older spelling); `tabId` names the starting tab of an immediate run. Answers `202 { batchId, kind, total, ... }`, plus `orderId` and `orderNumber` for an order |
| `GET /api/generation/batches/:id/stream?tab=<tabId>` | Progress as NDJSON. The run's own tab, open, is what keeps an immediate run alive |
| `GET /api/generation/batches?active=1&tab=<tabId>` | The immediate runs started from that tab and still going - what a reloaded tab reattaches to |
| `POST /api/generation/batches/:id/release?tab=<tabId>` | Stops an immediate run now. No body, and the session cookie suffices, so a `keepalive` fetch or `sendBeacon` from `pagehide` works |
| `GET /api/generation/batches/:id/tasks/:taskId/:kind` | One file of one finished resume (`resume-pdf`, `resume-docx`, `cover-letter-pdf`, `cover-letter-docx`), to its owner only |
| `POST /api/generation/batches/:id/cancel`, `POST /api/orders/:id/cancel` | Cancels what is left of a run or an order |
| `GET /api/import/tabs` | The tabs of your own job sheet, each with its `layout` (`job`, `blank` or `other` - only an `other` tab is never read), and `defaultTab`: All, or the first tab a job route reads when All is not one. `?sheetId=` may name only your own sheet; any other id is a 404 |

### Where data lives

| Data | Storage |
|------|---------|
| Profiles, groups, custom prompts, edited built-in prompts, app settings, skill library, bid-assistant jobs and answers | SQLite database in `DB_DIR` (default `/data/db/free_tailor.db`) |
| Accounts, live sessions, unused sign-in codes | The same database. Session tokens and codes are stored **hashed**, so a copy of the database yields no usable session |
| Which spreadsheet belongs to an account, and how far it is laid out | The same database, on the account's row: `sheet_layout` (2 once its All and Temp For AI tabs are there) with their gids, `sheet_all_gid` and `sheet_temp_gid` (NULL at layout 2 = a tab of that name was already there and is not a job tab, so it was left alone). Along with them, `sheet_shared_at`, the moment the owner's invitation to their own sheet was confirmed. Recorded once, so sign-in retries the invitation until it works and then stops asking Drive at all; going private still asks live, because that is the one moment a grant revoked in Google's own UI would lock somebody out |
| Orders and what each one built | The same database, in `orders` and `order_items`, deliberately NOT in the generation batch that produced them: a batch is evicted an hour after it settles, so an order built on one would go blank exactly when somebody came back for their files. The file paths live on the item row; the files themselves are on disk under `outputBaseDir`. A Generate Immediately run has a row there too, `kind = 'immediate'`, which **Orders** never lists - it is what files its resumes per account, checks who downloads them, keeps what each was charged for a refund, and tells the sweep when its files are due (`finished_at` + `IMMEDIATE_FILE_RETENTION_MS`) |
| Payments, and every webhook that decided one | The same database, in `payments` and `payment_events`. Separate from the ledger because a ledger row is an accounting fact that is never rewritten, while a payment has a lifecycle. The event payload is kept, redacted: ids, amounts, currencies and statuses survive because a dispute months later is argued from them, while the customer's name, email, address and card details are replaced with `[redacted]` - this application never reads them, and a copy kept for ever in a plain file is a liability rather than evidence |
| Payment provider keys | `.env` only, like every other key in this project |
| Credit ledger and open reservations | The same database, in thousandths of a dollar. The ledger is append-only and `users.balance_milli` is a cache of the sum of its `delta_milli`; a disagreement between the two is reported at startup rather than silently repaired. The whole-credit columns beside them (`users.credits`, `credit_ledger.delta`, `credit_reservations.units`, `payments.credits`...) hold the history from before credits were dollars, and every row written since puts `0` in them |
| AI models and their prices | The same database, in the app settings row: each model's display name, seat, model name, price per resume (`pricePerResumeMilli`, thousandths of a dollar) and description. A run's price is copied onto each of its queued tasks (`costMilli`) when it is submitted |
| API keys | None, anywhere - every AI provider is a subscription seat signed in on the server, in that CLI's own home directory |
| Providers, the analysis model and the contact list | The same database, in app settings: the providers an administrator added or changed (`aiProviders`) and the analysis model (`analysisModelId`) in the settings row beside the models, the contact channels under their own key (`contact`). A built-in provider nobody changed is not stored - it is `.env` |
| Job analyses | The same database, in `job_analyses`: one row per posting, ever, found by its normalised link or its text's hash. Never expired and never overwritten - it is what stops a posting being analysed twice. An account's own job sheet holds a copy in its protected columns, whose Analysis cell is used only as a pointer back to this row |
| Refund requests and personal notices | The same database: `refund_requests` (each request, its state, reason and what moved), and `notifications` - an announcement has no `recipient_id`, a notice for one account names it |
| Tailored answers kept for reuse | The same database, in `tailor_cache`: the model's answer to a tailoring or a cover letter, under a hash of everything it was made from, pruned after `TAILOR_CACHE_DAYS`. Safe to empty - the next build asks the model again |
| The Job Data Lake | The same database: `job_lake` (one row per job, its `job_hash` unique, its job type, clearance and industry, the reward its current version paid and at what rate), `job_lake_history` (each version a later report replaced), `job_reports` (each posting each reporter reported, once, with what became of it the first time - what *Reported before* is decided by) and `job_lake_fts` (the full-text index, kept in step by triggers). The rewards and revokes are ledger rows (`job-report-reward`, `job-report-reward-revoked`). The lake's settings and the admin sheet's id are app settings (`job-lake`, `job-lake.admin-sheet`). The admin sheet itself is a copy - a row whose `sheet_synced_at` is empty has not reached it yet |
| Default prompts (one per feature) | `backend/static/prompts/*.json` |
| Skill library seed (loaded into the database on first run) | `backend/static/skills/skills.json` |
| Built-in resume templates | `backend/static/templates/*.json`, read from the file on every request - so an edited file shows at once, with no import. What an administrator changes about a built-in - its name, description, disabled flag and the layouts it is offered for - is an override row in the database (`template_overrides`) laid over the file, never the file itself |
| Templates an administrator saved - imported from JSON, extracted from a PDF, built in the manual editor | **Files**, in the same `backend/static/templates` directory: `<id>.json` in the shipped shape plus a `"source"` (`uploaded`, `extracted` or `manual`). A file with a `source` is a saved template, editable and deletable on **Admin → Templates**; a file without one is a built-in. Written to a temporary file and renamed into place, so a crash never leaves half a template. They are not gitignored: they show in `git status`, and committing one ships it to every install that pulls |

Nothing under `backend/static` is written to at runtime **except `static/templates`**, which also holds the templates administrators save (`TAILOR_STATIC_DIR` moves the whole directory, seeds and saved templates together). Every other edit made in the admin panel goes to the database. The backend prints the templates directory under `Database:` at startup, and says so if this user cannot write to it.

**Backing up** means two things now: the database file in `DB_DIR`, and `backend/static/templates` (or `$TAILOR_STATIC_DIR/templates`), which holds the saved templates. Copy them together - a profile names its template by id, and a database restored without the template files falls back to `default` for those profiles. A database from a release that kept templates in it still holds its old `templates` rows, which nothing reads.

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
  claude auth status     # must print "loggedIn": true and "authMethod": "claude.ai"
  ```

  On Windows npm installs this as `claude.cmd`, which Node cannot spawn
  directly. The backend reads the shim and runs what it wraps - the package's
  `bin/claude.exe` today, a `cli.js` under an older release - so no extra
  configuration is needed. If that ever fails it says so and asks for
  `AI_CLI_BIN`.

  Two `authMethod`s are the subscription. `claude.ai` is the sign-in
  `claude auth login` saves, and every Claude Code release with `claude auth
  status` (2.1.40 onward - an older one has no such command, so update it)
  prints it for that. `oauth_token` is a token the CLI was handed rather than
  one it saved - what a hosted Claude Code machine prints. Either one counts only
  with no `apiKeySource` printed beside it: until 2.1.286 a Console login -
  an API key the CLI made for itself at `/login`, billed per token - also read
  `claude.ai`, with `"apiKeySource": "/login managed key"` the only sign of it
  (2.1.286 and later call it `api_key`). Anything else means the CLI found an
  API key, or signs in somewhere this app cannot vouch for; the backend says
  so loudly at startup and on the admin Settings page. A call the CLI runs on
  a key anyway is failed, and the seat is held as signed out so no further
  calls are billed.

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
npm install --include=dev
npm install --include=dev --prefix backend
npm install --include=dev --prefix frontend
```

**`--include=dev` is on purpose.** This repository builds and runs from source,
so it needs its devDependencies: `concurrently` at the root (what `npm run dev`
starts both halves with), `typescript` and `ts-node-dev` in the backend,
`tailwindcss` and `typescript` in the frontend. An npm told to leave
devDependencies out - `NODE_ENV=production` in the environment, or `omit=dev`
in its configuration (`npm config get omit` shows it) - leaves them out of a
plain `npm install`, and removes them when they are already there.
`--include=dev` installs them whatever either says; with npm 10 it was measured
to win over `NODE_ENV=production`, `--omit=dev`, `npm_config_omit=dev` and an
`.npmrc` with `omit=dev`. The root's own install is the `npm install` with no
`--prefix`: deleting the root's `node_modules` and re-running only the other
two leaves `concurrently` missing. `npm run dev` checks before it starts and
says so (Troubleshooting, *`npm run dev` stops at once ...*).

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
`cd backend && npm run mail:doctor` checks the SMTP path. **`ADMIN_EMAILS`
decides who administers the installation** (or, when it is unset, the
`SMTP_USER` address): those addresses are administrators from their first
sign-in, and everybody else signs in as a user. Arrival order decides nothing -
on a server anybody can reach, "the first account" is whoever is quickest. Set
it before anybody signs in, or the install has no administrator and says so at
startup.

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

This starts the backend in watch mode and the frontend's dev server on
Turbopack, which compiles each page the first time it is opened and again when
its source changes. For a production-style frontend build use `npm run dev:poll`
or run each side separately:

```bash
cd backend && npm run dev          # http://<server-ip>:3001
cd frontend && npm run dev:turbo   # http://<server-ip>:3000 (dev server, Turbopack)
cd frontend && npm run dev         # http://<server-ip>:3000 (production-style: build, then start)
```

`npm run dev:live` (or `npm run dev:live --prefix frontend` on its own) runs the
frontend on **webpack's** dev server instead. It is kept for anyone who needs
webpack, but it is no longer the default, for a reason you can see: whenever a
new tab of the app connects to it after anything has compiled, it reloads every
other open tab - and a Build Resumes tab that reloads stops the Generate
Immediately run going in it (Troubleshooting, *Opening a second tab of the app
reloads the first one*). `backend/test/e2e/dev-reload.js` reproduces that in a
browser. Against Next 16.1.6 it failed on `dev:live` (the first tab reloaded
both times a second tab opened, and its run was cancelled) and passed on
`dev:turbo` - twice, waiting 10 and then 15 seconds - and on the
production-style `dev`. Against 16.3.8, the Next the frontend pins, it gave the
same answers - `dev:live` failed 4 of its 8 checks the same way, `dev:turbo`
and `dev` passed all 8 - and passed all 8 on the Windows fallback's server
below as well (`next build --webpack`, then `next start`). Every one of those
runs was on Linux.

**On Windows, Turbopack's dev server can crash.** The upstream report,
[vercel/next.js#95015](https://github.com/vercel/next.js/issues/95015), has it
dying natively a moment after *✓ Ready* from 16.3.0-canary.49 on, with exit
code `3221225477` (`0xC0000005`) and nothing printed; it names no release that
fixes it, and whether 16.3.8 still does it has not been tried on Windows here.
When it happens under `npm run dev` (the frontend's `dev:turbo`),
`frontend/scripts/next.mjs` says so and starts the production-style server in
its place, once: `next build --webpack`, then `next start` on the same host and
port. The app is up again, but the page no longer hot-reloads - stop
`npm run dev` and start it again to see a change to the frontend; the backend
still restarts on its own. Only that crash, only in that mode and only on
Windows: everything else ends as it always did. Troubleshooting (*`npm run dev`
... exited with code 3221225477*) has the two ways to pick a mode yourself.
Every start of the frontend also compares the Next it is about to run with
the one `frontend/package.json` pins, and says so when they differ: `[next]
Next.js 16.3.5 is installed, but frontend/package.json pins 16.3.8. Run npm
run install:all.`

The backend prints every address it is reachable on when it starts, followed by
a readiness line for each AI provider. A locked one is reported as locked
rather than probed:

```
[ai] claude-cli: Signed in on a Claude subscription (claude.ai sign-in).
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

### 4. Upgrading

1. **Stop** the backend and the frontend.
2. **Back up** the database file in `DB_DIR` *and* `backend/static/templates`
   (or `$TAILOR_STATIC_DIR/templates`), which holds the templates
   administrators save - see [Where data lives](#where-data-lives).
3. **Pull**: `git pull`. If it refuses to overwrite `frontend/package.json` or
   `frontend/package-lock.json`, Next was moved by hand on this machine
   (`npm i next@...`, `npm audit fix --force`): put the two back with
   `git checkout -- frontend/package.json frontend/package-lock.json`, then
   pull again.
4. **Install**: `npm run install:all`, from the repository root - after every
   pull, since a pull brings `package.json` entries but not the packages.
5. **Build**: `npm run build --prefix backend` and
   `npm run build --prefix frontend`. The two halves ship together.
6. **Start** the backend and read its log.

**The database must have finished upgrading under build `ac3df79`.** This build
carries none of the code that upgraded an older build's database, so before
anything else it checks that every one of those upgrades finished - the data
migrations, the switch of credits to dollars, the move of saved templates into
files, the rename of `users.plan`, the Job Data Lake's job type, clearance and
industry - and refuses a database where one did not, with one line naming each
step that is missing, and exit code 1:

```
[db] The database at /data/db/free_tailor.db has not finished upgrading: its credits were never switched to dollars (schema_meta.credit_unit). Start build ac3df79 once on this database to finish its upgrade, then start this build.
```

Do what it says: start build `ac3df79` once on the same `DB_DIR`, let it finish
starting - it makes those upgrades and logs each one - stop it, and start this
build again.

```bash
git checkout ac3df79
npm run install:all && npm run build --prefix backend
npm start --prefix backend    # once it has started, stop it with Ctrl+C
git checkout -                # back to this build, then install, build and start it
```

When the line says the migrations *wait for an administrator*, the database has
nobody to adopt the profiles made before accounts existed: sign in to
`ac3df79` as an administrator (an address in `ADMIN_EMAILS`) before stopping
it. A database that passes is stamped once (`schema_meta.baseline_build`) and
later starts read only that stamp; one this build creates is stamped as it is
made.

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
working perfectly.

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
- **Each provider has its own queue lane**: the built-in seats' sized by
  `AI_CLI_CONCURRENCY`, `AI_CODEX_CONCURRENCY` and `AI_GEMINI_CONCURRENCY`, an
  added provider's by its own `concurrency_max_requests`. They are counted
  separately; the defaults of 4, 4 and 2 are a fine place to start - Gemini's is
  lower because a Google account has per-minute limits on top of its daily
  quota. A second account of a type is a provider added under **Admin → Models
  → Providers**, signed in as this same service user at its own folder
  (`sudo -u tailor -H env CLAUDE_CONFIG_DIR=/srv/claude-b claude auth login`).

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
├── scripts/                 # checkInstall.mjs, which npm run dev runs first to find packages that are not
│                            #   installed, and installCheck.mjs, its decisions
├── backend/                 # Express API
│   ├── src/
│   │   ├── config/         # .env loading, operational settings table, provider catalog,
│   │   │                   #   each seat's model-name list, static asset paths
│   │   ├── database/       # SQLite connection, schema, repositories, and upgradeGuard.ts - the
│   │   │   │               #   startup check that refuses a database an older build never finished
│   │   │   └── migrations/ # The runner for numbered data migrations (none today)
│   │   ├── routes/         # API routes
│   │   ├── services/
│   │   │   ├── ai/         # Provider-agnostic AI transport
│   │   │   │   ├── providers/cli/        # The shared spawn seam: runner, binary resolution
│   │   │   │   ├── providers/claudeCli/  # The `claude` CLI seat
│   │   │   │   ├── providers/codexCli/   # The `codex` CLI seat
│   │   │   │   └── providers/geminiCli/  # The `gemini` CLI seat
│   │   │   ├── credits/, payments/, refunds/  # Money: the ledger, purchases, refund requests
│   │   │   ├── jobAnalysis/              # The one gate to a job analysis, and the posting identity
│   │   │   ├── jobLake/                  # The Job Data Lake: identity, merge, reporter runs, admin sheet
│   │   │   ├── queue/                    # The generation queue: one lane per provider, tab leases
│   │   │   ├── sheets/                   # Each account's own job sheet, its analysis columns, the job export
│   │   │   ├── resumeService.ts          # Resume/cover-letter domain logic
│   │   │   ├── tailorCache.ts            # Tailorings reused for an unchanged profile, posting and model
│   │   │   └── templateChoice.ts         # The one rule for which template a resume is drawn with
│   │   ├── generators/     # PDF, DOCX, cover letter generation
│   │   ├── middleware/     # Auth, uploads, and publicError.ts - what a failure may tell whom
│   │   ├── scripts/        # The mail and sheets doctors, and the Google sign-in for job sheets
│   │   └── types/          # TypeScript types
│   ├── static/
│   │   ├── prompts/        # Default prompt per feature
│   │   ├── skills/         # Skill library seed
│   │   └── templates/      # Built-in templates, and the templates administrators save
│   └── test/               # node:test suite
│       └── fixtures/       # CLI event streams: cli/ (claude), codex/, gemini/
├── frontend/               # Next.js app
│   ├── scripts/            # next.mjs, which every npm script that runs Next goes through (the root
│   │                       #   .env, the port, the Windows fallback), and nextLaunch.mjs, its decisions
│   └── src/
│       ├── app/            # Pages (/, /orders, /credits, /report, /settings/*, /admin/*,
│       │                   #   /jobs/filter, /bid-assistant, /calendar)
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

**Every queued build - an Order and a Generate Immediately run alike - is
filed under one fixed layout**, a constant rather than a setting:

```
{account}/{date}/{order number}/{profile}/{company}/
├── {profile}.pdf
├── {profile}.docx
├── {profile}_cover_letter.pdf
└── {profile}_cover_letter.docx
```

File names (and the company folder's name) are templated per profile. An
order's number is `FT-YYYYMMDD-NNNN`; a Generate Immediately run gets one of its
own, `FT-RUN-YYYYMMDD-NNNN`, which nobody is shown and which takes nothing out
of the orders' sequence. Its files are deleted `IMMEDIATE_FILE_RETENTION_MS`
after it ends; an order's, after `ORDER_RETENTION_DAYS`.

The output path template in the admin settings, for example
`{profile}/{date}/{company}/{role}/`, now files only resumes built by the older
synchronous `POST /api/resume/generate`, which the builder no longer uses. It
had no account segment, so two accounts with a same-named profile building for
the same company on the same day wrote one file, and either could download it -
the reason builder runs moved onto the order layout.

Not configurable on purpose. These files are listed, downloaded, zipped and
eventually deleted *by path*, minutes or days after they were written - so a layout an
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
| **Accounts** | Every account on the installation, with its role, subscription, balance and profile use. Set a balance outright or add a delta, in dollars to `$0.001`, and read any account's ledger to see where a balance came from. Change any of them, disable an account, end all its sessions, or delete it. The last enabled administrator cannot be demoted, disabled or deleted - account management is admin-only, so that would leave nobody who could undo it - and no administrator can demote, disable or delete the account they are signed in with (another administrator can). Adding an account here sets somebody's subscription and role - User, Reporter or Administrator - before they arrive; it is not a way in, since they still prove the address through Google or a code. A row whose address is in `ADMIN_EMAILS` (or is `SMTP_USER`'s, when `ADMIN_EMAILS` is empty) says so, naming the setting: it can be given another role, but becomes an administrator again at its next sign-in. A **Reporter** row has a **rate per job** (dollars, empty for the global rate) and **Record payout** - the amount paid outside the app and a note saying how, taken off the balance, never more than it; recording one while the reporter has a payout request open closes that request as paid (see [Roles](#roles)) |
| **Profiles** | Create/edit candidate profiles - content, template, Technical Skills layout (Plain or Grouped), the Soft Skills and Strengths switches, prompts, file naming and hard-skill ordering - on a page of their own with the resume drawn live beside the form (see [Editing a profile](#editing-a-profile)). Three ways in: **New Profile**, **Upload Resume PDF** (an AI call reads the PDF), and **Import JSON** (no AI call - the file already is a profile); an upload, and an import that makes exactly one profile, open its editor. Each row shows the profile's template and layout |
| **Profile JSON import** | Takes one profile, a list of them, or `{ "profiles": [ ... ] }` - the shapes `GET /api/profiles/:id` hands out. An import never overwrites a profile you already have: an id that is free is kept, so a backup restored into an empty install keeps the ids its groups reference, and one that is taken gets a new profile instead. A file with one bad entry imports nothing rather than half |
| **Groups** | Group profiles for batch generation |
| **Credentials** | None to manage. Claude Code, Codex and the Gemini CLI run on subscription seats signed in on the server, and the app has no API key anywhere - nor a field to enter one |
| **Providers** (on **Models**) | Every place a seat runs: the built-in provider of each type, configured from `.env`, and any added - a name, a type, a **sign-in folder** on this server (passed to the CLI as `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GEMINI_CLI_HOME`, so it can be another account), optionally its own binary, and its own **concurrency_max_requests** (1-32). Each row shows where each value comes from (this page, `.env`, or the default) and its live state. Paths are checked as they are saved; a provider building something cannot be removed, only switched off - its waiting work moves to another of its type - and a built-in one can only be switched off. See [Several providers of one type](#several-providers-of-one-type) |
| **Models** | Each model an account can pick: a **display name** (required, and the only part of it anybody else sees), a **provider** - Claude (Subscription), Codex (Subscription) or Gemini (Subscription), with a 🔒 on a seat locked here - a **model name** chosen from that provider's own list, which changes with the provider (Sonnet, Opus, Haiku, Fable for Claude; Account default, GPT-6.1-Sol, GPT-6-Astra, GPT-6-Luna and the rest for Codex; Auto, Pro, Flash, Flash-Lite and the Gemini ids for Gemini - each list overridable in `.env`), a **price per resume** in dollars (`0.023`, in steps of `$0.001` from `$0` to `$1,000`, `0` shown as *Free*; required when a model is added, since there is no default), and a description. Every enabled model priced `$0` is listed in red above the table, so a free model is always a decision somebody can see. The list shows each model's provider, model, price and status. A model whose name has since left its provider's list is flagged *Not in model list* and keeps running. **Set Default** refuses a model that cannot run - switched off, on a locked seat, or on a provider switched off - rather than quietly substituting another. One model per provider and model name, and one per display name - compared trimmed and in any case, because the display name is all anybody else sees, and two models sharing one would be identical choices at different prices |
| **AI defaults per profile** | Each profile picks its own model; the builder shows that default and can override it for a single run. Both menus list only the models that can run right now, by display name - no provider, model name, price or lock. A profile whose model has since gone shows *Unavailable model* and runs on the default until the model is back - saving the profile for any other reason keeps the choice - and the server refuses a run, or a profile save that newly picks one, with *That model isn't available* |
| **Templates** | Open to every user and administrator (not reporters) from the sidebar to look at and preview; only an administrator can add, edit, disable or delete one. Nineteen built-in templates - Professional Two-Column, Classic Serif, Developer Mono, Structured Slate, Editorial Italic, Contrast Cards, Charcoal Sidebar, Timeline Bars, Indigo Band, Forest Chips, Slate Italic, Burgundy Rule, Navy Rule, Navy Gold, Amber Gradient, Ink Ledger, Dossier Panel, Framed Serif and Azure Stack - plus manual and uploaded ones. **View** renders any of them with a full sample resume in that template's own page box, read from its `@page` rule, so the preview and the printed PDF agree. Each template declares the Technical Skills layouts it prints (`skillsLayouts`) - Burgundy Rule and Navy Rule are Grouped only - and a profile's picker offers only those that print its layout; see [Templates and the two skills layouts](#templates-and-the-two-skills-layouts) |
| **Prompts** | Edit default prompts or add custom variants per feature, grouped into **Extracting Prompts** (a posting into its analysis, a resume PDF into a profile) and **Building Prompts** (the tailored resume content and the cover letter). The job analysis has exactly one prompt - edit it, there are no variants. Some variables are **required**: `[[jobFieldList]]` and `[[industryList]]` in the analysis prompt, `[[includeStrengths]]`, `[[includeSoftSkills]]` and `[[technicalSkillsLayout]]` in a tailoring prompt. A save that leaves one out is refused in so many words, and a stored prompt without one is marked *Needs update* and never runs - the built-in prompt of its feature runs in its place until it is updated. The line is what a prompt produces, not what it reads. A prompt can pin its own model - a provider and a model name from the same lists as **Models**. Each feature's prompt may use only the variables its code supplies, all listed beside it; a name that is not one of them is refused on save. Admin-only to change, since one edit changes what every account gets; see [Prompts and the section switches](#prompts-and-the-section-switches) |
| **Notifications** | Post a notice to everybody on the installation. It appears in the bell in every account's top bar, with an unread dot until they open it. Editing one corrects the text without marking it unread again, so fixing a typo does not light the dot for people who have already read it. The notices the app writes for one account - a refund request decided - are not listed here and cannot be edited |
| **Payments** | Every purchase, with **Refund** for a card payment, and the **Refund requests** queue: approve, decline with a reason the person will read, or mark refunded - which makes the refund - and, for a reporter's **payout request**, **Record payout**: what was sent, up to the balance, and how (see [Refund and payout requests](#refund-and-payout-requests)) |
| **Job Lake** | The [Job Data Lake](#the-job-data-lake): search it (when it was updated, who reported it, job field, job type, clearance, industry, company, salary, free text), open a job and its history, delete one with or without taking its reward back; **Push to Google Sheet** - the jobs of a search into the *Temp For AI* tab of your own job sheet; **Merge** the jobs builds analysed; set the **global rate per job**, the **duplicate window** (and see whether `.env` or this page decides it) and an optional **daily cap**; open the **admin sheet**, see how many jobs wait to be appended to it and why, and **Retry now** |
| **Google Sheets** | The range importer: read a range of your own job sheet, edit it and write it back. Your own sheet only, and never columns G to L of a job tab, which the app alone writes (*Columns G to L of a job tab are written by the app only*) |
| **Skills** | Maintain the hard/soft skill library |
| **Settings** | One entry in the sidebar covering General, Accounts, Google Sheets, Prompts, Models, Skill Library, Notifications, Payments, Job Lake and Prompt Test, which appear as a second row once you are in it. General holds AI providers, the default model, the **analysis model** (the one model every job posting is analysed on - empty for the default model), output location, the **Contact** list - how people reach you, shown to everybody in *Contact admin* (see [Contacting the administrator](#contacting-the-administrator)) - and a live status card per provider that is not locked - one per sign-in, so a second Claude account has its own (sign-in, in-flight calls, queued and running resumes, any hold, and for Claude the usage window; Gemini's names the signed-in Google account). Each provider row shows what it reports right now. A provider this installation cannot run is marked 🔒 with the reason, and its checkbox is fixed at whatever the operator last chose. Prompt Test shows a posting's analysis - the stored one, or the one made now on the analysis model with the analysis prompt as it stands (a posting is analysed once, so to try an edited prompt, try a posting it has not seen). Every page here shows the cause of a failure under its message |

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

Those settings - the timeouts, size caps, pool widths and model lists that used
to be literals in the code - are defined in one table,
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
| `CREDIT_SIGNUP_GRANT` | What a brand-new account starts with, **in dollars**, to `$0.001`: `5` is `$5`, `0.25` is `$0.25`. `0` by default; above `1000` clamps. A value with more than three decimals warns once and grants nothing |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Web application client id, for Google sign-in |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Sending the emailed sign-in codes. Port 465 is treated as implicit TLS and everything else as STARTTLS; `SMTP_SECURE` overrides that, and `SMTP_FROM` defaults to `SMTP_USER` |
| `SMTP_CONNECTION_TIMEOUT_MS` / `SMTP_SOCKET_TIMEOUT_MS` / `SMTP_MAX_CONNECTIONS` | The pooled SMTP connection: connect and greeting timeout (default `10000`), idle socket timeout (default `20000`) - both range 1000-300000, never 0, because an unbounded wait is a sign-in that never returns - and the pool's width (default `2`, range 1-20). *Startup* |
| `AI_LOCKED_PROVIDERS` / `AI_UNLOCKED_PROVIDERS` | Seats this machine cannot run (`claude-cli`, `codex-cli`, `gemini-cli`), comma separated, and the mirror, which wins. A locked seat's models are offered to nobody, and the default moves to the first seat not locked. A lock is on the TYPE: every provider of it, built-in or added, is locked with it. Nothing is locked by default |
| `AI_REQUEST_TIMEOUT_MS` | The wall-clock deadline of one AI call (default `300000`, range 5000-3600000). The outer bound on every seat - slot wait and CLI process included - so a CLI budget set above it never takes effect, and startup warns when one is |
| `AI_CLI_BIN` | Path to the `claude` binary when it is not on PATH. The built-in Claude provider's; an administrator's value under **Admin → Models → Providers** wins, and an added provider may name its own |
| `AI_CLI_MODEL` | Default model alias (`sonnet`) |
| `AI_CLI_CONCURRENCY` | Simultaneous `claude` processes for the built-in Claude provider, and the size of its queue lane (default `4`). An administrator's `concurrency_max_requests` for it wins; every added provider has its own |
| `AI_CLI_TIMEOUT_MS` / `AI_CLI_TIMEOUT_MS_TAILOR` | Per-call wall-clock budgets, each capped by `AI_REQUEST_TIMEOUT_MS` |
| `AI_CLI_ALLOW_OVERAGE` | Allow calls on the Claude plan's paid extra usage once the subscription window is spent. Off by default. There is no switch for an API key: every seat strips keys from its CLI's environment, always |
| `AI_CLI_EFFORT` | Reasoning effort passed to the `claude` CLI, installation-wide (default `low`). There is no per-run control by design: this is an operational default, not a per-request choice. An unrecognised value warns at startup and falls back |
| `AI_CLI_WORKDIR` / `AI_CODEX_WORKDIR` | The fixed, empty working directory the built-in provider of each CLI runs in. Default `claude-cli-work` / `codex-cli-work` inside `DB_DIR` when `DB_DIR` is set, otherwise `.claude-cli-work` / `.codex-cli-work` in the directory the backend was started from. Each added provider runs in one of its own beside it, `<this directory>-<provider id>` |
| `AI_CLI_HEALTH_TIMEOUT_MS` / `AI_CODEX_HEALTH_TIMEOUT_MS` | Timeout of the seat health checks - `claude --version` and `claude auth status` (default `20000`), `codex login status` (default `15000`) - run at startup and by the admin Settings card. Range 1000-120000. Raise it where a CLI is slow to start |
| `AI_CLI_MAX_OUTPUT_BYTES` / `AI_CODEX_MAX_OUTPUT_BYTES` | Most output one CLI call may produce before it is cut off to protect memory (defaults `25000000` and `8000000`) |
| `AI_CLI_RECOVERY_S` | How long a model the service refused as unavailable is left alone before it is tried again (default `600`) |
| `AI_BATCH_CONCURRENCY` | Ships unset, and should usually stay so: a batch then offers as many items at once as every switched-on provider of the model's type has slots, added together - the built-in one's `.env` value (`AI_CLI_CONCURRENCY`, `AI_CODEX_CONCURRENCY` or `AI_GEMINI_CONCURRENCY`) unless **Admin → Models → Providers** sets one, plus each added provider's own `concurrency_max_requests`. Set, it overrides all of that |
| `AI_CODEX_BIN` | Path to the `codex` binary when it is not on PATH. The built-in Codex provider's, overridable per provider like `AI_CLI_BIN` |
| `AI_CODEX_MODEL` | Default model (`default` means "pass no `-m`" and let the account decide) |
| `AI_CODEX_CONCURRENCY` | Simultaneous `codex` processes for the built-in Codex provider, and the size of its queue lane (default `4`). Counted separately from `AI_CLI_CONCURRENCY`; an administrator's value wins |
| `AI_CODEX_TIMEOUT_MS` / `AI_CODEX_TIMEOUT_MS_TAILOR` | Per-call wall-clock budgets, each capped by `AI_REQUEST_TIMEOUT_MS` |
| `AI_CLI_MODEL_OPTIONS` / `AI_CODEX_MODEL_OPTIONS` / `AI_GEMINI_MODEL_OPTIONS` | The model names **Admin → Models** offers each seat, comma-separated, in the order the form lists them (defaults `sonnet,opus,haiku,fable`, `default,gpt-6.1-sol,gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5` and `auto,pro,flash,flash-lite,gemini-2.5-pro,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.1-pro-preview`). Checked when a model is created or its provider or model name is changed, and when a prompt's model override is saved; a model already saved with a name the list no longer offers keeps running, and the admin list flags it. A list with an entry the seat's CLI would not run as written - for Claude anything but an alias or a full `claude-...` id, for Gemini anything but `auto`, `pro`, `flash`, `flash-lite`, `gemini-...` or `gemma-...` - is ignored with one warning and the default used |
| `AI_GEMINI_BIN` / `AI_GEMINI_MODEL` | Path to the `gemini` binary (default `gemini`, found on PATH) - the built-in Gemini provider's, overridable per provider like `AI_CLI_BIN` - and the model a call uses when nothing names one (default `auto`, which lets the CLI pick Pro or Flash per request). *Startup* |
| `AI_GEMINI_CONCURRENCY` | Simultaneous `gemini` processes for the built-in Gemini provider, and the size of its queue lane (default `2`, range 1-32). An administrator's `concurrency_max_requests` for it wins; every added provider has its own. Lower than the other seats': a Google-account seat has per-minute limits on top of its daily quota. *Startup* |
| `AI_GEMINI_QUEUE_WAIT_MS` / `AI_GEMINI_FIRST_EVENT_MS` | The longest a call waits for a free slot (default `600000`, range 1000-3600000), and the longest a turn may print nothing before it counts as wedged (default `60000`, range 1000-300000 - the first event follows the CLI's token refresh and setup calls). *Startup* |
| `AI_GEMINI_TIMEOUT_MS` / `AI_GEMINI_TIMEOUT_MS_TAILOR` | Per-call wall-clock budgets (defaults `180000` and `300000`, range 5000-3600000), each capped by `AI_REQUEST_TIMEOUT_MS`; startup warns when one is set above it. *Startup* |
| `AI_GEMINI_HEALTH_TIMEOUT_MS` | Timeout of `gemini --version`, the Gemini seat's health check, run at startup and by the admin Settings card (default `15000`, range 1000-120000). The check sends no prompt; it reads the sign-in files instead |
| `AI_GEMINI_MAX_ATTEMPTS` / `AI_GEMINI_MAX_OUTPUT_BYTES` | Attempts the CLI itself makes on a 429 or a 5xx, counting the first (default `3`, range 1-10), and the most output one turn may produce before it is cut off (default `25000000`, range 1000000-500000000 - the CLI echoes the whole prompt before the answer). *Startup* |
| `AI_GEMINI_WORKDIR` / `AI_GEMINI_STATE_DIR` / `AI_GEMINI_HOME` | The built-in Gemini provider's: the fixed, empty working directory its turns run in (default `gemini-cli-work` inside `DB_DIR`, else `.gemini-cli-work` where the backend started); where each turn's system prompt, the deny-all policy and temp files go, outside that directory on purpose (default `gemini-cli-state` beside it); and an optional dedicated sign-in home, passed to the CLI as `GEMINI_CLI_HOME` - the one way to keep an operator's personal `~/.gemini/GEMINI.md` out of every prompt. Sign in with `GEMINI_CLI_HOME` set to the same directory. A folder set for it under **Admin → Models → Providers** wins over `AI_GEMINI_HOME`; an added provider names its own there, and runs in `<work directory>-<provider id>` with its state in `<state directory>-<provider id>`. *Startup* |
| `GENERATION_MAX_ATTEMPTS` | How many times one resume may be built before it is given up on (default `3`, counting the first go; `1` switches retrying off). A retry costs no extra credit. *Startup* |
| `GENERATION_RENDER_CONCURRENCY` | How many resumes the generation queue renders through Chrome at once, across every lane (default `4`, range 1-32). Sized by the machine's memory, one Chrome tab per render. *Startup* |
| `PDF_RENDER_TIMEOUT_MS` | How long one PDF render step, or starting Chrome for it, may take (default `30000`, puppeteer's own; range 5000-300000) |
| `GOOGLE_CREDENTIALS_PATH` | Where to look for Google credentials, overriding the search. Either `google-oauth-credentials.json` (from `npm run sheets:login`) or a service account key. **One set serves everything** - per-account sheets, the Job Filter, Report Jobs, the lake's admin sheet and Push to Google Sheet, the range import and the bid assistant |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | The older name for the same thing, still honoured. Whichever credential is used, **both** the Sheets API and the Drive API must be enabled for its Cloud project |
| `SHEET_TIMEZONE` | IANA zone deciding which day a job row the app writes is dated - and so its NO(DATE) - (e.g. `America/New_York`). Defaults to the server's own |
| `SHEET_DEFAULT_VISIBILITY` | Whether a newly allocated spreadsheet is link-shared: `private` (default) or `public`. `public` means **anyone with the link may edit**. Only that exact string opens a sheet up - anything else resolves to `private` with a warning, because the unsafe value cannot be taken back once a link is out. The account holder's own access comes from a writer grant made at allocation either way, and each account can flip its own sheet under Settings > Job Sheet |
| `SHEET_BACKFILL` | Set to `off` to skip, at startup, allocating a spreadsheet for every account that has none yet; each gets one at its next sign-in instead |
| `SHEET_BACKFILL_PAUSE_MS` | Pause between two accounts in that startup backfill (default `250`, range 0-60000; `0` is no pause) - a throttle against your Cloud project's Drive and Sheets quota |
| `JOB_PAGE_FETCH_TIMEOUT_MS` / `JOB_PAGE_BROWSER_TIMEOUT_MS` / `JOB_PAGE_USER_AGENT` | The Job Filter reading each row's posting: the plain fetch's timeout (default `20000`, range 1000-120000), headless Chrome's page-load timeout for pages that need JavaScript (default `25000`, range 1000-180000), and the User-Agent both send (default in `.env.example`; one line of printable ASCII) - pinned to one Chrome release, so replace it when sites start refusing it |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Card payments through Stripe, with the form embedded in the buy page. All three are needed or the method is not offered: the publishable key is what the form mounts with, and the API serves it to the page so no frontend rebuild is needed to change it. The secret and publishable keys are on the dashboard's API keys page; the webhook secret is not - it comes from the webhook endpoint, or from `stripe listen`. The endpoint is `/api/payments/webhook/stripe` |
| `CRYPTOMUS_MERCHANT_ID` / `CRYPTOMUS_PAYMENT_API_KEY` | Crypto through Cryptomus, on its hosted invoice page. Both are needed or the method is not offered. The payment API key does double duty: it signs outgoing requests **and** is what every incoming callback is verified against, so there is no separate webhook secret. The endpoint is `/api/payments/webhook/cryptomus` |
| `CRYPTOMUS_INVOICE_LIFETIME_S` | How long a buyer has to pay a Cryptomus invoice (default `3600`; range 300-43200, Cryptomus's documented one, never checked against the live API from here) |
| `CRYPTOMUS_CALLBACK_URL` | Optional. Sends the callback address per invoice instead of relying on the one set in the Cryptomus dashboard. Must be this server's API, reachable from the internet. Left empty the field is omitted entirely - sending it blank would override the dashboard with nothing |
| `PAYMENTS_RETURN_URL` | Where a provider sends the browser back to after paying. Must be the frontend, not the API. Unset, it is `APP_URL`, then the first `FRONTEND_URL`, then the origin the buyer's own browser is on |
| `ORDER_RETENTION_DAYS` | How long an order's resumes are kept before the server deletes them (default `5`). Stamped on each order when it is placed, so a change applies to new orders only. `0` deletes on the next sweep |
| `ORDER_RETENTION_SWEEP_MS` | How often that sweep runs, besides once at startup (default `21600000`, six hours; range 60000-86400000). *Startup* |
| `IMMEDIATE_TAB_GRACE_MS` | How long a **Generate Immediately** run outlives a page that went without saying so: when the run's tab stops following it (network gone, laptop asleep, browser killed), the run is cancelled after this long unless that tab reconnects - a short drop loses nothing. A connection that vanished without closing is counted gone within 20 s first (the server ends the run's stream every 20 s and a live page attaches again), so such a run stops within this plus 20 s. Resumes that had not started are refunded (default `30000`; range 5000-600000). A page that is closed, reloaded or left stops its run at once instead |
| `IMMEDIATE_FILE_RETENTION_MS` | How long a Generate Immediately run's files stay on the server after the run ends, **downloaded or not** - the page downloads each resume as it lands, so the server copy only has to outlive that download (default `600000`, ten minutes; range 60000-86400000). Checked every minute. The resumes stay charged, and the run is never listed on **Orders** |
| `TAILOR_CACHE_DAYS` | How long a tailored resume and a cover letter are kept for reuse (default `30`, range 1-3650): generating again for the same unchanged profile, posting, model and prompt reuses them with no model call, and the resume is charged as usual. Pruned at startup and daily - see [The tailoring cache](#the-tailoring-cache) |
| `JOB_LAKE_DUPLICATE_WINDOW_DAYS` | The [Job Data Lake](#the-job-data-lake)'s duplicate window: a job reported again while its lake row was added or last replaced within this many days is a **duplicate** (red in the reporter's sheet, not paid); after it, the new report **replaces** the row and counts as added (default `60`, two months; range 1-3650). An administrator's value on **Admin → Job Lake** wins over this one, and that page says which is in effect |
| `JOB_LAKE_PUSH_MAX_ROWS` | The most jobs one **Push to Google Sheet** on **Admin → Job Lake** writes into the pushing administrator's own *Temp For AI* tab, newest first (default `1000`, range 1-5000). A filter that matches more is cut at this many, and the page says so |
| `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | The Chrome to print with, overriding puppeteer's download and any installed browser. `PUPPETEER_EXECUTABLE_PATH` wins when both are set. Honoured even when the file is missing, which startup reports |
| `TAILOR_STATIC_DIR` | Where the shipped seeds - default prompts, skill library, built-in templates - are read from, instead of `backend/static`. For tests and packaging. Nothing is written there except `templates/`, where the templates administrators save are kept beside the built-ins, so it must be writable for those and backed up with the database |
| `SMTP_USER` | Also the administrator's address when `ADMIN_EMAILS` is unset. Ignored for that purpose when it is a bare username rather than an email |

See `.env.example` for the full `AI_CLI_*` and `AI_CODEX_*` lists.

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
| Resumes sit *queued* and never start, and the backend log says `[queue] Work for claude-cli is waiting: no provider of that type can take work now - each is held, signed out or switched off` | Every provider of that model's type is out of service: its seat is held after a refusal (a spent usage window, a sign-in the CLI rejected), its last health check found it signed out or its binary missing, or an administrator switched it off. The work waits rather than failing into the hold, and starts on its own when a provider can take it - the log then says `A claude-cli provider can take work again`. Open **Admin → Settings**: each provider has its own card with the reason. Sign the one that is out back in **at its own folder** (`CLAUDE_CONFIG_DIR=<folder> claude auth login`, `CODEX_HOME=<folder> codex login --device-auth`, `GEMINI_CLI_HOME=<folder> NO_BROWSER=true gemini`) and reload that page - its fresh check lifts a sign-in hold - or add or switch on another provider of the type under **Admin → Models → Providers**. To stop waiting instead, cancel the run (an Order on **Orders**, Generate Immediately with **Stop**): what had not started is refunded. |
| One provider's card under **Admin → Settings** says *The Claude CLI is installed but not signed in* (or *Not ready*, *Signed out*, *Usage limit reached* under **Admin → Models → Providers**) while another of its type says *Ready*; or the log says `[ai] Holding off the Claude provider "<label>" for about N minute(s): ...` (`the Codex provider`, `the Gemini provider`) - and resumes still build, only fewer at once | That provider is out on its own, and nothing else is: its **waiting** resumes moved to the other providers of its type and new ones go there, so the run carries on at their width. A resume it was building when its CLI refused the sign-in fails with *AI generation isn't available right now. Please contact your administrator.* - a sign-in refusal is not retried - so generate that one again; a usage-limit hold ends on its own. To bring a signed-out provider back, sign it in at **its own** folder (shown under **Admin → Models → Providers**, and in the card's own advice), as the server's user: `CLAUDE_CONFIG_DIR=<folder> claude auth login`, `CODEX_HOME=<folder> codex login --device-auth` or `GEMINI_CLI_HOME=<folder> NO_BROWSER=true gemini`. The bare command signs in the server's default folder, which is the built-in provider's. Then reload **Admin → Settings**: its fresh check lifts a sign-in hold. Or switch the provider off until it is fixed. |
| Adding a provider under **Admin → Models → Providers** is refused: *must be an absolute path*, *does not exist on this server*, *is not executable by the user this server runs as*, *is inside ..., one of this app's own directories*, or *"..." already signs in at ...* | Each is the check it names. Paths are the SERVER's, absolute (`/srv/claude-b`, not `~/claude-b`), and must exist before the provider is added - create the folder and sign the CLI in there first, as the user the server runs as. A sign-in folder or binary inside the checkout, `DB_DIR`, the static directory or the output directory is refused so nothing the app writes, serves or deletes can reach it. Two providers of one type at one folder would be one account with two limits, so the second is refused; for the built-in provider with no folder set, that folder is the CLI's own default (`~/.claude`, `~/.codex`, or the home directory for Gemini). |
| A provider added at an empty sign-in folder reports *Signed in* before anybody signed in there, or two providers of one type report the same account | The CLI found a sign-in outside the folder it was given - a wrapper script in front of the binary, a managed or system-wide sign-in, or a key or token the CLI reads from somewhere the app's environment strip cannot reach - so both providers are really one account with two limits. Run the check by hand as the service user, with only that folder set (`env -i PATH="$PATH" HOME=<folder> CLAUDE_CONFIG_DIR=<folder> claude auth status`; `CODEX_HOME` for Codex, `GEMINI_CLI_HOME` for Gemini): it should say signed out until you sign in there. Point the provider at a binary that keeps its sign-in in that folder (its own **binary** field), or remove the sign-in the CLI is finding instead. |
| Removing a provider answers *This provider is building N resume(s) right now* | It is building those with its sign-in at this moment. Switch it **off** instead: nothing new reaches it, its waiting resumes move to another provider of its type at once, and what it is building finishes; remove it when its card shows nothing running. A built-in provider (`claude-cli`, `codex-cli`, `gemini-cli`) cannot be removed at all - only switched off - because every stored model names its type. |
| Generating a resume again came back exactly as before, and the log says `Tailoring reused from the cache, no model call` | The tailoring cache: the same profile, posting, model and tailoring prompt as last time - and the same skills checklist from the shared library - so the stored answer was reused, and the resume charged as usual. Change any of them (an edit to the profile, another model, an edited prompt, a library skill the posting names) and the model is asked afresh. An answer a fallback model wrote is never kept (`[tailor-cache] Not keeping this tailoring: it was written by ...`), so a repeat of that one asks again. Answers are kept `TAILOR_CACHE_DAYS` (30 days by default); to empty the cache, `DELETE FROM tailor_cache;` with the server stopped. |
| Somebody editing their job sheet gets Google's *You are trying to edit a protected cell or object* on the **Job Field** to **Analysis** columns | Working as intended: those six columns are written by the program alone, so a build can trust what they say and skip analysing the row again (see [Job analysis: once per posting](#job-analysis-once-per-posting)). Everything else in the row stays editable. To get a row analysed afresh there is nothing to clear - a posting is analysed once, ever; a different posting needs a different link or text. |
| The backend log says `[sheets] The analysis columns of "<tab>" in <spreadsheet> were not protected` (or *protected wrongly*) *... restoring the protection ... and clearing the Analysis cells somebody else could have written meanwhile* | The protection over the six analysis columns (G to L) was missing - an empty tab being laid out as a job tab, which is normal once, or a job tab somebody headed by hand - or somebody with the owner's account removed or changed it. It is put back on the spot, and the **Analysis** column (L, only it) is emptied in the same step, since anybody with the link could have typed into it meanwhile. Nothing is lost: every analysis is in the database, so those rows are read from it, or analysed once, and their cells are written again on each row's next run. If it repeats on every run for the same tab, somebody is removing it: with `npm run sheets:login` that can only be the operator's own Google account. |
| The log says `[sheets] Could not check the protection of the analysis columns ...` or `Google did not say which account this server's sign-in belongs to` | The server could not learn its own Google identity, which a protection must name as its only editor. With a `sheets:login` credential that is asked of Drive, so the **Drive API** must be enabled for the credential's project - `npm run sheets:doctor` in `backend/` checks it. Until it works, sheet runs still build, but they ignore the analysis cells and analyse from the database. |
| The log says `[analysis] Sheet row N's Analysis cell is cut short` (or *unreadable*) *; falling back to the store* | The cell holds more than Google's 50,000 characters, or is not the program's JSON - an old cell, or a paste from before the column was protected. The row's posting is read from the database instead (the cell still names its stored analysis when only its end was cut), and analysed once if the database has never seen it. Nothing is lost; a cell the program wrote for the row's own posting is not rewritten. |
| The log says `[sheets] Google answered 429 (quota) to ...; retry n of 5 in ...ms`, or a page says *Google Sheets is busy right now* | Google's per-minute Sheets quota is per project and per user, and every account of this install is the same user - the server's one credential - so a big filter run, a few sheet orders and their write-backs share one budget. A 429 is waited out with growing, randomised delays (and Google's own `Retry-After`), up to five times and 32 s a wait; only then is it reported. If it keeps reaching people, raise the Sheets quota in the credential's Cloud project, or run fewer sheet jobs at once. |
| **Load rows** on a sheet answers *Google Sheets could not complete that request. Check the sheet and the rows you chose, or contact your administrator.*, and an administrator's detail under it quotes Google's `... exceeds grid limits. Max rows: 1000, max columns: 12` | The rows asked for run past the end of the tab. A Google tab has a fixed number of rows and columns - a tab this app makes starts with 1,000 rows - and Google refuses a range that reaches beyond them rather than returning blank cells. Choose a **To** row no higher than the tab's last row, or add rows to the tab in Google. **Report Jobs** stops at the tab's last row by itself. Columns are the app's business: a job tab somebody headed by hand narrower than twelve columns is widened to twelve the next time the app checks it - until then the builder's **Analysis** column says *When built* for its rows. |
| The log says `[ai] The analysis model "<id>" cannot run ...; job postings are analysed on the app default model` | The model chosen as the **analysis model** under **Admin → Settings → General** is switched off, deleted, or on a provider that is switched off or locked here. Postings are analysed on the default model meanwhile. Choose a model that runs - or leave the field empty for the default - and save. |
| Every new posting comes back **Unclassified** | A posting that fits none of the job fields is Unclassified by design; when every one is, the Analyze Job Description prompt's text is fighting the list - an instruction to return exactly some other JSON shape, say. Compare it with the shipped text, `backend/static/prompts/analyze-job-description.json` (there is no reset button), and paste that over it. A prompt that does not use `[[jobFieldList]]` and `[[industryList]]` at all is not the cause: it is marked *Needs update* and never runs, and the shipped prompt runs in its place (see *Needs update* below). Only postings analysed from then on are affected: a stored analysis is never redone. |
| The builder's sheet table said *Skips analysis* for a row, but the run analysed its posting anyway (or used the database's analysis instead of the row's) | The table reads the row's **Analysis** cell as the page loaded it; the run reads it again on the server and trusts it only when the tab's protection is found intact in that run. When it had to be put back (the log says `... were not protected ... restoring the protection` and `Sheet row N's Analysis cell is not used: the protection of "<tab>" was not confirmed intact`), the Analysis column was cleared with it, the row is read from the database, or analysed once if it never was, and its cell is written again. A cell left by another posting - the row's posting was replaced, or rows sorted (`was not written for the posting in the row now`) - is not used either, and is written over with the right one. A Job Description that ends *...[cut at 50,000 characters]* (Push to Google Sheet writes a longer one so) is read as its posting only exactly as it was cut: edit it and it is another posting, analysed once (the same line, saying *its Job Description, cut at 50,000 characters, is not that analysis's posting as it was cut (edited since)*). A row moved or sorted since loading (`no longer matches`) is neither read nor written. |
| A row's Analysis cell is filled, yet its posting was found in the database or analysed again and the cell rewritten, and the log says `[analysis] Sheet row N's Analysis cell names an analysis this store does not have (<id>); it is ignored, the posting is found in the store or analysed once, and the cell is replaced.` | The cell names a stored analysis this database does not hold - copied from another install's sheet, left from a database restored from an older backup, or never written by the program. A cell is only ever a pointer into the database, never an analysis in itself, so the row is treated as if it were empty: its posting is found in the database (by link or text) or analysed once, and its six cells are written again. The Build Resumes table reads only the cell's shape and cannot tell; it says *Skips analysis* for such a row. |
| The log says `[analysis] Stored analysis <id> is not readable; it is treated as absent` | A row of the `job_analyses` table holds analysis JSON the program cannot read - a hand edit, or a backup restored part way. The program only ever writes whole JSON objects. The next request for that posting analyses it once more and writes the answer into the same row (`... could not be read; the new analysis of its posting replaces it`); from then on it is read like any other. One extra analysis per damaged row, not one per request; nothing needs doing. |
| The log says `[sheets] "<tab>" in <spreadsheet> is not laid out as a job tab (a tab of the person's own); its columns are left as they are` | A build ran on a tab that is not a job tab: its first row does not start with *Date, NO(DATE), Company, Job Title, Job Link, Job Description*, and it is not empty. Nothing in it is re-headered, protected, read as an analysis or written, and its postings are found in the database or analysed once. The builder offers only job tabs, so this is a tab whose first row changed after the page listed the tabs, or a request made by hand. Build from **All** or **Temp For AI**. |
| **Settings → Job Sheet** says *Your job sheet already has a tab named "All" that is not laid out as a job tab, so it was left exactly as it is.* (or *"Temp For AI"*, or both) | The sheet already had a tab of that name - one of the person's own, or a tab with data under an empty first row - so the app did not take it over and has no **All** (or **Temp For AI**) of its own: the job pages list that tab greyed out as *All (not a job tab)* and start on the first job tab instead, the note under their tab select says to rename or delete it before copying old jobs into All (rather than to copy them into it, where nothing would read them), and the log says `[sheets] <spreadsheet> already has a tab named "All" that is not a job tab`. Rename or delete that tab in Google Sheets, then reload **Settings → Job Sheet**: that page - and only that page, so the clash costs no Google reads on every other page load - looks again and the app adds its own tab, first (**All**) or second (**Temp For AI**). Until then the other pages go on saying what was recorded. An EMPTY tab of that name is simply taken over. |
| The **Tab** select on Build Resumes says *No job tab to read* (the Job Filter: *No job tab to filter*, Report Jobs: *No job tab to report from*), with every tab of the sheet listed greyed out | No tab of the sheet is a job tab: the app's **All** and **Temp For AI** are not there - their names are taken by tabs of the person's own (Settings → Job Sheet says so, see the row above), they were deleted or renamed in Google Sheets, or the sheet has not been laid out yet - and every other tab is one of the person's own. Open **Settings → Job Sheet**: it lays the sheet out and puts back a deleted tab (or says which name to free), then reload the page. An empty tab added in Google Sheets also works: it is offered, and laid out the first time it is used. |
| **Your job sheet** (the account menu, Report Jobs, Find Jobs, the Job Filter) opens the spreadsheet but not on **All**, and the tab selects start on **Temp For AI** with no All listed - a page left open from before says *Google Sheets could not complete that request. Check the sheet and the rows you chose, or contact your administrator.* when it reads All | **All** was deleted or renamed in Google Sheets. Every page but one links to the tabs as they were recorded, so they point at the tab that is gone; only **Settings → Job Sheet** looks at the tabs again each time it loads (Push to Google Sheet does too). Open **Settings → Job Sheet**: it puts All back, first, and every link follows from then on - the way back for anybody, a reporter included. The same goes for **Temp For AI**. A renamed All keeps its rows and stays a job tab under its new name; the new All starts empty. |
| **Admin → Google Sheets** refuses a write: *Columns G to L of a job tab are written by the app only (Job Field, Salary, Job Type, Clearance, Industry, Analysis). Choose a range within columns A to F.* - or *Columns K to P of "<tab>" are the app's protected analysis columns, written by the app only. Choose a range outside them.* (409 `protected-columns`) | The range reaches into the protected analysis columns of a job tab, or into any columns the app's own protection covers on that tab - an older build's daily tab keeps its **K to P**, and a tab whose first row was changed (so it no longer reads as a job tab) keeps its **G to L**. The server's Google identity is the only editor the protection lets through, so a write from the range importer is the one write a person could make into those cells. Those six cells are the program's: an **Analysis** cell written there could at most name a stored analysis, which a build uses only when it is that row's posting, and Job Field to Industry would just show something false. It is decided on the protection, not on the first row, which anybody may change and change back. Write A to F (or columns past the protected ones, or a tab the app never protected); the analysis columns fill themselves from each row's analysis. The importer also reads and writes only the administrator's own sheet now: any other spreadsheet id - another account's, or a sheet saved under an older build - is *That spreadsheet was not found.* |
| A reporter's run says *the sheet was not updated*, or a duplicate's row is not red, or a row's analysis columns stay empty after a run | Either its posting could not be analysed this time - the run's row says *Failed* with the reason and a `Ref:`: *AI generation isn't available right now. Please contact your administrator.* (a seat signed out, not installed, locked or held - see the seat rows above), *AI generation is busy right now. Please try again in a few minutes.* (a usage limit; wait), *The AI request failed. Please try again.* or *The request took too long and was cancelled.*, or, for any other failure, *The job could not be analysed. Please try again, or contact your administrator.* (or *The job could not be added to the lake*); an administrator finds the cause in the backend log under that `Ref:` - or the sheet could not be written: the log has `[lake] Report run rep_...: the duplicates of "<tab>" could not be painted` or `[sheets] Could not write the analysis of N row(s) back` (Google refused or was busy), or `Row N of "<tab>" ... no longer holds <company> (rows were sorted or deleted since); it is not painted`. Nothing is lost either way: the job is in the lake and paid if it was added, and running the same rows again finds the posting reported before - no model call, no second reward - fills its analysis columns and paints it if it was a duplicate. The run no longer writes a *Lake Status* or *Job Hash* into the row: there are no such columns now - each row's outcome is on the page. |
| **Report Jobs** says *The server restarted while this run was going, so its progress is gone.* | Runs are kept in the server's memory while they go (and for an hour after, so the page can show the last one), and the backend was restarted - by an operator, a crash, a deploy - in the middle of one. Nothing it did is lost: every job it added is in the lake and was paid, in the same transaction. Pick the same tab and rows and run them again: every row the lost run reported is *Reported before* - skipped, no model call, no second reward, painted red again if it was a duplicate - and the rest are reported. |
| **Report Jobs** says *"My notes" is not laid out as a job sheet tab, so it cannot be reported from. Choose All or Temp For AI, or an empty tab, which is laid out as one the first time it is used.* (with the tab's own name); the **Job Filter** says the same with *cannot be filtered* (409 `not-job-tab`) | The tab chosen is not a job tab: one the person made for themselves (notes, a list of their own) or a tab with data under an empty first row - its first row is not *Date, NO(DATE), Company, Job Title, Job Link, Job Description*. The program will not read it, protect it or write into it. The pages list such a tab greyed out and will not pick it - except a tab with data under an empty first row, which only the server can tell from an empty one - so this is said for that tab, for a tab whose first row changed after the page listed the tabs (reload it), or for a request made by hand. Choose **All** or **Temp For AI**; a job listed elsewhere has to be copied into one first. |
| A reported row is painted red and says *Duplicate* | The job lake already had that job - the same company (compared without case, punctuation, spaces or a legal suffix) in the same job field - added or last replaced within the duplicate window (60 days unless Admin → Job Lake or `JOB_LAKE_DUPLICATE_WINDOW_DAYS` says otherwise). That is the rule, not a fault: a duplicate is not paid. The same posting twice in one run is a duplicate the second time, and another reporter's copy of a posting is a duplicate too. A row whose posting was a duplicate the first time is painted red again by every later run over it (*Reported before (Duplicate)*). After the window, the same job reported again - another posting of it, or by somebody else - **replaces** the old one and is paid. |
| A row a new posting was pasted into still shows the old posting's **Job Field**, **Salary** or **Analysis** | The six analysis columns are protected - only the program writes them - so pasting a new job over Company to Job Description leaves the old job's cells beside it. That is expected, and nothing is lost: **Preview rows** shows such a row as *To add*, and the next report run (or a build from the row) sees the **Analysis** cell is not the new posting's, reports the new one and rewrites all six cells. Whether a row was reported is never read from the sheet: it is the database's record of the posting. |
| A reporter's row says *Reported before (Added)* - or *(Duplicate)*, *(Replaced)*, *(Unclassified)* - and is skipped, though it was never reported from that row or tab | The same reporter reported the same posting before - same link (tracking and `#fragment` aside) or same text - from another row, another tab, or this row before it was sorted or moved; in brackets is what became of it then. A posting is reported, paid and counted once per reporter, wherever it is pasted. For *(Added)*, *(Replaced)* or *(Duplicate)*, to have it reported again an administrator deletes the job on **Admin → Job Lake** (Details, Delete), which forgets every report that reached it. An *(Unclassified)* posting reached no job in the lake, so there is nothing to delete and it stays *Reported before*: its analysis is final, and reported again it would be unclassified again. A row whose company was missing is not remembered, and is reported once the company is filled in. |
| On **Admin → Job Lake** a job's **Job Type** or **Industry** is blank (a dash in the table; **Details** says *Not stated*) | That is what the posting gave: no remote, hybrid or on-site arrangement stated, or nothing to tell its industry by. A posting analysed before industries existed gets one from its company category or its own industry word when it has one, worked out each time it is read; it is never sent to a model again for it. **Clearance** is never blank: *Not required* unless the posting asks for one - an unfamiliar clearance word included. |
| A reported row says *Skipped* | It could not be reported this time: the row has no company, or no job description long enough to read a job field from. Fill it in and run the rows again - *Skipped* rows are tried again, unlike *Added*, *Replaced*, *Duplicate* and *Unclassified* ones. |
| A reporter added jobs but earned `$0` | The global rate is still `$0` (Admin → Job Lake shows *not set*) and the reporter has no rate of their own, or the **daily cap** was reached (the job is added, the reward stops at the cap until the next UTC day), or the account is not a Reporter - an administrator reporting is never paid. Each lake row records the rate in effect when it was added. |
| **Admin → Job Lake** says jobs are waiting for the admin sheet, or the log says `[lake] Could not append to the admin sheet` | The jobs are in the database - the sheet is a copy appended after them, and a failed append never undoes one. Under *Why the last attempt failed* the page shows the sentence and, on the line under it, Google's own reason: *Google Sheets is not configured on this server* means the server has no Google credential (see [The job sheet](#the-job-sheet)); *Google Sheets is busy right now*, over a Google 429, means the shared Sheets quota ran out even after backing off - **Retry now** later; *That spreadsheet or tab could not be found*, over a Google 404, means the spreadsheet was deleted in Google - use **Create a new admin sheet**, which sends it the whole lake (pressed while a sync is sending, that sync stops and starts again on the new sheet). Each sync also runs after the next report run or merge, and at startup. An administrator who cannot open the sheet was disabled when it was shared, or was appointed after the last sync - **Retry now** shares it with them. |
| The **Merge** tab does not offer a job a build analysed | It offers only analyses with a job field from the list and a company on record, not merged before. An *Unclassified* posting is never offered; one analysed with no company named - the builder's analysis names none, so a posting that was only previewed has none - is offered once a build, a job filter run or a report names its company; and a posting a reporter already reported is merged already. |
| **Push to Google Sheet** answers *A push to your Temp For AI tab is already going. Wait for it to finish first.* | One push per administrator runs at a time (409 `push-in-progress`), kept in the server's memory; another administrator's push is not held up. Wait for the first to finish - the largest push writes its rows 200 at a time - then push again. A restart forgets a push in progress: the tab holds what it had written so far, and the next push replaces it whole. |
| **Push to Google Sheet** answers *"Temp For AI" in your job sheet is not laid out as a job tab any more (its first row is not the job header), so nothing was pushed into it. Rename or delete that tab in Google Sheets, then push again: a new Temp For AI tab is added.* | Row 1 of the tab was changed - a push replaces only a job tab, so one whose header was edited, or that was filled with something else, is left exactly as it is (409 `not-job-tab`). Rename or delete it in Google Sheets and push again: the push puts a fresh Temp For AI back first. |
| **Push to Google Sheet** answers *Your job sheet already has a tab named "Temp For AI" that is not laid out as a job tab, so it was left exactly as it is. Rename or delete it in Google Sheets, then push again.* | The sheet had a tab of the person's own by that name before the app could add its own (409 `tab-name-clash`; **Settings → Job Sheet** says the same), and a push never writes into a tab the app did not lay out. Rename or delete that tab and push again: the app adds its own Temp For AI first. |
| **Push to Google Sheet** is greyed out, and pointing at it says *Wait for the search to finish first.* or *The lake could not be read, so there is no search to push.* | A push sends the filters of the search on the page, and its confirm names how many jobs go from that search's own answer, so it waits for that answer. Press **Search** - or **Try again** under the error - and wait for the table. *A push is going.* means the last press is still running. |
| A push says *Pushed the newest N of the M jobs these filters match ... the older K were left out* (or *the oldest was left out*) | A push writes at most `JOB_LAKE_PUSH_MAX_ROWS` jobs (1000 by default, 5000 at most), newest first, and its confirm says so before it starts. Narrow the filters - **Updated from** and **Updated to**, for one - and push again, or raise the setting in `.env` and restart. |
| Rows or notes typed into **Temp For AI** are gone after a push | By design: a push replaces the tab - every row under its header is emptied in columns A to L, a duplicate's red paint included, before the jobs are written, and the confirm says so. Columns past L and every other tab are left alone. Keep rows of your own in All, or in a tab of your own. |
| A build fails with *That job analysis was not found. Analyse the job description again.* | The page sent the id of an analysis this server has not stored - a page left open across a database restore, or a request made by hand. Analyse the description again (the builder does it when you press Generate), which finds the posting if it is stored or analyses it once. |
| Every page but Report Jobs, Credits and Settings sends somebody to Report Jobs, or a request answers *That part of the app is not available for your account. Ask your administrator if you need it.* (403 `role-not-allowed`) | The account's role is **Reporter**, and that is what a reporter is: no resume builder, profiles, orders, templates or buying credits (see [Roles](#roles)). If they should build resumes, an administrator changes the role to User on **Admin → Accounts**; it takes effect on their next request, and their open page catches up when it reloads. Nothing they owned before was deleted. (The other way round - a user made a reporter while their page is open - their next request is refused, and the page takes them to Report Jobs by itself.) |
| A reporter's account menu has no **Your job sheet**, and **Report Jobs** says *Job sheets are not set up on this server yet. An administrator has to connect Google Sheets before jobs can be reported.* (or that their job sheet could not be reached, with a `Ref:`); **Settings → Job Sheet** ends the same sentence *...before this page can show you one.* | The link is their own spreadsheet, and there is none to link: the server has no Google credential, or allocating their sheet failed. It is the same cause as a user with no **Find Jobs** row - see [The job sheet](#the-job-sheet) to set Google up, and an administrator finds a failure's cause under its `Ref:` in the backend log. The link appears by itself once **Settings → Job Sheet** shows a sheet. |
| An administrator made somebody a User or Reporter, and they are an administrator again | Their address is in `ADMIN_EMAILS` (or, with that unset, it is the `SMTP_USER` address). Those are promoted at every sign-in and every start, and never demoted, so a slip on the Accounts page cannot lock the operator out - the row and the change's own message say so. Take the address out of `ADMIN_EMAILS`, restart the backend, then change the role. |
| **Record payout** (on Admin → Accounts, or on a payout request in the refund queue) answers *That is more than this reporter's balance of $X. Record what was actually paid, up to the balance.* | A payout records money already paid outside the app, and is never more than the balance: it is refused rather than cut down, because a record saying less was paid than was is wrong. If more really was paid, the balance was short first - read the reporter's **History** on Admin → Accounts, and add the missing earnings with the **+/-** button beside the balance (add or take away credit, with a note) before recording the payout. *Only a reporter is paid out* means the account is not a Reporter; use the **+/-** button for anybody else. |
| **Record payout** on a payout request answers *That account is no longer a reporter, so no payout can be recorded against its balance. Decline the request instead.* (or *That account no longer exists ...*) | The reporter was made a user or an administrator, or deleted, after asking. Nothing was recorded and the request is still open: decline it with a reason. If they are to be paid anyway, make them a Reporter again first. |
| A reporter's **Ask for Refund** is greyed out | It asks for the whole earned balance, so it is offered only with something on the balance (`$0` has nothing to pay out) and only while no payout request of theirs is open - one at a time. The button's tooltip, and the line under it, say which; the open request is listed under it, and an administrator answers it in **Admin → Payments → Refund requests**. |
| Credit History shows `$0.050` on an older row and `$0.05` on a newer one | Amounts are shown without trailing zeros now (`$1`, not `$1.000`). A note written into a history row is stored as text and keeps the figure it was written with; the amount column beside it is always the new format. |
| An uploaded template still prints a **Strengths** or **Soft Skills** heading with the section switched off | The section is found by the `section-strengths` / `section-soft-skills` class, a `data-section="strengths"` / `"softSkills"` attribute, or - for markup with neither - from where the list is printed (`{{#each strengths}}`, `{{join softSkills ", "}}`): an element around it that holds the section and nothing else - no other data, no text, no picture - or the heading element before the list's container, past a divider (`<hr>`, an empty box) or a line break. A heading that is bare text beside other data, sits inside a `{{#if}}` of its own before the list, or has a picture or a line of text between it and the list is not found, and one in an element that also holds a photo or static text is taken without that element. Put the class or the attribute on the element that holds the heading and the list (not on the list alone), and the section goes whole. |
| The backend logs `[templates] Template "<id>" does not compile with its Strengths / Soft Skills section found from the list, ...` or `... section removed, so it is drawn with both sections in place ...` | Finding the section would have cut through a Handlebars block - typically an `{{#if}}` or `{{#each}}` that opens inside the section's element and closes after it (`<div class="section-strengths">{{#if summary}}...</div>{{/if}}`), which Handlebars accepts and the cut cannot. Rather than fail every resume on the template, it is drawn with less found: only the class- or `data-section`-marked section, or none - a switched-off list still prints empty, but its heading may stay. Move the block wholly inside or wholly outside the section's element (and mark the element with `section-strengths` / `section-soft-skills`), save the template, and the section goes whole again. Logged once per template while the server runs. |
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
| A person's refund request is refused with *What this resume was charged is not on record, so it cannot be refunded here.* | The resume is from an order placed before refund requests existed: its item carries no charge, and nothing else records what that one resume alone cost. Grant the amount by hand under **Admin → Accounts** - the run's reserve row in the account's Credit History says what each resume was charged - and decline the request. |
| A refund request offers only Decline, and says *This request names something this version of the app cannot measure, so it cannot be refunded here. Decline it, and refund by hand from Accounts if it is owed.* | An older build recorded the request against a queued resume's task (`task:`) - a builder run from before Generate Immediately runs were filed with a record of their own - or the row was edited by hand. This build cannot tell what it names or what it cost. Decline it, and if a refund is owed, grant it by hand under **Admin → Accounts**. |
| **Mark refunded** on a resume's request says *That account no longer exists, so nothing can be credited back* | The account was deleted after asking. There is no balance left to credit: decline the request with the reason instead. |
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
| `npm run dev` stops at once with `'concurrently' is not recognized as an internal or external command, operable program or batch file.` (Windows), `sh: 1: concurrently: not found` (Ubuntu) or `concurrently: command not found` (bash's wording, which macOS's `sh` uses by default) - or, from this release, `[install] npm run dev cannot start: packages this repository needs are not installed.` `[install]   In the repository root: concurrently` `[install] Run npm run install:all from the repository root, F:\Develop\free_tailor, then npm run dev again.` (`dev:live` and `dev:poll` the same) | The repository root's own packages are not installed. `npm run dev`, `dev:live` and `dev:poll` start both halves with `concurrently`, the root package's one package - a devDependency, kept in the root's own `node_modules`, not the backend's or the frontend's. It goes missing in three ways, which look the same: the root `node_modules` was deleted (by hand, or `git clean -xdf` while sorting out a pull) and only `npm install --prefix backend` and `--prefix frontend` were run again; npm leaves devDependencies out on that machine - `NODE_ENV=production` in the environment, or `omit=dev` in npm's configuration - so every plain `npm install` *removes* `concurrently`, and with it the backend's `ts-node-dev` and `typescript` and the frontend's `tailwindcss` and `typescript`, which this repository needs to build and run; or an install failed part-way - an `EPERM` or `EBUSY` on Windows, say, where a running dev server can hold files open. **Fix:** stop any `npm run dev`, then from the repository root run `npm run install:all`. It passes `--include=dev` to all three installs, which installs devDependencies whatever `NODE_ENV` or `omit` says. `npm config get omit` shows what npm will do - `dev` in its answer means it leaves devDependencies out, whichever setting says so - and `$env:NODE_ENV` in PowerShell (`echo %NODE_ENV%` in cmd, `echo $NODE_ENV` in sh) whether `NODE_ENV` is one of them; with `NODE_ENV` cleared, `npm config get omit` still saying `dev` means an `omit=dev` (or a `production=true`) in npm's configuration as well - `npm config ls` names the `.npmrc` it comes from, and `npm config delete omit` takes it out of your user one. **What happens now:** each of the three first runs `scripts/checkInstall.mjs` (npm's `predev`, `predev:live` and `predev:poll` hooks), which checks that every package the root, backend and frontend `package.json` files name is in that package's `node_modules`. When one is not, it prints the lines above - what is missing in each package, five names at most and how many more, and the repository root by its path - and stops before `concurrently`; when npm's settings, as far as a script can see them, leave devDependencies out it adds a line saying which and pointing to `npm config get omit` (`[install] npm looks set to leave devDependencies out of installs here: ...`) - a hint, because npm does not pass every setting on to a script: with `NODE_ENV=production` in the environment an `omit=dev` never reaches it, nor does an `.npmrc`'s deprecated `production=false`, which makes npm install them after all. With everything installed it prints nothing. npm skips a `pre` hook while its `ignore-scripts` setting is on (`npm config get ignore-scripts`), and then the shell's sentence is all there is - that setting also skips the backend's Chrome download. |
| `Cannot find module '<name>'` or `TS2307` right after pulling | A pull brings source, never packages - a commit that adds a dependency leaves `node_modules` a version behind, and the backend then fails to compile naming a module that is correctly listed in `package.json`. Run `npm run install:all`, or `npm install --include=dev --prefix backend` for the backend alone. |
| `npm run build --prefix frontend` (or the frontend's production-style `npm run dev`) fails with `Failed to type check.` after `.next/dev/types/validator.ts(53,39): error TS2307: Cannot find module '../../../src/app/account/page.js' or its corresponding type declarations.` (and the same for `app/jobs/page.js` and `app/settings/plan/page.js`) | A Turbopack dev server - the root `npm run dev` - ran on this checkout before a pull that deleted those pages. Next writes `frontend/.next/dev/types` only when `next dev` runs, and the frontend's `tsconfig.json` includes it, so it still names the pages that are gone. Delete `frontend/.next/dev` (or run `npm run dev` once, which writes it afresh) and build again. |
| `Could not find a declaration file for module 'better-sqlite3'` | Backend dev dependencies are not installed. Run `npm run install:all` from the repository root, or `npm install --include=dev --prefix backend` (never `--omit=dev`) - `--include=dev` installs them even where `NODE_ENV=production` or npm's `omit=dev` would leave them out (the `concurrently` row above). This is the same symptom as the row above with a different cause: the packages were installed, but without the dev ones that carry the types. |
| On **Admin → Templates**, importing, extracting, building or editing a template answers *Template could not be saved. Please try again, or contact your administrator.* with a `Ref:` (or deleting one, *Template could not be deleted.*) | Saved templates are files in `backend/static/templates` (or `$TAILOR_STATIC_DIR/templates`), and the server could not write there: the directory is read-only to the user the backend runs as - a checkout owned by somebody else, a read-only container layer - or the disk is full. The startup line under `Database:` says so as `Templates: <dir> is NOT writable (<reason>)`; the backend log line carrying the same `Ref` names the file and the error, and an administrator sees it under the message. Give that user write access to the directory (or point `TAILOR_STATIC_DIR` at a writable copy of `backend/static`) and try again. A failed save leaves the template as it was and no temporary file behind. Renaming, disabling or reclassifying a **built-in** still works meanwhile, because those go to the database. |
| A template file copied into `backend/static/templates` by hand is not offered any more, a profile that used it is drawn with `default`, and the startup line under `Database:` ends *Not offered, because a template file is named <id>.json with an id of lower-case letters, digits and hyphens: Company_Brand.json* | A template's id is its file name, and ids are lower-case letters, digits and hyphens now; an older release offered a file under any name. Rename the file to its id - `Company_Brand.json` to `company-brand.json` - and it is offered at the next request, with no restart; a profile naming `Company_Brand` finds it again, because a lookup folds case and `_`. What an administrator had changed about it as a built-in on **Admin → Templates** - its name, description, disabled flag and layouts - was recorded under the old id, so set those again there. |
| The backend stops at once with `[db] The database at <path> has not finished upgrading: <what is missing>. Start build ac3df79 once on this database to finish its upgrade, then start this build.` (exit code 1) | The database was last opened by a build older than `ac3df79`, or `ac3df79` never finished its upgrades on it - and this build carries none of the code that made them, so read as it is it would read wrongly: balances in the old unit, saved templates missing, providers that no longer exist. The line names each step that is missing. Start build `ac3df79` once on the same `DB_DIR`, let it finish starting, stop it, then start this build again (see [Upgrading](#4-upgrading)). Where the line says the migrations *wait for an administrator*, sign in to `ac3df79` as one (an address in `ADMIN_EMAILS`) before stopping it; where it says *some saved templates could not be written*, make `backend/static/templates` writable for the user the server runs as first. A copied or restored database is checked the same way, so a backup from before that build needs the same. A database that passed once is never checked again. |
| `Cannot create the database directory`, `SQLITE_CANTOPEN`, or a permission error on startup | `DB_DIR` points somewhere this user cannot write. On Ubuntu the usual cause is `/data/db` not existing; create it, or set `DB_DIR=./data/db`. On Windows a `DB_DIR=/data/db` copied from an older `.env` means `C:\data\db` and needs an administrator - unset it to get `%LOCALAPPDATA%\free_tailor\db`, or point it at a folder you own. |
| `NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 137` | `better-sqlite3` is a native module compiled for a different Node version than the one now running (127 is Node 22, 137 is Node 24). Run `npm rebuild better-sqlite3 --prefix backend`, or switch back to the Node version you installed with. |
| How a run of many resumes is actually scheduled | The backend owns a queue. One request carries every resume - thirty sheet rows and three profiles is ninety tasks - and the request returns a batch id straight away, before any of them has run. Each lane takes tasks off the head of its line as its slots come free, so with `AI_CLI_CONCURRENCY=4` four resumes are built at once on the Claude seat and the moment one finishes the next task starts. A second request appends behind the first - except that a Generate Immediately run's resumes wait ahead of every Order's on the same seat (somebody is watching one; nobody is waiting on the other), first come, first served within each. There is a lane per real resource - one per PROVIDER (the three built-in seats, and any an administrator added), each at its own limit - so no provider can hold up another, and a model's resumes are spread over every provider of its type that can take work (see [Several providers of one type](#several-providers-of-one-type)). |
| A run survives the server restarting | The queue is on disk, in the same SQLite database as everything else, so `npm run dev` reloading on a file save no longer costs you an hour of generation. On boot the server picks up any unfinished batch: resumes already built come back built and are not rebuilt, and whatever was mid-build at the moment the process died is built again - nothing completed it, so its file does not exist. Repeating one is safe because the output path is derived from the profile, company and row, so it overwrites rather than adding a second copy. A batch is kept for an hour after it finishes and then pruned. Its credits stay as charged: the startup sweep that hands back reservations older than six hours (`[credits] Released $X from N run(s) that never finished.`) skips every batch the restore brought back - an older build released a long order's whole charge here and then built the rest of it for free - and a batch that had finished just before the stop is settled on the spot, its failures refunded and its built resumes kept charged. |
| A run keeps going after the page is closed - or stops when it is | Which one depends on how it was started. An **Order** belongs to the queue, not to the page: closing or reloading the page does not stop it, and its files keep landing on **Orders**; to stop it, press **Cancel** there. A **Generate Immediately** run is tied to the tab that started it: a dropped connection inside `IMMEDIATE_TAB_GRACE_MS` (30 s) picks it back up without downloading anything twice, but a tab that is closed or reloaded - or a page left inside the app after confirming - stops it, and the log says which: `[queue] Immediate run bat_... stopped by its page` (the page said it was leaving) or `[queue] Immediate run bat_... stopped: no page has followed it for 30000 ms` (the tab went away without saying so and did not come back). Either way the resumes that had not started are refunded and the run's finished files stay downloadable for `IMMEDIATE_FILE_RETENTION_MS`. For a run nobody will sit through, use **Order**. |
| A Generate Immediately run stopped part way though the tab was still open | The page lost its connection to the server for longer than the grace (plus up to 20 s: the server ends the run's progress stream every 20 s, and a page that does not attach again by then is counted gone) - a laptop that slept, a network that dropped for a minute, a proxy that cut the progress stream and did not let it reconnect. The person sees the remaining resumes as *Cancelled* and the unstarted ones refunded. Raise `IMMEDIATE_TAB_GRACE_MS` (up to ten minutes) if your users' connections are like that, or have them **Order** long runs. |
| `npm run dev` serves the frontend for a moment after *✓ Ready*, then the log's last frontend line is `[frontend] npm run dev:turbo --prefix frontend exited with code 3221225477` and the page no longer loads (Windows; printed as a signed number - PowerShell's `$LASTEXITCODE`, say - the same code is `-1073741819`) - or the frontend prints `[next] Turbopack's dev server stopped with exit code 3221225477, 0xC0000005 STATUS_ACCESS_VIOLATION.` and goes on to a webpack build | `3221225477` is `0xC0000005`, Windows' *STATUS_ACCESS_VIOLATION*: native code - Turbopack, the Rust part of Next's dev server - touched memory it may not, and Windows ended the process before Node could print anything. It is Next's bug, [vercel/next.js#95015](https://github.com/vercel/next.js/issues/95015), reported from 16.3.0-canary.49 on; the log that brought it here ran Next.js 16.3.5. The backend is not involved and keeps running. **What happens now:** when Turbopack's dev server - `dev:turbo`, which the root `npm run dev` runs - ends that way on Windows, `frontend/scripts/next.mjs` explains it once and runs the production-style server in its place, on the same host and port: `next build --webpack` (webpack, since Turbopack has just crashed natively on this machine), then `next start`. The page works but does **not** hot-reload: stop `npm run dev` and start it again to see a change to the frontend (the backend still restarts on its own). If that build fails, the frontend ends with the build's exit code and a line saying the server was not started. It happens once, only in that mode and only on Windows; every other ending is passed on as before. **To pick a mode yourself,** from the repository root (the fallback fires the same way under `cd frontend && npm run dev:turbo`, and its advice names the root's commands): `npm run dev:live` - the backend with webpack's dev server, which hot-reloads but reloads other open tabs of the app (the next row) - or `npm run dev:backend` in one terminal and `npm run dev --prefix frontend` in another (`npm run dev:poll` runs the same two in one, its backend watching by polling): the production-style server, built by **Turbopack** - whether Turbopack's build crashes the same way on a given machine has not been tried. **Check which Next runs:** the frontend pins 16.3.8, and names any other it finds before starting - `[next] Next.js 16.3.5 is installed, but frontend/package.json pins 16.3.8. Run npm run install:all.` - which `npm run install:all` puts right (see [Upgrading](#4-upgrading) if `git pull` refuses to). Whether 16.3.8 itself still crashes on Windows is not known: the issue names no fixed release, and every measurement here was on Linux. Do not go back to 16.1.6 to avoid it: `npm audit` lists critical advisories against it, remote code execution on Windows-hosted servers among them. |
| Opening a second tab of the app reloads the first one, and a Generate Immediately run going there stops (*Your last run ended while this page was away ... Stopped after building 0 of 1 resume*) | The frontend is on **webpack's** dev server - `npm run dev:live`, or the root `npm run dev` of a release before this one. In Next 16.1 that server sends every open tab a "sync" when a new tab connects, and a tab that has not seen the latest compile (the page the new tab opened is one) takes it for a restarted server and reloads itself - and 16.3.8's reloads it just the same; a reloaded Build Resumes tab releases its run as it goes, which the server then stops and refunds. Nothing in the app reloads a tab. Run `npm run dev` (Turbopack) or the production-style `npm run dev --prefix frontend` instead - neither reloads, and a production `next start` has no such server at all. `cd backend && DB_DIR=... E2E_MODE=dev:live node test/e2e/dev-reload.js` shows which a given setup does (backend/test/e2e/README.md). |
| Only the first resume of a Generate Immediately run downloaded, or the browser asks *This site is trying to download multiple files* | The browser blocks a page from starting several downloads on its own until it is allowed to. Choose **Allow** in that prompt (in Chrome: the icon at the end of the address bar, or *Site settings → Automatic downloads → Allow* for this site). The files are on the server for `IMMEDIATE_FILE_RETENTION_MS` after the run ends (ten minutes by default), and the page lists each one under the progress (*This run's files*) to download again while it is open; after that they are deleted, downloaded or not - an **Order** keeps them for days instead. |
| Downloading a Generate Immediately resume answers *That file has been deleted from the server* | Its run ended more than `IMMEDIATE_FILE_RETENTION_MS` ago, and the files went with it (owner decision: an immediate run's files are only kept long enough to download). The resume stays charged; if it never reached the person, an administrator can add the credit back with the **+/-** beside their balance on Admin → Accounts. Raise the setting, or use **Order**, when files are needed for longer. |
| A link to `/api/generated/...` or `/api/resume/download/...` answers `{"error":"File not found"}` for a file that is on disk | The file is another account's: an order or a Generate Immediately run recorded it, or it sits in a run's own folder (`<account>/<date>/<order number>/...`, where a resume is written before it is recorded as finished - and stays, unrecorded, when its build fails). Whose it is is decided on the path as the server opens it, so a `//`, a `./`, a `..`, a symlink or (on Windows and macOS) another case of the same name is the same file and gets the same answer; an administrator is refused like anybody else, as before. Its owner downloads it from **Orders**, or from the run's own page while the files last. Otherwise the path leaves the output directory, names a folder rather than a file, or the file is gone. |
| Building for several profiles is refused with *Building for more than one profile needs a Premium subscription or higher* | The account is on the Default subscription, which supports one profile: Multiple, All profiles, Specific group and Select Group need Premium or higher, for Generate Immediately and Order alike (403 `subscription-too-low`). One profile at a time works on every subscription. Move the account up under **Admin → Accounts → Subscription**; administrators are never refused. |
| Behind a reverse proxy, a long batch's progress bar says *Finished 4 of 30* while the server goes on building | The page follows a running batch over one long-lived response, and a proxy closes a connection that has been quiet for a while - nginx's `proxy_read_timeout` and an AWS load balancer after 60 s by default, Cloudflare after about 100 s - while one resume can take minutes. Each cut used to cost the page one of its twenty reattaches, so a long healthy batch ran out of them and stopped following. The stream now sends a bare newline every 25 s, which keeps those proxies from seeing it as idle, and the page keeps following until the server says the run is over: after twenty attaches in a row that brought nothing it slows from one attach a second to one every 10 s, and it stops at once only when the server answers that the batch is gone (404: restarted or expired). A proxy with an idle limit under 25 s still cuts it - raise that limit for `/api/generation/batches/*/stream`. |
| A batch of profiles or a sheet import runs one at a time | Fixed. Every batch endpoint now runs its items in parallel, as wide as the model's type can actually take: the slots of every switched-on provider of it, added together - the built-in one's `AI_CLI_CONCURRENCY`, `AI_CODEX_CONCURRENCY` or `AI_GEMINI_CONCURRENCY` unless **Admin → Models → Providers** sets its limit, plus each added provider's own. The queues were already there - a freed slot is handed to the head of its line the moment it is released - the batch just was not offering them enough work. `AI_BATCH_CONCURRENCY` still overrides the whole thing. The backend logs the width and the reason at the start of each batch. |
| Generation feels like it sends more than it needs to | It used to. The profile is now projected before it goes to the model: contact details, this database's ids and timestamps, and the whole of `profileSettings` (your prompt choices, file-name templates and which model you pay for) are left out, and the JSON is compact rather than pretty-printed. Measured on a five-role profile: 9,365 characters down to 6,942. Nothing the prompt reads was removed. The three choices the prompt does need - the layout and the two section switches - travel as three words of their own, and the profile's own soft skills are not sent at all, because the code lists them. |
| The same job posting is analysed over and over | It is not any more: a posting is analysed **once, ever**, and the analysis is stored in the database (`job_analyses`) - not for six hours, not per model, per prompt, per profile, per run or per restart. A posting is recognised by its link or its text, so a preview followed by a generate, a sheet re-run, an order of the same rows, a retry and the job filter all reuse the one analysis. Editing the analysis prompt or changing the analysis model reaches only postings never seen before - see [Job analysis: once per posting](#job-analysis-once-per-posting). The only repeat is after a call that failed, which stored nothing. |
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
| **Admin → Prompts** marks a prompt *Needs update* (*Not run: it does not use [[...]].*), or saving one says *Missing required prompt variables: ...* | Some variables are required: `[[jobFieldList]]` and `[[industryList]]` in the Analyze Job Description prompt, so every posting is filed under a job field and an industry from the lists, and `[[includeStrengths]]`, `[[includeSoftSkills]]` and `[[technicalSkillsLayout]]` in every Tailor Resume prompt, so the profile's section switches reach the model. A save without them is refused. A stored prompt without them - edited before the rule, or written by hand - never runs: the built-in prompt of its feature runs in its place (an administrator's edit of it when that is complete, else the shipped text), and the backend log says so once: `[prompts] The prompt "..." (...) does not use [[industryList]], which every Analyze Job Description prompt must; the built-in Analyze Job Description prompt runs instead until it is updated under Admin -> Prompts.` Add the variables where the shipped prompt (`backend/static/prompts/<feature>.json`) has them - the analysis prompt names both lists under their own headings before `[[jobLink]]` and asks for `jobField` and `industry`; the tailoring prompt's *RESUME SECTIONS* block follows `[[profileJson]]` - and save; the mark goes. |
| An exported set of templates will not import | Fixed. The JSON upload now takes one template, a list of them, or `{ "templates": [ ... ] }`, works `sections` out from the markup when the file names none, and says which entry is wrong rather than failing the file. It saves all of them or none, and never overwrites a template already here. |
| An uploaded profile lost its skills | It should not now: a flat list, a `{ "Languages": [ ... ] }` map, a list of `{ category, skills }` groups, and a mix of names and groups all import to the same profile. Every grouped skill also lands in the flat list the tailoring prompt reads. |
| A model is missing from the model menus | The menus list only models that can run right now. Under **Admin → Models**, it is either *Disabled*, on a provider switched off under Admin → Settings (*Provider off*) - or on a type whose every provider is switched off under **Admin → Models → Providers**, which reads the same - or on a seat locked in this installation (*🔒 Locked*, with the reason). Nothing is locked by default, so a lock means `AI_LOCKED_PROVIDERS` in `.env` names it; remove it there and restart. |
| *That model isn't available. Choose another, or contact your administrator.* | A run, or a profile save, named a model that cannot run: switched off, deleted, on a locked seat or on a provider switched off. It is refused rather than replaced, because another model could cost a different price. An administrator's response carries the reason underneath. A profile that already stored such a model is not refused - it shows *Unavailable model* and runs on the default, and the server log says so once. |
| *AI generation isn't available right now. Please contact your administrator.* | What anybody but an administrator is told when the seat a run needs cannot answer: its CLI is signed out or not installed, the account cannot use that model, the provider is locked or switched off - or every seat is locked, so nothing can run at all. An administrator sees the cause under the same sentence; the startup `[ai]` lines and the seat cards on Admin → Settings say which seat and why. The other three AI sentences are for the person to act on: *busy* (a usage limit - wait), *took too long* (ask for less) and *failed* (try again). |
| `Could not find Chrome (ver. ...)`, or `PDF rendering needs a Chrome to print with` | Puppeteer's Chrome was never downloaded - an `npm install --ignore-scripts`, a proxy blocking the download, or a cleaned cache. Run `npm run setup:browser`, which fetches exactly the build puppeteer expects. If that download cannot get through, point the server at a browser you already have instead: `CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe` in `.env` (Chrome, Edge, Chromium and Brave all work - same engine). The server also finds an installed browser on its own when the download is missing, so this only comes up when there is neither. |
| `Could not start ... - but there is no file there` at startup | `CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH` names a path that does not exist. An explicit setting is never silently overridden, so fix the path or unset it to fall back to the downloaded browser. |
| `The Claude CLI is not installed or is not on the server PATH` (an administrator's detail, or the startup line) | Either it genuinely is not installed, or the server process has a different PATH than your shell - common under systemd and Docker, which get a minimal one. Set `AI_CLI_BIN` to the full path from `which claude` (`where claude` on Windows). On Windows npm installs the CLI as `claude.cmd`, a shim wrapping `node_modules\@anthropic-ai\claude-code\bin\claude.exe`; the server follows the shim to that binary on its own, so `AI_CLI_BIN` is only needed if that fails, and then it should name the `.exe`, not the `.cmd`. |
| A Codex turn fails with `spawn codex ... ENOENT` | Same two causes as the row above, one vendor along: either `@openai/codex` is not installed, or this process has a different PATH than your shell (common under systemd and Docker). Set `AI_CODEX_BIN` to the full path from `which codex`. |
| Codex says `Not logged in`, or a turn fails with an auth error | Run `codex login --device-auth` **as the user the server runs as** - it prints a code you approve from a browser anywhere, so the server needs no display. The sign-in lives in that user's `CODEX_HOME`, so a login as yourself is invisible to a service running as someone else. `codex login status` prints the account; note it exits 0 either way, so read the text rather than the exit code. Then check **Admin → Settings**, which shows this seat's own readiness card. |
| Codex reports *Signed in with an API key, not a ChatGPT subscription* | The CLI was signed in with `codex login --with-api-key` (or a Bedrock key), and every call on that would be billed per token - so the seat counts as not signed in, and refuses every call without running it (an administrator's detail says *signed in with an API key, so this call would be billed per token*; users are told to contact you) until it is signed in with ChatGPT again. The check is cached for a minute, so the first calls after the fix may still be refused. Run `codex logout`, then `codex login --device-auth` as the user the server runs as, and sign in with ChatGPT. Keys in the environment are a different matter and already handled: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` are always stripped from the child, and there is no longer a switch to let them through. |
| `[ai] gemini-cli: No "gemini" on the server PATH.` | Either `@google/gemini-cli` is not installed (`npm i -g @google/gemini-cli`; it needs Node 20 or later), or this process has a different PATH than your shell (common under systemd and Docker). Set `AI_GEMINI_BIN` to the full path from `which gemini`. On Windows npm installs a `.cmd` shim around `bundle/gemini.js`, which the server runs under its own Node; `AI_GEMINI_BIN` is only needed if that fails. Lock the seat (`AI_LOCKED_PROVIDERS=gemini-cli`) if you do not mean to use it. |
| `[ai] gemini-cli: Not signed in: there is no Google sign-in at .../.gemini/oauth_creds.json`, or a Gemini turn fails with an auth error | Run `NO_BROWSER=true gemini` **as the user the server runs as**, choose *Sign in with Google*, open the URL it prints in any browser, paste the code back and `/quit`. The file the check names is where the server looks: with `AI_GEMINI_HOME` set, sign in with `GEMINI_CLI_HOME` set to that same directory, or the sign-in lands in a home the server never reads. *has no refresh token, so it stops working within the hour* means the same fix. A failed sign-in holds the whole seat for 30 minutes (`[ai] Holding off the Gemini seat ...`) so calls stop failing one by one; after signing in, open **Admin → Settings** - its seat check sees a sign-in written after the hold and lifts it (`[ai] Lifting the hold on the Gemini seat ...`). A restart lifts it too. While a sign-in is still on disk, the CLI's refusal is first read as *could not validate its Google sign-in* and held for only two minutes: the CLI checks its token with `oauth2.googleapis.com` on every start, and a refused connection or a proxy fault there ends in exactly the signed-out error. Check that the server can reach that host; the third such failure in a row is taken as a revoked token and gets the 30-minute hold and the sign-in action. With `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` the check cannot read the sign-in and says so - the first call is the test. |
| A seat still says it is not signed in after you signed its CLI back in - users see *AI generation isn't available right now*, an administrator's detail says *not signed in* or *Invalid authentication. Please run /login* | A failed sign-in holds the Claude or Gemini seat for 30 minutes (`[ai] Holding off the Claude subscription ...`, `... the Gemini seat ...`) so calls stop failing one by one - and a hold is normally lifted by the next success, which the hold itself turns away. Open (or reload) **Admin → Settings**: its seat check runs fresh, and lifts a sign-in hold when it finds the seat signed in - the Claude seat on the subscription (`authMethod` `claude.ai` or `oauth_token`, with no `apiKeySource` beside it), the Gemini seat by a sign-in file written after the hold, since a token Google revoked still reads as signed in from the file. The log says `[ai] Lifting the hold on ...`. Otherwise wait out the 30 minutes, or restart the backend. A usage-limit hold is not lifted this way; signing in does not refill a window. Codex keeps no sign-in hold: it asks `codex login status` before every turn, cached for a minute - and a turn that finds it signed out takes it out of service at once, until a check that starts after that (the next minute's, or opening **Admin → Settings**) finds it signed in. Before this, a held Claude call whose CLI had said *Invalid authentication* was reported as the usage limit being reached. |
| A Codex provider's card says *Usage limit reached*, the log says `[ai] Holding off the Codex subscription for about N minute(s): You've hit your usage limit...` (or `... the Codex provider "<label>" ...`), and its users see *AI generation is busy right now. Please try again in a few minutes.* | That Codex account is out of its usage window. It is held - at least 5 and at most 30 minutes, the wait the CLI names when it names one in minutes or hours, else 15 - and takes no new work meanwhile; its waiting resumes go to another Codex provider if there is one, and otherwise wait. When the hold ends, the next turn is the probe: a limit still in force holds it again, an answer lifts it. Signing in again does not refill a window. Before this a Codex provider kept no hold at all: it went on taking work and failing it in a moment, so it looked the least busy, every retry went back to it, and resumes failed there that another Codex provider could have built. |
| Opus resumes (or one other model's) wait or go to one provider while another provider of the type sits idle, and the log says `[ai] Holding off model "opus" for about N minute(s)` | That provider is held for that **model** only - a weekly Opus or Sonnet limit (`seven_day_opus`), or a model the account cannot use - so it gets none of that model's work while another provider of the type can build it, and goes on building every other model. With no provider of the type able to run that model, its resumes wait (no log line from the queue - the seat's line above is the one) and start when the hold ends; a model hold is re-checked every 10 s while work waits for it. Its card on **Admin → Settings** lists the hold with its scope. Before this, a provider held for one model still counted as free, failed that model's resumes in a moment, and drew the retries of every other provider's work. |
| A Gemini turn is refused: *the Gemini CLI billed this call to the account's paid AI Credits* (an administrator's detail; users see *busy*) | The workspace this server writes for the CLI says `billing.overageStrategy: "never"`, so something that outranks it turned paid credits on - a system settings file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `/etc/gemini-cli`). The answer is thrown away and the seat held, so the next calls are not billed the same way. Remove that setting, or wait for the free quota to reset. |
| A Gemini turn fails with *the model called N tool(s)* | The seat runs with no tools and a deny-all policy, so a tool call means something re-enabled them for every workspace - a system settings file again (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `/etc/gemini-cli`) adding tools. MCP servers and extensions cannot be the cause: every turn passes `--allowed-mcp-server-names __tailor_none__ --extensions none`, so neither the service user's `~/.gemini` servers and extensions nor a system file's are loaded. Nothing that turn produced is used. |
| `[ai] gemini-cli: ... GEMINI.md is not empty, and the CLI appends it to every prompt this seat runs` | The service user's personal `~/.gemini/GEMINI.md` - notes the CLI adds to every prompt, whatever the app sends, with no way to turn it off. Empty it, or give the server a home of its own with `AI_GEMINI_HOME` and sign in there. |
| A Gemini model fails with *The signed-in Google account cannot use model "..."* | The account's plan does not offer that model (a preview, or Pro on a plan without it), and that model is left alone for 10 minutes. Pick another model name for that record under **Admin → Models** - `auto` lets the CLI choose one the account can use. |
| A resume built on Gemini comes back cut short, or a Gemini build is retried with *the answer opened @@BEGIN_JSON@@ and never closed it* in its log (an administrator's detail; users see *The AI request failed*) | A known limit of the Gemini CLI's stream format: an answer cut off at the model's output limit arrives marked as a success, and the CLI names no finish reason once any text was written. A structured answer - the analysis, the tailored resume - gives itself away: this seat has no JSON mode, so it is asked to wrap the document in `@@BEGIN_JSON@@` / `@@END_JSON@@`, and one that opened the first and never wrote the second was cut off. That is refused as truncated, without holding the seat, and built again (`GENERATION_MAX_ATTEMPTS`). It used NOT to fail: the JSON reader found the first complete object inside the cut-off document - one experience entry, say - and took it for the whole answer. A prose answer, such as a cover letter, has no such marker and can still arrive short. If it recurs on long resumes, use another model or seat for them. |
| Generating a resume fails with Cloudflare **error 524**, but the backend log shows it finishing | The request went through Cloudflare's proxy, whose read timeout is ~100s on Free/Pro/Business and is not adjustable, while `/api/resume/analyze`, `/generate` and `/preview` run inline and wait: `/generate` alone awaits the job analysis, then the tailoring, then the PDF and DOCX rendering, against a 3-5 minute per-call budget. The server is fine; the proxy hung up. Set the site's `A` records to **DNS only** (grey cloud). `curl -sI https://yourdomain.com \| grep -i ^server:` answering `cloudflare` means a record is still proxied. Keeping the CDN means splitting the API onto a grey-clouded `api.` subdomain via `NEXT_PUBLIC_API_URL`. |
| A resume failed but the run shows it building again | Expected: a failed build is retried, up to `GENERATION_MAX_ATTEMPTS` (default 3, counting the first go). The progress line says how many are retrying. It costs nothing extra - the resume's price is taken once at submission and returned only if the resume never delivers. A cancelled batch and a task kind this build does not know are **not** retried. |
| One seat's work queues while another sits idle | Each provider has its own queue lane, sized by its own limit - `AI_CLI_CONCURRENCY`, `AI_CODEX_CONCURRENCY` and `AI_GEMINI_CONCURRENCY` for the built-in seats unless **Admin → Models → Providers** sets one, an added provider's own `concurrency_max_requests`. Types are deliberately not pooled with each other: one shared lane across independently-sized process pools either strands the larger or lets tasks blocked on the smaller hold slots another seat needs, and a Claude model's resume cannot run on a Codex seat. Providers of ONE type are pooled. Raise the limit of a provider of the type that is waiting - on that page it applies at once, in `.env` after a restart - or add another provider of that type. |
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
| Admin → Models lists models in red as *free*, and runs on them cost nothing | Every enabled model priced `$0` is listed: a shipped model arrives unpriced, and a model nobody has given a price reads as `$0`. Set a price per resume on each. `0` is a valid price - a deliberately free model stays listed, so nobody gives resumes away without seeing it. |
| A price, balance or grant is refused: *... can have at most three decimal places: $0.001 is the smallest step* | Amounts are exact to a thousandth of a dollar, and anything finer is refused rather than rounded either way - `0.023` is fine, `0.0235` is not. A purchase must be a whole number of cents (`12.50`, not `12.505`), because that is all a card or an invoice can charge. |
| Startup logs `[sheets] Could not load the Google credentials` / `invalid_grant: Token has been expired or revoked` | The saved Google consent is dead. **Not fatal** - the server starts and serves; what stops working is per-account sheet allocation, the job export and filter pages, the builder's sheet mode and the bid assistant's sheet reads. If you did not revoke it yourself, the cause is an OAuth consent screen still in **Testing**, where Google expires every refresh token after seven days. Fix: `cd backend && npm run sheets:login`, which re-consents and rewrites `google-oauth-credentials.json` - it re-uses the client id and secret already in that file, so the originally-downloaded `client_secret*.json` does not have to still be around. Then `npm run sheets:doctor` to confirm the whole chain. To stop it recurring, publish the consent screen **before** signing in again - a consent given while it is in Testing keeps the seven-day limit: Cloud console -> Google Auth Platform -> Audience -> Publish app (older consoles: APIs \& Services -> OAuth consent screen -> PUBLISH APP). With the restricted Drive scope Google then shows a "Google hasn't verified this app" screen at sign-in; for your own install that is expected - Advanced -> Go to the app. A Google Workspace project can choose user type Internal instead, which has neither the expiry nor the warning. `deleted_client`, `disabled_client` or `invalid_client` instead of `invalid_grant` means the OAuth client itself is gone, and signing in again would re-use it: a deleted one can be restored for 30 days under Google Auth Platform -> Clients; otherwise make a new Desktop app client, download it into `backend/` and run `npm run sheets:login -- --client <that file>` - naming it, because an older `client_secret*.json` left there can otherwise be picked. If `GOOGLE_CREDENTIALS_PATH` names the credential, `sheets:login` re-uses the client from that file and says so if the app will keep reading a different one from the file it just saved. `SHEET_BACKFILL=off` in `.env` silences the startup attempt meanwhile, at the cost of not allocating sheets for older accounts until each next signs in. |
| A script ends with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` (Windows) | A Node.js bug, not this app's: calling `process.exit()` just after network I/O races Node's own teardown on Windows ([nodejs/node#56645](https://github.com/nodejs/node/issues/56645)). Everything printed above it is complete and correct - read the report, not the crash; the only casualty was the exit code. The doctors and `sheets:login` now let the process end on its own, which avoids it on every Node version. Node itself fixed it in 24.20.0 and 26.7.0 ([nodejs/node#61999](https://github.com/nodejs/node/pull/61999)), and 22.x never got the fix, so a current 24 LTS is worth having anyway. |
| Startup warns the sign-in is not a subscription: `[ai] claude-cli: Signed in with authMethod="...". This may not be a subscription sign-in. ...`, and the Claude card under **Admin → Settings** says the same | `claude auth status` reports an `authMethod` other than `claude.ai` or `oauth_token`, or names an `apiKeySource` beside one (the line then reads `authMethod="claude.ai" and apiKeySource="..."`), so the CLI may have found an API key: `api_key`, `api_key_helper` and `third_party` are a key or another provider's API, and `claude.ai` with `apiKeySource="/login managed key"` is a Console login - billed per token - on a Claude Code older than 2.1.286, which later releases call `api_key`. A call the CLI starts on a key is stopped at its first event - `system/init` names the credential before the model answers - and the seat is held as signed out for 30 minutes so no further calls are billed. Run `claude auth login` as the user the server runs as, and remove whatever supplies the key - an `apiKeyHelper` in the CLI's own settings, say; `ANTHROPIC_API_KEY` in the environment is stripped from the child already. Then open **Admin → Settings**: its seat check lifts the hold once `claude auth status` reports the subscription, and a key still in the way is caught at the next call's first event again. An earlier build of this app took `oauth_token` alone for the subscription, so it said this about `authMethod="claude.ai"` with no key beside it - the ordinary `claude auth login` - at every start, and its seat check never lifted that seat's sign-in hold; nothing was wrong with the sign-in, and this build reads it as the subscription. |
| Generation returns 429 with a `Retry-After`, and users see *AI generation is busy right now* | A seat's usage limit is spent: the Claude subscription's window, the ChatGPT plan's, or the Google account's quota. The Settings page shows the Claude window and its reset time; generation resumes on its own. The Gemini seat holds itself off for as long as Google's error asked - from 30 seconds up to 30 minutes, five when it named no delay - and logs `[ai] Holding off the Gemini seat for about ...`. |
| Startup prints `[env] NAME="..." is not a whole number; using ...` or `[env] NAME=... is outside a..b; using ...` | A value in `.env` could not be used as written, and the server is running on the value that line names instead - the default for an unreadable one, the nearest end of the range for one too big or too small (except `PORT`, which falls back to 3001 rather than becoming port 1 or 65535). Deliberately not fatal: a server that refused to start over a timeout typo would hide every other diagnostic it prints. Write plain digits with the unit taken from the name (`AI_REQUEST_TIMEOUT_MS=600000`, not `10m` or `600s`), keep it inside the range `.env.example` gives, and restart. Each variable is reported once per start, however often it is read. |
| Startup warns `[ai] AI_CLI_TIMEOUT_MS_TAILOR=... is longer than AI_REQUEST_TIMEOUT_MS=...` | A CLI budget was raised above the deadline that bounds every AI call, so it can never take effect - the call is cut off at `AI_REQUEST_TIMEOUT_MS` (300000 by default) whatever the budget says. Raise `AI_REQUEST_TIMEOUT_MS` to at least the budget, and restart. The same holds for every `AI_CLI_TIMEOUT_MS*`, `AI_CODEX_TIMEOUT_MS*` and `AI_GEMINI_TIMEOUT_MS*`. Each is read as its seat reads it - the Claude and Codex budgets loosely, so `600000ms` counts as 600000, and the Gemini ones strictly, like every newer setting; a budget left at its own default - older copies of `.env.example` wrote the first six out - is never reported, since lowering the deadline below it is a deliberate cap. |
| A PDF upload is refused with *... is N MB or larger; this server accepts PDFs under N MB* (the page's check names the file, the server's 413 says *That PDF*) | The file is at or over `UPLOAD_MAX_MB` (10 by default) - a file of exactly N MB is refused too. Raise it in `.env` and restart the backend - the upload pages read the new number from the API, so the frontend needs no rebuild, and a page left open re-checks it before refusing. A big file over a slow link may also need `HTTP_REQUEST_TIMEOUT_MS` raised, and a reverse proxy in front has a body limit of its own (nginx's is 1 MB unless `client_max_body_size` says otherwise). |
| A large batch or profile import fails with `request entity too large` | The JSON body is over `JSON_BODY_MAX_MB` (10 by default). Raise it and restart the backend. A reverse proxy's body limit applies on top. |
| A template JSON import fails with *File too large* | The template import is a file upload with its own fixed 2 MB cap - `JSON_BODY_MAX_MB` does not raise it. Split a file of several templates into smaller ones. |
| The calendar page works locally but answers 404 on the domain | The reverse proxy sends `/api/calendars/*` to Express, which has no such route: the calendar's API is made of Next.js route handlers in the frontend. Add the `handle /api/calendars/*` block from the Caddyfile under [Serving it on your own domain](#-serving-it-on-your-own-domain), above `handle /api/*`, and reload Caddy. |
| A changed `NEXT_PUBLIC_*` value - the calendar's time zone, the API URL - has no effect after a restart | `NEXT_PUBLIC_` values are compiled into the frontend bundle by `next build`. Run `npm run build --prefix frontend`, then restart the frontend. The calendar's `CALENDAR_API_TIMEOUT_MS` and `CALENDAR_DETAIL_CONCURRENCY` are not `NEXT_PUBLIC_` and need only the restart. |
| Shortening `SESSION_TTL_DAYS` did not sign anybody out | Expected: a session's expiry is stamped when it is created and never extended, so a change applies to new sign-ins only. To end an account's sessions now, press **Sign out** on its row under Admin -> Accounts. |

## 🧪 Tests

```bash
npm test
```

Runs the backend `node:test` suite against temporary SQLite databases and static directories.
The run gets a temporary directory of its own (`backend/scripts/runTests.js` points
`TMPDIR`/`TEMP`/`TMP` at it, and `DB_DIR` at a directory inside it whatever the
environment says, so no test can open the real database) and deletes it when
the suite ends, so the system temp directory gains nothing from a run;
`TAILOR_KEEP_TEST_TMP=1` keeps it for looking at what a failing test left
behind.

The startup guard is pinned in `upgradeGuard.test.js`: a database this build
creates is stamped and opens again; one that build `ac3df79` finished upgrading
opens and is stamped, so later starts read only the stamp; a database missing
any one of the upgrades - its migrations, the dollar switch, the template move,
the `users.plan` rename, the lake's facts - is refused by name with nothing
written, all of them in one refusal; the real server, started on such a
database, prints that one line and exits 1 before it listens; and this README
quotes that line in the guard's own words.

Generate Immediately and Order are pinned in `immediateRuns.test.js` (kinds,
the tab lease through the stream, the release, the owner-checked per-file
download and the deletion after the run, the refund by order item),
`tabLease.test.js` (the grace on a mock clock), `queuePriority.test.js`
(immediate before orders on one seat, retries and restores included) and
`subscriptionGates.test.js` (one profile on every subscription, several only
from Premium, administrators exempt); the Tab select's listing in
`sheetTabs.test.js`. The page's own decisions - a tab's id, which resumes are
still to download, the release request, how a run ended, the sheet rows - are
run by `immediateRunHelpers.test.js`, and the whole of it in a browser by
`test/e2e/immediate-run.js` and `test/e2e/sheet-panel.js`, against a seat and a
Google Sheet stubbed by preloads (`backend/test/e2e/README.md`).

Job analysis running once is pinned case by case in `analysisOnce.test.js`:
each of the ten ways a posting used to be analysed again - the cache's window,
three profiles on three models, a restart mid-order, a 150-row order, a prompt
edit, a profile's own analysis prompt, Generate pressed twice, two requests at
once, a retry, the job filter then a build - runs through the real routes and
queue against a stub seat that must see exactly one analysis call. The store,
its indexes and query plans are in `jobAnalysisStore.test.js`, the gate as the
only caller of the analysis prompt in `analysisGate.test.js`, and the job
sheet's six columns - sheet-first builds, write-back, the protection, the
backoff - in `analysisSheets.test.js`.

The Job Data Lake is pinned in `jobLakeIdentity.test.js` (the company
normalisation and the versioned hash), `jobLakeStore.test.js` (the tables, the
indexes and their query plans, the duplicate window on a fake clock, rewards,
revokes, four threads adding one job, the job type, clearance and industry, and
the record of who reported what),
`jobLakeSync.test.js` (the admin sheet's outbox and its header) and
`jobLakeReport.test.js` (a reporter's run - reported before, moved rows, the
same posting twice in one run - the merge and
the admin API over HTTP). The
industries, and an older analysis's industry worked out from what it holds,
are in `jobAnalysisStore.test.js`. The two pages' own decisions - the rows a run is asked for, the
settings a save sends, the lake's filters, the owner's line drawn from a real
run's summary, the rows it paints red, what a row reported before says, each
job's type, clearance and industry - are run against the server's code by
`frontendJobLake.test.js` - with the Lake tab's filter order and Push to
Google Sheet, whose body is the search's own filters (the same jobs, refused in
the same words) and whose confirm and result are read from a real push's
answer - (and Admin → Prompts' notes on a prompt that lacks a required variable
by `frontendAnalysis.test.js`), and both pages in a browser by
`test/e2e/report-run.js`, and the push - the tab it replaces, a build from it
that analyses nothing - by `test/e2e/lake-push.js`, against a Google Sheet and
a seat stubbed by preloads.

Providers of one type are pinned in `providerQueues.test.js` (two Claude
providers with limits 1 and 2 running three at once, each at its own limit; a
held provider's waiting work moving to the other; a switched-off provider
getting nothing; a restored resume naming a removed provider landing in its
type's pool; urgent work per lane; the provider recorded on the order item),
`providerSeats.test.js` (each provider's child naming its own folder and binary
with every key still stripped, holds and health per provider, the registry and
the pool) and `aiProviders.test.js` (the `.env` defaults and an administrator's
override, every path check on an add and an edit against the app's real
directories, and the routes over HTTP). The tailoring cache is in
`tailorCache.test.js`: a second identical build makes no tailoring call and is
charged again, a one-character profile change makes one, every caller reuses
(the queue, `/resume/preview`, `/resume/generate`, cover letters included),
another template or a library skill the posting names is a miss, an answer that
does not parse or that a fallback model wrote is never kept, the key, the
one-seek lookup and the prune.

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
against the markup; `sectionHeadings.test.js` renders every built-in and a set
of uploaded-style markups (a heading before the loop, a heading in a plain div,
a guard around the loop only, both sections in one column, a divider under the
heading, the `join` helper...) with each switch off - no heading left,
Experience and Technical Skills intact - and on, keeps a photo, an icon or a
line of text that shares the section's element in every mode, never takes an
element that also holds the summary or the Experience loop, or a paragraph past
60 characters, finds a `data-section` element whatever its heading reads, draws a template
the section finds would stop compiling with less found, and holds the profile
preview route and the render a PDF prints from to the same answer. The live preview's access rules and its lack of side
effects are in `profilePreview.test.js`, run with every seat locked so a 200
also proves no model was asked; the prompt variables, their drift check and
the required ones - a save without one refused, a stored record without one
never run - in `promptVariables.test.js`.

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

Who may reach what is one table, in `routeAccess.test.js`: a row for every
router `backend/src/index.ts` mounts, saying who it is for (anybody, any
signed-in account, users and administrators, or administrators). It fails when
a router is mounted with no row, when any route carries a different guard from
the one its row decides - read off the router itself, so a route added without
`requireAdmin` to a router guarded per route is caught - and, over HTTP with a
session for each role, unless a reporter is refused every route that is not
theirs with 403 `role-not-allowed` and reaches the ones that are. Roles, the
reporter's rate per job and **Record payout** (never above the balance, once
per press, the ledger still summing to the balance) are in
`accountRoutes.test.js` and `accounts.test.js`; payout requests - only a
reporter asks, one at a time, never at `$0`; Record payout writes one row keyed
by the request, refuses above the balance or for an account no longer a
reporter without moving anything, and Admin → Accounts' payout closes the open
request - in `payoutRequests.test.js`.

Money is pinned in `credits.test.js` (exact thousandths: seven `$0.023`
resumes reserve `$0.161`, two refunds give back `$0.046`), `money.test.js` (the
one dollar parser and formatter - `$1`, `$4.1`, `$0.023`, `$0`, `$1,234.5`,
`-$0.046` - a guard that no money path floors,
truncates or float-parses an amount, and that the docs outside the release
history spell an amount the same way, with no padding zeros) and
`paymentFees.test.js` (a purchase credits exactly what it charges, by card and
by crypto).

The frontend has no test runner, so its decisions that need no browser are
small modules the backend suite transpiles and tests
(`frontendHelpers.test.js`, `frontendEditorHelpers.test.js`). What does need
one is in `backend/test/e2e/`, run by hand against servers that are already up:
`shell.js` walks every page as each role, `preview-vibration.js` opens the
profile editor with real scrollbars (puppeteer hides them by default) and
watches the preview's size every frame for each template, at the window sizes
where it used to shake, `section-switches.js` unticks Strengths and Soft Skills
in the same editor and reads the preview frame after each click, and
`dev-reload.js` opens a second tab against whichever
dev server is running and fails if the first one reloads or loses its run
(`devServer.test.js` holds the root `dev` to the mode that passed, and runs
the launcher's Windows fallback - as Windows, against a stand-in Next that
records what it is asked to run - since the real crash cannot be made on
Linux; `nextPin.test.js` holds `frontend/package.json` and its lockfile to one
exact Next, never one the Windows advisory names). `installCheck.test.js` runs
the check `npm run dev` makes first on fake trees, Windows paths among them,
then for real - on this checkout, where it must say nothing (skipped, saying
why, where the root's or the frontend's `node_modules` was never made, as in a
backend-only install), and on a copy of
the three `package.json` files with nothing installed, where it must name
`concurrently` and the copy's root - and holds `install:all` to
`--include=dev`, every script that starts `concurrently` to its `pre` hook and
the Troubleshooting row to the check's own words.

The documentation is checked too. `backend/test/envExample.test.js` reads
`.env.example` and this README against the table in
`backend/src/config/operational.ts`, and fails when a setting there is missing
from either, ships uncommented, or is shown with a default, a range or a
read-timing tag the code no longer matches.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Next.js 16 - pinned exactly, at **Next.js 16.3.8**, and never to one older than 16.3.3 ([GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36), remote code execution on a Windows-hosted server) - React 19, Tailwind CSS 4 |
| **Backend** | Express, TypeScript, better-sqlite3 |
| **AI** | Subscription seats only: Claude Code CLI (default), Codex CLI, Gemini CLI |
| **PDF** | Puppeteer |
| **DOCX** | html-to-docx |
| **Templates** | Handlebars |

---

## 📄 License

ISC
