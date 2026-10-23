# End to end, against running servers

The unit tests in `backend/test/*.test.js` prove each piece; the scripts here
prove the pieces are joined up, against a backend (and, for the browser ones,
a frontend) that are already running. None of them is part of `npm test`.

| Script | What it drives | Section |
|---|---|---|
| `walkthrough.js`, `browser.js`, `buy-credits.js` | Buying credits, over HTTP and in a browser, against fake payment providers (`fake-providers.js`) | [Running it](#running-it) |
| `refunds.js` | A reporter's payout request, the refund requests left from before, and Contact admin, with no provider at all | [Running it](#running-it), step 5 |
| `preview-vibration.js` | The resume preview holding still with real scrollbars | [The resume preview, held still](#the-resume-preview-held-still) |
| `section-switches.js` | The resume preview with Strengths and Soft Skills unticked, on uploaded-style templates and a built-in | [The resume preview, sections switched off](#the-resume-preview-sections-switched-off) |
| `skills-layouts.js` | Every template laid out in both Technical Skills layouts, and the Grouped / Plain switch in the template chooser and Admin -> Templates | [Both skills layouts, in a browser](#both-skills-layouts-in-a-browser) |
| `immediate-run.js`, `sheet-panel.js` | Generate Immediately, Order and the sheet panel (one profile, in one build mode), against a stubbed seat and Google Sheet (`stub-seat.js`, `stub-sheets.js`) | [Building resumes, with the seat stubbed](#building-resumes-with-the-seat-stubbed) |
| `profiles.js` | The Profiles pages (a profile is a person holding that person's resumes) and the three build modes - Choose Suitable Resume, Partial Tailor, Fully Tailor - against a stubbed seat and Google Sheet (`stub-seat.js`, `stub-sheets.js`) | [Profiles and the three build modes, with the seat stubbed](#profiles-and-the-three-build-modes-with-the-seat-stubbed) |
| `subscription.js` | Settings -> Subscription bought from the credit balance, the spend alert, the renewal sweep, and the one lock left (adding a profile past the tier's limit), against a stubbed seat | [Subscriptions, the locks and the spend alert](#subscriptions-the-locks-and-the-spend-alert) |
| `report-run.js` | Report Jobs and Admin -> Job Lake, against a stubbed sheet and seat (`stub-report-sheets.js`) | [Report Jobs and the job lake](#report-jobs-and-the-job-lake-with-google-stubbed) |
| `lake-push.js` | Admin -> Job Lake's filter form and Push to Google Sheet, and a build from the pushed rows, against a stubbed sheet and seat (`stub-lake-push-sheets.js`) | [Push to Google Sheet](#push-to-google-sheet-with-google-stubbed) |
| `find-jobs.js` | Find Jobs: the lake searched with several values, rows picked across pages, Export into Sheet and Order Immediately (one profile, in one build mode), against the same stubbed sheet and a stubbed seat | [Find Jobs](#find-jobs-with-google-stubbed) |
| `providers.js` | Admin -> Models -> Providers, against a stubbed seat | [Providers, with the seat stubbed](#providers-with-the-seat-stubbed) |
| `shell.js` | Every page as a user, an administrator and a reporter - the Profiles dashboard, the builder's profile and mode choices and the one lock left among them | [The shell, as every role](#the-shell-as-every-role) |
| `dev-reload.js` | A second tab must not reload the first, in each mode the frontend can be served in | [A second tab, in each dev mode](#a-second-tab-in-each-dev-mode) |

**Start every e2e backend with a preload from here** - the script's own
sheets stub (`--require ./test/e2e/stub-sheets.js` or its kin), and for a
backend that needs no stub at all, `--require ./test/e2e/no-google.js`. A
backend finds `backend/google-oauth-credentials.json` or a service-account
key by itself, beside its own compiled code, and blanking `GOOGLE_*` in the
environment does not stop that search: every account a script signs in then
gets a REAL spreadsheet in that Google account (its job sheet is made at
sign-in). `no-google.js` turns the search off
(`TAILOR_GOOGLE_CREDENTIAL_SEARCH=off`) and blanks both path variables, as
`npm test` does; every stub and `fake-providers.js` requires it first, before
anything loads the backend. A backend started with NO preload still finds a
real credential. The startup log says so - *Using user credentials* or
*Using service account* - and a backend that prints either is talking to
Google.

**Build the frontend with `npm run build --prefix frontend`** before a run
that judges what it draws. Next 16.3's build cache once shipped a stylesheet
older than `globals.css` (the list boxes unstyled, a removed rule back), so
`next.config.ts` now switches it off for builds and every build is cold; if
you see old styles anyway, `rm -rf frontend/.next/cache/turbopack` first. A
page that moved or was deleted since the last `next dev` stays named in
`frontend/.next/dev`, and the build's type check then fails on it (v4.2 moved
the resume chooser and editor to `/admin/resumes/...`): delete
`frontend/.next/dev` first (README, Troubleshooting).

## Buying credits

A credit is a dollar. Every script here buys an amount of money (`amountUsd`),
expects exactly that much credit back, and reads every amount the API answers
with as thousandths of a dollar in a field ending `Milli` - `$20` on the
page, `20000` in the body (every significant decimal, no trailing zero:
`$0.023`, `$4.1`). A request without an amount in dollars is expected to be
refused, whatever else it names.

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
STRIPE_SECRET_KEY= STRIPE_PUBLISHABLE_KEY= STRIPE_WEBHOOK_SECRET= DB_DIR=/path/to/db \
  node --require ./test/e2e/no-google.js dist/index.js
DB_DIR=/path/to/db node test/e2e/refunds.js
```

Every script exits non-zero on the first failing claim and prints every check.
`buy-credits.js`, `shell.js`, `refunds.js`, `immediate-run.js`, `sheet-panel.js`, `subscription.js`, `report-run.js`, `lake-push.js`, `find-jobs.js`, `providers.js` and `profiles.js` use puppeteer, which the backend
already installs for PDF rendering, so they run anywhere this project does;
`browser.js` needs playwright and will not run on a checkout without it.

Off the default ports - beside another server, say - every script reads
`E2E_API`, `E2E_APP` and `E2E_FAKE` (the backend's `/api`, the frontend, the
fake provider), and `fake-providers.js` listens on `FAKE_PROVIDER_PORT` and
posts its webhooks to the server's own `PORT`. The frontend has to be BUILT
with `NEXT_PUBLIC_API_URL` naming that backend, and the backend started with
`FRONTEND_URL` naming the frontend, or its CORS gate refuses the page. Name
both by `127.0.0.1`, as the defaults do, not `localhost`: `immediate-run.js`
sets its session cookie for `127.0.0.1`, and the cookie is all the pagehide
release carries across origins - under `localhost` its two release checks
fail (*...and OK leaves, and stops the run at once*, *closing the tab stops
its run at once*) with the run left going. Set `E2E_SHOTS` to a folder of
your own unless you mean to replace the screenshots committed here.

## The resume preview, held still

`preview-vibration.js` is not about payments: it watches the resume editor's
preview for the shake a scrollbar used to cause (README, Troubleshooting). It
launches puppeteer **with real scrollbars** - the default `--hide-scrollbars`
is why nothing else here could ever see it - opens one resume's editor
(`/admin/resumes/<id>`: the signed-in account's first resume, as
`GET /api/resumes` lists them, or the one `E2E_RESUME_ID` names; with neither
it makes a profile with one resume for the purpose and deletes the profile
again at the end), picks each
template in turn from the editor's `#resume-template` select, **in each
layout** (every template prints both, and Plain changes the page's height,
which is what the shake depends on), and reads the page's width and both
scrollbars on every animation frame. It needs the two servers up and `DB_DIR`
naming the backend's database, like the others:

```bash
DB_DIR=/path/to/db PORT=3001 node --require ./test/e2e/no-google.js dist/index.js   # the backend
DB_DIR=/path/to/db node test/e2e/preview-vibration.js
# E2E_VIEWPORTS=1920x937,1080xband  E2E_TEMPLATES=default  E2E_SECONDS=3
# E2E_RESUME_ID=<a resume of the account> opens that one, not the account's first
# E2E_NO_GUTTER=1 turns scrollbar-gutter off, to prove the editor's own guard
```

A passing run ends with a line like *N template/layout/viewport
combination(s) watched for Ns each: none shook.* (N follows the installation's
templates and `E2E_VIEWPORTS`; the v4.2 gate run watched 208).
`1080xband` measures the narrow layout's Preview tab and watches it 5px inside
the band where, unfixed, the window's own scrollbar took itself away. Measured
before the fix (Linux Chrome, 15px scrollbars, a one-page resume, 19 built-ins
and two uploaded templates): at 1920x937 and 1903x937, 20 of 21 templates
alternated 533.3 <-> 518.3px every frame (180 changes in 181 frames) - all but
the uploaded one whose page ran to two pages; at 1440x900 none did; in the
narrow layout every width tried shook inside its band (1080x1450-1465,
1000x1360-1375, 900x1242-1257, 760x1382-1397, 600x1203-1218). After it: none of
84 template/viewport pairs, nor 80 in the narrow band, nor 20 with
`E2E_NO_GUTTER=1`.

## The resume preview, sections switched off

`section-switches.js` opens the resume editor as an administrator and
watches its preview frame while it unticks **Print a Strengths section**
(`#resume-include-strengths`), then **Print a Soft Skills section**
(`#resume-include-soft-skills`), and ticks them back. It saves two
uploaded-style templates first (headings and loops only, no
`section-strengths` class) through the admin upload, and checks one built-in
beside them: a CSS-grid sidebar holding a photo, Strengths and a static
*References* block with Soft Skills under a divider in the main column, and two
columns with a bold *Strengths* label and a line break before its loop and
Soft Skills printed by `{{join}}`. Every state must show the heading and items
exactly when the switch is on, and Experience, Technical Skills, the photo, the
sidebar and every static line always. A resume lives in a profile (a person),
so it first makes a profile of its own and files the resume it opens under it
(`POST /api/resumes?profileId=`); every template is offered to every resume,
so the editor's template select lists the saved ones with the built-in, none
disabled; and at the end it deletes the resume, the profile and the
templates. It needs the two servers up and `DB_DIR` naming the
backend's database:

```bash
DB_DIR=/path/to/db PORT=3001 node --require ./test/e2e/no-google.js dist/index.js   # the backend
DB_DIR=/path/to/db node test/e2e/section-switches.js
# E2E_SHOTS=/some/dir saves the preview pane in every state
```

A passing run ends *Every state matched.* (it counts states, not claims).
Against the finder before these templates were covered, 6 of its 15 states
failed: the sidebar went with its photo and *References*, and the Soft Skills
heading under its divider, the bold *Strengths* label and the `join`
section's heading all stayed.

## Both skills layouts, in a browser

`skills-layouts.js` checks what only a browser can say about the two
Technical Skills layouts, which every template prints. It draws every enabled
template - the built-ins and whatever the installation has saved - from the
gallery route in each layout, lays it out at the printed page's size
(794x1123), and asks: in **Plain**, does every child of an element the Plain
net marked (`data-plain-skills`) span its holder's width with no minimum
height (Burgundy Rule's and Navy Rule's one headless group used to fill one
third-width cell of their grid), and are those two marked at all; in
**Grouped**, does any line of a leaf block - a `p`, `li`, `td` or a `div` with
no block children, a line ending at a `<br>` - hold both the sample's
*Languages* and *Frameworks* headings (the owner's ATS templates used to print
Grouped as one run-on paragraph). Then it saves an uploaded-style three-column
grid through the admin upload, checks it the same way and deletes it; opens a
template's details in the chooser for a profile it makes
(`/admin/resumes/new?profile=<id>`), presses **Plain** in
its *Technical skills* switch, and checks that the page frame asks for
`layout=flat` and that **Use this template** opens the editor
(`/admin/resumes/new?template=<id>&layout=flat&profile=<id>`, the profile kept)
with Plain ticked (no resume is saved, and the profile is deleted again at the
end); and on **Admin → Templates** presses **View**, then
**Plain**, and checks that the frame and *Open in new tab* ask for
`layout=flat` and that the viewer stayed open - its overlay closes on any
click that reaches it. On both pages, **Plain**, **Grouped** and **Plain**
again - each page loaded before the next press - must add nothing to the
browser's history (a loaded frame sent to another address added an entry a
press, and Back then turned the page back under the switch). In the details,
the arrow keys pressed on the switch must not step to another template; the
viewer must take focus when it opens and give it back to **View** when Escape
closes it. Both pages are checked at
1440x900 and 390x844, where the switch must sit inside the window with nothing
scrolling sideways. It needs the two servers up and `DB_DIR` naming the
backend's database; point the backend's `TAILOR_STATIC_DIR` at a copy of
`backend/static`, so the template it saves for a moment never lands beside
your own:

```bash
TAILOR_STATIC_DIR=/path/to/static-copy DB_DIR=/path/to/db PORT=3001 \
  node --require ./test/e2e/no-google.js dist/index.js   # the backend
DB_DIR=/path/to/db node test/e2e/skills-layouts.js
# E2E_SHOTS=/some/dir saves the details and the viewer with Plain pressed, at both widths
```

A passing run ends *Every check passed.*

## Building resumes, with the seat stubbed

`immediate-run.js`, `sheet-panel.js` and `profiles.js` need resumes actually
BUILT, which needs a model. `stub-seat.js` is that model: a `--require` preload, like
`fake-providers.js`, that registers a canned Claude seat before the app loads -
nothing is spawned, so a machine whose `claude` is signed in never spends its
owner's subscription on a test. It answers each prompt by its call site, and
fails loudly on one it does not know. Each call waits `E2E_STUB_DELAY_MS`
(2500 by default) so there is time to press Stop or leave a page mid-run - a
new posting's analysis is two calls (the keywords and the facts), made side
by side, so it still takes one delay (*Stored analysis ... in 2.51s*), and a
resume whose draft leaves a term out takes one more for its revise pass - and an abort
is honoured as the real runner honours it - a signal already aborted when the
call starts is refused at once, so a stopped run's waiting resume is not built
and charged behind the check. Set
`E2E_OUTPUT_DIR` too: stub-seat.js hands it to the app as `OUTPUT_BASE_DIR`
(unless that is set already), the `.env` default under the admin *Output
folder* setting, so the runs' PDFs land there and not in the repository's
`generated/` - and nothing is stored, so the page reads *From .env*.
`stub-sheets.js` adds Google Sheets for `sheet-panel.js` - every account's job
sheet exists, as an upgraded sheet looks: **All** and **Temp For AI** in the
twelve-column layout (A to F the user's, G to L the analysis's), an older
build's daily tab in ITS layout (Company in B, sixteen columns), and *Notes*, a
job tab of the person's own; rows held in memory, All's first row already
carrying its six analysis cells (G:L), whose Analysis cell names an analysis
the stub stores in the server's own database the first time the tab is read -
a build trusts a cell only when it names its posting's stored analysis, so a
canned id the store never had would be analysed and replaced, and the panel's
*Skips analysis* would be the page's word alone - through the same three seams the unit
tests use (the account sheet's client - the tab list and the one batched read
of every tab's row 1 the layouts come from - the range reader `POST
/api/import` calls, and the analysis columns' client: the tab verify, reported
intact on a job tab, the one batched read of a sheet run's rows, and the
write-back, which throws on the old tab) - plus the Job Filter's tab
inspection and its read of C:E, which the route calls directly. All three share the rows, so what a run writes back is
what the next *Load rows* shows. `stub-seat.js` answers the analysis call with
one canned set of keywords, the same for every posting (TypeScript and Docker,
a *Senior Engineer*), and the facts call with its job type, clearance,
salary (no currency, as the facts prompt asks for none), company category and
job field; the tailoring in the shipped prompt's shape (`skillGroups` with the
soft skills last, no role description), its summary carrying every term of
that analysis, so a resume whose role it names gets no revise pass; and a
revise call, when one comes (a resume whose own words name a checklist term
that summary lacks, or whose own bullets carry a figure the stub's answer
drops), with no change - one more delayed call.
Everything else is the shipping code:
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

Give `sheet-panel.js` a database of its own (a fresh `DB_DIR`, the backend
restarted on it) once `immediate-run.js` has run on one: the two share a
posting's text, and `immediate-run.js` stores that posting's analysis with no
link first, so the analysis `stub-sheets.js` stores for Today Inc is already
there, linkless, and the Job Filter - which skips the page fetch only for a
posting stored under its link - fetches `https://today.example/jobs/1`
(*Could not open the job page*): 36 of 37, the Job Filter's verdict being the
claim that fails. On a fresh database it passes all 37.

The stub's delay applies only to a call that reaches it. A posting analysed
once is never analysed again, and the tailoring cache answers the same posting,
resume and model with no call at all - no tailoring and no revise pass - so a
repeat build is near-instant - it
finishes in PDF time, before anything can be stopped. The timing checks
therefore give every queued JOB a posting of its own (`immediate-run.js`'s
`postingsFor`, `... Ref <submission>-<job>.`); a script written later that
needs a run still going when it acts has to do the same, per job and not per
submission, or jobs 2..N of a run hit the cache the moment the first is
tailored.

`immediate-run.js` — 34 claims, on the Default subscription. It makes its
resume through `POST /api/resumes`, so the server files it under its person:
the one profile a Default account keeps, which Build Resumes starts on
(`#manual-profile`) and every run below names, in Partial Tailor (a request of
`{ profileId, buildMode: 'partial' }`; on the page the script picks it on the
mode cards, `input[name=manualBuildMode]`). It saves
the account's own folder path, the owner's example
`/{{date}}{{profile_name}}/{{company_name}}/{{role}}`. The first
Generate Immediately asks first, in the owner's sentence, with *Do not show
again* - and, Partial Tailor being left unpriced (a mode nobody priced is
free), says nothing is taken from the
credit and names no amount - and after it is ticked the next click goes
straight through, remembered for Generate Immediately alone
(`freeTailor.spendConfirm.immediate.skip`); the run
shows progress and Stop, ends saying what it built, and its resume reaches the
browser's download folder by itself, named for the company and the person, and
is listed under the progress to download again. On the server, the run's
folder - recorded as its order's `output_root` - is `<E2E_OUTPUT_DIR>/<the
account's email>/<its order number>` (the default prefix), and every file the
run recorded is on disk under that account's folder path, its first folder the
date and the name on the resume in one (`2026_10_15ada_run/acme/senior_engineer/`).
A run queued for the tab is
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

`sheet-panel.js` — 37 claims. Its resume is made through `POST /api/resumes`,
which files it under its person: the profile a run builds. The sheet card has
no *Import from Google Sheet* button, no sheet to choose and no column
mapping (the own sheet and its columns are the app's), and its build target
is ONE profile (`#sheets-profile`) and one of three open mode cards
(`input[name=sheetsBuildMode]`), with no Single, All profiles or list target;
the Tab select lists every tab in the spreadsheet's
order and starts on **All**, the daily tab in an older build's layout listed
as *09/30/2026 (not a job tab)* and disabled - driven to it anyway, the
select stays on All - with the sentence that says where its rows go; nothing
can be built before
rows are loaded. *Load rows* shows a job per row with a company and a
description (rows 2, 3 and 5 of All), a link only where the cell is a web
address (not the
`javascript:` one), *From the posting* where there is no title, and the count
of rows skipped; then Order and Generate Immediately, with the run priced. The
table's Analysis column says *Skips analysis* - with the row's Job Field and
Salary - for the row whose Analysis cell is filled, and *When built* for the
others, and the line above it counts them (*1 of 3 already analysed*); a tab
with nothing in its analysis columns has no row that skips.
Another tab (*Notes*) drops what was loaded and loads its own rows. Order answers with an
order number at once, saying what it builds (*2 resumes for 2 jobs are being
built: Partial Tailor for Sam Sheet.*) - free, since Partial Tailor is
unpriced, so it is placed without a spend alert, which an Order asks
only when it takes credit - and Cancel on the receipt asks, cancels, and the order reads
cancelled on Orders; Generate Immediately builds the loaded rows here and
hands each of their twelve files to the browser once - and, reloaded after it,
every row says *Skips analysis*: the two it analysed (or found stored) were
written back, all six G:L cells. At 390px the loaded table scrolls inside its
box rather than widening the page. The server's log says where the run found
each analysis - `[queue] Sheet run on "All": 1 job(s) analysed in the sheet, 2
from the store, 0 to analyse.`: Today Inc's cell names the analysis the stub
stored, and the other rows share its posting's text, so no model is asked -
and each write-back (`[e2e stub] wrote the analysis cells 'All'!G3:L3`). Last, the **Job Filter**
on All lists the same tabs (the old one disabled) and shows each row's
verdict on the page - *1 pass, 3 not judged*: Today Inc passes on its stored
analysis with no page fetched, Now LLC's `javascript:` link cannot be opened,
and the two rows with no link say so - and writes nothing into the sheet (the
stub answers the filter's tab inspection and its one read of C:E).

## Profiles and the three build modes, with the seat stubbed

`profiles.js` drives the Profiles pages and the builder's three modes in a
browser. A profile is a PERSON and holds that person's resumes; a run builds
ONE profile in one of Choose Suitable Resume, Partial Tailor and Fully Tailor.
It needs the seat and Google stubbed as `sheet-panel.js` does (`stub-seat.js`
and `stub-sheets.js`), `E2E_STUB_DELAY_MS=300` (at the default 2500 ms the
previews and builds are slow), `E2E_OUTPUT_DIR` (it reads the built PDFs back)
and the backend's own log, named as `E2E_BACKEND_LOG`: the stub prints each
call (`[e2e stub] call N: <call site>`) to the backend's output, so that goes
to a file, and without it the claims that count the seat's calls print `SKIP`
while the rest run. The script makes its own accounts straight in `DB_DIR` -
an administrator, a Premium user (room for five profiles) and a Default user
(one) - and leaves them, with the three prices it sets ($0.01, $0.02 and
$0.03), so the database must be FRESH:

```bash
cd backend && npm run build
E2E_STUB_DELAY_MS=300 E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
  node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-sheets.js dist/index.js > /tmp/e2e-backend.log 2>&1
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-db E2E_BACKEND_LOG=/tmp/e2e-backend.log node test/e2e/profiles.js
```

Each section of the script is wrapped, so a selector that never appears is
one failed claim (*<section>: ran to the end*) and the rest still run; a claim that
cannot be made prints `SKIP`, and the last line counts the checks and the
skips. Its screenshots are `profiles-*.png` in `E2E_SHOTS` (beside the script
by default).

`profiles.js` — 130 claims, in two parts, with `E2E_BACKEND_LOG` set (the last
line is *All 130 checks passed.*; without it the two claims that count the
seat's calls print `SKIP` and are counted apart, *All 128 checks passed (2 more
skipped).*). **Part A**, the Profiles pages. As the
Premium user: the empty dashboard (*My Profiles*, the tabs *Profiles (0)* and
*All resumes (0)*, an open New profile tile and *No profiles yet*); **Create
New** names a profile in the *New profile* dialog and opens that profile's own
page; **New resume** there goes through the chooser for that profile
(`/admin/resumes/new?profile=<id>`, *Start building a resume for Alpha
Person*, its Back link reading the profile's name), a template's details
offer **Use this template** - never off, and nothing said to be used by
another resume - the editor keeps `template=<id>&profile=<id>`, offers to
import an existing resume first and has a Back button reading the profile's
name; **Create Resume** files the resume under that profile and goes back to
its page, where it is the one card and carries the *Default* star, which the
server agrees with (the first resume in becomes the default), on the template
that was chosen. Resumes of two profiles share one template: the chooser for
the second profile offers it, the editor's template select lists every
template with none disabled, and the second profile's own resume opens on it
with *Back to Beta Person*. The tabs and the address (`?tab=resumes` put in
by a click and kept by a reload, taken out again by *Profiles*, a `?tab=`
naming no tab read as Profiles, ArrowRight moving to All resumes and focusing
it); Grid and List (`freeTailor.profiles.view` in localStorage, kept across a
reload, on both tabs); the search on each tab with its count line (*1 of 2
profiles match.*, *0 of 2 profiles match.*, a profile found by the headline of
one of its resumes, a resume by its headline, name or profile) and **Clear**
giving the focus back to the box. A profile's page: the default resume first
and starred; a resume's ⋮ menu (*Edit, Set as default, Duplicate, Move to
another profile..., Keywords, Download JSON, Disable, Delete*), Escape closing
it with the focus back on its button, *Set as default* off on the default and
moving the star otherwise; **Duplicate** makes a third resume in the profile,
on the same template; **Keywords** opens a dialog and is a card on the
editor's Customize tab; and the editor's Back goes to the profile's page, not
the bare list. **Move**: the dialog lists the other profile and *A new
profile*, open while there is room; Escape returns the focus to the ⋮ button;
a real move says so, takes the card off the page and hands the focus to the
next card; a move into *A new profile* makes a profile holding that resume. A
profile's own ⋮ menu (*Open, Rename, New resume, Delete*) and **Delete a
profile that holds two resumes**: the warning first, in the owner's words
(*You can't undo this. Every resume in this profile will be deleted with it
and can't be recovered.*) over a confirm button *Delete profile and its
resumes*; Escape leaves it alone, focus back; confirming deletes the profile,
says *Deleted Beta Person and its resumes.*, drops the tab counts, takes both
resumes away (a 404 on the server, gone from All resumes) and hands the focus
on to a neighbour; deleting from the profile's own page returns to the
dashboard, which says what went. Old addresses: a resume's id after
`/admin/profiles/` opens that resume's editor, an old chooser address reaches
the new-resume page with its query string, an address that is neither a
profile nor a resume says *That profile was not found. It may have been
deleted.* with a way back. At
390px (the dashboard, List rows that stack, an open menu and a profile's
page: no sideways scroll, everything inside the window) and in the dark
theme.

The Default user makes their one profile (*Pat Match*); after that the New
profile tile and **Create New** are locked (*Needs Premium*,
`data-locked-feature="more-profiles"`), the page says *You are using all 1
profile on the Default subscription.*, and pressing the tile opens *Locked:
More profiles* with what Premium allows and Go to subscription; the server is
the real lock (a second profile is a 402 `profile-limit`). Resumes are never
counted: a Go and a React resume are added to the one profile and it is still
one profile; the New resume tile stays open and goes straight to the chooser
for that profile, with no locked panel; Duplicate and Delete (which asks
first) stay open.

As the administrator: Admin -> Models has no Price column or box and says
where a resume's price is set, and its Create New Model dialog has no price;
Admin -> Settings has a **Price per resume** section with the three
`#mode-price-<setting>` boxes (text, `inputMode="decimal"`), a red *Free:
nobody is charged for ...* line for exactly the modes priced $0, the Builder
Defaults' default profile (*Choose automatically* first) and default builder
mode (the three modes), a price finer than a thousandth refused under its own
box in the server's words with nothing saved, **Save Prices** sending only
what changed ($0.01 on the server), the other two prices set through the API
and, after a reload, the boxes reading 0.01, 0.02 and 0.03 with no price Free
and each *Set here*; at 390px the three boxes sit inside the window.

**Part B**, the builder's three modes, as the Default user: one profile
(*Pat Match*) holding a Go resume (*Golang Backend Specialist*) and a React
resume (*React Frontend Specialist*, made the profile's default), $5 of
credit, and a folder path that files by role, so the Role box shows. Build
Resumes starts on that profile (*Pat Match (2 resumes)*) with Partial Tailor
chosen; the three mode cards are all open - no lock - and each says what a
resume costs in its mode (*$0.01 a resume.*, *$0.02 a resume.* and *$0.03 a
resume.*); the cost line follows the mode (*1 resume × $0.01 = $0.01*, then
$0.02 and $0.03); and the note under the cards is *For each job, the resume
whose keywords match the posting best.* for Choose Suitable Resume and
*Builds React Frontend Specialist, Pat Match's default resume, for every
job.* for Fully Tailor. **Choose Suitable Resume** previews the matched
resume AS WRITTEN - the Go posting gets the Go resume, the React posting the
React one, each drawn with its own summary, with no ATS OPTIMIZATION pill and
no Manual Edits box, and the preview names the resume and the mode - and,
from the backend's log, asked the seat for the postings' analyses and for no
tailoring and no cover letter. **Partial Tailor** previews the matched Go
resume tailored (the pill, Manual Edits, the stub's sentence in place of the
resume's own summary); **Fully Tailor** previews the profile's DEFAULT resume
- the React one, not the match - saying *Fully Tailor: the profile's default
resume*. Each mode is then built as an order through the API and its resume
PDF read back: Choose Suitable Resume prints the chosen resume's own summary
and is charged $0.01, with only cover-letter calls in the log; Partial Tailor
prints the stub's tailored sentence on the Go resume, charged $0.02, with no
posting analysed again; Fully Tailor prints it on the React resume, reason
*default*, charged $0.03. Each order item names the profile and the resume
and why (`profileLabel`, `resumeLabel`, `match`), and the order's page prints
the item as *Pat Match · Golang Backend Specialist* with how it was chosen
under it. An **Order** placed from the page in Choose Suitable Resume ends in
the receipt *1 resume for 1 job is being built: Choose Suitable Resume for
Pat Match.* (it takes $0.01, so the spend alert asks first, and Proceed
answers). At
390px the three mode cards stack inside the window with no sideways scroll,
and in the dark theme the builder and its cards are dark. The last claim: no
page threw an uncaught error.

How the match is decided here: `stub-seat.js` answers EVERY posting's
analysis with the same canned one, so the keyword half of the matcher cannot
tell the Go posting from the React one. The two resumes therefore share
TypeScript and Docker (equal recall) and differ in their titles - neither is
an engineer, which the canned analysis would match in both - and each posting
is built with the Role box set to the title it wants, so the matcher's title
half decides. The skills half is `resumeMatch.test.js`'s; a stub that
answered per posting would let the browser say it too, in the same
direction.

## Subscriptions, the locks and the spend alert

`subscription.js` buys a subscription from the credit balance in a browser,
and needs the renewal sweep to run every second, so it can watch a renewal and
a lapse happen. The backend runs with the stub seat (nothing is built) and
`SUBSCRIPTION_RENEWAL_SWEEP_MS=1000`, sharing `DB_DIR` with the script, which
writes the accounts, a resume and - to bring a renewal forward -
`subscription_paid_through` straight into it:

```bash
cd backend
npm run build
SUBSCRIPTION_RENEWAL_SWEEP_MS=1000 DB_DIR=/tmp/e2e-sub-db PORT=3001 \
  node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-sheets.js dist/index.js
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-sub-db node test/e2e/subscription.js   # E2E_SHOTS=<dir> saves the cards, the alert, 390 and General
```

`subscription.js` — 47 claims, in the order of the page. The prices are set through the server
(Premium $9.99, Premium+ $19.99, Premium Max an emptied box: not offered) and
the user given $50. The four tiers are cards in one row at 1440 with Default
current, the prices on them, Premium Max *Not offered* with its Contact admin
link, and no "plan" on the page; at 1024 and 1200 they are two by two, never
three and one. Subscribe asks first - *This takes $9.99 from
your credit*, *Your balance after: $40.01.*, *Do not show again* - Cancel there
moves nothing, and Proceed buys it: one ledger row of exactly $9.99, and the
page says when it renews. The builder's three build modes (Choose Suitable
Resume, Partial Tailor, Fully Tailor) are open, with no lock of any kind. Upgrade names the
server's own proration (worked out again by `dist`'s billing rules from the
stored row) and charges exactly it. Premium Max priced at $5 for a moment, its
card reads *Upgrade · $0* - the unused days of Premium+ cover it - and still
asks: *Nothing is taken now*, $5 when its 30 days end, and the credit it does
not use *is not refunded*; Cancel there moves nothing. Switch at renewal says
nothing is taken now and what is on the day; ticking *Do not show again* there
makes Keep go through unasked. Cancel subscription asks in a dialog of its
own, then says when it ends - in the Current subscription section, scrolled
into view and focused. With the paid period moved into the past the sweep renews it -
a `subscription-renewal` row and *Premium+ renewed: $19.99* in the bell - and,
the balance emptied and the period moved back again, ends it: Default, *Premium+
ended: not enough credit*, and the builder's three modes are still open - a
run has no lock at any tier. At the profile limit (a profile is a person: the
Default subscription keeps one) the New profile tile on `/admin/profiles` is
locked but pressable, *Needs Premium*, and opens *Locked: More profiles* with
Go to subscription. Resumes are never counted: two more resumes of the same
person are created (201), the dashboard reads *Profiles (1)* and *All resumes
(3)* with its New resume tile open, and `/admin/resumes/new` is drawn - the
template chooser, with no locked panel. One
card a row and no horizontal scrollbar at 390. An
administrator's page has nothing to buy and says why, its Credits section
says nothing is taken from the balance, and Settings -> General
carries the three price boxes as stored, *Not offered* as the empty one's
placeholder, with *Set here* and Reset to default.

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
name. Measured on Next 16.1.6: `dev:live` (webpack) failed - tab A reloaded
each time a tab opened, and its run was cancelled (*Your last run ended while
this page was away*); `dev:turbo` (Turbopack) passed all 8 claims, twice (10 s,
then 15 s on `/credits` and `/jobs`); the production-style `dev` passed all 8.
Measured again on 16.3.8, the Next this release pins, each mode on a fresh
frontend with `.next` deleted: `dev:live` failed 4 of the 8 the same way (tab A
reloaded after tab B and after tab C, and its run was cancelled), `dev:turbo`
and `dev` passed all 8, and so did the server the frontend's launcher falls
back to on Windows - `npx next build --webpack`, then `node scripts/next.mjs
start` (`E2E_MODE='build --webpack + start'`, a label only). All of it on
Linux. So the root `npm run dev` runs `dev:turbo`, and `npm run dev:live` keeps
webpack for whoever asks for it by name - `test/devServer.test.js` holds the
scripts to that, and runs that Windows fallback against a stand-in Next (a
real `0xC0000005` cannot be made on Linux).

## Report Jobs and the job lake, with Google stubbed

`report-run.js` drives a reporter's run and the administrators' lake in a
browser. `stub-report-sheets.js` is its Google: every account's job sheet
exists with **All**, **Temp For AI**, an older build's daily tab in its own
layout and a tab of the reporter's own (*My notes*, whose header is not the
job sheet's), rows in memory, and the admin sheet a list in memory - through
the four seams the unit tests use (the account sheet's client, the report
run's, the analysis columns' and the admin sheet's). The first three share the
rows, so what a run writes back (G:L, and nothing else in a row) is what the
next preview reads. `stub-seat.js`'s facts call answers every posting as a
remote Backend job at a SaaS company (*Technology*), no clearance. All's rows are `report-sheet-rows.js`'s, in the
twelve-column layout: *Acme Corp*
(added), *ACME, Inc.* (the same company once normalised, so a duplicate),
*Globex LLC* (added), *Initech* (reported by this reporter before, and added
then), a row with no company and one with no description and a `javascript:`
link (both Skipped), *Hooli* (reported before, a duplicate then of the Hooli
job an administrator merged in) and *Acme Corp*'s posting again (a duplicate
of the row above). "Reported before" is the database's record, not the
sheet's: the script records those two reports itself, through the lake's own
merge in the database the server shares (`seedEarlierReports`), and sets the
global rate to $0.05.

```bash
cd backend && npm run build
E2E_STUB_DELAY_MS=700 DB_DIR=/tmp/e2e-db PORT=3001 \
  node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-report-sheets.js dist/index.js
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-db node test/e2e/report-run.js
```

`report-run.js` — 38 claims, on a fresh database (the stub's rows live in the
server's memory, so a second run against the same server finds them reported).
The two earlier reports are on record; Report Jobs opens on **All**, rows
2-501, with the rate per job; Add to job lake waits for a preview; *My notes*
and the daily tab in an older build's layout are both listed as *(not a job
tab)* and cannot be chosen - driven to *My notes* anyway, the select stays on
All; the preview lists
the eight rows, *Initech* as *Reported before (Added) - skipped* and *Hooli*
as *Reported before (Duplicate) - skipped*, and the `javascript:` link as
text; the run shows its bar and ends with *2 out of 6 was added, your current
credit is $0.1* over every row's outcome - red exactly on the rows the run
paints in the sheet (the duplicate, *Hooli* again, the repeated posting), the
notes saying why, each added row $0.05; the same rows previewed again say
they were reported (the two Skipped and the repeated posting are tried
again); the top bar's balance moved; no horizontal scrollbar at 390px; in the
dark theme the last run comes back with its duplicates in the dark red. Then
as an administrator: Job Lake is a Settings tab and lists the four jobs, the
run's two paid, each with its job type, clearance and industry (*Remote / Not
required / Technology*, *Hybrid / Required / Finance*, *Onsite / Not required
/ -*); *acme inc* finds *Acme Corp*; Details shows the reward, the reporter,
the three facts and the history; Delete with *Also revoke the reward* takes
the job and exactly its $0.05 back off the reporter; Settings shows the
stored rate, the window *60 (the default)* and the admin sheet with every job
on it, *Retry now* has nothing to send, and $0.0505 is refused under the rate
box; Merge has nothing to merge; Admin -> Accounts' rate boxes say *Global
rate ($0.05)*.

## Push to Google Sheet, with Google stubbed

`lake-push.js` drives Admin -> Job Lake's filter form and **Push to Google
Sheet**, then builds from what the push wrote. `stub-lake-push-sheets.js` is
its Google: every account gets a spreadsheet of its OWN (so a push into one
administrator's sheet can be seen to leave another's alone) with **All** and
**Temp For AI**, the latter holding what an earlier push left - rows 2 to 6
filled across A:L, a note of the person's own in M, rows 3 and 4 painted red
across A:M - except for an account whose email contains `clash`, whose Temp For
AI is a tab of the person's own. Five seams, the ones the unit tests use: the
account sheet's client, the push's (`setLakePushSheetsClientForTests`: the
inspection, the verify, the ONE `:batchUpdate` - applied to the cells, values
and paint as its `fields` say - and the RAW writes), Find Jobs' export's
(`setJobExportSheetsClientForTests`: All's inspection and verify, its reads -
whole columns like `'All'!A:E` included - the grid grown, and the RAW writes,
each an `export-*` event), the analysis columns' (what a build from the tab
reads, and any write-back) and the admin sheet's.
The cells, and every read and write in order, are written to a JSON file after
each change - `E2E_SHEET_STATE`, else `e2e-lake-push-sheets.json` in `DB_DIR` -
which the script reads to see the sheet as a person would. The script seeds the
lake itself (five jobs a day apart, each from an analysis stored for its
posting, with its own job type, clearance and industry) in the database the
server shares, so the database must be FRESH. Start the server with
`JOB_LAKE_PUSH_MAX_ROWS=4`, so pushing all five is cut at the cap; give the
script the server's log as `E2E_BACKEND_LOG` and it also checks the server's own
line that the build took every analysis from the sheet.

```bash
cd backend && npm run build
E2E_STUB_DELAY_MS=300 JOB_LAKE_PUSH_MAX_ROWS=4 E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
  node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-lake-push-sheets.js dist/index.js > /tmp/e2e-backend.log 2>&1
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-db E2E_BACKEND_LOG=/tmp/e2e-backend.log node test/e2e/lake-push.js
```

`lake-push.js` — 37 claims. The filter boxes are in the owner's order
(*Updated from, Updated to, Requested by, Job field, Job type, Clearance,
Industry, Company, Salary from, Salary to, Full text*), *Job type*'s list (a
box of several values: `pick` opens it and presses an option) offers Remote,
Hybrid, Onsite, *Clearance* Any, Required, Not required, *Industry*'s list the
server's own, and **Push to Google Sheet** sits between Clear and Search (a
list box's chip buttons aside). Pushing the unfiltered lake asks first - *Push the newest 4 of the 5
jobs these filters match - a push takes at most 4 (JOB_LAKE_PUSH_MAX_ROWS) -
into the Temp For AI tab of your own job sheet* - and says afterwards that the
oldest was left out, with *Open Temp For AI* linking to the tab. Temp For AI
then holds the newest four from row 2, newest first, each row a date, its
number for the day, company, link and description and the six analysis cells
naming its posting's stored analysis; the earlier push's sixth row is emptied
across A:L, the red is gone from A:L, and column M and the header are as they
were. A search for *Remote*, with the Company box changed afterwards, pushes
the search on the page - the confirm names its 2 jobs and says the boxes
changed since are not what is pushed - and leaves just those two, the rest of
A:L emptied. An order built from those two rows (one profile, the one the
script's resume - made through `POST /api/resumes` - is filed under, in
`buildMode: 'partial'`) reads their analysis cells
and writes nothing back - a cell the server did not trust would be replaced -
and, with the log, the server says *2 job(s) analysed in the sheet, 0 from the
store, 0 to analyse*. The other administrator's Temp For AI is exactly as it
was, every push wrote only into the pusher's sheet, and *Remote* and *Hybrid*
picked together are two chips whose search finds the 3 jobs of either - which
the push's confirm names. An administrator whose Temp For AI is a tab of their
own is refused in the Job Sheet page's words with their tab left alone, and
the Lake tab adds no horizontal scrollbar at 390px.

## Find Jobs, with Google stubbed

`find-jobs.js` drives Find Jobs (`/jobs`) as a user, an administrator and a
reporter, against `stub-lake-push-sheets.js` (every account its own sheet; the
export's reads and writes go through its export seam, and land in the same
JSON file, which the script reads) and `stub-seat.js` (the order's resumes).
The script seeds the lake itself - thirty jobs an hour apart from ten
companies, each from an analysis stored for its own posting, half reported by
a reporter: the newest in *Localization and internationalization* and the
next in *Site reliability engineering (SRE)*, the other twenty-eight in
Backend (10), Frontend / web UI and DevOps (9 each), and the newest three with
the catalogues' widest words (*Telecommunications*, *Localization and
internationalization*, *Logistics & Transportation*, *Manufacturing*), long
titles and salaries - so the database must be FRESH. What a resume costs is
the price of the build mode it is built in (a model has none), so the script
prices Partial Tailor at $0.023 (`PUT /api/admin/settings` with
`partialPriceUsd`, taken off the stored row again when it ends; the other two
modes stay unpriced, which is free) and gives the user $5. It makes the
resumes through `POST /api/resumes`, which files each under its person: two of
one person for the user (*Una Finder*: a Senior Engineer listing TypeScript
and Docker, and a Data Analyst listing Go and Python - so the Default tier's
one profile holds a choice for the matcher) and two people for the
administrator (*Ada One* and *Ada Two*, a profile each). Start the backend with both
preloads: with `stub-seat.js` alone (which loads `no-google.js`) Go to my
sheet is off, the page says job sheets are not set up, and the export has
nowhere to go. Only a backend started with no preload at all reaches a real
credential (see the top).

```bash
cd backend && npm run build
E2E_STUB_DELAY_MS=300 E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
  node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-lake-push-sheets.js dist/index.js
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-db node test/e2e/find-jobs.js
```

`find-jobs.js` — 77 claims, on a fresh database. The rail's Find Jobs is a same-tab link to
`/jobs`, and **Go to my sheet** opens the user's own All tab in a new one; a
user's form has no *Requested by* box and the table no such column, the
table fits its box at 1440px with those wide rows on top (no sideways
scroll, every row's Details in view), and the
rows the API sends a user name no reporter and no reward. *Remote* and
*Hybrid* picked together, the keywords *kubernetes, react* (two chips once
Search is pressed), and *Acme Robotics* picked from the Company box's
suggestions as *acme* is typed each find the server's own count. Twelve
ArrowDowns through Job field scroll its list so the active option stays in
sight; *devops* typed and Enter chooses DevOps, which stays the active option
once the list is whole again; *heal* typed into Industry and never picked is
gone after Search, which applies DevOps alone. All of page 1 and two of page
2 are *27 jobs selected*, tinted (a picked cell's computed colour differs
from an unpicked one's, so a lost or out-ranked tint rule fails it), and Search lets them go and goes back to
page 1. Three picked and exported land in the stub's All, newest first, each
Analysis cell naming its job's stored analysis, and stay picked; exported
again they are *in All already* and nothing is written twice. **Order
Immediately** builds ONE profile in ONE mode, on every tier: the dialog has a
single profile select (`#order-profile`, *Una Finder (2 resumes)*) and the
three mode cards (`input[name=orderBuildMode]`), all open for the Default
user, with no Several, All profiles or list target to be locked. Partial
Tailor's card says what it costs a resume (*$0.023 a resume.*) and the note
under the cards says the resumes are chosen among by their keywords; the cost
line prices the order (*This order: 3 resumes × $0.023 = $0.069*), it asks
first (*This takes $0.069 from your credit*, *Do not show again*), and ends in
the receipt *You ordered successfully: Order number - ...*, which says what is
built (*3 resumes for 3 jobs are being built: Partial Tailor for Una
Finder.*), links to the order and takes the focus; `/api/orders` holds the
order with three items, each naming the profile (*Una Finder*), the resume the
matcher chose (*Senior Engineer*) and why (Partial Tailor, matched
TypeScript); the selection is let go. One job is then ordered in **Choose
Suitable Resume**: the card says *Free.*, the cost line reads *1 resume × $0 =
$0*, nothing is asked first, and its item and its order page say which resume
and why - *Una Finder · Senior Engineer* with *Suitable resume: matched
TypeScript* under it. An administrator's form and
table have *Requested by*, the table still fits its box at 1440px, and at
1280px it scrolls under every row's Details, held in view; picking the reporter finds their 15 jobs alone,
and Details names them; their order dialog offers both of their profiles, says
*Please select a profile.* where the cost line stands, with Place order off,
notes that the profile chosen has one resume, so every job builds it, and, in
Fully Tailor (open to an administrator as to everyone), that it builds that
profile's default resume; the order is priced (*Administrators are not
charged*), and Cancel
gives the focus back to Order Immediately. A reporter on `/jobs` is sent to
Report Jobs. At 390px the four keyword chips wrap inside their box and the
page has no horizontal scrollbar; a mouse press on a row's checkbox, more than
half cut off at the box's left edge, ticks it, and one on each line of its
Title link, scrolled half under the held Details, reaches the link, the box
not moving either time (it once scrolled on a press's focus, and the click
landed on the cell); then Shift+Tab from that row's Details to the link scrolls
the link clear of it; in the dark theme a picked row is tinted
too, and the last screenshot is that theme.

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
E2E_STUB_DELAY_MS=4000 E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 node --require ./test/e2e/stub-seat.js dist/index.js
# the frontend, built against that backend, in another terminal; then
DB_DIR=/tmp/e2e-db node test/e2e/providers.js
```

`providers.js` — 44 claims, in order. The table lists the three built-in providers in
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
switched off). The administrator's resume is filed under a profile of its own
(the raw writer does it), and the order the script places names that profile
and a mode (`{ profileId, buildMode: 'partial' }`: Partial Tailor, the mode a
resume was always built in before modes belonged to the run). That order runs
on Team B, Remove is refused while it builds
- in the server's sentence, the row still there - and once the order is done
its page says *Built on Team B (Claude)* to the administrator; idle, Team B is
removed. Then Admin -> Models' own dialog (owner decisions M1, M2): the page
says what a resume costs is the builder mode's price (*What a resume costs is
set per builder mode under Settings > General > Price per resume.*) and a
model has none - no price column, no price on a row; **Create New Model** at
the top right opens a dialog with a name box and no price box; a display name
another administrator takes meanwhile (the script adds it over the API) is
refused by the server and its sentence pinned under the name box; the model is
created, its row names no price, and Edit saves a new description;
**Set default** moves the *Default* badge and the default model
reads *Set here*; **Use for analysis** puts the *Analysis* badge on it and its
row then offers **Use the default model**, which leaves the analysis on the
default model, still *Set here*; both **Reset to default**s give what the page
said they would, neither set here; and the model is deleted. No horizontal page
scroll at 390px. An ordinary account's order page and API answer name no
provider, and the provider and health routes refuse it.

## The shell, as every role

`shell.js` walks every page as a user, an administrator and a reporter, in
both themes and at 1440 and 390 (545 claims), with the two servers up and `DB_DIR` naming
the backend's database (it writes the sessions, the reporter's balance and one
resume each for the user and the administrator, straight into it - the user
ends with ONE profile, the Default subscription's whole allowance, and each
has a person for the builder's profile select to offer):

```bash
cd backend && npm run build
DB_DIR=/path/to/db PORT=3001 \
  node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-sheets.js dist/index.js
# the frontend, built against that backend, in another terminal; then
DB_DIR=/path/to/db node test/e2e/shell.js
```

Without the sheets stub - `stub-seat.js` alone, which loads `no-google.js` -
nothing shows the account's own sheet: Build Resumes' sheet panel and Find
Jobs say sheets are not set up on this server (*Job sheets ...* to a user,
*Google Sheets ...* to an administrator; Find Jobs' Go to my sheet is off), and a
reporter's account menu simply has no *Your job sheet*. Only a backend started
with no preload at all reaches a real credential (see the top).

The rail reads Profiles, Find Jobs, Build Resumes, Orders, Credits |
Job Filter, Bid Assistant, Calendar | Templates, Settings for every builder -
one Profiles entry and no locked row - Find Jobs
a same-tab link to `/jobs`, which lights it alone (as `/jobs/filter` lights
Job Filter alone), and every route walked includes `/jobs`, the dashboard's
second tab, a profile that is nobody's and the template chooser.

The reporter half (owner decision A3): their four pages - Report Jobs, Credits,
Settings -> Account and Job Sheet - each stay put, under a rail of Report Jobs,
Credits and Settings, with only those two Settings tabs; Credits is their
earnings and the payout the administrator just recorded, with no Purchase
Credits and no order or refund tabs, but *Ask for Refund* - a payout request -
in Purchase Credits' place and style, and their *Payout requests* listed; the
account menu has
no subscription; and every other address - every route the other two roles
walk, plus /admin, an order and an invoice - lands on Report Jobs.
Every API answer the reporter's page gets is watched, and the walk fails on a
single 403: a page of theirs that asked a builder route, or a bounced page
that mounted before it was sent away, would show here. A user made a reporter
while their page is open is taken to Report Jobs by their next request; one
made a reporter on Job Sheet who then opens Settings -> Account, where nothing
is refused, finds it drawn as a reporter's - no Resume files, and no failure
to read where their resumes are saved. On
Admin -> Accounts: Reporter in the role select and the invite form (which
then asks for a rate per job rather than a subscription), a rate typed into a
reporter's row stored as thousandths, and Record payout refusing more than the
balance in the server's words, saying what a payout leaves, and recording it.
Neither a user nor an administrator is offered *Ask for refund* on any page
they walk (owner decision R1), and the Refund Requests tab says to contact the
administrator, with the link.

The profiles and the one lock, for a user on the Default subscription: the
rail has no locked row at all. Build Resumes locks
nothing on a run: both ways of building draw one profile select
(`#manual-profile`, `#sheets-profile`, offering the user's one profile,
chosen) and the three build modes as cards (`input[name=manualBuildMode]`,
`input[name=sheetsBuildMode]`) - every one open, none disabled or locked, one
chosen, each saying what it does and none naming a subscription; pressing a
mode chooses it and the note under the cards follows (Fully Tailor builds the
default resume; Choose Suitable Resume says the profile has one resume, so
every job builds it); the sheet card has no Single, All profiles or list
target and no picker for several. `/admin/profiles` is *My Profiles* with the
tabs *Profiles (1)* and *All resumes (1)* and the user's profile a card, and,
at the Default subscription's one profile, the New profile tile is the one
thing locked: pressable, *Needs Premium*, opening *Locked: More profiles* with
what Premium allows, **Go to subscription** (to `/settings/subscription`) and
**Close** - on a phone too, where Close gives the focus back to the tile.
`?tab=resumes` selects All resumes, whose New resume tile is never locked;
`/admin/resumes/new?profile=<id>` draws the chooser for that profile, with no
lock even at the limit; `/admin/profiles/<no such profile>` says so, with a
link to My Profiles, and keeps Profiles lit; and an old
`/admin/profiles/<a resume's id>` bookmark replaces itself with that resume's
editor. An administrator sees every choice open, the Profiles entry in the
rail, and the New profile tile open whatever their own subscription (the page says
*administrators have no limit*). Settings -> Subscription draws four cards in
one row at 1440 with Default current, and one a row at 390 with no sideways
scroll.

The prompts, as an administrator sees them (owner decisions J0, J1, O1):
Admin -> Prompts lists Analyze Job Description, Job Facts (Filter), Revise
Resume Coverage and Generate Cover Letter beside Tailor Resume, and each of
the four is one prompt - no New Variant, Duplicate, Save Active or model
override, and its own sentence saying why - while Tailor Resume still offers
New Variant and the override. Admin -> Settings -> General has no analysis
model select and no folder template any more (owner decisions M2, O5): its
output prefix box shows the prefix in effect, its three tokens as chips and the
server's preview, and every setting with a `.env` default says where its value
came from (*Set here*, *From .env (NAME)* or *Default*); its **Price per
resume** section has a text box for each of the three build modes
(`#mode-price-<setting>`) with **Save Prices**, and its Builder Defaults
choose a default profile (a select) and a default builder mode - no build
target. Admin -> Models has
**Create New Model** at the top right of its header and no inline form, the
*Default* and *Analysis* badges and **Set default** and **Use for analysis**
on its rows, and says each posting is analysed once and that a resume costs
the builder mode's price, with no price column; Create New Model opens the
dialog, a name and no price box. Settings -> Account -> Resume files, for a user:
the folder path in effect, its five tokens as chips, the server's preview and
*Default*; a chip lands at the caret, and a token of the administrator's
(`{{order_number}}`) is refused under the box by name before anything is
saved. A reporter's Settings -> Account has no Resume files.

## Sign-in is seeded, deliberately

`services/auth/mailer.ts` refuses to pretend an email was sent, so there is no
offline path to a login code and no dev backdoor. Rather than add one, these
scripts write a session row directly and send its token as a Bearer token —
which is what the browser would be carrying anyway. Sign-in is not what these
scripts are testing.

A seeded sign-in is the `ft_session` cookie and the `adminToken` in
localStorage, and every page of one browser context shares both. So a page
opened for a second account signs every OTHER page of that context in as
that account at their next request or reload: `profiles.js`' builder page
once loaded as the administrator (no profiles, no balance) because an admin
page had been opened after it. Give each account its own context
(`browser.createBrowserContext()`, as `profiles.js`' `newPage` and
`refunds.js` do), or sign a page in again before it reads anything
account-specific after another account was signed in (`shell.js`' phone
section).

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

`buy-credits.js` — 115 claims over the three-step dialog and the credits page,
a third of them through HTTP first because the browser half needs what they
leave behind. Over HTTP: with nothing set on Admin -> Payments the buy page's
card bounds are the defaults (`.env`'s, else the code's), a save of the limits
alone makes only them *Set here* and the buy page offers the new bound, and
Reset to default (`paymentLimits: null`) hands them back; each method judged by its own bounds and presets that
fall inside them; an `asset` from a stale tab ignored rather than refused, and
unable to change the price; a purchase that asks to keep the card keeping it,
and one that does not, not - even for an account that already has a customer;
a saved card that is the owner's alone to charge or delete, and answering 404
to anybody else; and an off-session charge settling through
`payment_intent.succeeded` against a `pi_` reference and crediting exactly
once. Then with a mouse: Admin -> Payments saying where the limits and card
security come from, neither set here, and its Save limits, pressed untouched,
sending nothing (*Nothing to save*); only what the installation can serve offered; a
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

`refunds.js` — 63 claims over a reporter's payout request, the refund requests
left from before asking was removed, and Contact admin, with no provider at all
(step 5 above - against step 2's server, whose fake Stripe accepts every
refund, the card checks fail, and the first of them says why): its purchases,
run charge and order are written straight into the database the server reads
(so `DB_DIR` must name the backend's), paid the way a webhook pays them, and
the four older requests are seeded the way the app made them then
(test/refundSeed.js). Nobody but a reporter asks (owner decision R1): the
server has no route to ask one - both asking routes answer 404 and no request
is made; a user's paid purchase offers Invoice and Help and
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
bad Telegram name to that row, with nothing saved; the saved list reading *Set
here* with **Reset to default**, which shows everybody `.env`'s
`CONTACT_CHANNELS` (or none) and says so beside it; and both Credits pages at
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
