# CLAUDE.md

Build and orientation notes for this repository. Verified by running every
command below on a clean checkout (Node 22, Linux).

## What this is

Tailor: a Next.js 16 frontend and an Express + SQLite backend that generate
tailored resumes and cover letters. Two npm workspaces that are
not npm workspaces — `backend/` and `frontend/` each have their own
`package.json` and lockfile, and the root `package.json` only orchestrates
them. A single `.env` at the repository root feeds both sides.

## Build and test

```bash
npm run install:all            # root + backend + frontend (run after every pull)
npm run build --prefix backend # tsc -> backend/dist   (~8s)
npm run build --prefix frontend# next build            (~16s)
npm test                       # backend node:test suite (~22s with the tsc step, 1065 tests)
npm run dev                    # backend watch + frontend dev server
```

Facts worth knowing before you build:

- **`npm run install:all` after every pull.** A pull brings `package.json`
  entries but not packages; the symptom is `TS2307` / `Cannot find module`
  naming a dependency that is plainly listed.
- **The backend postinstall downloads Chrome** (`scripts/installBrowser.js
  --if-missing`) for PDF rendering. It is idempotent and skips an existing
  download. If the download is blocked, `npm run setup:browser` retries, or set
  `CHROME_PATH` to an installed Chrome/Edge/Chromium/Brave.
- **`npm test` builds first.** It is `tsc && node --test "test/*.test.js"`, so
  the suite runs the compiled output in `backend/dist`, never the sources.
  Editing a `.ts` and rerunning a single test file directly will run stale
  JavaScript.
- **`npm run lint --prefix frontend` exits 1 on a clean checkout** — 3
  pre-existing `react-hooks/set-state-in-effect` errors, ALL THREE in
  `src/bid-assistant/App.jsx` (lines 259, 293, 369; `src/app/page.tsx`
  contributes none), and no warnings.
  Not a build gate: `next build` does not run ESLint. Do not treat a red lint as
  something your change caused without checking `git stash` first.
- **Dark mode does not work the way it looks.** `globals.css` ends with a block
  that remaps light utilities under `html.dark` (`html.dark .bg-white { ... }`).
  That block is **unlayered** while every Tailwind utility sits in
  `@layer utilities`, so it beats `dark:` variants outright — on
  `class="bg-white dark:bg-slate-900"` the shim wins and the variant is
  ignored. Twenty of the 28 App Router pages carry no `dark:` at all and
  theme entirely through it, so it stays. New chrome uses the `@theme inline` tokens instead
  (`bg-surface`, `border-line`, `text-muted`), which the shim never names, and
  needs no `dark:` variant. Three of its rules are catch-alls rather than
  dark-mode fixes — the bare `border` width class, every `shadow*`, and bare
  `input`/`select`/`textarea` — so avoid those on anything new.
- **`frontend`'s npm scripts go through `scripts/next.mjs`**, never `next`
  directly. That wrapper loads the root `.env` (Next only reads `.env` inside
  its own directory) and passes the port without POSIX shell syntax, which
  `cmd.exe` cannot expand. Keep using it. Note `dev` is a production-style
  build+start; `dev:live` is the webpack dev server.
- **`better-sqlite3` is native.** Install and run with the same Node major, or
  `npm rebuild better-sqlite3 --prefix backend`. A
  `NODE_MODULE_VERSION 127 ... requires 137` error is this and nothing else.

## Running it

The backend needs a writable `DB_DIR` and nothing else to boot:

```bash
DB_DIR=/tmp/ft-db PORT=3001 node backend/dist/index.js
curl http://127.0.0.1:3001/api/health
```

Unset, `DB_DIR` defaults to `/data/db` on Linux/macOS (often not writable — the
most common first-run failure) and `%LOCALAPPDATA%\free_tailor\db` on Windows.
The backend prints the resolved path, the Chrome it will print with, and a
readiness line per AI seat at startup; a CLI that is missing or signed out is
reported, not fatal, and so is any removed metered-provider variable
(`OPENAI_API_KEY`, `AI_CLI_ALLOW_API_KEY`...) still set in `.env`.

To sign in, `.env` needs Google OAuth (`GOOGLE_CLIENT_ID`) or SMTP. The first
account to sign in becomes the administrator unless `ADMIN_EMAILS` decides in
advance.

## Layout

```
backend/src/
  index.ts            # Express app: mounts 21 routers under /api
  config/             # env loading (.env, UTF-16 aware), browser resolution.
                      #   ENV_PATH resolves from the COMPILED module, so it is
                      #   always <repo root>/.env regardless of cwd - a file at
                      #   backend/.env is ignored. envFile.ts's summarizeEnvFile
                      #   reports a file's path, encoding and key NAMES (never
                      #   values) so the doctors can say why a setting that is in
                      #   the file is not in effect. A NEW setting is read through
                      #   envValue.ts (envInt/envList/...: empty = default, junk
                      #   warns once, out of range clamps, never throws) and, if
                      #   it is operational - a timeout, cap, pool width, model
                      #   list - added to operational.ts, the ONE table of
                      #   name, default, range and getter (a seat may keep its
                      #   own in its options.ts and spread them in, as
                      #   GEMINI_CLI_SETTINGS does), AND to .env.example
                      #   as `#NAME=default` with its range, AND to the README's
                      #   Configuration table. The drift test
                      #   test/envExample.test.js fails until all three agree.
                      #   providerCatalog.ts is the ONE list of seats and of
                      #   retired ids; providerModels.ts each seat's model-name
                      #   list; creditsPerResume.ts the price field's rules;
                      #   modelErrors.ts the two model refusals.
  controllers/        # one file, the skills handlers routes/resume.ts mounts
  database/           # better-sqlite3, one repository per table
  database/migrations # numbered, run on first DB use, and a CHAIN: a step that
                      #   defers (003 waits for an admin; 006 and 007 for a
                      #   settings row that names what they remove but does
                      #   not parse; 008 for one whose model list does not)
                      #   stops the ones after it. Adding a seed model needs a
                      #   migration - stored `aiModels` is read verbatim, never
                      #   unioned with the defaults, so a seed reaches fresh
                      #   installs only (005 did it for Codex, 008 for Gemini).
                      #   The chain is 001, 003-008: 002 seeded the browser-chat
                      #   models and went with them, and the runner skips any
                      #   version it has passed, so the gap is harmless. Never
                      #   reuse a retired number.
  extractors/         # reading a template's styles back out of its HTML
  generators/         # PDF (puppeteer), DOCX (html-to-docx), Handlebars
  integrations/       # Stripe, Cryptomus, Google Sheets - one file per service
  middleware/         # auth, uploads, and publicError.ts - what a failure may
                      #   tell whom (see "The AI layer" below)
  routes/             # one file per /api/* area
  scripts/            # operator tools, each behind an npm script: mail:doctor,
                      #   sheets:login, sheets:doctor, migrate:legacy,
                      #   ai:rollback. The doctors share one shape -
                      #   walk the real chain in order, stop at the first break,
                      #   name the remedy - because each diagnoses a failure whose
                      #   single error message covers several causes.
  services/ai/        # provider-agnostic transport; one directory per provider
  services/queue/     # on-disk generation queue (survives a restart). One LANE
                      #   per real resource - one per seat, `cli`, `codex` and
                      #   `gemini` (`laneFor`) - each sized from its seat's own
                      #   variable. A restored row naming a lane this build
                      #   lacks is moved to one it has. A task row's `data` is a
                      #   hand-picked PROJECTION built by index.ts's `taskRow`,
                      #   not the Task serialized, so a new field must be named
                      #   there AND in the restore mapper or it silently does
                      #   not persist. The payload persists whole, which is why
                      #   a task's price lives on it (`payload.creditCost`).
  bidAssistant/       # the Bid Assistant's own prompt building
  types/, utils/      # shared types; path, storage and filename helpers
backend/
  scrapers/           # NOT under src/, and the bulk of the backend's
                      #   JavaScript: seven Apify actors plus one shared
                      #   apify.js, behind one registry, reached from
                      #   services/scraperProviders.ts and routes/jobs.ts.
                      #   (bidAssistant/database.js and scripts/installBrowser.js
                      #   are JavaScript too.)
  static/             # seed prompts, skills, templates — defaults only
  test/               # node:test, 87 files; fixtures/cli, codex and gemini
                      #   replay real CLI streams (`recorded-` is a capture,
                      #   `constructed-` a real envelope around a fake answer)
frontend/src/
  app/                # App Router pages: /, /settings/*, /admin/*, /jobs,
                      #   /orders, /credits (+ /credits/invoice, drawn with no
                      #   shell - navModel's isBareRoute). /account redirects.
  components/shell/   # The app shell - top bar, rail, and the "Settings" title
                      #   and tabs above every settings route (Administration
                      #   is one tab with a second row of the /admin/* pages).
                      #   Mounted once in the root layout inside AuthGate;
                      #   pages render no navigation of their own. navModel.ts
                      #   is the ONE list of rail entries and settings tabs.
                      #   The look follows a reference design (textverified):
                      #   .tl-tabs, .tl-button(-quiet), .tl-table(-box),
                      #   .tl-section, .tl-input in globals.css are the shared
                      #   pieces, as classes the dark-mode shim never names.
  components/icons/   # Hand-rolled inline SVG set (there is no icon library).
                      #   index.tsx is UI icons - one grid, one stroke, one
                      #   colour, and the ROW decides it. marks.tsx is brand
                      #   and asset marks, which are filled and multi-colour
                      #   and never recoloured by a parent. Anything needing a
                      #   fill belongs in marks.tsx.
  components/credits/ # The three-step purchase dialog. order.ts holds the
                      #   wizard reducer with no JSX in it; chrome.ts holds the
                      #   shared class strings and the note on why none of them
                      #   carries a `dark:` variant. Also the /credits history
                      #   tables: usePagedList.ts (paging with the race guards),
                      #   TablePager, OrderHistory, CreditHistory. A colour on a
                      #   .tl-table cell goes on an inner span - the unlayered
                      #   td rule beats a utility on the td itself.
  bid-assistant/      # the largest single feature directory here, and the only
                      #   JSX: its own App, components and stylesheet. Its
                      #   failures go through lib/apiBase.js's readError /
                      #   responseError, then messageWithDetail like the rest
  components/ui/      # The kit every page is built from: kit.tsx (Page,
                      #   PageHeader, Section, Card, Field, Notice, ErrorNotice,
                      #   Pill, EmptyState, Spinner) over the .tl-* classes in
                      #   globals.css, which state every colour for both themes.
                      #   New UI uses these and the tokens (text-ink, text-muted,
                      #   bg-surface, border-hairline...), never bg-white /
                      #   text-gray-* / dark: - see the shim note above. The
                      #   .tl-* rules are unlayered, so a utility cannot override
                      #   their padding or height; use a data-* option or a
                      #   CSS module. /admin/* pages sit inside app/admin/
                      #   layout.tsx's <main> and under the shell's Settings
                      #   title, so they open with an h2, not a PageHeader.
  components/, lib/   # UI and the API client. Shared bits worth knowing before
                      #   writing another copy: lib/format.ts (one formatDate for
                      #   every page), lib/sheet.ts (the spreadsheet range
                      #   parsers), components/pageChrome.ts (the CARD and LABEL
                      #   class strings, with the note on why they keep `dark:`),
                      #   lib/userMessage.ts (userMessage / messageWithDetail -
                      #   the ONE way a page turns a failure into text; never
                      #   print `err.message`, and render a caught error with
                      #   <ErrorNotice>, which shows an admin's `detail`).
```

Crypto payments go through **Cryptomus** (`integrations/cryptomus.ts`), a
hosted invoice page, and that is the only crypto path. Nothing in this
repository has ever called it - this machine cannot reach `api.cryptomus.com` -
so the request shape is pinned by tests against a stubbed socket and the README
says so out loud. Its webhook signature arrives INSIDE the JSON body, which
inverts `paymentWebhooks.ts`'s "verify before reading" rule; that exception is
confined to `verifyWebhookSign` and explained there.

Two earlier crypto paths were deleted once nothing was in flight through them:
a non-custodial watcher reading four blockchains, and Coinbase Commerce.
**`'chain'` and `'coinbase'` stay in `PaymentProvider`** so their rows still
read and still refund with the right advice, and `chain_invoices`,
`chain_cursors` and `chain_orphans` are left in any database that has them -
the `CREATE TABLE` statements are gone from `database/sqlite.ts`, the tables
are not dropped.

All dynamic data lives in SQLite. `backend/static` holds seeds only — a running
install reads its prompts, skills and templates from the database.

## The AI layer

Every model call goes through `backend/src/services/ai`. A provider is one
directory implementing `AIProviderAdapter`; the registry is keyed on the
provider catalog, so a missing entry is a compile error. There are exactly three,
all **subscription seats** run through a local CLI, in catalog order:
`claude-cli` (the default), `codex-cli` and `gemini-cli` - labelled "Claude
(Subscription)", "Codex (Subscription)", "Gemini (Subscription)". All three work
headless: `codex login --device-auth` and `NO_BROWSER=true gemini` need no
browser on the server. **Nothing reads or sends an API key**, and there is no
switch to allow one: each seat strips every key variable from its child (Gemini
pins them to ""), the Claude seat stops a turn the moment its `system/init`
event names an `apiKeySource` other than `none` - before the answer, not after
the bill - and holds itself as signed out, and Codex asks `codex login status`
(cached a minute) before every turn and refuses, without spawning, a CLI signed
in with a key (stored in CODEX_HOME, out of the environment strip's reach). `AI_LOCKED_PROVIDERS` marks a seat this machine
cannot run; nothing is locked out of the box, a fresh install defaults to the
first seat not locked, and with all three locked a settings READ still succeeds
with no runnable models (saves keep their asserts) while a run fails with
`AiUnavailableError`. The job filter and the Bid Assistant run on the app
default MODEL - a record's provider and model name - like any run that names
none, and a prompt's model override still decides them. It does NOT decide a
resume: analysis, tailoring and cover letter pass `runChoiceWins`, so they run
on the model the run was charged at, whatever the prompt record says.

Models are admin-curated records: a display name, a seat, a model name and
`creditsPerResume`. The model name is chosen from `config/providerModels.ts`'s
`listProviderModelOptions(provider)`, each seat's list overridable in `.env`
(`AI_CLI_MODEL_OPTIONS`, `AI_CODEX_MODEL_OPTIONS`, `AI_GEMINI_MODEL_OPTIONS`,
read per call, all-or-nothing). It is checked when a model is created or its
provider or model name changes, and when a prompt override is saved -
`normalizeAIModelRecords` stays list-agnostic, so a `.env` edit can never brick
a settings read. An ordinary account sees models as `{ id, name }` only
(`getUserAppSettings`, `GET /api/resume/models`); the admin payload carries
everything plus `providerModelOptions`. A REQUEST naming a model that cannot run
is refused (`ModelUnavailableError`, 400) rather than swapped, because another
model could cost another price, while a STORED profile preference that went
stale falls back to the default with a warning once. The bare-provider and
`provider:modelName` request forms are admin-only.

**Price per resume.** `creditsPerResume` is whole credits, 0..1000, 0 = free
(`config/creditsPerResume.ts`; `DEFAULT_CREDITS_PER_RESUME = 1`, which
`services/credits`' `CREDITS_PER_RESUME` aliases). It is not called "price" in
code: `creditPriceCents` already means money per credit. A stored record
without it reads as 1 in memory - no write-back, no migration - and an
out-of-range one clamps on read; admin mutations refuse a bad value by name,
and a partial edit keeps it. A resume is priced at submit by the same
resolution its task runs (`resolvePricedAiChoice`: request, then profile, then
default) and the price is snapshotted on the task as `payload.creditCost` -
OUTSIDE `payload.choice`, so a restore that re-resolves a retired choice never
re-prices it; the queue hook refunds `taskCreditCost(payload)`, 1 when absent.
`reserveCredits` and `refundTaskUnit` take AMOUNTS, a batch reserves the sum,
and `POST /api/generation/quote` prices a batch body through the same
`resolveProfileChoices` without reserving anything. Administrators stay exempt.
Tailored content a preview already wrote is priced at the model that WROTE it,
not the one the finalising request names: `/resume/preview` and `/preview-all`
hand back a signed `previewToken` (`services/credits/previewToken.ts`, HMAC with
a secret kept in `app_settings`), `/resume/generate` and `/generation/batches`
(`previewTokenByProfileId`, which the quote takes alone) price and run on its
model, and supplied content without a valid token is charged at least what the
profile's own model costs (`resolveSuppliedContentChoice`).

**What a failure may tell whom** (`middleware/publicError.ts`). Most people
using an install do not run its server, so a response never names a seat, CLI,
command, setting, path, model id or third party's raw text to them. A
`PublicError` - `AuthError`, `InsufficientCreditsError`, `ModelUnavailableError`,
`AiUnavailableError`, the payment, sheet and Google errors among them - carries a
sentence written for anybody. Everything else goes through
`sendPublicError(req, res, error, fallback)`: `<fallback>. Please try again, or
contact your administrator.` with a `ref` (`ERR-` and six hex digits), the cause
logged once as `[error ERR-...] <METHOD path> <cause>`. An `AIProviderError`
becomes one of four `PUBLIC_AI_MESSAGE` sentences (busy, timeout, retry,
contact-admin) by its `publicFailure`, never naming the seat; its `message`,
`adminMessage` and `adminAction` are for the log and for administrators, who
get the cause as `detail` in the body - the server decides that by role, and
pages render it (`<ErrorNotice>`, `messageWithDetail`) without checking. Errors
that outlive their request (`publicTaskError`, `publicItemError`) are stored as
the sentence plus `(Ref: ...)`; older raw rows are sanitised on read for
non-admins (`publicStoredError`). A message stays specific only when it is
about the caller's own input, objects or entitlements, they can act on it, and
it names nothing about how the server is run. Never send
`{ error: err.message }` from a route a non-admin can reach. `isPublicError`
also checks a `Symbol.for` brand, because the tests `loadFresh` modules and a
reloaded class fails `instanceof`.

Two families of providers were deleted, and both are **retired, not
aliased**: the browser-chat pair `claude-web` / `chatgpt-web`, which drove
claude.ai and chatgpt.com in a debug Chrome (migration 006), and the metered
APIs `claude` (Anthropic), `openai` and `deepseek` (migration 007). Unlike
`openrouter` in `LEGACY_PROVIDER_ALIASES` they map onto nothing: a browser
record's `modelName: 'chat'` is no seat's, and moving an API model onto a seat
would change what a run costs. `RETIRED_PROVIDER_IDS` and `RETIRED_MODEL_IDS`
in `config/providerCatalog.ts` are null-prototype maps from id to family
(`'browser-chat' | 'metered-api'`, so a warning names the right removal). The
model map holds `free-hybrid`, `claude-web-chat`, `chatgpt-web-chat` and the
seven shipped metered seeds, and `isRetiredModelId` also matches the seed id an
old `OPENAI_MODEL` / `CLAUDE_MODEL` / `DEEPSEEK_MODEL` produced, while that
variable is still set. They let a stored row, a profile, a prompt override or a
stale tab that names them read as "the default" instead of throwing, and they
are permanent for the reason the alias map is: a restored backup, a hand-edited
row or a page left open from before the upgrade can bring the ids back at any
time. There is deliberately no prefix rule (it would swallow `claude-cli-*`),
and a deleted model that was never retired is still an error - do not widen the
tolerance to "any unknown id". 006 and 007 each strip their family once and keep
a settings snapshot minus any stored API keys, and 007 also deletes the keys
from 001's snapshot. The read-time tolerance - including the in-memory repair,
onto a seat not locked here, of a row left with nothing it can run
(`rescueRetiredProviderRow`, ranked exactly as 007 ranks: switched on, then not
recorded, then switched off; then has an enabled model; then catalog order) -
has to stand on its own, because both sit after 003 in the chain and wait with
it until an administrator exists. Their logs, `migration-log.provider-schema-6`
and `-7`, are read back and so load-bearing: their `removedModelIds` keep an
administrator's own retired model (a UUID) reading as the default after a
restart, and the LATEST `leftRunning` across both limits the in-memory repair to
a row still as the migrations left it - after an admin's own save, a new lock
fails by name. 008's log (`-8`) is read back too: the Gemini model it appends
counts as part of what the migrations left. 006 itself is frozen history; on a
database that skips straight here it can still land on a metered model, which
007 moves in the same boot.

All three seats share the spawn seam in `services/ai/providers/cli/`:
`runner.ts` is the only module under `services/ai` that imports
`child_process`, and `resolveBinary.ts` exists because npm installs a CLI on
Windows as a `.cmd` shim `spawn` cannot execute. Codex differs from Claude in
one way worth knowing: its answer is read from the file named by
`--output-last-message`, not from the event stream, so the JSONL envelope can
move without breaking it. Gemini differs again: its answer is the joined
assistant deltas of `--output-format stream-json`, taken ONLY when the `result`
event says `status: 'success'` - exit 0 alone is not success. Its child env
pins every API-key, Vertex and gateway variable to "" and sets `NO_BROWSER`,
`NO_COLOR` and `GEMINI_CLI_NO_RELAUNCH` (without it the CLI relaunches itself
and SIGTERM never reaches the real process). Every turn runs in one fixed empty
workdir whose `.gemini/settings.json` enforces the Google sign-in, registers no
tools, turns hooks and telemetry off and sets `billing.overageStrategy:
'never'`, under a deny-all policy. MCP servers and extensions are kept out by
FLAGS (`--allowed-mcp-server-names __tailor_none__ --extensions none`): 0.62.0
ignores `admin.*` in every settings file and reads an empty `mcp.allowed` as
"no limit", so the settings keys that look like they do it do not. The prompt
goes on stdin with a leading `/` pushed off column one and EVERY `@` reference
escaped - a bare `@name` resolves inside the operator's own
`context.includeDirectories`, which no workspace setting can clear - and the
`\@` the escape puts before an email is taken back out of the answer. The turn
dir and the CLI's session transcript are removed afterwards. A "Using AI
Credits" notice or any tool call fails the turn. Exit 41 with a sign-in still
on disk is usually the CLI's per-start token check failing on the network, so
it is held for two minutes as `unavailable` and becomes the 30-minute sign-in
hold only on the third in a row. Its health check sends no prompt: `gemini
--version`, then the sign-in files under the CLI's home.

Tests never spawn a browser, a subprocess or a network call: each CLI provider
replays recorded event streams from `test/fixtures/cli`, `test/fixtures/codex`
and `test/fixtures/gemini` through an injected runner, and storage tests point `DB_DIR` and
`TAILOR_STATIC_DIR` at temp dirs. No real Google account has answered through
the Gemini seat: its successful fixtures are the real 0.62.0 CLI's envelopes
around fake answers, and the file names say so.

## Conventions from the history

Some 190 commits, no tags; releases are `vN.0` merge PRs (v2.0, v3.0, v4.0 so far).
The pattern in nearly every feature arc is a feature commit followed by one or
more "fix what the adversarial review found" commits, so expect review passes
to be part of the work rather than an afterthought.

Commit subjects are written as sentences saying what changed and why it
matters — "Stop link-sharing every new spreadsheet, and let an operator ask for
it back", not "fix(sheets): visibility". Match that voice.

The README's Troubleshooting table is long and genuinely load-bearing: most
failures you can hit here already have a row explaining the cause. Read it
before debugging a PDF-rendering Chrome, database-directory, seat or provider
problem, and add a row when you fix a new class of failure. Quote a message
the way the person who reports it sees it - usually the generic sentence and
its `Ref:` - and say where an administrator finds the cause.

## Platform notes

Windows support is deliberate and tested from Linux: the platform-dependent
decisions (default DB directory, Windows binary resolution, command-line
budget, reserved path characters) take the platform as an argument rather than
reading `process.platform`, so both branches are covered from either host.
`backend/src/config/env.ts` and `frontend/scripts/next.mjs` both decode a
UTF-16 `.env` (PowerShell writes those) — change the two together.
