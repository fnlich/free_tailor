# End to end, against running servers

The unit tests in `backend/test/*.test.js` prove each piece; the scripts here
prove the pieces are joined up, against a backend (and, for the browser ones,
a frontend) that are already running. None of them is part of `npm test`.

| Script | What it drives | Section |
|---|---|---|
| `walkthrough.js`, `browser.js`, `buy-credits.js` | Buying credits, over HTTP and in a browser, against fake payment providers (`fake-providers.js`) | [Running it](#running-it) |
| `refunds.js` | A reporter's payout request, the refund requests left from before, and Contact admin, with no provider at all | [Running it](#running-it), step 5 |
| `preview-vibration.js` | The profile preview holding still with real scrollbars | [The profile preview, held still](#the-profile-preview-held-still) |
| `section-switches.js` | The profile preview with Strengths and Soft Skills unticked, on uploaded-style templates and a built-in | [The profile preview, sections switched off](#the-profile-preview-sections-switched-off) |
| `immediate-run.js`, `sheet-panel.js` | Generate Immediately, Order and the sheet panel, against a stubbed seat and Google Sheet (`stub-seat.js`, `stub-sheets.js`) | [Building resumes, with the seat stubbed](#building-resumes-with-the-seat-stubbed) |
| `report-run.js` | Report Jobs and Admin -> Job Lake, against a stubbed sheet and seat (`stub-report-sheets.js`) | [Report Jobs and the job lake](#report-jobs-and-the-job-lake-with-google-stubbed) |
| `providers.js` | Admin -> Models -> Providers, against a stubbed seat | [Providers, with the seat stubbed](#providers-with-the-seat-stubbed) |
| `shell.js` | Every page as a user, an administrator and a reporter | [The shell, as every role](#the-shell-as-every-role) |
| `dev-reload.js` | A second tab must not reload the first, in each mode the frontend can be served in | [A second tab, in each dev mode](#a-second-tab-in-each-dev-mode) |

## Buying credits

A credit is a dollar. Every script here buys an amount of money (`amountUsd`),
expects exactly that much credit back, and reads every amount the API answers
with as thousandths of a dollar in a field ending `Milli` - `$20` on the
page, `20000` in the body (every significant decimal, no trailing zero:
`$0.023`, `$4.1`). A request in the old unit (a count of `credits`) is
expected to be refused as a stale page.

These files prove the purchase is joined up: a real server on a real port,
the real routers, the real database, the real webhook mount, and a browser
clicking the real pages.

The only thing faked is the company at the other end of the wire. There is no
way around that — a real end-to-end run needs live provider keys and a webhook
that can reach this machine from the internet, which is the checklist at the
bottom rather than something a script can arrange.

## What is faked, and what is not

`fake-providers.js` is loaded with `node --require` **before** the app, so it is
evaluated before the app requires its integration modules. It replaces every
function that reaches the network and nothing else: Stripe's
`createCheckoutSession`, `getCheckoutSession`, `refundPaymentIntent`,
`createCustomer`, `getPaymentIntent`, `getPaymentMethod`,
`detachPaymentMethod` and `chargeSavedCard`, plus Cryptomus's `createInvoice`.
The routes, the database, the webhook mount, the signature verification and the
ledger are all the shipping code.

It also serves a checkout page of its own on port 4242. Pressing **Pay** there
signs a webhook with the real scheme and posts it to the real endpoint, exactly
as the provider would; the server's own verifier decides whether to believe it.
For Cryptomus that means the signature goes INSIDE the body, which is the one
thing about it that is genuinely unlike Stripe.

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
CRYPTOMUS_MERCHANT_ID=e2e-merchant-not-a-real-id
CRYPTOMUS_PAYMENT_API_KEY=e2e_cryptomus_local_key
ADMIN_EMAILS=boss@example.com
EOF

# 2. The server, with the fake providers in front of it
cd backend && npm run build
node --require ./test/e2e/fake-providers.js dist/index.js

# 3. The API walkthrough, in another terminal
node test/e2e/walkthrough.js

# 4. The browser walkthroughs, with the frontend running too
npm run start --prefix ../frontend
node test/e2e/buy-credits.js   # the three-step purchase dialog; puppeteer
node test/e2e/browser.js       # the OLD buy page; needs playwright, which may not be installed

# 5. Payout and refund requests and Contact admin need NO provider at all: a card refund
#    that fails at Stripe is part of what they check, and the fake providers
#    would make it succeed. Stop step 2's server and start it bare, with the
#    Stripe keys blanked - an exported empty value beats the one in .env -
#    then point the script at the same DB_DIR the server uses.
STRIPE_SECRET_KEY= STRIPE_PUBLISHABLE_KEY= STRIPE_WEBHOOK_SECRET= DB_DIR=/path/to/db node dist/index.js
DB_DIR=/path/to/db node test/e2e/refunds.js
```

Every script exits non-zero on the first failing claim and prints every check.
`buy-credits.js`, `shell.js`, `refunds.js`, `immediate-run.js`, `sheet-panel.js`, `report-run.js` and `providers.js` use puppeteer, which the backend
already installs for PDF rendering, so they run anywhere this project does;
`browser.js` needs playwright and will not run on a checkout without it.

Off the default ports - beside another server, say - every script reads
`E2E_API`, `E2E_APP` and `E2E_FAKE` (the backend's `/api`, the frontend, the
fake provider), and `fake-providers.js` listens on `FAKE_PROVIDER_PORT` and
posts its webhooks to the server's own `PORT`. The frontend has to be BUILT
with `NEXT_PUBLIC_API_URL` naming that backend, and the backend started with
`FRONTEND_URL` naming the frontend, or its CORS gate refuses the page.

## The profile preview, held still

`preview-vibration.js` is not about payments: it watches the profile editor's
preview for the shake a scrollbar used to cause (README, Troubleshooting). It
launches puppeteer **with real scrollbars** - the default `--hide-scrollbars`
is why nothing else here could ever see it - opens one profile's editor, picks
each template in turn and reads the page's width and both scrollbars on every
animation frame. It needs the two servers up and `DB_DIR` naming the backend's
database, like the others:

```bash
DB_DIR=/path/to/db node test/e2e/preview-vibration.js
# E2E_VIEWPORTS=1920x937,1080xband  E2E_TEMPLATES=default  E2E_SECONDS=3
# E2E_NO_GUTTER=1 turns scrollbar-gutter off, to prove the editor's own guard
```

`1080xband` measures the narrow layout's Preview tab and watches it 5px inside
the band where, unfixed, the window's own scrollbar took itself away. Measured
before the fix (Linux Chrome, 15px scrollbars, a one-page profile, 19 built-ins
and two uploaded templates): at 1920x937 and 1903x937, 20 of 21 templates
alternated 533.3 <-> 518.3px every frame (180 changes in 181 frames) - all but
the uploaded one whose page ran to two pages; at 1440x900 none did; in the
narrow layout every width tried shook inside its band (1080x1450-1465,
1000x1360-1375, 900x1242-1257, 760x1382-1397, 600x1203-1218). After it: none of
84 template/viewport pairs, nor 80 in the narrow band, nor 20 with
`E2E_NO_GUTTER=1`.

## The profile preview, sections switched off

`section-switches.js` opens the profile editor as an administrator and
watches its preview frame while it unticks **Print a Strengths section**, then
**Print a Soft Skills section**, and ticks them back. It saves two
uploaded-style templates first (headings and loops only, no
`section-strengths` class) through the admin upload, and checks one built-in
beside them: a CSS-grid sidebar holding a photo, Strengths and a static
*References* block with Soft Skills under a divider in the main column, and two
columns with a bold *Strengths* label and a line break before its loop and
Soft Skills printed by `{{join}}`. Every state must show the heading and items
exactly when the switch is on, and Experience, Technical Skills, the photo, the
sidebar and every static line always. It deletes the templates and the profile
again at the end. It needs the two servers up and `DB_DIR` naming the
backend's database:

```bash
DB_DIR=/path/to/db node test/e2e/section-switches.js
# E2E_SHOTS=/some/dir saves the preview pane in every state
```

Against the finder before these templates were covered, 6 of its 15 states
failed: the sidebar went with its photo and *References*, and the Soft Skills
heading under its divider, the bold *Strengths* label and the `join`
section's heading all stayed.

## Building resumes, with the seat stubbed

`immediate-run.js` and `sheet-panel.js` need resumes actually BUILT, which
needs a model. `stub-seat.js` is that model: a `--require` preload, like
`fake-providers.js`, that registers a canned Claude seat before the app loads -
nothing is spawned, so a machine whose `claude` is signed in never spends its
owner's subscription on a test. Each call waits `E2E_STUB_DELAY_MS` (2500 by
default) so there is time to press Stop or leave a page mid-run, and an abort
is honoured as the real runner honours it - a signal already aborted when the
call starts is refused at once, so a stopped run's waiting resume is not built
and charged behind the check. Set
`E2E_OUTPUT_DIR` too: it writes the admin *Output folder* setting at boot, so
the runs' PDFs land there and not in the repository's `generated/`.
`stub-sheets.js` adds Google Sheets for `sheet-panel.js` - every account's job
sheet exists, with an older day's tab, today's and a Notes tab, and rows held
in memory, today's first row already carrying its six analysis cells (K:P) -
through the same three seams the unit tests use (the account sheet's client,
the range reader `POST /api/import` calls, and the analysis columns' client:
the tab verify, reported intact, the one batched read of a sheet run's rows,
and the write-back). All three share the rows, so what a run writes back is
what the next *Load rows* shows. `stub-seat.js`'s canned analysis carries a job
field, a salary and the filter facts. Everything else is the shipping code:
routes, the analysis gate and its trust rule, the queue, the tab lease, order
rows, files.

```bash
cd backend && npm run build
E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
  node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-sheets.js dist/index.js
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-db node test/e2e/immediate-run.js   # E2E_DOWNLOADS=<dir> keeps the files
DB_DIR=/tmp/e2e-db node test/e2e/sheet-panel.js
```

Leave `IMMEDIATE_TAB_GRACE_MS` at its default: `immediate-run.js` tells the
page's own release from the server's 30-second grace by how soon the run
stops.

The stub's delay applies only to a call that reaches it. A posting analysed
once is never analysed again, and the tailoring cache answers the same posting,
profile and model with no call at all, so a repeat build is near-instant - it
finishes in PDF time, before anything can be stopped. The timing checks
therefore give every queued JOB a posting of its own (`immediate-run.js`'s
`postingsFor`, `... Ref <submission>-<job>.`); a script written later that
needs a run still going when it acts has to do the same, per job and not per
submission, or jobs 2..N of a run hit the cache the moment the first is
tailored.

`immediate-run.js` — 29 claims, on the Default subscription. The first
Generate Immediately asks first, in the owner's sentence, with *Don't show
again*, and after it is ticked the next click goes straight through; the run
shows progress and Stop, ends saying what it built, and its resume reaches the
browser's download folder by itself, named for the company and the person, and
is listed under the progress to download again. A run queued for the tab is
picked back up by that tab after a reload - and never by a second tab, which
gets an id of its own - followed to its end with every file of every resume
handed to the browser exactly once. Stop mid-run says what was refunded and
the server has it cancelled. A rail link while a run goes asks first: Cancel
stays, OK leaves and the run is cancelled at once, and back on Build Resumes
the page says how it ended. An order's live row on Orders offers Cancel, which
asks, then says what it stopped; Orders lists that order and none of the
immediate runs. Closing the tab cancels its run inside five seconds - the
pagehide release, not the grace.

What the browser SAVES is counted apart from what the page hands it: headless
Chrome lets a page start only so many downloads by itself (about ten) and then
drops the rest without a word, which is exactly the "multiple files" prompt a
real person sees (README, Troubleshooting) and why the page lists the run's
files to download again. The handed-over count is the page's promise; the saved
count only has to be more than nothing.

`sheet-panel.js` — 30 claims. The sheet card has no *Import from Google Sheet*
button; the Tab select lists every tab in the spreadsheet's order and starts
on today's, marked *(today)*; nothing can be built before rows are loaded.
*Load rows* shows a job per row with a company and a description (rows 2, 3
and 5 of today's tab), a link only where the cell is a web address (not the
`javascript:` one), *From the posting* where there is no title, and the count
of rows skipped; then Order and Generate Immediately, with the run priced. The
table's Analysis column says *Skips analysis* - with the row's Job Field and
Salary - for the row whose Analysis cell is filled, and *When built* for the
others, and the line above it counts them (*1 of 3 already analysed*); a tab
with nothing in its analysis columns has no row that skips.
Another tab drops what was loaded and loads its own rows. Order answers with an
order number and Cancel on the receipt asks, cancels, and the order reads
cancelled on Orders; Generate Immediately builds the loaded rows here and
hands each of their twelve files to the browser once - and, reloaded after it,
every row says *Skips analysis*: the two it analysed (or found stored) were
written back. At 390px the loaded table scrolls inside its box rather than
widening the page. The server's log shows the run's analysis calls (`[e2e
stub] call N: analyze-job-description`): today's run makes none.

## A second tab, in each dev mode

`dev-reload.js` is the owner's report reproduced: with the root `npm run dev`
running, opening a second tab reloaded the first - and, a Build Resumes tab
reloading releases its Generate Immediately run, so it also STOPPED that run.
Nothing in the app reloads a tab: Next 16.1's webpack dev server sends every
open tab a `SYNC` with the latest build hash when a new tab connects, and a tab
holding an older one (anything compiled since it opened - the page the new tab
asked for, say) calls `window.location.reload()`. The script opens Build
Resumes in tab A and marks it, opens a page nothing has compiled yet in tab B,
waits `E2E_WAIT_MS` (10 s) and requires tab A to keep its mark and load nothing;
then the same with a Generate Immediately run going in tab A (tab C opening
another uncompiled page), which must keep running and finish as built.

Start the frontend FRESH for each mode, so tab B and tab C really ask for
uncompiled pages (`E2E_ROUTE_B`, `E2E_ROUTE_C`; `/orders` and `/calendar` by
default), against a backend with the stub seat slow enough that one resume
outlasts the wait:

```bash
cd backend && npm run build
E2E_STUB_DELAY_MS=6000 E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
  node --require ./test/e2e/stub-seat.js dist/index.js
npm run dev:live --prefix frontend      # then dev:turbo, then dev (production-style)
DB_DIR=/tmp/e2e-db E2E_APP=http://localhost:3000 E2E_MODE=dev:live node test/e2e/dev-reload.js
```

Against a dev server use `localhost` for `E2E_APP`: Next refuses its dev
resources to any other origin that `NEXT_PUBLIC_ALLOWED_DEV_ORIGINS` does not
name. Measured on Next 16.1.6 (this release): `dev:live` (webpack) failed - tab
A reloaded each time a tab opened, and its run was cancelled (*Your last run
ended while this page was away*); `dev:turbo` (Turbopack) passed all 8 claims,
twice (10 s, then 15 s on `/credits` and `/jobs`); the production-style `dev`
passed all 8. So the root `npm run dev` runs `dev:turbo`, and `npm run dev:live`
keeps webpack for whoever asks for it by name - `test/devServer.test.js` holds
the scripts to that.

## Report Jobs and the job lake, with Google stubbed

`report-run.js` drives a reporter's run and the administrators' lake in a
browser. `stub-report-sheets.js` is its Google: every account's job sheet
exists with an older day's tab, today's and a tab of the reporter's own (*My
notes*, whose header is not the job sheet's), rows in memory, and the admin
sheet a list in memory - through the four seams the unit tests use (the account
sheet's client, the report run's, the analysis columns' and the admin sheet's).
The first three share the rows, so the Lake Status a run writes is what the
next preview reads. `stub-seat.js` answers every analysis as a Backend posting.
Today's tab: *Acme Corp* (added), *ACME, Inc.* (the same company once
normalised, so a duplicate), *Globex LLC* (added), *Initech* (its Lake Status
already *Added*, beside the Analysis cell an earlier run wrote for its
posting), a row with no company and one with no description and a
`javascript:` link (both Skipped). The script sets the global rate to $0.05
itself.

```bash
cd backend && npm run build
E2E_STUB_DELAY_MS=700 DB_DIR=/tmp/e2e-db PORT=3001 \
  node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-report-sheets.js dist/index.js
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-db node test/e2e/report-run.js
```

`report-run.js` — 35 claims, on a fresh database (the stub's rows live in the
server's memory, so a second run against the same server finds them reported).
Report Jobs opens on today's tab, rows 2-501, with the rate per job; Add to job
lake waits for a preview; *My notes* is refused in the run's own words before
anything starts; the preview lists the six rows, *Initech* marked as reported
before and the `javascript:` link as text; the run shows its bar and ends with
*2 out of 5 was added, your current credit is $0.1* over every row's outcome,
the duplicate - only it - red, each added row $0.05; the same rows previewed
again say they were reported (the two Skipped are tried again); the top bar's
balance moved; no horizontal scrollbar at 390px; in the dark theme the last run
comes back with its duplicate in the dark red. Then as an administrator: Job
Lake is a Settings tab and lists the two jobs; *acme inc* finds *Acme Corp*;
Details shows the reward, the reporter and the history; Delete with *Also
revoke the reward* takes the job and exactly its $0.05 back off the reporter;
Settings shows the stored rate, the window *60 (the default)* and the admin
sheet with every job on it, *Retry now* has nothing to send, and $0.0505 is
refused under the rate box; Merge has nothing to merge; Admin -> Accounts' rate
boxes say *Global rate ($0.05)*.

## Providers, with the seat stubbed

`providers.js` drives Admin -> Models -> Providers, the per-provider cards on
Settings -> General and the provider on an order's page. `stub-seat.js` is
registered under the Claude TYPE, so it answers for every Claude provider the
script adds; Codex and Gemini are whatever this machine has (usually *Not
ready*, which is what their rows then say). The added provider's sign-in folder
is made under `E2E_HOMES` (default: a fresh folder in the system temp dir),
which must be outside the checkout, `DB_DIR` and the output folder - the server
refuses a folder inside any of them. A stub delay of a few seconds gives the
script time to try removing a provider while it builds.

```bash
cd backend && npm run build
E2E_STUB_DELAY_MS=4000 DB_DIR=/tmp/e2e-db PORT=3001 node --require ./test/e2e/stub-seat.js dist/index.js
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-db node test/e2e/providers.js
```

`providers.js` — 31 claims. The table lists the three built-in providers in
catalog order, each marked *Built-in* with no Remove, each value saying where
it comes from, the stub Claude seat *Ready*. Add provider: a relative folder is
refused under its box before anything is sent; a folder that does not exist is
refused by the server and its sentence pinned under the same box; a real one
adds *Team B* after the built-in Claude provider, its limit *Set here*, its
binary the built-in's. Edit: a limit of 40 refused in the server's words, 3
saved; the built-in's form starts empty (`.env` decides), a limit of 5 set
there wins, and cleared it is `.env`'s again. Switch off and on; Check now
checks afresh. Settings -> General draws a card for *Team B (Claude)* and the
Claude row counts *1 of 2* providers that can take work (the built-in one
switched off). An order then runs on Team B, Remove is refused while it builds
- in the server's sentence, the row still there - and once the order is done
its page says *Built on Team B (Claude)* to the administrator; idle, Team B is
removed. No horizontal page scroll at 390px. An ordinary account's order page
and API answer name no provider, and the provider and health routes refuse it.

## The shell, as every role

`shell.js` walks every page as a user, an administrator and a reporter, in
both themes and at 1440 and 390, with the two servers up and `DB_DIR` naming
the backend's database (it writes the sessions, and the reporter's balance,
straight into it):

```bash
DB_DIR=/path/to/db node test/e2e/shell.js
```

The reporter half (owner decision A3): their four pages - Report Jobs, Credits,
Settings -> Profile and Job Sheet - each stay put, under a rail of Report Jobs,
Credits and Settings, with only those two Settings tabs; Credits is their
earnings and the payout the administrator just recorded, with no Purchase
Credits and no order or refund tabs, but *Ask for Refund* - a payout request -
in Purchase Credits' place and style, and their *Payout requests* listed; the
account menu has
no subscription; and every other address - every route the other two roles
walk, plus /admin, an order, an invoice and /account - lands on Report Jobs.
Every API answer the reporter's page gets is watched, and the walk fails on a
single 403: a page of theirs that asked a builder route, or a bounced page
that mounted before it was sent away, would show here. A user made a reporter
while their page is open is taken to Report Jobs by their next request. On
Admin -> Accounts: Reporter in the role select and the invite form (which
then asks for a rate per job rather than a subscription), a rate typed into a
reporter's row stored as thousandths, and Record payout refusing more than the
balance in the server's words, saying what a payout leaves, and recording it.
Neither a user nor an administrator is offered *Ask for refund* on any page
they walk (owner decision R1), and the Refund Requests tab says to contact the
administrator, with the link.

The job analysis, as an administrator sees it (owner decisions J0, J1): Admin
-> Prompts lists no Filter Google Sheet Job prompt, and Analyze Job
Description is one prompt - no New Variant, Duplicate, Save Active or model
override, and a sentence saying why; Admin -> Settings -> General has a Job
Analysis section whose Analysis model select starts on the app default, with
its own Save.

## Sign-in is seeded, deliberately

`services/auth/mailer.ts` refuses to pretend an email was sent, so there is no
offline path to a login code and no dev backdoor. Rather than add one, these
scripts write a session row directly and send its token as a Bearer token —
which is what the browser would be carrying anyway. Sign-in is not what these
scripts are testing.

## What they check

`walkthrough.js` — 44 claims over HTTP: both methods offered with their bounds
in thousandths and no price per credit; a request carrying its own price priced
by the server anyway, an amount in fractions of a cent refused, and a count of
credits from a stale page refused;
a checkout that credits nothing until the webhook lands; the return URL
visited before paying crediting nothing; a card crediting on a signed event
and crypto crediting on a signed Cryptomus callback for its whole amount, with
no fee, offered as one button rather than a row per coin; a retried delivery crediting nothing further; a cancelled checkout closing without crediting;
another account's payment answering 404; forged and unsigned webhooks refused;
the admin list and a refund that reports what it reversed; the amount the
provider was actually asked for; and an event payload that keeps the amount
and drops the customer.

`buy-credits.js` — 110 claims over the three-step dialog and the credits page,
a third of them through HTTP first because the browser half needs what they
leave behind. Over HTTP: each method judged by its own bounds and presets that
fall inside them; an `asset` from a stale tab ignored rather than refused, and
unable to change the price; a purchase that asks to keep the card keeping it,
and one that does not, not - even for an account that already has a customer;
a saved card that is the owner's alone to charge or delete, and answering 404
to anybody else; and an off-session charge settling through
`payment_intent.succeeded` against a `pi_` reference and crediting exactly
once. Then with a mouse: only what the installation can serve offered; a
preset agreeing with the server's own figure; an amount above the ceiling
priced AT the ceiling and saying so, and a fraction of a cent refused with
Continue switched off; Back preserving the amount; a summary with the same
figure charged and credited and no fee on it; the summary pricing
itself without opening a checkout, so looking at it costs the buyer nothing;
the order appearing when the new-card form is asked for; the form mounting or
saying plainly that it could not; Escape closing; and nothing hanging off the
side at 1440 or 390, in either theme. A method that is switched off is shown
twice: to an administrator with its reason, wrapped rather than clipped (the
`buy-1-unavailable-*.png` screenshots), and to the buyer as *Not available
right now. Please contact your administrator.* with no setting named. On the credits page: four tabs - Card,
Crypto, Credit History and Refund Requests - over one table at a time, the card
list opening on ten rows and saying how many there are, Next, Previous, Last
and First moving between real pages, and a page whose request FAILS keeping
its rows while the count sentence still describes them - a failed press used
to leave rows 1-5 under "6-10 of 12". At 390 the table scrolls inside its box
and the tab row inside itself, its cut edge faded (`data-more`), and nothing
else leaves the window. On the invoice page: an unpaid
order says *No invoice yet* and offers no Print button, and the same order once
paid is an invoice with exactly one, one line of credit at its charge and
`$0` of fees. A purchase's Action(s) are Invoice and Help and nothing else, and
Credit History has no Action column: nothing asks for a refund. The top-bar pill follows a payment that lands while the
return page is open, in dollars. It screenshots each step.

`buy-credits.js` also drives a whole crypto payment through the fake Cryptomus:
one button rather than a row per coin, the hand-off panel naming whose page
comes next, a callback signed the way Cryptomus signs one crediting the whole
amount, and a retried callback crediting nothing further.

`browser.js` — needs playwright, so it does NOT run on a checkout without it,
and that is how its `Your payments` selector survived three commits past the
heading being renamed to *Payment history*. Read the page for the current
wording before trusting a locator in here. The same purchase with a mouse, now
that the form is embedded:
the buy page priced from the server; pressing Pay navigating NOWHERE and the
dialog opening in place; the form either mounting or saying plainly that it
could not; the return page waiting for the webhook rather than congratulating
on arrival; the balance and the ledger afterwards; backing out of a payment;
and an admin refunding from the UI.

`refunds.js` — 62 claims over a reporter's payout request, the refund requests
left from before asking was removed, and Contact admin, with no provider at all
(step 5 above - against step 2's server, whose fake Stripe accepts every
refund, the card checks fail, and the first of them says why): its purchases,
run charge and order are written straight into the database the server reads
(so `DB_DIR` must name the backend's), paid the way a webhook pays them, and
the four older requests are made through the service the routes used to call
(`createRefundRequest`, kept unrouted). Nobody but a reporter asks (owner
decision R1): a stale page's ask is answered 410 in the sentence that says to
contact the administrator; a user's paid purchase offers Invoice and Help and
no *Ask for refund*, Credit History has no Action column, an order's page has
no Refund column (the resume that did not build still offers Contact admin),
and the Refund Requests tab lists the older request read-only, saying to
contact the administrator, with the link. The reporter: *Ask for Refund* where
a user's Purchase Credits sits, in its pill, off at $0 with the server's reason
under it, on once they have earned $5; the dialog asks for the whole balance
with no amount to type and an optional note, sends with its reference, and the
button is off again while the request is open, which is listed under *Payout
requests*. The administrator: the bell announcing it with a link that lands on
the queue tab and its open count; the payout row marked *Payout* with *Balance
now $6.5* once the reporter earned more, and *Record payout*; every Approve,
Decline, Mark refunded and Record payout inside the queue's box at 1440x900,
with no sideways scroll; Record payout prefilled with the $5 asked, refusing a
missing note and more than the balance in the server's words, and recording
$6.5 - more than was asked, up to the balance (owner decision R2) - as one
`reporter-payout` row. Then the older requests: a crypto refund saying to send
the money back by hand FIRST and refusing to go on until that is confirmed; a
decline refused without a reason; a resume credited back; a card refund that
fails at Stripe (there are no Stripe keys here) answering the generic sentence
with its Ref and a Contact admin link - which opens a dialog OVER the refund
dialog, closed alone by Escape with the page's scroll still locked until the
second Escape; the request then still open with nothing outstanding and the
credit the refund held back on the balance; the same dialog-over-dialog Escape
on the payments list's own Refund dialog, whose typed note survives; and the
state filter in the address, the payout *Paid out* there. Then the person
again: Refunded with what came back, Declined with the administrator's reason,
both in their bell marked *For you* and linked to their Refund Requests tab,
the credit as its own row - and nothing in a bystander's feed. The reporter
again: *Paid out*, *$6.5 paid out to you.*, the payout in Earnings and
Payouts, the button off at $0, and *Payout recorded: $6.5* in their bell
linking to Credits. Last, Contact admin from the account menu (a `mailto:`
link, a Discord name to copy) and the editor pinning the server's refusal of a
bad Telegram name to that row, with nothing saved; and both Credits pages at
390 with no sideways scroll. The person, the reporter and the administrator
browse in separate browser contexts: a sign-in is a cookie and a localStorage
token, and one context would share them.

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
7. **Cryptomus, every step below.** This is the row that matters most on this
   list, and it is not optional: **no call in this repository has ever reached
   Cryptomus.** It was built on a machine that cannot resolve
   `api.cryptomus.com`, so the endpoint path, the header names, the field
   names, the signature formula and the status vocabulary all come from the
   published reference and are pinned only by tests against a stubbed socket.
   Those tests prove the shape does not change by accident. They cannot prove
   it was ever right.

   a. Put a real merchant id and payment API key in `.env`, restart, and
      confirm the **Crypto** button is offered.

   b. Open one invoice for the smallest amount your limits allow, and compare
      the request this server logged against Cryptomus's current API reference
      - path, header names, field names, and how `sign` is computed. A wrong
      guess here is a 4xx with nothing in it that says which guess was wrong.

   c. Pay it. Confirm the callback arrives, verifies, and credits. If it is
      refused with *Signature verification failed*, the first thing to try is
      JSON escaping: Cryptomus signs the serialized body, PHP escapes `/` as
      `\/` by default and JavaScript does not, and callback bodies carry URLs.
      One line, in `verifyWebhookSign`.

   d. Re-send that same callback. It must credit **nothing** the second time -
      Cryptomus retries until it gets a 2xx, so this is ordinary traffic and
      not an attack.

   e. Underpay one invoice and let another expire. Neither may credit, and
      neither may sit silent: check the payment's own page and the backend log.

   f. Confirm the statuses Cryptomus actually sends match the three sets in
      `integrations/cryptomus.ts`. A status that belongs in `PAID_STATUSES` and
      is not there is a customer who paid and got nothing; one in there that
      should not be is credits given away.

   g. If anything sits in front of this server, allow Cryptomus's callback
      addresses through. The signature is the only authentication this endpoint
      has, and it is the only one it needs - but an endpoint nothing can reach
      credits nobody.
