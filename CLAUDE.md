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
npm test                       # backend node:test suite (~20s with the tsc step, 757 tests)
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
readiness line per AI provider at startup; missing API keys and signed-out
seats are reported, not fatal.

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
                      #   the file is not in effect.
  controllers/        # one file, the skills handlers routes/resume.ts mounts
  database/           # better-sqlite3, one repository per table
  database/migrations # numbered, run on first DB use, and a CHAIN: a step that
                      #   defers (003 waits for an admin, 006 for a settings
                      #   row that does not parse) stops the ones after
                      #   it. Adding a seed model needs a migration - stored
                      #   `aiModels` is read verbatim, never unioned with the
                      #   defaults, so a seed reaches fresh installs only. The
                      #   chain is 001, 003-006: 002 seeded the browser-chat
                      #   models and went with them, and the runner skips any
                      #   version it has passed, so the gap is harmless. Never
                      #   reuse a retired number.
  extractors/         # reading a template's styles back out of its HTML
  generators/         # PDF (puppeteer), DOCX (html-to-docx), Handlebars
  integrations/       # Stripe, Cryptomus, Google Sheets - one file per service
  middleware/         # auth, and turning an AI failure into a useful status
  routes/             # one file per /api/* area
  scripts/            # operator tools, each behind an npm script: mail:doctor,
                      #   sheets:login, sheets:doctor, migrate:legacy,
                      #   ai:rollback. The doctors share one shape -
                      #   walk the real chain in order, stop at the first break,
                      #   name the remedy - because each diagnoses a failure whose
                      #   single error message covers several causes.
  services/ai/        # provider-agnostic transport; one directory per provider
  services/queue/     # on-disk generation queue (survives a restart). One LANE
                      #   per real resource - the Claude seat, which also
                      #   carries the metered APIs, and the Codex seat - each
                      #   sized from its own variable. A restored row naming a
                      #   lane this build lacks is moved to one it has. A task
                      #   row's `data` is a hand-picked PROJECTION built by
                      #   index.ts's `taskRow`, not the Task serialized, so a new
                      #   field must be named there AND in the restore mapper or
                      #   it silently does not persist.
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
  test/               # node:test, 70 files; fixtures/cli replays real streams
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
                      #   JSX: its own App, components and stylesheet
  components/ui/      # The kit every page is built from: kit.tsx (Page,
                      #   PageHeader, Section, Card, Field, Notice, Pill,
                      #   EmptyState, Spinner) over the .tl-* classes in
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
                      #   class strings, with the note on why they keep `dark:`).
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
provider catalog, so a missing entry is a compile error. Providers:
`claude-cli` (the default) and `codex-cli` (subscription seats via the local
`claude` and `codex` binaries; both work headless, and `codex login
--device-auth` needs no browser on the server), and `claude` / `openai` /
`deepseek` (metered API keys). `AI_LOCKED_PROVIDERS` in `.env` marks a provider
this machine cannot run; nothing is locked out of the box. A locked Claude seat
moves the default to Codex, and with both seats locked the default is a metered
API model - so nothing keyless is left, and the default bills per token.

Two browser-chat providers were deleted: `claude-web` and `chatgpt-web` drove
claude.ai and chatgpt.com in a debug Chrome over DevTools. **They are retired,
not aliased** - their records carry `modelName: 'chat'`, which no seat has, so
unlike `openrouter` in `LEGACY_PROVIDER_ALIASES` they map onto nothing.
`RETIRED_PROVIDER_IDS` and `RETIRED_MODEL_IDS` (`free-hybrid`,
`claude-web-chat`, `chatgpt-web-chat`) in `config/providerCatalog.ts` let a
stored row, a profile, a prompt override or a stale tab that names them read as
"the default" instead of throwing, and they are permanent for the reason the
alias map is: a restored backup, a hand-edited row or a page left open from
before the upgrade can bring the ids back at any time. Migration 006 strips
them from the database once and keeps a settings snapshot (minus any stored
API keys); the read-time tolerance - including the in-memory repair, onto a
provider not locked here, of a row left with nothing it can run - has to
stand on its own, because 006 sits after 003 in the chain and waits with it
until an administrator exists. A deleted model that was never a browser one is still an
error - do not widen the tolerance to "any unknown id". 006's log,
`migration-log.provider-schema-6`, is read back and so load-bearing: its
`removedModelIds` keep an administrator's own browser model (a UUID) reading
as the default after a restart, and its `leftRunning` limits the in-memory
repair to a row still as 006 left it - after an admin's own save, a new lock
fails by name.

Both CLI providers share the spawn seam in `services/ai/providers/cli/`:
`runner.ts` is the only module under `services/ai` that imports
`child_process`, and `resolveBinary.ts` exists because npm installs a CLI on
Windows as a `.cmd` shim `spawn` cannot execute. Codex differs from Claude in
one way worth knowing: its answer is read from the file named by
`--output-last-message`, not from the event stream, so the JSONL envelope can
move without breaking it.

Tests never spawn a browser, a subprocess or a network call: the CLI provider
replays recorded event streams from `test/fixtures/cli` and
`test/fixtures/codex` through an injected runner, and storage tests point `DB_DIR` and `TAILOR_STATIC_DIR` at temp dirs.

## Conventions from the history

148 commits, no tags; releases are `vN.0` merge PRs (v2.0, v3.0, v4.0 so far).
The pattern in nearly every feature arc is a feature commit followed by one or
more "fix what the adversarial review found" commits, so expect review passes
to be part of the work rather than an afterthought.

Commit subjects are written as sentences saying what changed and why it
matters — "Stop link-sharing every new spreadsheet, and let an operator ask for
it back", not "fix(sheets): visibility". Match that voice.

The README's Troubleshooting table is long and genuinely load-bearing: most
failures you can hit here already have a row explaining the cause. Read it
before debugging a PDF-rendering Chrome, database-directory, seat or provider
problem, and add a row when you fix a new class of failure.

## Platform notes

Windows support is deliberate and tested from Linux: the platform-dependent
decisions (default DB directory, Windows binary resolution, command-line
budget, reserved path characters) take the platform as an argument rather than
reading `process.platform`, so both branches are covered from either host.
`backend/src/config/env.ts` and `frontend/scripts/next.mjs` both decode a
UTF-16 `.env` (PowerShell writes those) — change the two together.
