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
npm run build --prefix frontend# next build            (~17s)
npm test                       # backend node:test suite (~70s with the tsc step, 1713 tests)
npm run dev                    # backend watch + frontend dev server (Turbopack; see next.mjs below)
```

Facts worth knowing before you build:

- **`npm run install:all` after every pull.** A pull brings `package.json`
  entries but not packages; the symptom is `TS2307` / `Cannot find module`
  naming a dependency that is plainly listed.
- **The backend postinstall downloads Chrome** (`scripts/installBrowser.js
  --if-missing`) for PDF rendering. It is idempotent and skips an existing
  download. If the download is blocked, `npm run setup:browser` retries, or set
  `CHROME_PATH` to an installed Chrome/Edge/Chromium/Brave.
- **`npm test` builds first.** It is `tsc && node scripts/runTests.js`, so
  the suite runs the compiled output in `backend/dist`, never the sources.
  Editing a `.ts` and rerunning a single test file directly will run stale
  JavaScript. `scripts/runTests.js` runs `node --test "test/*.test.js"` (or
  the files you pass it) with TMPDIR/TEMP/TMP pointed at a fresh directory of
  its own and deletes that directory afterwards, propagating the exit code -
  the suite makes ~760 temp directories per run and used to leave them all in
  the system temp dir, which filled a disk. `TAILOR_KEEP_TEST_TMP=1` keeps it
  and prints where. A test that writes anywhere but `os.tmpdir()` escapes it.
- **`npm run lint --prefix frontend` exits 1 on a clean checkout** — 3
  pre-existing `react-hooks/set-state-in-effect` errors, ALL THREE in
  `src/bid-assistant/App.jsx` (lines 271, 305, 381; `src/app/page.tsx`
  contributes none), and no warnings.
  Not a build gate: `next build` does not run ESLint. Do not treat a red lint as
  something your change caused without checking `git stash` first.
- **Dark mode does not work the way it looks.** `globals.css` ends with a block
  that remaps light utilities under `html.dark` (`html.dark .bg-white { ... }`).
  That block is **unlayered** while every Tailwind utility sits in
  `@layer utilities`, so it beats `dark:` variants outright — on
  `class="bg-white dark:bg-slate-900"` the shim wins and the variant is
  ignored. 32 of the 33 App Router pages carry no `dark:` at all (only
  `/test` does); they are built from the kit and the tokens rather than the
  utilities it remaps, but it is still loaded and still wins wherever it
  matches. New chrome uses the `@theme inline` tokens instead
  (`bg-surface`, `border-line`, `text-muted`), which the shim never names, and
  needs no `dark:` variant. Three of its rules are catch-alls rather than
  dark-mode fixes — the bare `border` width class, every `shadow*`, and bare
  `input`/`select`/`textarea` — so avoid those on anything new.
- **`frontend`'s npm scripts go through `scripts/next.mjs`**, never `next`
  directly. That wrapper loads the root `.env` (Next only reads `.env` inside
  its own directory) and passes the port without POSIX shell syntax, which
  `cmd.exe` cannot expand. Keep using it. Note the frontend's own `dev` is a
  production-style build+start; `dev:turbo` is the Turbopack dev server, which
  the ROOT `npm run dev` runs; `dev:live` (root `npm run dev:live`) is webpack's,
  opt-in only, because Next's webpack dev server reloads every other open tab
  when a new one connects after anything compiled - and a reloaded Build
  Resumes tab releases, so stops, its Generate Immediately run.
  test/e2e/dev-reload.js measured it on 16.1.6 and again on 16.3.8, on Linux
  (webpack failed both times, 4 of 8 on 16.3.8; Turbopack and the
  production-style `dev` passed all 8, and on 16.3.8 so did the fallback's
  `next build --webpack` + `next start`) and test/devServer.test.js holds the
  root `dev` to Turbopack.
  **On Windows Turbopack's `next dev` can die natively** with 0xC0000005 a
  moment after Ready (vercel/next.js#95015; the owner's log, on a hand-moved
  16.3.5: `npm run dev:turbo --prefix frontend exited with code 3221225477`).
  Then, and only then - mode `dev`, win32, that code in either spelling
  (3221225477, or -1073741819 signed), no signal, once - the wrapper prints
  one explanation and runs `next build --webpack` and, only if that exits 0,
  `next start` on the same host and port: the production-style server, no
  hot reload (owner's decision). A failed build ends the wrapper with its
  code and a note; every other ending passes through as before (a signal
  re-raised, else the code). It also warns before every launch, in every mode,
  when the installed Next differs from an EXACT pin in package.json (`[next]
  Next.js 16.3.5 is installed, but frontend/package.json pins 16.3.8. Run npm
  run install:all.`), and never refuses. Every decision is
  `scripts/nextLaunch.mjs` (`afterExit`, `fallbackSteps`,
  `describeNativeExit`, `fallbackExplanation`, `installedVersionProblem`,
  `MODES`, `nextArgs`) - no imports and no process, file or env access, which
  a test checks - imported by devServer.test.js, which also holds the
  README's quotes of the launcher to its own words. next.mjs launches Next the
  moment it is evaluated, so the test reads it as text or runs a COPY beside a
  stand-in Next; the "as Windows" copy injects exactly two lines by text
  (`platform: process.platform`, and one after `child.on('exit', (code,
  signal) => {`), so reshape either and update AS_WINDOWS there. No signal
  handler, on purpose: Ctrl+C reaches the wrapper's process group (or
  console) and ends it, so no later step starts; a signal to the wrapper's PID
  ALONE leaves `next-server` running, as it always did - stop a server you
  started by its process group. Simulated on Linux only (an exit code is a
  byte here); README Troubleshooting has the row as the owner saw it.
- **Next is pinned EXACTLY**: `next` and `eslint-config-next` both `16.3.8`
  (owner's decision), and test/nextPin.test.js holds package.json and the
  lockfile to one exact, equal release no older than 16.3.3 - GHSA-p293-qw3h-jr36,
  remote code execution on a Windows-hosted server - and every `postcss` in
  the lockfile to 8.5.23 or later. Never back to 16.1.6 (its nested postcss
  8.4.31 is flagged too). Edit package.json and regenerate the lockfile with
  `npm install --prefix frontend`, never by hand. `next.config.ts` sets `agentRules: false`: under an AI agent
  (Claude Code included) Next 16.3's `next dev` otherwise writes
  frontend/AGENTS.md and a frontend/CLAUDE.md on every start. The installed
  Next's own docs are in frontend/node_modules/next/dist/docs/. Turbopack's
  build keeps a cache in `.next/cache/turbopack` from 16.3 (~60 MB).
  When the pin was made `npm audit --omit=dev` in frontend/ still listed
  baseline-browser-mapping and source-map-js, both fixable in range by `npm
  audit fix` and left out of the pin.
- **`better-sqlite3` is native.** Install and run with the same Node major, or
  `npm rebuild better-sqlite3 --prefix backend`. A
  `NODE_MODULE_VERSION 127 ... requires 137` error is this and nothing else.

## Running it

The backend needs a writable `DB_DIR` and nothing else to boot:

```bash
DB_DIR=/tmp/ft-db PORT=3001 node backend/dist/index.js
curl http://127.0.0.1:3001/api/health
```

A variable on the command line like that beats the same one in `.env`. Unset,
`DB_DIR` defaults to `/data/db` on Linux/macOS (often not writable — the
most common first-run failure) and `%LOCALAPPDATA%\free_tailor\db` on Windows.
The backend prints the resolved path, the Chrome it will print with, and a
readiness line per enabled AI provider at startup; a CLI that is missing or signed out is
reported, not fatal, and so is any removed metered-provider variable
(`OPENAI_API_KEY`, `AI_CLI_ALLOW_API_KEY`...) still set in `.env`.

To sign in, `.env` needs Google OAuth (`GOOGLE_CLIENT_ID`) or SMTP.
`ADMIN_EMAILS` (else an `SMTP_USER` that is an address) names the
administrators - promoted at every sign-in and start, never demoted
(`config/adminIdentity.ts`) - and every other sign-in is a `user`; arrival
order decides nothing, and with neither set there is no administrator.

## Layout

```
backend/src/
  index.ts            # Express app: mounts 27 routers under /api
  config/             # env loading (.env, UTF-16 aware), browser resolution.
                      #   ENV_PATH resolves from the COMPILED module, so it is
                      #   always <repo root>/.env regardless of cwd - a file at
                      #   backend/.env is ignored. The ENVIRONMENT beats .env on
                      #   both halves (envFile.ts's applyEnvFile here, the same
                      #   `key in process.env` skip in frontend/scripts/next.mjs -
                      #   change the two together): the file fills in only what
                      #   is unset, an exported empty value counts as set, and a
                      #   name set in both with different values is warned about
                      #   once at startup, by NAME only (describeShadowed builds
                      #   the line; next.mjs keeps a copy, pinned by
                      #   test/envFile.test.js). envFile.ts's
                      #   summarizeEnvFile reports a file's path, encoding and key
                      #   NAMES (never values), including the ones the environment
                      #   overrides (`shadowed`), so the doctors can say why a
                      #   setting that is in the file is not in effect. A NEW setting is read through
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
                      #   providerCatalog.ts is the ONE list of seats (TYPES)
                      #   and of retired ids; aiProviders.ts the PROVIDERS -
                      #   every place a type runs, see "Providers of one type"
                      #   below; jobFields.ts the job fields a posting
                      #   is classified into (stable ids, never reused);
                      #   industries.ts the industries it is filed under
                      #   (closed list, stable ids, `not_specified`; the
                      #   keywords an older analysis's free text is read
                      #   by); providerModels.ts each seat's model-name
                      #   list; pricePerResume.ts the price field's rules
                      #   (thousandths of a dollar, see "Money" below);
                      #   modelErrors.ts the two model refusals;
                      #   accountSubscriptions.ts the account TIERS (Default,
                      #   Premium, Premium+, Premium Max) and their profile
                      #   caps. The tier is a "subscription" in code, API, UI
                      #   and database (it was "plan"; the word is not used for
                      #   it anywhere now, and test/subscriptionRename.test.js
                      #   greps frontend/src to keep it so). Not the AI
                      #   "subscription seats", which share only the word.
                      #   middleware/auth.ts's requireSubscription(min) gates
                      #   on it (403 `subscription-too-low`) and IS satisfied
                      #   by being an admin (`hasSubscription`, owner decision
                      #   B1 - groups.ts relies on it). The multi-profile lock
                      #   is `assertProfileScopeAllowed` there: a run that
                      #   resolves to more than one profile, or omits
                      #   `profileIds` (= all), needs MULTI_PROFILE_SUBSCRIPTION
                      #   (premium) - POST /generation/batches, its /quote and
                      #   /resume/preview-all call it after resolving the
                      #   profiles and before any charge or model call. A
                      #   single-profile run, immediate or order, is open to
                      #   every subscription.
                      #   accountRoles.ts the three ROLES - user, reporter,
                      #   admin (exclusive; owner decisions A3/A4) - and
                      #   `canBuildResumes` (user or admin, by name).
                      #   middleware/auth.ts: `requireUser` IS that builder
                      #   check (a reporter gets 403 `role-not-allowed` and
                      #   ROLE_NOT_ALLOWED_MESSAGE), so every router on it -
                      #   and every router written later - is closed to
                      #   reporters; `requireAccount` is any signed-in role,
                      #   opted into only by auth's /account, credits,
                      #   notifications, sheet and refund-requests' GET /.
                      #   `requireReporter` (`canReportJobs`: reporter or
                      #   admin, never a user - 403 `role-not-allowed`) is
                      #   /api/report's and refund-requests' /payout (whose
                      #   service refuses an admin, 409 `not-a-reporter`), a
                      #   level of its own in the table below.
                      #   requireSubscription refuses a reporter by role first.
                      #   test/routeAccess.test.js is the table of EVERY mount
                      #   in index.ts and every route's effective guard (read
                      #   off router.stack), plus a reporter refused on every
                      #   route that is not theirs over HTTP: a new router or
                      #   a route whose guard differs from its router's fails
                      #   it until a row decides. reportRate.ts a reporter's
                      #   per-account pay per job (`users.report_rate_milli`,
                      #   NULL = the lake's global rate; parse/bounds only).
  controllers/        # one file, the skills handlers routes/resume.ts mounts.
                      #   The library is one store for every account: reading it
                      #   and POST /skills/confirm (additive, idempotent) are
                      #   everybody's; adding with metadata, editing and deleting
                      #   are requireAdmin.
  database/           # better-sqlite3, one repository per table. getDb()
                      #   runs, in order: renameColumns (COLUMN_RENAMES -
                      #   users.plan became users.subscription - guarded by
                      #   PRAGMA table_info and NOT a schema_meta marker, so a
                      #   database renamed back for a rollback is renamed
                      #   forward again; check and ALTER in one BEGIN
                      #   IMMEDIATE, so a second opener of the file waits and
                      #   finds it done; fatal on failure), then SCHEMA, then
                      #   addMissingColumns (never fatal), then
                      #   addIndexesAfterColumns (INDEXES_AFTER_COLUMNS: every
                      #   index naming an added column - in SCHEMA it would
                      #   fail every upgraded boot), then the one-time
                      #   move of `templates` rows to files
                      #   (templateFileMove.ts, schema_meta
                      #   `templates_moved_to_files`, never fatal; recorded
                      #   row by row, so only a row it could not WRITE is
                      #   tried at the next start), then the one-time switch
                      #   of credits to dollars (dollarSwitch.ts, schema_meta
                      #   `credit_unit`, never fatal - see "Money" below),
                      #   then the lake's facts for rows an older build wrote
                      #   (jobLakeFacts.ts, every start, by condition - see
                      #   "The Job Data Lake" below - never fatal), then the
                      #   migrations.
                      #   Rolling back to the previous release (5177fc3) needs
                      #   no statement - nothing it reads was renamed - only
                      #   open payout requests decided and [[industryList]]
                      #   out of an edited analysis prompt, which the README's
                      #   check lists; 90adbaf reads users.plan, so going back
                      #   that far renames it back first (README, "Rolling back
                      #   this release" and its "Going back further, to
                      #   90adbaf", which gather every step a rollback needs;
                      #   test/rollbackDocs.test.js runs the check and the
                      #   statements against this build's schema, and 5177fc3's
                      #   own reads and lake insert too, so a column renamed,
                      #   a request kind or a notice stored differently fails
                      #   it until the README follows).
                      #   Saved templates are NOT a table:
                      #   templateFiles.ts is their store, `<id>.json` in
                      #   static/templates (see the note under this block);
                      #   templateRepository.ts keeps the four signatures it
                      #   had, plus the template_overrides table.
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
  integrations/       # Stripe, Cryptomus, Google Sheets - one file per service.
                      #   Every Sheets/Drive call goes through `fetchWithBackoff`
                      #   (429: jittered exponential backoff, Retry-After
                      #   honoured, 5 retries, 32s cap); analysis data and the
                      #   filter's verdicts are written RAW, never USER_ENTERED
  middleware/         # auth, uploads, and publicError.ts - what a failure may
                      #   tell whom (see "The AI layer" below)
  routes/             # one file per /api/* area. profiles.ts also holds
                      #   POST /profiles/preview, the profile editor's live
                      #   preview (see "Profiles, templates and the section
                      #   switches" below). accounts.ts refuses an admin
                      #   disabling, demoting or deleting their OWN account
                      #   (409 `own-account`; another admin may), and its
                      #   last-admin guard (`wouldStrandInstall`) counts ANY
                      #   role but admin as losing one - not `user` by name.
                      #   It also takes `role` user|reporter|admin (anything
                      #   else 400 `bad-role`, never a quiet user), serves each
                      #   row's `roleLabel`, `reportRateMilli` (ADMINS ONLY -
                      #   read by its own query, never on UserAccount or the
                      #   session) and `configuredAdmin` (an ADMIN_EMAILS -
                      #   else SMTP_USER - address, named by
                      #   `configuredAdminSource`; a demotion's `note` says
                      #   sign-in undoes it), takes `reportRateUsd` (only for a resulting
                      #   reporter; '' or null clears), and POST
                      #   /:id/payout { amountUsd, note, requestId? } records
                      #   a reporter's payout and closes their open payout
                      #   request in the same transaction (`closedRequestId`;
                      #   see "Money" below).
                      #   refundRequests.ts (a reporter's payout request, the
                      #   410 for the retired refund asks, and the admin
                      #   queue) and
                      #   contact.ts (GET /api/contact is PUBLIC, no session)
                      #   are described under "Money" below. generation.ts is
                      #   the queue's HTTP side - see services/queue/ below for
                      #   its run kinds, the release route and the per-file
                      #   download. import.ts's GET /tabs lists the caller's
                      #   OWN sheet's tabs (`listAddressableSheetTabs`: the
                      #   resolveAddressableSheet guard - own sheet only, any
                      #   other id 404, an admin's too - then one listing and
                      #   ONE batched read of every tab's row 1), each with
                      #   `layout` job | blank | other, `defaultTab` All;
                      #   POST / still reads a tab's rows. POST
                      #   /resume/generate (synchronous, admin output
                      #   template, refundable as `charge:`) is KEPT for any
                      #   caller, but the builder queues every build now.
                      #   generatedFiles.ts is the one owner check of the two
                      #   path-taking downloads, GET /api/generated/* (its
                      #   handler, mounted inline by index.ts) and
                      #   /api/resume/download/* (`generatedFileFor`): asked of
                      #   the path as the server OPENS it - utils/generatedPath's
                      #   `resolveGeneratedFile` spellings, empty and dot
                      #   segments resolved, then through the native realpath -
                      #   never the raw parameter, which let `a//b` and `./a/b`
                      #   read another account's run. `ownersOfGeneratedFile`
                      #   (orderRepository) folds case, and also claims a whole
                      #   run's folder by its order-number segment, so a file is
                      #   the run's before (or without) its item recording it;
                      #   test/orderFileAccess.test.js sends the spellings raw.
  scripts/            # operator tools, each behind an npm script: mail:doctor,
                      #   sheets:login, sheets:doctor, migrate:legacy,
                      #   ai:rollback. The doctors share one shape -
                      #   walk the real chain in order, stop at the first break,
                      #   name the remedy - because each diagnoses a failure whose
                      #   single error message covers several causes.
  services/ai/        # provider-agnostic transport; one directory per provider
                      #   TYPE, one adapter per PROVIDER (registry.ts keyed by
                      #   provider id), providerPool.ts which provider of a
                      #   type a call runs on
  services/jobAnalysis/ # THE way to a job analysis: gate.ts's
                      #   `getOrCreateAnalysis` (the only caller of the analysis
                      #   prompt - test/analysisGate.test.js greps for any
                      #   other), identity.ts (link key, content hash),
                      #   facts.ts (salary, filter facts), submit.ts (a batch's
                      #   analyses at submission, sheet first). See "Job
                      #   analysis runs once" below.
  services/queue/     # on-disk generation queue (survives a restart). One LANE
                      #   per PROVIDER (lane id = provider id: `claude-cli`,
                      #   `codex-cli`, `gemini-cli` for the built-ins, `prv-...`
                      #   for an added one), each as wide as its
                      #   `concurrency_max_requests`, re-read live; a task names
                      #   its POOL (`laneFor` = its model's type) and is placed
                      #   with a serving provider of it - see "Providers of one
                      #   type" below. A restored row naming a lane this process
                      #   lacks (a removed provider, an older build's `cli`/
                      #   `codex`/`gemini`) goes to its type's pool. A task row's `data` is a
                      #   hand-picked PROJECTION built by index.ts's `taskRow`,
                      #   not the Task serialized, so a new field must be named
                      #   there AND in the restore mapper or it silently does
                      #   not persist (`ranOn`, the provider it last ran on, is
                      #   one such). The payload persists whole, which is why
                      #   a task's price lives on it (`payload.costMilli`), and
                      #   its job's stored analysis (`payload.analysisId`, set
                      #   at submit or stamped on every task of the job by the
                      #   first to obtain it - `recordJobAnalysis`) -
                      #   and so does `batch.shared`, which is why a batch's
                      #   KIND is there: `shared.kind = 'order' | 'immediate'`
                      #   (`isOrderBatch`, `isImmediateBatch`; submit body
                      #   `mode`, default immediate, `asOrder: true` an alias
                      #   for order; a restored batch from before kinds is an
                      #   order if its `orders` row says so, else an older
                      #   builder run left to finish - no lease, no priority).
                      #   EVERY run gets an `orders` row (`orders.kind`, an
                      #   added column; immediate rows number `FT-RUN-...`, are
                      #   hidden from listOrdersForUser and the order routes'
                      #   `mine()`, and are filed under ORDER_OUTPUT_PATH_TEMPLATE
                      #   like an order - the admin's output template files
                      #   only POST /resume/generate's builds). An immediate run is LEASED to
                      #   its tab (tabLease.ts, `getTabLeases()`): the owner's
                      #   stream with `?tab=` = `shared.tabId` holds it; when the
                      #   last such reader closes, IMMEDIATE_TAB_GRACE_MS starts
                      #   and its expiry calls `queue.cancel` (refunds through
                      #   the usual hooks). A hold lasts LEASE_READER_LIFETIME_MS
                      #   (20 s) and the route then ENDS that stream, so a reader
                      #   counts by renewal - the page reattaches - and a peer
                      #   that vanished without a FIN cannot hold the run until
                      #   TCP gives up. Armed at submit and after a restore
                      #   too; forgotten by the queue's `batchFinished` hook;
                      #   POST /generation/batches/:id/release?tab= cancels at
                      #   once (owner, own tab; no body, cookie auth, so a
                      #   keepalive pagehide fetch works). An immediate batch is
                      #   `urgent` (taskQueue `enqueue`: ahead of non-urgent
                      #   tasks in its lane, FIFO within each tier, for submit,
                      #   restore and the retry re-queue alike - not persisted,
                      #   re-derived from the kind). Its files: GET
                      #   /generation/batches/:id/tasks/:taskId/:kind (owner
                      #   only, found through the orders row so eviction does
                      #   not matter; snapshots list each done task's `files`
                      #   kinds), deleted IMMEDIATE_FILE_RETENTION_MS after
                      #   `finished_at`, downloaded or not (retention.ts's
                      #   minute sweep, `listFinishedImmediateRuns`; the order
                      #   sweep skips kind immediate). The builder's
                      #   `GET /generation/batches?active=1` lists only the
                      #   caller's OWN non-order runs, admins included, and
                      #   `&tab=` only that tab's immediate runs.
                      #   `restoreGenerationQueue` reports the `batchIds` it
                      #   put back, and index.ts hands them to
                      #   `reconcileCredits`, which never releases those
                      #   reservations however old (a restored batch that had
                      #   already finished is settled by the restore itself).
                      #   A job with no role is built for the analysis's
                      #   `jobMeta.title` (`resolveTaskRole`, which
                      #   routes/resume.ts uses too) - cover letter, path,
                      #   files and result alike; the builder has no
                      #   Fallback Role.
  services/tailorCache.ts # the tailoring cache (owner decision P6): the model's
                      #   answer to a tailoring or a cover-letter call, reused
                      #   for the same unchanged profile, posting, model and
                      #   prompt - see "The tailoring cache" below.
  services/templateChoice.ts # THE answer to "which template is this resume
                      #   drawn with" - resolveTemplateForProfile, for the live
                      #   preview, /resume/preview, /preview-all,
                      #   /resume/generate and the queue. Do not write a
                      #   second copy of the fallback.
  bidAssistant/       # the Bid Assistant's own prompt building, and database.js.
                      #   Its job board is SHARED (deleting a job, which takes
                      #   every account's answers, and the one Ask AI template
                      #   are requireAdmin); sheet sources carry an `account_id`
                      #   (added in place, PRAGMA + ALTER - an owner-less legacy
                      #   row is listed for all, changed by an admin, and a
                      #   deleted account's is listed to admins only); answers
                      #   are scoped through the reader's own profiles, and so
                      #   is a job's `has_answers`. Answers are keyed by profile
                      #   id alone and ids are reusable, so deleting a profile
                      #   deletes its answers (profileRepository.deleteProfile)
                      #   and loading database.js sweeps any left orphaned.
  types/, utils/      # shared types; path, storage and filename helpers
backend/
  scrapers/           # NOT under src/, and the bulk of the backend's
                      #   JavaScript: seven Apify actors plus one shared
                      #   apify.js, behind one registry, reached from
                      #   services/scraperProviders.ts and routes/jobs.ts.
                      #   (bidAssistant/database.js and scripts/installBrowser.js
                      #   are JavaScript too.)
  static/             # shipped defaults, never written at runtime EXCEPT
                      #   templates/, which also holds saved templates - and
                      #   not all read the same way: see the note under this block
  test/               # node:test, 139 files; fixtures/cli, codex and gemini
                      #   replay real CLI streams (`recorded-` is a capture,
                      #   `constructed-` a real envelope around a fake answer)
frontend/src/
  app/                # App Router pages: /, /settings/*, /admin/*, /jobs,
                      #   /orders, /credits (+ /credits/invoice, drawn with no
                      #   shell - navModel's isBareRoute). /account redirects
                      #   in a client effect (router.replace), by its hash,
                      #   which never reaches the server: #subscription ->
                      #   /settings/subscription, #credits -> /credits, #sheet
                      #   -> /settings/job-sheet, else /settings - so it cannot
                      #   be a redirect(). /settings/plan goes to
                      #   /settings/subscription by a static redirect() the
                      #   client follows on hydration (the root layout's shell
                      #   streams first, so it is never an HTTP 307).
                      #   /admin/profiles, /admin/profiles/new and
                      #   /admin/profiles/[id] are EVERY builder's own profiles
                      #   and their editor, whatever the path says. /report
                      #   (Report Jobs) is a REPORTER's home, behind
                      #   AuthGate's `ReporterOnly` (an admin may open it, a
                      #   user is told what it is for): their rate, earnings
                      #   and sheet, a tab and rows previewed, "Add to job
                      #   lake", the run followed to the owner's line - see
                      #   "The Job Data Lake" below, as for /admin/job-lake.
                      #   A REPORTER opens only lib/roles.ts's allowlist -
                      #   /report (and under it), /credits, /settings,
                      #   /settings/job-sheet, each exactly - and AuthGate
                      #   sends them to /report from every other path WITHOUT
                      #   mounting it (every builder page fires requests the
                      #   moment it mounts, all 403 `role-not-allowed`). An
                      #   allowlist because /admin/* holds builders' pages too;
                      #   test/frontendRoles.test.js walks every page.tsx and
                      #   fails unless exactly those four are a reporter's, so
                      #   a new reporter page is added there AND to that list.
                      #   /credits draws `EarningsCredits` for them (balance +
                      #   CreditHistory `variant="earnings"`; no purchase,
                      #   order or refund panels, which a reporter is refused).
  components/shell/   # The app shell - top bar, rail, and the "Settings" title
                      #   and tabs above every settings route (Administration
                      #   is one tab with a second row of the /admin/* pages).
                      #   Mounted once in the root layout inside AuthGate;
                      #   pages render no navigation of their own. navModel.ts
                      #   is the ONE list of rail entries and settings tabs,
                      #   by ROLE: an entry's `roles` names who sees it and
                      #   ABSENT means the builders (user, admin), so a new
                      #   entry is kept from reporters until it names them -
                      #   `canSee(item, role, subscription)`, `settingsTabsFor`.
                      #   A reporter's rail is Report Jobs, Credits, Settings
                      #   (Profile, Job Sheet); their account menu has their
                      #   sheet link, Settings, Contact admin, Log out and no
                      #   subscription. lib/roles.ts copies the backend's role
                      #   catalog (drift-tested) and holds the allowlist. A 403
                      #   `role-not-allowed` is NOT a sign-out: lib/api.ts's
                      #   `noticeRefusal` hands it to AuthContext, which
                      #   re-reads the account (at most once in 10 s), so a
                      #   user made a reporter mid-session is redrawn as one.
                      #   Every fetcher goes through it - the Bid Assistant's
                      #   raw-fetch client too, from its `responseError` -
                      #   and frontendRoles.test.js fails on a new raw fetch
                      #   of the API that does not.
                      #   The look follows a reference design (textverified):
                      #   .tl-tabs, .tl-button(-quiet), .tl-table(-box),
                      #   .tl-section, .tl-input in globals.css are the shared
                      #   pieces, as classes the dark-mode shim never names.
  components/profile/ # The profile editor: ProfileEditor owns the draft and
                      #   the save, the sections are split by area
                      #   (ContentSections, HistorySections, SkillSections,
                      #   TemplateSection, SettingsSections; parts.tsx), and
                      #   ProfilePreview frames the server's render in two
                      #   swapping <iframe sandbox="allow-same-origin"> (no
                      #   allow-scripts - same-origin only so the page can
                      #   measure it), debounced, aborting stale requests and
                      #   keeping the last good page up. It scales the page to
                      #   the width it WOULD have with a scrollbar
                      #   (lib/previewPane.ts, plus scrollbar-gutter on the well
                      #   and, while the editor is open, on html): scaled to the
                      #   width as it stood, a one-page resume shook every frame
                      #   wherever scrollbars take room - puppeteer hides them,
                      #   so only test/e2e/preview-vibration.js sees it. The
                      #   decisions with no React in them - draft <-> payload,
                      #   what the preview is sent, which templates the picker
                      #   offers, the sample-text notice and placeholders, what
                      #   an unticked section keeps - are lib/profileDraft.ts,
                      #   which imports types only so test/frontendHelpers and
                      #   frontendEditorHelpers.test.js can load it. An
                      #   unticked Soft Skills / Strengths box shows only its
                      #   switch and "N kept"; nothing is deleted.
  components/icons/   # Hand-rolled inline SVG set (there is no icon library).
                      #   index.tsx is UI icons - one grid, one stroke, one
                      #   colour, and the ROW decides it. marks.tsx is brand
                      #   and asset marks, which are filled and multi-colour
                      #   and never recoloured by a parent. Anything needing a
                      #   fill belongs in marks.tsx.
  components/credits/ # The three-step purchase dialog. order.ts holds the
                      #   wizard reducer with no JSX in it, and the purchase
                      #   AMOUNT rule: dollars as typed, fitted into the
                      #   method's bounds, a fraction of a cent refused in the
                      #   server's own words; chrome.ts holds the
                      #   shared class strings and the note on why none of them
                      #   carries a `dark:` variant. Also the /credits history
                      #   tables: usePagedList.ts (paging with the race guards),
                      #   TablePager, OrderHistory, CreditHistory,
                      #   RefundRequestHistory (the Refund Requests tab, read-only
                      #   and saying to contact the administrator; and, as
                      #   `variant="payouts"`, a reporter's Payout requests). A
                      #   colour on a .tl-table cell goes on an inner span - the
                      #   unlayered td rule beats a utility on the td itself.
                      #   NOTHING asks for a refund (owner decision R1): no Ask
                      #   on a purchase, a Credit History row or an order's
                      #   resume, and frontendRefunds.test.js fails on one. A
                      #   reporter's Credits (app/credits EarningsCredits) has
                      #   "Ask for Refund" in Purchase Credits' place and style,
                      #   off with the server's reason (`payoutBlocker`) at $0 or
                      #   with a request open, opening PayoutRequestDialog - the
                      #   whole balance, an optional note, never an amount.
                      #   PayDialog is only an alias of ui/Dialog.tsx.
                      #   The administrators' queue is app/admin/payments/
                      #   RefundQueue.tsx, the `?tab=refunds` of Payments, where
                      #   every "New refund/payout request" notice links: a
                      #   payout row is marked Payout with its balance now, and
                      #   its Refunded is "Record payout" - an amount prefilled
                      #   with the smaller of what was asked and the balance now,
                      #   and a note, both checked by lib/reporterPay.ts's
                      #   `payoutProblem`, the one Admin -> Accounts uses.
  bid-assistant/      # the largest single feature directory here, and the only
                      #   JSX: its own App, components and stylesheet. Its
                      #   failures go through lib/apiBase.js's readError /
                      #   responseError, then messageWithDetail like the rest
  components/ui/      # The kit every page is built from: kit.tsx (Page,
                      #   PageHeader, Section, Card, Field, Notice, ErrorNotice,
                      #   Pill, EmptyState, Spinner) and Dialog.tsx (the one
                      #   modal: portal, Escape for the TOP dialog only, one
                      #   scroll lock however many are stacked -
                      #   lib/dialogStack.ts's `pageDialogs`) over the .tl-*
                      #   classes in globals.css, which state every colour for
                      #   both themes. A modal that draws its own chrome joins
                      #   that stack with Dialog.tsx's `useDialogLayer` (the
                      #   payments list's Refund dialog), or, keeping its own
                      #   scroll lock, ignores Escape while
                      #   `pageDialogs.size() > 0` (the calendar's) - else one
                      #   Escape closes it AND the Contact admin opened from
                      #   its error notice.
                      #   Notice (warn/error), Status (error) and ErrorNotice
                      #   end a TEXT sentence that asks the reader to contact an
                      #   administrator (lib/contactChannels.ts
                      #   `asksForAdministrator`) with a "Contact admin" link;
                      #   text drawn outside them gets it from
                      #   <ContactAdminFor text={...} />, and a sentence
                      #   written as JSX puts <ContactAdminLink /> after it -
                      #   test/frontendRefunds.test.js parses every page and
                      #   fails on one that does not.
                      #   New UI uses these and the tokens (text-ink, text-muted,
                      #   bg-surface, border-hairline...), never bg-white /
                      #   text-gray-* / dark: - see the shim note above. The
                      #   .tl-* rules are unlayered, so a utility cannot override
                      #   their padding or height; use a data-* option or a
                      #   CSS module. /admin/* pages sit inside app/admin/
                      #   layout.tsx's <main>; the ones that are Settings tabs
                      #   are also under the shell's Settings title, so they
                      #   open with an h2, not a PageHeader. /admin/profiles
                      #   (and its editor), /admin/templates and /admin/groups
                      #   are not tabs, and do open with a PageHeader.
  app/page.tsx        # Build Resumes. Every build is queued (POST
                      #   /generation/batches) as Generate Immediately (`mode:
                      #   'immediate'` + this tab's `tabId`, lib/generationQueue's
                      #   currentTabId - claimed in sessionStorage, so a reload
                      #   keeps it and a duplicated tab mints its own) or Order.
                      #   An immediate run is followed with `?tab=` until the
                      #   SERVER says it ended (lib/batchFollow `nextAttach`
                      #   stops only on a 404 and otherwise slows down - the
                      #   lease always ends the run server-side); each finished
                      #   resume is downloaded once, fetched as a Blob and saved
                      #   through a blob: anchor so a 410 stays a notice, each
                      #   FILE kept in sessionStorage as `<taskId>:<kind>` the
                      #   moment it is saved (a reload mid-resume saves only the
                      #   rest), and listed again under the
                      #   progress (components/ImmediateRunFiles) because a
                      #   browser blocks a second automatic download silently.
                      #   Leaving stops it: `pagehide` sends the keepalive
                      #   release (no body, no Content-Type, the bearer only on
                      #   the same origin), so a RELOAD stops it too, after the
                      #   browser's prompt; an in-app link asks first
                      #   (`leavesBuilder`, a capture-phase click listener) and
                      #   unmounting releases it. The pure parts - tab id,
                      #   downloads, the release request, the confirm's "Don't
                      #   show again" (localStorage), how a run ended - are
                      #   lib/immediateRun.ts, and the sheet panel's rows
                      #   (components/SheetsSourcePanel) lib/sheetRows.ts, both
                      #   run by test/immediateRunHelpers.test.js; sheetRows.ts
                      #   also holds the own sheet's LAYOUT (C:F, then G, H
                      #   and L) and the Analysis cell's states, which
                      #   test/frontendAnalysis.test.js holds to
                      #   JOB_SHEET_COLUMNS and parseAnalysisCell. The
                      #   multi-profile choices lock on lib/subscriptions.ts
                      #   `canBuildForManyProfiles` (the backend's
                      #   hasSubscription, admins exempt; frontendHelpers.test.js
                      #   runs both), and the target in effect is DERIVED from it
                      #   rather than corrected in an effect.
  components/, lib/   # UI and the API client. Shared bits worth knowing before
                      #   writing another copy: lib/format.ts (one formatDate for
                      #   every page, and formatMoney / parseDollars /
                      #   toDollarInput for every amount - see "Money"),
                      #   lib/ledger.ts and lib/paymentDisplay.ts (how a ledger
                      #   row and a payment read), lib/sheet.ts (the spreadsheet range
                      #   parsers), components/pageChrome.ts (the CARD and LABEL
                      #   class strings, with the note on why they keep `dark:`),
                      #   lib/userMessage.ts (userMessage / messageWithDetail -
                      #   the ONE way a page turns a failure into text; never
                      #   print `err.message`, and render a caught error with
                      #   <ErrorNotice>, which shows an admin's `detail`).
                      #   components/contact/ is Contact admin: the dialog
                      #   anybody opens (account menu, sign-in and
                      #   account-disabled screens, every "contact your
                      #   administrator" sentence) and Settings -> General's
                      #   editor, which pins the server's `fieldErrors` to rows
                      #   by key. A link the server hands a page - a notice's
                      #   `link`, a channel's `href` - goes through
                      #   lib/appLinks.ts before it is an href; a page never
                      #   builds one from a value. lib/refunds.ts is the refund
                      #   and payout API (`refundRequestsApi.list`, read-only;
                      #   `payoutRequestsApi`; the admin queue);
                      #   lib/refundDisplay.ts how a request reads (a refunded
                      #   payout is "Paid out", `refundStateLabel`) and which
                      #   buttons it gets, with no request in it, so
                      #   test/frontendRefunds.test.js runs it (and the reason,
                      #   note and amount rules it copies) against the server's
                      #   code and the real payout routes.
                      #   lib/orderCancel.ts is what Cancel on an order asks AND
                      #   says it did (/orders, an order's page, the builder's
                      #   receipt) - one file, so the two agree that a resume
                      #   stopped mid-build is refunded unless it finished.
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

All dynamic data lives in SQLite, except saved templates. `backend/static` is
never written, except `static/templates`, which also holds saved templates -
and its three kinds of default are read three different ways. The skill library is
copied into the database once, on first use, and read from there. A built-in
prompt is read from its file until an administrator edits it; from then on its
database row wins. **Built-in templates are read from `backend/static/templates`
on every request** and never copied: the database holds only an override row
per built-in (`template_overrides` - name, description, disabled,
`skillsLayouts`) laid over the file, so editing a shipped template's JSON
changes every install at its next request.

**Uploaded, extracted and manual templates are files in the same directory**
(`database/templateFiles.ts`, through `getStaticTemplatesDir()`, so
`TAILOR_STATIC_DIR` and the tests' temp dirs still work): `<id>.json` in the
shipped shape plus `"source": "uploaded" | "extracted" | "manual"`. **A file
without `source` is a built-in** - read-only, its edits in
`template_overrides`, so a `git pull` never conflicts with an edit; a file with
one is editable and deletable, rewritten or removed by the admin Templates
page. A write goes to a unique `<id>.json.<pid>-<hex>.tmp`, is fsynced and
renamed over the file (a crash leaves the old file or the new, never half);
ids are `[a-z0-9-]`, at most 100, never a Windows device name, checked before
any path is built (`templateFileId`); a built-in's id, or an unreadable file's,
is never overwritten; `supportsSoftSkills` / `supportsStrengths` / `isBuiltIn`
are never written. Every reference goes through `currentTemplateId`
(templateRepository.ts): a file id is itself; an older build's spelling is
first looked up EXACTLY in the move's renames, then folded (case and `_`,
`canonicalTemplateId`) - in that order, because `Navy_Rule` folded is the
shipped `navy-rule`, not the row the older build drew it with. A profile's
`preferredTemplate` is stored (`normalizeProfilePayload`) and read
(`profileRepository`) under that id, because the editor, the Profiles list and
the one-template-per-profile rule compare ids as they are. A write that fails
throws `TemplateStoreError`, which the template routes answer with "Template
could not be saved." and a ref. `getDb()` wrote an older database's
`templates` rows out once (templateFileMove.ts) and left them as an unread
backup: rows whose id is already a file id go first and keep it; any other is
filed under its folded id if free, else a `u-` id derived from the old one
(so a re-run finds it), never a built-in's or another row's, and the profiles
naming it are repointed in the same transaction; the renames stay as aliases.
It is recorded row by row - a row that failed to write is retried alone, a
moved one is never looked at again - and the README's "Rolling back this
release" (step 5, and *Upgrading again*) says how to roll back and run it
again. Saved files are not
gitignored, so they show in `git status` and can be committed to ship them.
Startup prints whether the directory is writable, and names any `.json` there
no id can have (not offered), under `Database:`.

## Profiles, templates and the section switches

A profile's resume choices are three fields of `ProfileSettings`:
`technicalSkillsLayout` (`'categorized' | 'flat'`, shown as **Grouped** /
**Plain**, absent = categorized) and the booleans `includeSoftSkills` and
`includeStrengths`, absent = false - which is what every resume rendered before
they existed, so they needed no migration. Read them with `profileService`'s
getters (`getProfileResumeSections` for all three); a save keeps a stored value
when the payload omits it, and only a boolean decides. `Profile.softSkills` is
the person's own list (trimmed, case-insensitively unique, 50 x 100 chars).

**The render gate** is `applySkillsLimit` in `generators/pdfGenerator.ts`: every
path - the live preview, the PDF, the DOCX, the queue - empties a switched-off
section there, whatever content it was handed, because batch and queued
content can arrive from the client without being re-parsed. At compile time
a switched-off section is stripped WHOLE, heading included, and a switched-on
one is guarded on its list (`{{#if strengths.length}}`) - both through ONE
finder, `findOptionalSections`: the `section-strengths` / `section-soft-skills`
class (every built-in, the manual builder); else `data-section="strengths"` /
`"softSkills"`; else, from each place the list is printed outside those
(`sectionLoops`: a `{{#each <field>}}` loop, or an inline `{{join <field> ...}}`
/ `{{<field>}}` - what `inferTemplateCapabilities` offers the switch for), the
nearest element around it that holds the section and NOTHING else
(`holdsOnlyTheSection`: one piece reading as the heading - `/strength/i`,
`/soft[\s-]*skill/i`, at most 60 characters - and beside it only markup that
`showsNothing`: no text, no data, no img/svg/media, no CSS `url(`, no
style/script), or the list's container (plus a guard right around it) and the
heading element before it, past dividers and line breaks. An element that also
holds a photo, an icon or a line of static text is never taken whole - a grid
sidebar once went with its photo and *References* - and one holding other data
never at all (test/sectionHeadings.test.js; test/e2e/section-switches.js drives
the editor). A guard is taken only when its `{{#if}}` and `{{/if}}` pair up
INSIDE what is cut (`besidesTheLoop`), and `compileTemplate` parses the result
(`compilableMarkup`): markup the finds would leave uncompilable is compiled
with the marked sections only, then with none, logged once per template - a
find must never stop a template rendering. The stored file is never
rewritten. Per-item skill loops are rewritten into categories only for
`categorized` (the compile cache is keyed on the markup plus those choices).
The DOCX draws its own sections from the gated lists, so it never needed the
finder.

**The template decides the switches too.** A switch that the generation's
template has no section for counts as OFF everywhere: read the profile through
`profileForTemplate(profile, template)` (`profileService`), which every render
entry point does (`generateResumePDF`, `generatePreviewHTML`,
`generateProfilePreviewHTML`, and `generateResumeDOCX`, which takes the
template for exactly this) and every tailoring caller does before
`tailorResume` / `parseTailoredResumeContent` / `finaliseHeldContent` (the two
resume routes, `/preview-all` - which resolves each profile's template before
tailoring - and `runResumeTask`). A new output or tailoring path that skips it
prints a section the PDF does not, or loses the posting's soft skills from the
summary to a list that never prints.

Every template carries `skillsLayouts` (a non-empty subset, in the order
`['categorized','flat']`): the built-ins state it in their JSON (Burgundy Rule
and Navy Rule are categorized-only), anything stored without one gets
`inferTemplateSkillsLayouts(html)` on read (`services/templateImport.ts`), and an
admin's `PATCH /api/templates/:id { skillsLayouts }` goes into a built-in's
override row. `supportsSoftSkills` / `supportsStrengths` are derived from the
markup on every read and stripped before a stored row is written. Templates are
offered to a profile only for its layout, and `services/templateChoice.ts`
falls back rather than failing a resume over a mismatch.

`POST /api/profiles/preview` (any signed-in account, body `{ profile,
profileId?, templateId? }`, answers `{ html, templateId, page: { widthPx,
heightPx, contentHeightPx }, sampled }`) renders a DRAFT untailored through the same
pipeline as generation - with one difference: whatever the draft leaves empty
is drawn from the gallery's sample person (`withSampleDefaults`,
`services/sampleProfile.ts`, which also holds `SAMPLE_PROFILE`), per field for
single values and per section for lists, Strengths and Soft Skills only while
their switch is on for the template (it runs after `profileForTemplate`).
`sampled` names what was filled, from `SAMPLE_FIELDS` and in that order:
`name, title, email, phone, location, linkedin, summary, experience,
education, skills, strengths, softSkills`. It is applied in that route and
nowhere else - never a save, a generation, a PDF/DOCX or a prompt -
and test/sampleDefaults.test.js fails if anything else calls it. `buildPreviewProfile` never throws and takes only the
four render settings from the draft; nothing is saved, no subscription limit is
checked, no model is asked, no credit moves (test/profilePreview.test.js runs
with every seat locked to prove it). The document carries
`PREVIEW_CONTENT_SECURITY_POLICY` as a meta right after its doctype - before it
would flip the page into quirks mode and away from the PDF's layout - and a
Grouped preview is NOT padded from the library (`padSkillCategories: false`),
while generation still is. The gallery's `GET /api/templates/:id/preview` sends
the same policy as a header and takes `?layout=&softSkills=&strengths=`.

## Money

**A credit is a dollar, counted in thousandths.** Every amount - a balance, a
price, a charge, a refund, a purchase, `CREDIT_SIGNUP_GRANT` - is an integer
count of milli-dollars (`23` is $0.023) and nothing on a money path rounds,
floors or parses a float: test/money.test.js fails on a `Math.floor`,
`Math.trunc`, `parseFloat`, `parseInt` or `Number.isInteger` in the money
modules it lists. `utils/money.ts` is the ONE text-to-money parser
(`parseDollars`: at most three decimals, refused rather than rounded, a JSON
number read through its shortest spelling) and the ONE formatter (`formatMoney`:
every significant digit and no trailing zero or bare dot - `$1`, `$4.1`,
`$0.023`, `$0`, `$1,234.5`, `-$0.046` - integer-built, never rounded; it used
to pad to three decimals, and `$1.000` read as a thousand. Text already STORED
- a ledger note, a request's label - keeps the figure it was written with; the
docs spell amounts its way too, and money.test.js reads them for a padded
amount outside the README's release history),
plus `parseProviderCents` for an amount a
provider reports (exact; `12.505` is not a match for 1250 cents). The frontend's
`lib/format.ts` mirrors both - its fixed-decimal helpers (`toDollarInput`'s
`2.50`, `formatLegacyUnitPrice`'s `$0.50`) build from a private `moneyParts`,
never by slicing `formatMoney`'s text - and test/frontendMoney.test.js runs each pair over
the same inputs (and the Admin -> Models price box against
`parsePricePerResume`) and fails on any difference - and on a `Math.floor`,
`parseInt`, `parseFloat`, `Number.isInteger` or `toFixed` in the frontend money
files it lists. A page shows every amount with `formatMoney`, never `Intl`
currency formatting, and SENDS an amount as the text that was typed
(`amountUsd`, `balanceUsd`, `pricePerResumeUsd`), never a number it parsed.
History from before dollars is shown in its own unit and never converted: a
ledger row with `legacyCredits` reads `-12 credits` (lib/ledger.ts), and a
payment that bought credits keeps its "195 Credits at $0.50 each" invoice line
(lib/paymentDisplay.ts `isLegacyPurchase` - not just "has `legacyCredits`": a
checkout opened before the switch and paid after was credited in dollars).

**The API contract.** Every amount in every response is an integer in a field
ending `Milli` (`balanceMilli`, `heldMilli`, `deltaMilli`, `balanceAfterMilli`,
`costMilli`, `pricePerResumeMilli`, `neededMilli`, `amountMilli`,
`creditMilli`...). Every amount in a request is dollars, as text or a JSON
number, in a field ending `Usd` (`pricePerResumeUsd`, `balanceUsd`, `amountUsd`,
`minUsd`...). A request still carrying an amount in the old unit (`credits`,
`amount`, `creditsPerResume`, `minCents`) is refused as a stale page, never read
as dollars. The old integer-credit fields are gone from responses, not aliased.

**Storage is NEW columns, never the old ones reinterpreted** - that is a 1000x
rollback hazard: `users.balance_milli`, `credit_ledger.delta_milli` /
`balance_after_milli`, `credit_reservations.units_milli` / `refunded_milli`,
`payments.credit_milli` / `credited_milli` / `refunded_milli`. Every row written
now puts 0 in the whole-credit columns beside them (`credits`, `delta`,
`units`, `payments.credits`, `unit_price_cents`), so a ledger row is in exactly
one unit: `delta != 0` - or reason `reset`, which can move 0 - means a row from
before dollars, served as `legacyCredits: { delta, balanceAfter }` and never
converted (creditRepository's `toEntry`); a payment with
`credits > 0` is served with `legacyCredits` (its receipt keeps "N credits at
$0.50"). A purchase credits exactly what it charges (no fee, no price per
credit; `creditPaid` grants `creditMilli`, or `amountCents * 10` for a
checkout opened before dollars), and refunding a payment from before dollars
reverses nothing (`creditedMilli` is 0: those credits were reset).

**The switch** (`database/dollarSwitch.ts`) ran once in `getDb()` with marker
`schema_meta.credit_unit = 'usd-milli'` and snapshot
`app_settings["migration-log.credits-to-dollars"]`. The owner chose a RESET
(M1): a `reset` ledger row per account with old credits (reason `reset`, in the
old unit; an account whose credits were all held by a run gets one at delta 0
saying its run stops refunding), `users.credits` zeroed, open reservations
closed, every task given
`payload.costMilli: 0` (it finishes on the credits it was paid with and refunds
nothing), pending payments stamped `credit_milli = amount_cents * 10`. Model
prices go to $0 BY RULE (an absent `pricePerResumeMilli` reads as 0) - the
settings row is deliberately NOT rewritten, because that would change what
migration 001 snapshots for `ai:rollback`. It is safe to have not run: every
dollar column starts at 0, so old data already reads as reset. A ROLLBACK
across it - to 90adbaf - is not lossless (README, "Going back further, to
90adbaf"): dollars held by a run in flight are never refunded (the older build sees `units = 0`, then
closes the reservation, and a closed one takes no refund here), the first
settings save of any kind rewrites every model without `creditsPerResume`, so
an older build prices them all at 1 credit - and the OLDER build's first save
drops every `pricePerResumeMilli` (its normaliser builds the row field by
field, as it drops `aiProviders` and `analysisModelId`), so after upgrading
back every model reads free again. Its refund of a purchase made here
reverses nothing (`credits_granted` and `credits` are 0) while returning the
money.

**Reporter payouts** (owner decision A4). A reporter's earnings are paid
OUTSIDE the app; an administrator records each one with POST
/api/admin/accounts/:id/payout, a `reporter-payout` ledger row carrying their
note (`recordReporterPayout` -> creditRepository's `debitReporterPayout`). ONE
conditional UPDATE takes it - `role = 'reporter' AND balance_milli >= amount` -
and it is refused, never clamped like `applyAdjustment`'s revoke (409
`not-a-reporter` / `insufficient-balance` with `balanceMilli`): a record that
says less was paid than was is wrong. Keyed `payout:<account>:<requestId>`, so
a repeated `requestId` answers `recorded: false` with the first row. The
reporter gets a notice (link `/credits`). Accounts' payout goes through
services/refunds `recordDirectPayout`: the payout AND, in the same
`.immediate()` transaction, the reporter's open payout request (if any) marked
Refunded with that amount (`closedRequestId`), so the queue cannot pay it
again. `MAX_PAYOUT_NOTE`, `PAYOUT_REQUEST_ID` and `readPayoutNote` live in
services/credits, shared by both places that record one. Reporters cannot buy:
/api/payments is `requireUser`, and so are refund-requests' retired /options
and POST (a user or admin gets their 410) - a purchase refund gives back the
UNSPENT balance, which for a reporter is earnings.

**Payout requests** (owner decisions R1, R2). The ONE thing still asked for:
`POST /api/refund-requests/payout { reason? }` (`requireReporter`; an admin is
refused 409 `not-a-reporter` by `createPayoutRequest`, also `request-open` with
`requestId`, `nothing-to-pay-out` at $0) asks for the WHOLE balance - kind and
item type `payout`, item key `payout:<accountId>`, so the open-request index
allows one open per reporter, label `Payout of earnings` - and notifies every
admin, all in one `.immediate()` transaction; `GET /payout` is
`describePayoutStatus` (`{ balanceMilli, openRequest, available,
unavailableCode, unavailableReason }`). In the queue its `refundableNowMilli`
is the reporter's balance NOW (0 with a reason when no longer a reporter or
deleted). `refundRequest()` dispatches a payout BEFORE the resume branch to
`payOutRequest(id, admin, { amountUsd, note })` - both required; any amount up
to the balance then (R2); ONE `.immediate()` transaction of
`recordReporterPayout` keyed by the REQUEST (`payout:<account>:<rfr id>`, a
savepoint) and `markRefundRequestRefunded`; a refusal (409
`insufficient-balance` with `balanceMilli`, `not-a-reporter`,
`account-missing`) throws and moves nothing; the reporter's notice follows the
commit. Its wording is kind-aware (*Payout request approved/declined*, *Payout
recorded: $X*, link `/credits`); a refunded payout reads *Paid out*.
`toRequest` derives the kind from the ITEM KEY (`kindOfItemType`) - it used to
read any unknown kind as a resume and any unknown item type as a payment, which
5177fc3 still does: there a payout request is a resume's refund it can neither
pay nor close, so a rollback decides every open one first (the README's check
lists them, `kind = 'payout'`) - and
marks an item type this build does not know `unrecognised` (refundable never,
409 `unrecognised`; declinable). `GET /api/refund-requests?kind=` filters by
kind. Asking for a purchase or resume refund is CLOSED (R1): `POST /` and
`GET /options` answer 410 `refund-requests-closed` with
`REFUND_ASKING_CLOSED_MESSAGE`, which ends "contact your administrator";
`createRefundRequest` stays, unrouted, for tests and e2e seeding, and every
request made before is decided as below.

**Refund requests** (owner decision M3; `services/refunds`,
`database/refundRequestRepository.ts`, `routes/refundRequests.ts`). Somebody
asked about their OWN purchase or resume, with a reason (before R1 closed
asking; such requests are still in the queue); an administrator moves it
Requested -> Approved (no money), Requested|Approved -> Declined (reason
required, final) or -> Refunded (the money moves in the same step, final). The
state machine is in the WHERE clauses; a repeat of the same action answers 200
`changed: false` and moves nothing. ONE OPEN REQUEST PER ITEM is a partial
UNIQUE index on `refund_requests(item_key) WHERE state IN ('requested',
'approved')`, not a route check. An item is one of five names (`payout:<account>`
above, and four for a charge), and a resume has exactly one: `payment:<id>`; `order-item:<id>` (durable - `order_items.cost_milli`
is copied from the task's `costMilli` at `createOrder`, because the task is
evicted); `charge:<reservation id>` for a `/resume/generate` build (a
`kind: 'request'` reservation is that one resume); `task:<id>` for a queued
resume with NO order row, only while the queue holds its batch (a task of a
batch with an order row always resolves to its order item). Every run queued
now has one - a Generate Immediately run's is `orders.kind = 'immediate'` - so
`task:` is left only for a builder run an older build queued; it stays so such
requests still read. A resume's refund is
`refundRequestedCharge` - `refundAgainstReservation` with `includeClosed`, key
`refund-request:<id>`, reason `refund-request`, under the reservation's SQL cap
- in the same `.immediate()` transaction as the state change and the notice.
A purchase gives back its UNSPENT part, `wholeCentsBelow(min(balance,
creditedMilli))` (the reversal `refundPayment` makes, in whole cents), measured
when asked and re-measured at Refunded, never above `amountMilli`. A card does
NOT go through `refundPayment`, which calls the provider first and reverses
after: in services/refunds `refundCardPurchase`, ONE `.immediate()` transaction
takes the re-measured amount off the balance (`purchase-refund`, a fresh key
`purchase-refund:<payment>:<request>:<n>` per hold), writes `attempt_milli` and
`hold_key` on the request and claims the payment (`beginRefund(id, requestId)`);
only then is Stripe sent EXACTLY that (`sendCardRefund` -> `refundPaymentIntent`'s
`amountCents`, key still `refund:<paymentId>`), so the buyer cannot spend it,
nor a second refund measure it, while Stripe answers, and the shortfall is
always 0. Accepted: payment and request turn Refunded together. Refused: the
credit goes back (`purchase-refund-failed`, key `<hold>:returned`), the hold is
cleared and the claim released in one transaction - the next press measures
again. No answer (`isUnansweredRefund`): only the claim is released; the hold
and `attempt_milli` stay, the retry sends the same body and takes nothing more.
While a request holds one, `beginRefund` refuses every other claim on that
payment IN ITS UPDATE (the payments list's whole refund says why), and a
Decline is refused (409 `refund-unconfirmed`); a Decline is also refused while
the payment is `refunding` (409 `refunding`, the DB claim, so across
processes), and on a payment already `refunded` it closes the request from the
payment instead (409 `request-final`, state `refunded`) - Declined never lands
on money that moved. Crypto needs `{ paidByHand: true, amountUsd }` - the
amount the administrator SENT, required, never measured again (409
`paid-by-hand-required` with `amountMilli` first) - and goes through
`refundPayment(..., { amountMilli, refundedByHand: true })`, a balance spent
since reported as the shortfall. `payments.refund_cents` records the money
returned (0 on an older refunded row reads as `amount_cents`), served as
`refundAmountMilli` - the invoice's *Amount Refunded* and the payments list's
note read it (lib/paymentDisplay.ts `refundedMoneyMilli`), never `amountMilli`,
and after a partial refund call the credit not reversed "spent, or still on
the balance" (a request leaves its sub-cent remainder there), never all spent.
A refund from the payments list closes the payment's open
requests (`closeRequestsForRefundedPayment`). The frontend's `lib/credits.ts`
knows the new ledger reasons, `refund-request` and `purchase-refund-failed`,
and the lake's `job-report-reward` and `job-report-reward-revoked` (see "The Job
Data Lake" below; drift-checked by test/frontendMoney.test.js, which also lists
the lake's money modules among those that may not floor or float-parse).

**Notifications are for everybody or for one account.** `notifications.recipient_id`
NULL is an announcement (every row an older build wrote), set is a notice for
that account alone; every reader query is `recipient_id IS NULL OR
recipient_id = me` (list AND unread count), through
`idx_notifications_recipient`, which `getDb()` creates AFTER `addMissingColumns`
(`INDEXES_AFTER_COLUMNS`) because an index in SCHEMA naming an added column
fails every upgraded boot. `link` is an app path only (`safeAppPath`). The
announcement editor lists, edits and deletes announcements only, and
`deleteUser` deletes the account's own notices. The bell draws a notice's
`link` only through lib/appLinks.ts's `safeAppPath` (a copy of the server's,
run against it by test/frontendRefunds.test.js) and marks a notice "For you".
90adbaf has no recipient filter and reads EVERY row as an announcement, so a
rollback that far deletes `WHERE recipient_id IS NOT NULL` first (README,
"Going back further, to 90adbaf") - or every bell shows other people's refund
and payout notices, emails and reasons included. 5177fc3 filters as this
build does.

**Contact** (owner decision A2): `app_settings['contact'] = { channels: [{ type,
label, value }] }`, types closed (`email|telegram|discord|whatsapp|other`),
validated whole on save by `services/contact.ts`, which also BUILDS every
`href` (`mailto:`, `https://t.me/<name>`, `https://wa.me/<digits>`, Discord
none, `other` only as an `http(s)` URL without credentials; any other link
scheme - `mailto:`, `tel:`, `x://` - is refused, and a label with a colon,
`Hours:9-5`, is plain text). `GET /api/contact`
is PUBLIC (no session - the sign-in and disabled-account pages need it) and
re-checks every stored channel on read, so a hand-edited row cannot serve a
`javascript:` link. Pages render `href` or plain text, never a link of their own.

## The AI layer

Every model call goes through `backend/src/services/ai`. A provider TYPE is one
directory implementing `AIProviderAdapter`; the registry builds an adapter per
PROVIDER (a type at one sign-in location - "Providers of one type" below), and
the catalog's `satisfies Record<AIProvider, ...>` makes a missing type a
compile error. There are exactly three types,
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
in with a key (stored in CODEX_HOME, out of the environment strip's reach). `AI_LOCKED_PROVIDERS` marks a seat TYPE - every provider of it - this machine
cannot run; nothing is locked out of the box, a fresh install defaults to the
first seat not locked, and with all three locked a settings READ still succeeds
with no runnable models (saves keep their asserts) while a run fails with
`AiUnavailableError`. The Bid Assistant runs on the app default MODEL - a
record's provider and model name - like any run that names none, and a
prompt's model override still decides it. It does NOT decide a resume:
tailoring and cover letter pass `runChoiceWins`, so they run on the model the
run was charged at, whatever the prompt record says. A JOB ANALYSIS runs on the
administrator's analysis model (`analysisModelId`, see "Job analysis runs once"
below), also with `runChoiceWins`, and the Job Filter makes no model call of its
own at all - it judges that analysis.

Models are admin-curated records: a display name, a seat, a model name and
`pricePerResumeMilli`. The model name is chosen from `config/providerModels.ts`'s
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

**Price per resume.** `pricePerResumeMilli` is thousandths of a dollar,
0..1,000,000 ($0-$1,000), 0 = free (`config/pricePerResume.ts`). There is
NO default: an admin create without `pricePerResumeUsd` is refused, and a stored
record without the field - a seed a migration adds, or one priced in credits
before dollars (its `creditsPerResume` is never read as a price) - reads as 0
in memory, no write-back, and the admin payload's `freeEnabledModelIds` lists
every enabled model at 0 for Admin -> Models to show in red. Junk or a fraction
of a thousandth reads as 0 and warns once; out of range clamps; admin mutations
refuse a bad value by name (`creditsPerResume` in a mutation is a stale page,
refused), and a partial edit keeps it. A resume is priced at submit by the same
resolution its task runs (`resolvePricedAiChoice` -> `{ choice, costMilli }`:
request, then profile, then default) and the price is snapshotted on the task
as `payload.costMilli` - OUTSIDE `payload.choice`, so a restore that re-resolves
a retired choice never re-prices it; `chargeFor` sums `taskCostMilli(payload)`
and the queue hook refunds it, 0 when absent (a task from before dollars, whose
`creditCost` is never read as money). `reserveCredits` and `refundTaskUnit`
take AMOUNTS in thousandths, a batch reserves the sum, and
`POST /api/generation/quote` prices a batch body through the same
`resolveProfileChoices` without reserving anything (`costMilli`, and
`pricePerResumeMilli` when every resume costs the same, else null).
Administrators stay exempt.
Tailored content a preview already wrote is priced at the model that WROTE it,
not the one the finalising request names: `/resume/preview` and `/preview-all`
hand back a signed `previewToken` (`services/credits/previewToken.ts`, HMAC with
a secret kept in `app_settings`), `/resume/generate` and `/generation/batches`
(`previewTokenByProfileId`, which the quote takes alone) price and run on its
model, and supplied content without a valid token is charged at least what the
profile's own model costs (`resolveSuppliedContentChoice`).

**Prompt variables are the code's, strictly.** A feature-linked prompt may use
exactly the variables `PROMPT_FEATURES` declares for it (`promptService.ts`), and
that list must equal the keys of the feature's value builder -
`buildTailorResumePromptValues`, `buildAnalyzeJobDescriptionPromptValues` and
their siblings in `resumeService.ts`; test/promptVariables.test.js fails when
they drift, so a new variable goes in both. A variable whose value the CODE
fixes and is the same on every call is listed in `STABLE_PROMPT_VARIABLES`
(promptService.ts) - today the analysis prompt's `[[jobFieldList]]` and
`[[industryList]]` - and promptAssembly keeps it in the cacheable stable part
instead of starting the call's data at it. Create, update,
`/prompts/validate` and `/preview` refuse or report any other name (`Unknown
prompt variables: x`; an unsaved draft names its `featureKey`), and a stored
record holding one fails at render with `contains unknown variables`. The
tailor-resume prompt gets the profile's section choices as three words -
`[[includeStrengths]]` / `[[includeSoftSkills]]` yes|no and
`[[technicalSkillsLayout]]` grouped|plain (`buildResumeSectionPromptValues`) -
never inside `profileJson`, and referenced AFTER it in the shipped prompt so the
cacheable stable part is byte-identical. The switches do decide what
`profileJson` HOLDS: `buildPromptProfile` sends `strengths` only while
Strengths is on (off means not given to the model, tailoring and cover letter
alike), and never sends `softSkills`, which the code lists after the answer. Because an admin-edited row may never
mention them, `buildFinalSkillOverride(profile)` - a function of the profile,
not a constant - is appended to the user body of EVERY tailor-resume turn and
states all three; `parseTailoredResumeContent` then enforces them against the
profile as it is NOW (strengths `[]` when off, never a made-up "Core Strength";
the profile's own soft skills first when on; a Plain hard-skill list with no
library padding; the summary's `Working style:` sentence only while Soft Skills
is off). `runResumeTask` runs client-held preview content through the same
parse (`finaliseHeldContent`), as `/resume/generate` does, so a switch flipped
between preview and batch is honoured. No migration touches an admin's prompt
text; a tailor-resume record that never mentions `[[includeStrengths]]` is
flagged `predatesSectionSwitches` for admins. Nothing about a profile is in a
posting's analysis, on purpose: the analysis reads the posting, not the
profile, and one analysis serves every profile, for ever (below).

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
and SIGTERM never reaches the real process). Every turn runs in its provider's
fixed empty workdir (an added provider's is `<seat dir>-<id>`, its state dir
likewise) whose `.gemini/settings.json` enforces the Google sign-in, registers no
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
Credits" notice or any tool call fails the turn, and so does a JSON answer that
opened `@@BEGIN_JSON@@` and never wrote `@@END_JSON@@` (as `truncated`, retried,
the seat not held): the envelope names no finish reason once text arrived, and
the extractor's balanced scan would take the first complete inner object of
the cut-off document as the answer. Exit 41 with a sign-in still
on disk is usually the CLI's per-start token check failing on the network, so
it is held for two minutes as `unavailable` and becomes the 30-minute sign-in
hold only on the third in a row. A sign-in hold - this one or any other - is
lifted early only by a sign-in file written AFTER it (`clearAuth`, keyed on
`oauth_creds.json`'s mtime, read by a fresh health check): the check only reads
the file, so it says "signed in" for a revoked token too. The Claude seat's
holds record their kind (`auth`, `rateLimited`, `unavailable`) - a held call
reports that kind, never a guess from the reason's wording - and its sign-in
hold is lifted by a fresh `claude auth status` on the subscription that
STARTED after the hold was set. The subscription is claudeCli/health.ts's
`isSubscriptionSignIn`, the one verdict the startup warning and that lift
share: `authMethod` in SUBSCRIPTION_AUTH_METHODS - `claude.ai`, which every
CLI since 2.1.40 (the first with `auth status`) prints for `claude auth
login`, or `oauth_token`, a token it was handed - with no `apiKeySource`
beside it, because up to 2.1.285 a Console login billed per token also read
`claude.ai` (2.1.286 calls it `api_key`). Taking `oauth_token` alone warned
about every ordinary sign-in and never lifted its hold. Every hold, health reading and minute's status cache
is the PROVIDER's (its adapter's), not the type's. The admin Settings page's
seat check (`GET /api/admin/ai/health`) asks every enabled PROVIDER with
`health({ fresh: true })`, one card each, skipping the minute's cache, which is
what makes it the place to lift a hold. Codex holds itself only for a usage
limit, read from the turn's words (codexCli/limits.ts `isCodexUsageLimit`,
also `429` / `rate limit`; `turn.failed`'s nested `error.message` is read),
seat-wide, for the wait it names clamped to 5-30 minutes (15 when it names
none), refused before spawning and lifted by an answer; a turn that finds it
signed out sets its cached health to signed out at once, and only a status
check that STARTED after that may put it back. Gemini's health check
sends no prompt: `gemini --version`, then the sign-in files under the CLI's home.

Tests never spawn a browser, a subprocess or a network call: each CLI provider
replays recorded event streams from `test/fixtures/cli`, `test/fixtures/codex`
and `test/fixtures/gemini` through an injected runner, and storage tests point `DB_DIR` and
`TAILOR_STATIC_DIR` at temp dirs. No real Google account has answered through
the Gemini seat: its successful fixtures are the real 0.62.0 CLI's envelopes
around fake answers, and the file names say so.

## Providers of one type

Owner decisions P1-P4. A PROVIDER is one place a type runs:
`config/aiProviders.ts`, stored as `aiProviders` in the app-settings row next to
`aiModels` (`{ id, type, label, homeDir, binaryPath, concurrency_max_requests,
enabled, createdAt, updatedAt }`, only what an administrator set -
`storableProviders`; an untouched built-in is not stored). The FIRST of each
type is the BUILT-IN one, id = the type id, so every stored model, prompt
override, profile and queued task (which all name a type) keeps working; its
values come from `.env` as before (`AI_CLI_BIN` / `CLAUDE_CONFIG_DIR` /
`AI_CLI_CONCURRENCY`, `AI_CODEX_BIN` / `CODEX_HOME` / `AI_CODEX_CONCURRENCY`,
`AI_GEMINI_BIN` / `AI_GEMINI_HOME` / `AI_GEMINI_CONCURRENCY` -
`builtInProviderDefaults`) unless an administrator sets one, which wins
(`resolveProviders` says which, per field: `sources`). An added one is
`prv-<8 hex>` (never a type or model id), and must name a sign-in folder.
Every path an administrator gives is checked (`checkProviderHomeDir` /
`checkProviderBinary`): absolute, existing, a directory / an executable file,
not inside `listAppDirectories` (aiModelConfig.ts: the checkout, DB_DIR, the
static dir, the output dir, the seats' work dirs), symlinks followed; a folder
another provider of the type signs in at (a null folder = the CLI's default,
`defaultProviderHome`) is refused 409 `home-in-use`; 1-32
`concurrency_max_requests`. Refusals are `AIProviderInputError { code, field,
status }`, answered by name (admin-only routes). A type runs only while a
provider of it is enabled (`isProviderEnabled`); a change that leaves nothing
runnable is 409 `nothing-left`; a built-in can only be switched off (409
`built-in`). `noteStoredProviders` keeps the last-read list synchronously, keyed
by DB path, for the dispatcher (`currentProviders`, memoised on the list and the
env values it reads; `providerTypeOf` remembers every id seen, so a removed
provider's waiting work still knows its type).

**Adapters.** `services/ai/registry.ts` builds one per provider id from its
`ProviderInstanceSpec` (types.ts): each seat's `create*Adapter({ instance })`
takes the provider's binary and limit, gives an added one a work dir of its own
(`<seat dir>-<id>`, providers/cli/instance.ts; Gemini's state dir too, so its
workspace settings file and transcripts are per provider), keys its semaphore
by the provider id, and sets the folder in the child env AFTER the usual strip
(`buildChildEnv(parent, { configDir })`, `buildCodexChildEnv(parent, { home })`,
Gemini's `home`) - a null folder (an unset built-in) keeps the inherited one.
`claude auth status`, `codex login status` and Gemini's `clearAuth` read that
env, and every piece of sign-in advice the seat gives - the health check's
`warning` / `detail` (each `check*Health` takes the command: `signInCommand`,
Codex's `signOutCommand` too, Gemini's `signInAction`), an `auth` failure's
`adminAction`, the missing-binary advice - names the provider's own folder
(`CLAUDE_CONFIG_DIR=<folder> claude auth login`, ...), because the bare
command signs in the server's default folder, the built-in provider's. A
changed folder or binary rebuilds the adapter (holds and health go with
the old one); a changed limit resizes its semaphore IN PLACE
(`AsyncSemaphore.resize`, `getProviderSemaphore` never replaces one now). A
stub `registerAdapter`ed under a TYPE id stands in for every provider of that
type without one of its own, so a suite stubbing the three seats never reaches
a real CLI. Every adapter has a synchronous `readiness(modelName?)` - the last
health verdict (`ready: null` until checked, and Codex's `unknown` status, never
bench a provider) and any hold that would turn the call away: the seat's
(`seatHold()`) and, asked about a model ('' = the seat's default), that
model's too (`holdFor`, keyed exactly as `complete` keys it), so a weekly Opus
cap or a model the account cannot use benches a provider for that model's
work only. Asked about no model (the admin card) only the seat counts. A stub
without one is always ready. A failure's detail names an added provider.

**Which provider a call runs on** (`services/ai/providerPool.ts`
`pickProvider(type, modelName)`, called by promptExecution's `runAssembled`
after the type's enabled check, with the model the call names): the provider a
queued task is PINNED to (`runPinnedToProvider`, AsyncLocalStorage, wrapped
around every resume task by `makeResumeRunner`) when it is of the call's type
- switched off since or not, so a running task finishes where its lane slot
is; only a REMOVED one is picked afresh; else, among the type's enabled
providers that are ready and not held for that model, the least loaded (in
flight + waiting at its semaphore, over its limit), ties to list order; with
none ready, the first enabled one, so a direct call meets its hold and fails
with the hold's error. The analysis model pools the same way.

**The queue** (taskQueue.ts, generic over lane names): the capacity reading is
either the plain `{ lane: slots }` (tests; each lane its own pool, always
serving) or `{ lanes: [{ id, pool, enabled, slots }] }` (queue/index.ts
`readCapacity`: every provider, switched off ones included, from the settings,
re-read every 15 s while work waits and at once after an admin change - the
provider routes call `refreshCapacity`). A lane SERVES when it is in the
reading, enabled (its type too), has slots and `policy.ready(lane)` (adapter
readiness); it serves a TASK when also `policy.ready(lane, policy.modelOf(task))`
- the real `modelOf` is queue/index.ts `taskModelName`, the payload's
`choice.modelName` - asked once per lane and model per dispatch pass
(`readyMemo`). `place`: a task goes to the lane of its pool that serves it
with the lowest (running + waiting) / width, ties to reading order, urgent
tasks spliced before the first ordinary one IN THAT LANE (an immediate run's priority
is per lane), and a RETRY not to the lane it just failed on while another
serves it (`Task.avoidLane`, set by `retryTask`, cleared at start, not
persisted) - a provider that fails fast is always the least loaded, so by
load alone it took every retry back; with none serving it stays (or goes to
its pool's first lane) and WAITS. `rebalance` (every dispatch) moves the
waiting work of a lane that stopped serving, and a serving lane's tasks it is
held for by model (`moveUnserved`), to one that serves, persisted. `fill` and
`steal` never start more than a lane's width, counted by what RUNS there
(`isFull`), not by free slot ids: a limit lowered while busy leaves tasks on
slots the reading no longer lists. `fill` takes the first waiting task the
lane serves (a held model's task does not block the work behind it); `steal`
lets an idle serving slot with nothing of its own it may run take the first
task it may run (urgent first, then the busiest lane's, never a retry back to
the lane it failed on) from another lane OF ITS POOL, never across pools, and
a lane with no donor moves on to the next lane (`break`, not `return`);
`watchBlocked` logs a pool with no serving lane once (`[queue] Work for <type>
is waiting ...`) and re-reads every 10 s until one serves - and re-reads,
without a line of its own, while work waits on a model every lane is held for.
Before the first reading a task waits under its own name. `runningOn` and the
persisted `ranOn` are the lane = provider id (stripped for non-admins by
generation.ts's `readerSnapshot`); `taskStarted` logs it and
`markItemRunning(batch, seq, provider)` puts it on `order_items.provider_id`
(an added column), served on GET /api/orders/:id to an administrator only as
`ranOn: { id, label, type }`.

**Routes** (routes/aiHealth.ts, `/api/admin/ai`, requireAdmin): GET
/providers, POST /providers (201), PUT /providers/:id (`{ ..., moved }`),
DELETE /providers/:id (409 `provider-busy` while it runs a task; `{ moved }`),
POST /providers/:id/check (a fresh card), GET /health (one card per provider).
The admin settings payload carries `aiProviders` too; an ordinary account's
never does.

**The pages.** lib/providerDisplay.ts is everything the browser decides about
providers, with no runtime import (test/frontendProviders.test.js runs it
against the server): the shapes, read leniently (`normalizeAdminProvider`,
`normalizeProviderCard` - the test reads every field the routes send through
them and gets it back whole); copies of `PROVIDER_HOME_VARIABLE`,
`BUILT_IN_PROVIDER_ENV`, the 1-32 range and the type list, drift-checked; the
Add / Edit form's checks in the server's own sentences, on the server's own
field names (`providerDraftProblems` - every one of them a refusal the server
makes on the same field; a path is refused only when no platform would call it
absolute, since the page cannot know the server's); what a save sends -
`addProviderBody`, and `editProviderBody`, ONLY what changed, so a built-in's
`.env` value stays `.env`'s until its box is touched and '' puts it back;
`refusalField` (which box a server refusal is pinned under); `sourceNote`
(set here / which `.env` line / default / the type's), `providerStatus`
(locked, switched off, a hold by its kind - `HOLD_KIND_LABELS`, drift-checked
against the seats' unions - then the fresh check), `describeSignIn` (a
card's Sign-in row: `SIGN_IN_LABELS` names the CLI's `authMethod` and never
says "subscription" - that verdict is the server's detail line - checked
against SUBSCRIPTION_AUTH_METHODS and the Gemini seat's word),
`describeTypeHealth`, `describeRanOn`; and `hasEnabledProviderOfType`, the
third clause of lib/api.ts's `isProviderOffered`, so the admin pages offer a
type exactly when `isProviderEnabled` would run it. lib/aiProviders.ts is the
client for the routes; test/frontendProviders.test.js fails if a page outside
app/admin/ imports it or names the routes. **Admin -> Models -> Providers**
(app/admin/models/ProvidersSection.tsx) is the table - type, label, folder and
its variable, binary, limit and lane, each with its source, live status from
GET /health (read after the list, so a slow CLI never holds the table up) - and
Add provider / Edit (a kit Dialog), Switch off/on, Check now (POST .../check)
and Remove (offered only for an added provider; a 409 `provider-busy` is shown
in the server's sentence). **Settings -> General** draws one card per provider
(lib/seatHolds.ts reads `outagesByProvider` by provider id; the call totals are
per TYPE and say so when a type has two providers) and each type's row sums its
providers. An order's page draws `ranOn` when it is sent - to an administrator
only; the page never checks the role. test/e2e/providers.js drives all of it
against stub-seat.js.

## The tailoring cache

Owner decision P6 (`services/tailorCache.ts`, `database/tailorCacheRepository.ts`,
table `tailor_cache`, `idx_tailor_cache_key` UNIQUE on `cache_key` and
`idx_tailor_cache_created`, both in INDEXES_AFTER_COLUMNS; the lookup's plan is
pinned by test/tailorCache.test.js). `tailorResume` and `generateCoverLetter`
take an optional `TailorCacheContext { analysisId, templateId }` and look the
answer up BEFORE their model call; every caller that has the posting's stored
analysis passes one (the queue task, /resume/preview, /preview-all,
/resume/generate). `tailorCacheKey` is SHA-256 of `TAILOR_CACHE_VERSION`, the
kind, the profile as the call sees it (after `profileForTemplate`) minus
`createdAt`/`updatedAt`, canonical JSON, the template id, the analysis id, the
provider type, model record id and model name, the prompt record's id and the
SHA-256 of its text, the SHA-256 of the rendered `promptValues` plus the
`appendToUserBody` text (built BEFORE the lookup - they read the shared skill
library, `buildLibraryAugmentedPromptLists`, so a library add or confirm that
changes a posting's checklist is a miss, and so is any change to the code that
builds them, with no TAILOR_CACHE_VERSION bump), and (cover letter) the company
and role. No tailoring is cached without an analysis id. What is stored is the
model's RAW answer, kept only once it parsed AND only when the asked-for model
wrote it: `CompletionResult.fellBack` (types.ts; set by the Claude seat when
`--fallback-model` answered - `answeredByFallback`, by model FAMILY, never a
string compare, since an alias comes back as a full id - and by Gemini when
another family answered, `geminiAnsweredByFallback`, `auto` never) makes
`tailorResume` / `generateCoverLetter` use the answer and skip the write
(`[tailor-cache] Not keeping this ...`); they call `createPromptCompletionResult`,
the variant of `createPromptCompletion` that answers the whole result. A hit
runs `parseTailoredResumeContent` against the profile again, and an answer that
no longer parses is a miss. The charge never depends on it: a resume is priced
at submission. Read and write failures are a miss, warned once. Every caller and
both rules are pinned by test/tailorCache.test.js through the real routes. `TAILOR_CACHE_DAYS` (operational.ts, default 30, 1-3650)
prunes on `created_at` at boot and daily (`startTailorCachePrune` from
index.ts, unref'd).

## Job analysis runs once

**A posting is analysed exactly once, ever** (owner decisions J0, J1, J3, J5,
J8, P5, P7; PLAN check 1). `services/jobAnalysis/gate.ts`'s
`getOrCreateAnalysis({ jd, link, sheetRow?, requestedBy?, storedOnly?, signal? })`
is the only function that runs the analysis prompt - test/analysisGate.test.js
reads every source file and fails on any other that names
`analyze-job-description`, builds or parses its completion, or keeps an
analysis path of its own. It answers, in order: (0) a Google Sheet row's own
analysis, read BY THE SERVER from the row's protected Analysis cell: the
STORED analysis the cell's id names (`SheetRowAnalysis` is `{ analysisId,
row }` and nothing else), and only when that stored analysis is the posting
in the row NOW, by content hash or link key - or, for a posting longer than a
cell, by the hash of the copy the program cuts into one (`analysisMatchesPosting`
-> analysisColumns.ts's `isAnalysisOfPosting` / `cellCopyHash`, so a pushed
row with no link still matches; an edited cut copy does not): a
replaced posting, or rows sorted under the protected columns, leave another
posting's cell behind. The cell's CONTENT is never used and never stored: a
cell naming an id the store lacks - another install's, or program-shaped text
that is not the program's (a formula spilled into L from an unprotected
column) - is ignored with a log line (`names an analysis this store does not
have`) and the row falls to (1) and then (3); nothing writes `source =
'sheet'` any more (test/analysisGate.test.js greps for it), which once let
such a cell become a posting's only analysis for ever. Rows an older build
registered that way stay readable as they were; (1) the stored row of the posting, by its normalised link and
then by its whitespace-normalised text - `identity.ts`'s `linkKey` (host
lower-cased, http/https and a default port folded, fragment, `utm_*`/`gclid`/
`fbclid`/`ref`/... dropped, remaining parameters sorted, one trailing slash
folded) and `contentHash` (SHA-256 hex); (2) the analysis of the same posting
already in flight in this process (a map keyed under both keys; one caller's
abort releases that caller only, the call is aborted when the last waiter
leaves); (3) ONE model call on the analysis model, stored with
`INSERT ... ON CONFLICT DO NOTHING` and read back. A call that fails stores
nothing - the only way a posting reaches a model twice, bar a stored row
whose `analysis_json` cannot be read as an object (damaged outside the
program): it reads as absent, so its posting is analysed once more and the
answer written into THAT row (`repairUnreadableRow`, under an IMMEDIATE
transaction), never once per request. Nothing about a
model, a prompt, a profile or an account is part of a posting's identity, so
a prompt edit or a new analysis model reaches only postings never analysed
before, and there is no re-analyse anywhere (the admin Prompt Test page's
`/resume/analyze-prompt-test` goes through the gate too, and ignores the
`promptId` and `model` it is sent).

**The store** is `job_analyses` (database/sqlite.ts; `jobAnalysisRepository.ts`,
read and written only through the gate): `content_hash` UNIQUE, `link_key`
partial UNIQUE `WHERE link_key IS NOT NULL`, `(merged_at, created_at)` for the
lake's merge tab, `job_field_id` for its filter - all four in
`INDEXES_AFTER_COLUMNS`. test/jobAnalysisStore.test.js pins the gate's two
lookups to single index seeks with EXPLAIN QUERY PLAN. No TTL, no cap, no
overwrite of a readable row; a row found by its text that had no link is given the link it was
found with (`attachLinkKey`, NULL only). `merged_at` is the Job Data Lake's (set
by `mergeIntoLake`, for a report or a merge, on every outcome but `unclassified`
and `no-company`, which write nothing to the lake). `company_name`
(an added column, '' on older rows) is the company a caller knew the posting by -
the gate takes an optional `company` and records it on insert or, when the row
has none, afterwards (`attachCompanyName`, '' only; the builder routes, the
queue task, the submission step, the Job Filter and the reporter run all pass
it) - because the analysis leaves company names out and the lake's merge hashes
on it. Never part of a posting's identity.

**Callers pass `analysisId`**, never an analysis: `/resume/analyze` answers the
analysis plus `analysisId` and `jobFieldLabel`; `/resume/preview`,
`/preview-all`, `/generate` and every job of `/generation/batches` take
`analysisId` (must exist: 400 otherwise) or `jobDescription` + `jobLink` and
answer `analysisId`. A `jobAnalysis` object in any body is NOT read - it was a
way to forge a job field. `/generation/batches` resolves ONE analysis per job
at submission, before fanning out per profile (`submit.ts`'s
`resolveAnalysesAtSubmit`, no model call, `storedOnly`), and puts it on every
task as `payload.analysisId`; a job with none is analysed by its first task
through the gate (the others wait for that call), which then stamps every task
of the job (`AnalysisHooks.recorded` -> queue/index.ts `recordJobAnalysis`), so
a retry, a restored task and a sibling skip the analysis step. Per-profile
analysis prompts are gone (`profileSettings.analyzeJobPromptId` is dropped on
save, a variant cannot be created or activated, an old one is listed but never
active).

**The analysis** (`JobAnalysis`, types/template.ts) gained `jobField` (one id
from `config/jobFields.ts` - the owner's list at bullet level, areas 1-8, 10
and 11; area 9 is not offered - else `unclassified`, checked in code by
`normalizeJobFieldId`), `salary` `{ min, max, currency, period, raw }` (only
what the posting states; `facts.ts`), and `filter` (the Job Filter's facts;
seniority is `jobMeta.seniority`). An off-list filter word becomes
`not_specified` - except a clearance, which fails CLOSED (`normalizeClearance`:
an unknown word is kept, and fails the filter; only an absent or empty one is
`none`), and words are folded across spaces, `-` and `/` (`TS/SCI` is
`ts_sci`). Since v6 it also has `industry` (one id from
`config/industries.ts`, or `not_specified`; `normalizeIndustry`: an id, a
label, a known short form or a keyword, else `other`) - OPTIONAL, and set by
`normalizeJobAnalysisResponse` ONLY when the answer has the key, so an analysis
stored (or a sheet cell written) before it stays without one. Its industry,
job type and clearance are derived when READ, by facts.ts's pure
`industryOf` (its own `industry` whenever the key is there; else its filter's
company category, `COMPANY_CATEGORY_INDUSTRY`; else keywords in its free-text
`jobMeta.industry`; else `not_specified`), `jobTypeOf` ('remote' | 'hybrid' |
'on_site' | '') and `clearanceRequiredOf` (false only for `none` and
`not_specified`, so an unknown clearance word is required, failing closed) -
`analysisFactsOf` is all three, and every place that shows them uses it.
NOTHING re-asks a model for an older analysis's industry, and nothing is
written back into one. The tailoring prompt is given none of the four
(`jobField`, `industry`, `salary`, `filter` are stripped by
`buildTailorResumePromptValues`, so its values and every tailor-cache key are
what they were - pinned by test/tokenBudget.test.js; `jobMeta.industry`, the
posting's own word, is in it as it always was). The analysis prompt's variables
are `jobFieldList` and `industryList` (both stable, before `[[jobLink]]`, so
the cached system part is byte-identical across postings - test pins it),
`jobLink` and `jobDescription`; an administrator's record that never mentions
`[[jobFieldList]]` is flagged `predatesJobField` and gets
`buildAnalysisFactsOverride()` appended to every turn - the seniority words
(`SENIORITY_VALUES`, which the filter judges) as well as the four keys, the
industry among them; one that names `[[jobFieldList]]` but not
`[[industryList]]` is flagged `predatesIndustry` and gets
`buildIndustryOverride()` alone (gate.ts `analysisOverrideFor` decides; never
both flags). An older build (5177fc3 and before) refuses a stored analysis
record naming `[[industryList]]` (*contains unknown variables*), so a rollback
takes it out of an edited prompt first. The analysis model is
`analysisModelId` in the admin settings ('' = the app default model; a stale
one falls back with a warning; a save CHANGING it to a model that cannot run
is refused by name) - never in an ordinary account's payload.

**The Job Filter** (routes/jobs.ts) makes no model call of its own (J8): a row
whose link is stored is judged on that analysis with no page fetch; otherwise
the page is fetched and handed to the gate. The verdict is
`evaluateJobFilterAnalysis(jobFilterAnalysisOf(analysis))`. It runs on the
caller's own sheet only (the tab named, else All, a job tab only - 409
`not-job-tab` otherwise), reads C:E once, judges EVERY row with a link and
answers each to the page (`rows: [{ row, company, title, link, result:
'Pass'|'Fail'|null, reason, reused, error? }]`), and writes NOTHING into the
sheet - no verdict, no analysis cell (owner's default). The
`filter-google-sheet-job` prompt is retired (an edited copy of it is not
listed), and so are the `AI_*_TIMEOUT_MS_FILTER` budgets.

**The account's own sheet** (owner decisions S1-S3;
`services/sheets/accountSheet.ts`). Every job route - Build Resumes' sheet
mode, the Job Filter, the export, the reporter run, Admin -> Google Sheets -
reads and writes the caller's OWN spreadsheet and no other
(`resolveAddressableSheet`: any other id is 404 before Google is asked, an
administrator's included). The saved "shared" sheets are gone:
`googleSheetsSources` is in no payload, but stays in the stored settings row,
unchanged by every save (a stale page sending one is dropped), so a rollback
finds it. A sheet has two tabs of the app's: **All** (first, the default of
every route) and **Temp For AI** (second, what Phase 4's push replaces). A new
sheet is created with All and gets Temp For AI at index 1; a sheet an older
build made (one `MM/DD/YYYY` tab a day) gets whichever is missing, All at 0
and Temp at 1 (at 0 while All's name clashes, so the All added once it is
free lands it second), and its daily tabs are never read, written, re-headed,
protected or cleared again - they are not job tabs. A tab already called All
or Temp For AI that is not a job tab is left alone and reported (`conflict: {
tabs, message }` on the state, logged once when found). Only the Job Sheet
page looks at the two tabs again - `GET /api/sheet?recheck=1`
(`describeAccountSheet`'s `recheck`, a verifying ensure on EVERY such load, not
only while a clash is recorded), so a clashing tab renamed since is replaced,
and an All or Temp For AI deleted or renamed under a recorded layout is put
back, at its next load - the one way a REPORTER, who has no export, gets a
deleted All back; every other read, the shell's on every page load included,
answers from the row (a deleted tab's link included), and a look Google
refuses falls back to it. It is
recorded in `users.sheet_layout` (2) with `sheet_all_gid` / `sheet_temp_gid`
(NULL at layout 2 = that name clashes), added columns; `sheet_tab_date` /
`sheet_tab_gid` are an older build's and never written, so a rollback resumes
its daily tabs. Once layout 2 is recorded a sign-in makes NO Google call; a
verifying ensure (the export, the push, the Job Sheet page's look) lists the
tabs once and puts back a deleted All or Temp For AI;
the boot backfill also lays out sheets below layout 2
(`listAccountsNeedingSheetLayout`). The state is `{ configured,
spreadsheetId, spreadsheetUrl, defaultTab, defaultTabUrl, tempTab,
tempTabUrl, conflict? }`. `sheetDateText` is a day in SHEET_TIMEZONE,
`sheetDateSerial` / `sheetDateOfCell` its serial number and its reading back.

**The job tab** (`integrations/googleSheets.ts`): twelve columns. A-F are the
person's - Date, NO(DATE), Company, Job Title, Job Link, Job Description - and
G-L the program's - Job Field, Salary, Job Type, Clearance, Industry, Analysis
(`JOB_SHEET_HEADERS` / `JOB_SHEET_COLUMNS`; Rate, note, Job Finder, the
filter's two and the lake's Job Hash, Analyzed At and Lake Status are gone). A
tab is a JOB TAB (`isJobSheetTab`) when its row 1 starts with the six user
headers, or when the WHOLE tab is empty (`inspectJobSheetTab` reads the whole
tab once more only when row 1 is blank; `empty`) - an empty tab, under any
name, becomes one the first time it is used. Nothing else ever is: not a tab
with data under a blank row 1, not an older build's daily tab, not the
person's own. `verifyJobSheetTab` has NO option to touch any other tab - it
returns `jobTab: false` and sends nothing - and every caller (the analysis
columns' read and write-back, the reporter run, `addSheetTabWithHeaders`, the
export) goes through it. Every row of a job tab is 21 px high with its data
cells CLIPPED and the Date column formatted as a date (`jobRowLayoutRequests`,
the header's own format CLIP too): sent on every format, on a conversion, with
every verify that sends anything, and before every export write.
`addSheetTabWithHeaders(id, title, { index, existing })` adds a tab at its
place or verifies the one there (`jobTab: false` = a name clash). The range
importer (routes/admin.ts, own sheet only) refuses a write touching G-L of a
job tab, and any write into a column under a protection of the program's
(`analysisProtectionHit`: our description, or exactly G:L - so an older
build's K:P too) whatever row 1 says (409 `protected-columns`): the server's
identity is the protection's only editor, so a write through it is the one
way past the protection (a written Analysis cell can still only name a stored
analysis, used only when it is the row's posting; G-K would show what was
typed) - and row 1 is not protected, so
deciding on the header alone let A1 be changed, L written and A1 changed
back. A protected range Google reads back without a `sheetId` is the tab's
own (it leaves a 0 out - All's gid on every new sheet).

**The export** (`POST /api/jobs/scrapers/export`): own sheet, the tab named or
All, a job tab only (409 `not-job-tab` before the search runs; an empty tab is
laid out). After the search, ONE read of A:E gives the duplicate check (a
company already in the tab is skipped), the first row after the last used one
and NO(DATE) - 1 + the highest number on rows dated today (in any form
`sheetDateOfCell` reads). It writes A:F RAW in chunks of 50 - Date as a serial
number (a real date), NO(DATE), Company, Job Title, Job Link, Job Description -
never a column the caller names (they are ignored), never G-L; before each
chunk its rows are read again (A:F) and a row holding anything moves the rest
below the last used row (409 `sheet-changed` after five tries), and one
`:batchUpdate` grows the grid when the chunk runs past it and lays the rows
out. Exports to one tab are serialised in-process. The answer's `export`
carries `date, firstNo, lastNo, startRow, endRow, updatedRanges, tabUrl`.

**The analysis columns** (G-L, J5): only the app's OWN sheets
(`isAppOwnedSheet`: allocated to an account) get them, in job tabs. They are a
protected range over the six whole columns G to L, header included,
`warningOnly: false`, editors = only the server's identity
(`getCredentialEmail`: the service account's `client_email`, or Drive `about`
for a `sheets:login` credential), `domainUsersCanEdit: false` - added by
`formatJobSheetTab` on a new tab, and checked on every `verifyJobSheetTab`
(every verifying ensure, every sheet run, every write-back: ONE read of grid
size, protections and header row, then at most one `:batchUpdate` that
`appendDimension`s the grid to twelve columns, rewrites a stale header and
puts the protection back, logging the repair - and, in that same atomic call,
CLEARS the Analysis column below the header (`analysisClearRequest`; L only),
since it was writable meanwhile). A sheet's Analysis cell is trusted only when
the protection was found INTACT in that run, so every cell ever trusted was
written by the program under the protection. A tab that is not a job tab is
not re-headered, protected, read or written (`jobTab: false`). The values
(`analysisColumnValues`) are the Job Field label, the salary, the Job Type
label (Remote, Hybrid, Onsite, or ''), Clearance as a real TRUE/FALSE
(`clearanceRequiredOf`), the Industry label (`industryOf`, so an analysis from
before Industry is mapped, never asked again) and the full Analysis cell. At
a sheet submission (`sheet: { spreadsheetId?, tabName }` + each job's
`sourceRowNumber`) the rows' Company and Job Link and their six analysis cells
are read in ONE batched call (`values:batchGetByDataFilter`, C:E and G:L per
run of consecutive rows); a row that no longer names the job's company (or
link) is neither read nor written; a cut (`...[cut at 50,000 characters]`) or
unreadable cell falls back to the stored row it names, then the store, then
the gate, logged with its row. The cell records its posting's keys
(`{ v, id, posting: { hash, link }, jobField, analysis }`) for a reader;
`cellIsForPosting` decides whether it is the row's on the stored analysis its
`id` names ALONE (`isAnalysisOfPosting`: link, text hash, or a long text's
cut copy) - an id the store lacks is nobody's, whatever keys it
records. A row whose cell was empty, or held a program-shaped cell (an `id`)
that is not its posting's stored analysis - another posting's, or one this
store never held - is written back once per row and analysis
(`analysisColumns.ts`'s `queueAnalysisWriteBack`, batched per spreadsheet for
1.5 s, RAW, after re-reading the rows: skipped, and NOT settled, when moved;
skipped when the cell already holds this posting's analysis, when it is not
the program's JSON, or when it is empty but G to K hold something other than
this posting's own facts - typed while the protection was off; a stale
program cell is replaced whole; `settled` is keyed on row + analysis id, and a
tab whose protection had to be put back is forgotten from it; best-effort,
never fails a resume; `WriteBackReport.failedSpreadsheets` names where a write
failed).
A deleted analysis model clears the setting.

**The pages** hold an analysis, never send one. The builder keeps the one
`/resume/analyze` answered with the description it was made for
(lib/jobAnalysis.ts `holdAnalysis` / `heldAnalysisFor`: the server's own
whitespace normalisation, so re-spacing the text is the same posting) and
sends its `analysisId` to preview, preview-all and every batch; a change of
company, role, profile or model never asks again (the held analysis is NOT
reset with the other outputs), an edited description is another posting, and
a 400 from a request that named it lets it go (`dropsHeldAnalysis`).
components/AnalysisFacts shows its title, job field label and salary
(`formatSalary`, a copy of the server's) under the description, in both
preview dialogs and on Prompt Test, which has no prompt or model select any
more. The sheet panel sends `sheet: { tabName }` (the account's own sheet,
the server's default - there is no other) and each row's `jobLink`, never a
cell; it reads the rows' C:F, then G:L in a SECOND, best-effort range read (a
job tab narrower than twelve columns refuses a range past its grid - the rows
then say *When built*) to show which rows skip analysis. It has no sheet
select and no column mapping. Every page that picks a tab - the panel, Find
Jobs' export, the Job Filter, Report Jobs - draws the server's listing through
lib/sheetTabs.ts: `sheetTabOptions` lists a `layout: 'other'` tab DISABLED
with why (*old layout, not read* for a `MM/DD/YYYY` title, else *not a job
tab*) and `chosenTab` starts on the server's `defaultTab` (All) and never
yields an `other` tab, however the select was driven;
test/frontendJobSheet.test.js runs both against `listAddressableSheetTabs`.
The note under the select is `unreadTabsNoteFor(tabs)`: `UNREAD_TABS_NOTE`
(copy an old daily tab's jobs into C to F of All), or, while the tab named
All is an `other` one (the name clash), `UNREAD_TABS_NOTE_ALL_CLASH`, which
says to rename or delete it and open Settings > Job Sheet first - never to
paste into a tab no route reads. Both spell the tab names out on purpose: Next 16.1's
Turbopack folded an EXPORTED constant built from template literals joined
with `+` at build time and dropped the middle literal of three (not tried
again on 16.3.8), so write such a constant as plain string literals. The Job Filter page shows each row's
verdict (lib/jobFilterDisplay.ts - its reason words are drift-checked against
services/jobFilter.ts's reasons by the same test) and sends only `{ tabName,
startRow, endRow? }`. Admin -> Settings ->
General has the Analysis model select (its own Save; a stored model that
stopped running stays listed as "cannot run here"); Admin -> Prompts offers no
New Variant, Duplicate, Save Active or model override for the analysis
feature, and pills `predatesJobField` / `predatesIndustry` /
`predatesSectionSwitches` - with the editor's own note on the text as typed,
lib/promptNotes.ts (`lacksJobFieldList` / `lacksIndustryList` /
`lacksSectionSwitches`, the server's variable syntax), which
test/frontendAnalysis.test.js holds to those flags and to the gate's
`analysisOverrideFor`. The profile
editor's Extracting prompt select is gone with `analyzeJobPromptId`.
test/frontendAnalysis.test.js runs every copy here against the server's code.

## The Job Data Lake

Owner decisions J2-J10. One row per JOB - a company hiring in a job
field - in `job_lake` (database/sqlite.ts; `database/jobLakeRepository.ts`
is its only writer), not per posting. The doc block there and in
`services/jobLake/` is the detail; what to know before touching it:

**Identity** (`services/jobLake/identity.ts`, J2a): `normaliseCompany` -
symbols dropped (before NFKC, which would spell `™` as TM), NFKC, lower case,
`.` and apostrophes dropped and every other punctuation a space, trailing legal
suffixes (`LEGAL_SUFFIXES_V1`, multi-word ones whole, stripped repeatedly, never
to nothing) dropped, every space removed. `lakeIdentity(company, fieldId)` is
SHA-256 of `v1\0companyKey\0fieldId`, or null for no company or a field not in
config/jobFields.ts (`unclassified` included): never merged, never paid. The
steps and the list are `JOB_LAKE_HASH_VERSION`; change either and it is a new
version with a deliberate re-hash, never an edit.

**Schema**: `job_lake` has an INTEGER AUTOINCREMENT id (the FTS5
external-content index `job_lake_fts` points at rows by rowid, which VACUUM
renumbers on a table without one; three triggers keep it in step) and the plan's
indexes exactly - `job_hash` UNIQUE, `updated_at`, `(job_field_id, updated_at)`,
`(company_key, updated_at)`, `requested_by`, and `id WHERE sheet_synced_at IS
NULL` (the outbox), and `id WHERE job_type IS NULL` (the boot step's rows still
to fill) - plus `job_lake_history(lake_id)`, `job_lake_history(id) WHERE
job_type IS NULL` (its earlier versions still to fill) and `job_reports`' two
(below), all in `INDEXES_AFTER_COLUMNS`. test/jobLakeStore.test.js pins them
and their plans (`FIND_BY_HASH_SQL`, `LIST_DEFAULT_SQL`, `UNSYNCED_SQL`,
`HISTORY_SQL`, `FIND_JOB_REPORT_SQL`, `findJobReportsSql`,
`DELETE_LAKE_REPORTS_SQL`, and jobLakeFacts.ts's `LAKE_TO_FILL_SQL`,
`HISTORY_TO_FILL_SQL` and `DROP_STALE_REPORT_SQL`).

**Facts** (v6): `job_lake` and `job_lake_history` carry `job_type` ('remote' |
'hybrid' | 'on_site' | ''), `clearance` (0/1) and `industry` (a
config/industries.ts id or `not_specified`) - the analysis's, through
`lakeJobFromAnalysis` -> facts.ts `analysisFactsOf`, never the caller's;
written on insert, replace and the history copy. NULL means "not filled yet":
a row an older build wrote. `database/jobLakeFacts.ts`'s `fillLakeFacts` runs
in getDb() every start (after the dollar switch, before the connection is
registered - so no repository and no getDb() inside it), by CONDITION, not a
marker: rows whose `job_type` IS NULL (the two partial indexes, so a start
with nothing to fill reads two empty indexes and neither table), history
first, in IMMEDIATE batches of 500, from each row's stored `analysis_json` through the
same pure functions - NO model, nothing written into an analysis; a row whose
analysis is gone or unreadable gets '' / 0 / `not_specified`. A history row
found NULL also marks its lake row for a refill, because only an older build's
REPLACE leaves one (it overwrote the row without touching the facts). In the
same batches it records the reports those rows hold in `job_reports` (below):
a `source = 'report'` row's versions only - never a merge's, whose
`requested_by` is the analysis's maker - the first `added`, each later one
`replaced`. A duplicate or unclassified report an older build made left no
row, so it is NOT remembered: the first run over it merges it again (a
duplicate again inside the window, a paid replacement after it), and records
that - the README says so where it promises a re-run pays nothing.
Never fatal; a second start is a no-op. `toEntry` / `toHistory` serve `jobType`,
`jobTypeLabel` (Remote, Hybrid, Onsite, ''), `clearance` (boolean), `industry`
and `industryLabel` ('' for `not_specified`), all null/'' while unfilled.
`LakeQuery` (and GET /api/admin/job-lake) filters on `jobType`
(`not_specified` = ''), `clearance` (`true`/`false`) and `industry`, with no
index of their own: the page still reads `idx_job_lake_updated` in order, no
sort (pinned); the GET answers `options: { jobTypes, industries }` for the
page's selects.

**`job_reports`** (v6): every posting a reporter reported, ONE row per
`(account_id, analysis_id)` (UNIQUE `idx_job_reports_account_analysis`), with
the FIRST outcome (`added` | `replaced` | `duplicate` | `unclassified`,
`JOB_REPORT_OUTCOME_LABELS`), the lake row and job hash it reached (NULL for
unclassified), the reward, the sheet row it came from, `created_at`;
`idx_job_reports_lake` for a delete. It is what "reported before" means:
the database, by the posting's ANALYSIS, wherever the row has been moved,
sorted or copied to - no sheet cell is read for it. `findJobReports(account,
analysisIds)` reads it. `deleteLakeEntry` deletes the reports that reached
the row (`DELETE_LAKE_REPORTS_SQL`), so the job can be reported again, by any
of them; an `unclassified` record names no row, so nothing forgets it (its
analysis is final - it would be unclassified again). A record whose lake row is gone anyway (an older build, which knows
nothing of the records, deleted it) counts for nothing: `findJobReports` skips
it (`findJobReportsSql`'s EXISTS), so the run and the preview never call the
posting reported before, and the merge drops it when it meets it; when that
build took the same report again as a new row, the boot step's seed replaces
the record with one naming that row (`DROP_STALE_REPORT_SQL`, one seek), so
Delete here forgets it. No sweep of the table at startup.

**`mergeIntoLake(job, requestedBy, policy)`** is the only way in, for the
reporter run and the admin merge alike: ONE `.immediate()` transaction - for a
REPORT (source `report`, an account and an analysis) first the `job_reports`
seek: found -> `already` with `priorOutcome`, nothing moves (no seen_count, no
reward, no record), from ANY row, tab or day, and even after the window (the
same posting never replaces itself); then seek the hash; none -> INSERT
(`added`); a row whose `updated_at` is within the window ->
`seen_count`/`last_seen_at` bumped (`duplicate`; `updated_at` does NOT move,
so the window runs from the add); an older row -> copied to
`job_lake_history`, overwritten, `requested_by`/`updated_at`/the facts/the
reward moved, `sheet_synced_at` NULL again (`replaced`, which counts as ADDED).
A report decided added, replaced, duplicate or unclassified is then recorded
(`INSERT OR IGNORE`); `no-company` is not - the reporter fills it in and
reports again. Another account's report of the same posting is a `duplicate`
(and recorded as theirs). A merge (source `merge`) is nobody's report: never
`already`, never recorded. `job_lake.report_ref`
(`reportRefOf(spreadsheet, tab, row)`, from `LakeJob.reportedFrom`) is still
written, because an older build decides ITS `already` on it, but decides
nothing here. The analysis is marked merged in the same transaction. The decision reads the database ONLY
(J10) - test/jobLakeSync.test.js runs it with every Google seam set to throw -
and worker threads in test/jobLakeStore.test.js race four writers for one job.
`services/jobLake/index.ts`'s wrapper resolves the policy from the settings at
the moment of the merge (`setLakeClockForTests` is the fake clock).

**Rewards** (J7) are paid INSIDE that transaction (creditRepository's
`payJobReportReward`, a savepoint when nested): only to an account whose role is
`reporter` at that moment (an admin reporting is never paid; a merge passes no
reward), at `users.report_rate_milli ?? the global rate`, cut to what the daily
cap leaves of the UTC day (`jobRewardsSince`, gross - a revoke does not free it),
never a $0 row, keyed `job-lake:<id>:<updated_at>` (a replacement pays again,
a version never twice), stamped with the merge's moment. The lake row records
`reward_milli` and the rate in effect, `reward_rate_milli` (snapshot).
`revokeLakeReward` / `deleteLakeEntry(..., { revokeReward })` take the current
version's reward back once (`job-lake-revoke:<id>:<updated_at>`,
`job-report-reward-revoked`, clamped at the balance like `applyAdjustment`, a
notice to the reporter); a replaced version's reward stays paid.

**Settings** (`services/jobLake/settings.ts`, `app_settings['job-lake']`):
`reportRateMilli` (global, unset = $0 - nobody paid until set),
`duplicateWindowDays` (WINS over `JOB_LAKE_DUPLICATE_WINDOW_DAYS`, an
operational setting, default 60, 1-3650; `resolveDuplicateWindow` says
`admin | env | default`), `dailyCapMilli` (unset = no cap). PUT takes
`reportRateUsd`, `duplicateWindowDays`, `dailyCapUsd` (null/'' clears) and
refuses `*Milli`. Admin -> Accounts' list carries `globalReportRateMilli`.

**The reporter run** (`services/jobLake/reportRun.ts`, routes/report.ts under
`requireReporter`, the caller's OWN sheet only - no spreadsheet id is read from
any request): inspect the tab (a tab that is not a job tab is refused before it
is touched - 409 `not-job-tab`, `notJobTabMessage`, which names All, Temp For
AI and an empty tab), verify it on that same read, read C:F once (nothing the
lake did is in the sheet to read), then skip as `already-reported` - "Reported before
(Added)", `priorOutcome` on the row, not in `total` - each row whose posting is
STORED (gate's `findStoredAnalysis`, no model) and has this account's
`job_reports` row, the FIRST row of that posting in the range only; the
submission step's `resolveAnalysesAtSubmit` (sheet first, no model) runs over
every row, skipped ones included (so their empty analysis cells are written
back), and the gate for the rest (three at a time, written back like a queued
task's first analysis); merges in ROW ORDER - a merge answering `already` for a
posting a row ABOVE already stands for in this run (`seenThisRun`) is shown as
a red `duplicate`, "The same posting is on a row above." (unclassified when its
posting is), otherwise as reported before; then `flushAnalysisWriteBacks()`
FIRST, then `paintDuplicateRows` - the rows' C:E read again, then ONE
`repeatCell` batch painting `DUPLICATE_ROW_COLOR` (background only) on
duplicates and on rows whose first outcome was a duplicate, each only while it
still holds its posting. Nothing is written into a row's cells but its
analysis columns: there is no Job Hash or Lake Status column any more, and a
run's rows carry no `lakeStatus`. `sheetUpdated` is false when the run's own
write-backs or its paint failed. GET /rows answers each row's `reported`,
`priorOutcome` and `jobHash` from the same database lookup, read-only
(`findStoredAnalysis(..., { readOnly: true })`), first row of a posting only -
exactly what a run would skip; it no longer serves `lakeStatus`. In memory, one run
per account (409 `run-in-progress`), kept an hour; a restart loses a run in
progress and re-running finishes it. Seam: `setReportSheetsClientForTests`.

**The admin merge** (`services/jobLake/merge.ts`, J6) lists
`listMergeableAnalyses` - not merged, a field that is not `unclassified`, a
company on record - and merges with `requested_by` = the analysis's `created_by`
and NO reward; never a model, never a sheet.

**The admin sheet** (`services/jobLake/adminSheet.ts`, J9/J10): created on first
use by the server (`app_settings['job-lake.admin-sheet']`) - stored the moment
it exists with `headerWritten: false`, so a header write that fails leaves that
sheet to finish, never a second one (absent = true) - header written RAW
(`ADMIN_LAKE_HEADERS`: the eight, then Job Type, Clearance, Industry as I-K,
`adminSheetRow` writing the labels and a real TRUE/FALSE; a sheet whose stored
`headerVersion` is below `ADMIN_LAKE_HEADER_VERSION` - absent reads as 1 - has
its whole header rewritten once, before its next append; older lines stay
blank there), shared as writer with every ENABLED admin's email (more at each sync, an idle
one included; nobody is unshared). An OUTBOX: rows with `sheet_synced_at IS NULL` are appended in
batches of 200 (`appendValuesRaw`, `values:append` RAW + INSERT_ROWS, through
the 429 backoff) and marked by id AND `updated_at`, and only while the sheet
appended to is still the stored one; syncs are serialised; a
failure keeps the rows and `lastError` - the sentence, then Google's `detail`
on its own line - for the page. Runs after each report run
and merge (`requestAdminLakeSync`), at boot (index.ts), and on "Retry now"
(POST /api/admin/job-lake/sync); asks Google nothing with nothing to send and
nobody to share with. `recreate` makes a new spreadsheet and reopens the outbox
for every row in the same tick as it stores the new id; it never joins a plain
creation in flight (it waits, then makes its own), and a sync appending to the
old sheet meanwhile marks nothing and goes round again on the new one.
At-least-once across a crash between Google's answer and the mark. Seam:
`setAdminLakeSheetClientForTests`.

**Push to Google Sheet** (`services/jobLake/push.ts`, owner decision L1;
POST /api/admin/job-lake/push, filters in the JSON body under the list's own
names, read by the one `readLakeFilters` that reads GET /'s query string, so a
push holds exactly what Search shows and a bad filter is refused in Search's
words, 400, before Google is asked anything). The CALLER's own sheet and its
Temp For AI tab only - no spreadsheet or tab is read from the request: one
push per administrator at a time (in memory, 409 `push-in-progress`);
`ensureAccountSheet(admin, { verifyTab: true })` (a Temp For AI deleted or
renamed since is put back; the name held by a tab of the person's own is 409
`tab-name-clash`, the Job Sheet page's clash sentence ending "then push
again."); Temp For AI inspected once and refused unless a job tab (409
`not-job-tab`, `tempTabNotJobTabSentence`), then verified on that read; the
rows (`listLakeForPush(filters, JOB_LAKE_PUSH_MAX_ROWS)`: `whereOf`, newest
first by `updated_at DESC, id DESC`, read as cap + 1 with the COUNT in the
same read transaction; `PUSH_DEFAULT_SQL` walks idx_job_lake_updated, pinned
by test/jobLakePush.test.js); ONE `:batchUpdate` - `appendDimension` ROWS when
the grid is short, `clearDataRowsRequest` (an `updateCells` of A:L from row 2
to the end, fields `userEnteredValue,userEnteredFormat.backgroundColor`, so a
duplicate's red paint goes too - never the header, never a column past L),
`jobRowLayoutRequests`; then RAW writes of A:L in chunks of at most
`PUSH_WRITE_MAX_ROWS` (200) rows and `PUSH_WRITE_MAX_BYTES` (1.5 MB of JSON;
one bigger row goes alone). A row is Date (`sheetDateText` of `updated_at` in
SHEET_TIMEZONE, sent as `sheetDateSerial`), NO(DATE) (1, 2, ... down each
day's rows), Company, Job Title, Job Link, Job Description (analysisColumns.ts's
`descriptionCell`: cut at 50,000 with `ANALYSIS_TRUNCATED_MARKER`, never
through a surrogate pair) and `analysisColumnValues` of
the row's stored analysis - six blanks when it has none - so a build from the
tab finds each row's Analysis cell naming its posting's stored analysis and
asks no model (and writes nothing back) - a cut description with no link
included, matched by `cellCopyHash` (the hash of `descriptionCell` of the
stored text), which test/jobLakePush.test.js pushes and builds. The tab's settled write-backs are
forgotten (`forgetTabWriteBacks`). Answers `{ pushed, matched, capped,
maxRows, tabName, tabUrl }`; 0 matches empties the tab. GET / carries the cap
as `pushMaxRows`, for the page's confirm. Seam: `setLakePushSheetsClientForTests`.

**Routes**: `/api/report` (GET /, /tabs, /rows, POST /runs -> 202, GET
/runs/current, /runs/:id) and `/api/admin/job-lake` (GET /, /settings, PUT
/settings, GET|POST /sync, POST /sheet, GET|POST /merge, POST /push, GET|DELETE
/:id, POST /:id/revoke-reward - /push declared before /:id), each a row in
test/routeAccess.test.js. The run's summary
is `{ added (added + replaced), total, duplicates, unclassified, replaced,
skipped, failed, alreadyReported, earnedMilli, balanceMilli, sheetUpdated }`.

**The pages.** lib/jobLake.ts is the API's shapes; lib/jobLakeDisplay.ts
everything the two pages decide, with no React and no runtime import but
lib/format.ts and lib/reporterPay.ts, so test/frontendJobLake.test.js runs it
against the server: `readReportRange` is `readRunRange`'s refusal word for
word, `lakeSettingsProblems` / `lakeSettingsChanges` are `updateLakeSettings`'s
(only what changed is sent, AS TYPED, '' to clear), `lakeFilterProblem` the
lake route's 400s (the job type and industry against the route's own
`options` lists, never a copied one), `lakeFilterBody` the one spelling of
the filters sent - the query string's parameters and Push to Google Sheet's
body alike, in `LAKE_FILTER_ORDER` - with `describePushConfirm` /
`describePushResult` drawn from a real push's answer (the cap sentence names
JOB_LAKE_PUSH_MAX_ROWS), `notJobTabMessage` the run's own
refusal, the statuses' labels and `JOB_REPORT_OUTCOME_LABELS` (the "(Added)"
in *Reported before (Added)*) are read against the source, and
`describeRunSummary` - the owner's "N out of M was added, your current
credit is $X" - is drawn from a real run's summary there. **/report** (app/report/page.tsx) asks GET
/api/report on arrival (rate, today's earnings, balance, the LATEST run - a
running one is followed, one that ended is shown for the hour the server
keeps it), lists the tabs (`defaultTab` chosen), previews rows 2-501 by
default, and enables Add to job lake only over a PREVIEW of the same tab and
rows that has something to report (`startBlocker`); a 409 `run-in-progress`
follows the run its `runId` names. It polls GET /runs/:id every
`REPORT_POLL_MS` until the SERVER says it ended (a 404 is a restart: the run
is gone, what it merged is not), then re-reads the overview, the account (the
top bar's balance) and the preview of those rows. A previewed row reported
before says what became of it then from the row's `priorOutcome`
(`describePreviewRow`; nothing about a row is read from its Lake Status), and
so does a run row's pill (`reportRowLabel`). A row is red exactly where the run
paints the sheet - a duplicate, and a row reported before whose posting was a
duplicate then (`isRedOutcome`, the run's `isRed`; the unit test compares it
with the rows the run painted) - via page.module.css, a rule more specific
than the unlayered `.tl-table td`, stated for html.dark too. A link from a sheet or the lake
reaches an href only through `safeWebLink` (http(s), a host, no credentials).
**/admin/job-lake** (app/admin/job-lake/: page.tsx, LakeTab, MergeTab,
SettingsTab) is a Settings -> Administration tab (navModel's
SETTINGS_ADMIN_TABS), its own tabs in `?tab=` (lake, merge, settings) as
Payments keeps them; the lake's filter boxes are drawn FROM
`LAKE_FILTER_ORDER` and `LAKE_FILTER_LABELS` - the owner's order: Updated
from, Updated to, Requested by, Job field, Job type, Clearance, Industry,
Company, Salary from, Salary to, Full text (frontendJobLake.test.js pins it
and that LakeTab maps it) - Job type offering `LAKE_JOB_TYPE_CHOICES` (a copy
of `listJobTypesForClient` less `not_specified`, drift-tested), Clearance
Required / Not required, Industry the route's own `options.industries`; the
filters apply on Search (a bumped epoch on usePagedList). **Push to Google
Sheet**, beside Search, pushes `applied` - the search on the page, never boxes
changed since, which its kit Dialog confirm says - after naming the count THAT
search's latest answer gave (`searched`, guarded against an older answer
landing late; `pushBlocker` waits for it) and that it replaces Temp For AI of
your own sheet; the result is a Notice (warn when capped) linking to the tab
through `safeWebLink`, a refusal an ErrorNotice. The table and Details show
each job's Job type, Clearance and
Industry in the server's words (`jobTypeLabel`, `industryLabel`;
`lakeFactCells`, and `describeLakeFacts`, which says *Not stated*, or *Not
filled in yet* for a NULL an older build left); Details is a kit Dialog with
Revoke reward and Delete + "Also revoke the reward"; the money boxes are text, never `type="number"`,
and the page is in frontendMoney.test.js's FRONTEND_MONEY_SOURCES.
test/e2e/report-run.js drives both against stub-report-sheets.js and
stub-seat.js, recording the reporter's earlier reports in the database first
(report-sheet-rows.js, which both share) - a Lake Status cell decides nothing;
test/e2e/lake-push.js drives the filter form and the push against
stub-lake-push-sheets.js (every account its own spreadsheet, the cells written
to a JSON file in DB_DIR for the script to read), then builds from the pushed
rows: their cells are read and nothing is written back.

## Conventions from the history

Some 200 commits, no tags; releases are merge PRs named for their branch (v2.0,
v3.0, v4.0, and v4.1, built one commit per phase plus a review-fix commit where
one was needed - Phase 9's 4b43c01). The README's
"What changed in this release" and "Rolling back this release" are rewritten
for each release from the commits since the last one: what an operator must DO
after upgrading, in order, and every step a rollback needs, checked against the
older build's code. The release before that keeps its steps too, marked *From
<commit>* in the one ordered list and summed up under "Coming from ...", and
going back that far keeps a subsection of its own ("Going back further, to
...") - an install may skip a release. The pattern in nearly every feature arc is a feature commit
followed by one or more "fix what the adversarial review found" commits, so
expect review passes to be part of the work rather than an afterthought.

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
