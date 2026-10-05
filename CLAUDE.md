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
npm test                       # backend node:test suite (~55s with the tsc step, 1440 tests)
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
  ignored. 31 of the 32 App Router pages carry no `dark:` at all (only
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

A variable on the command line like that beats the same one in `.env`. Unset,
`DB_DIR` defaults to `/data/db` on Linux/macOS (often not writable — the
most common first-run failure) and `%LOCALAPPDATA%\free_tailor\db` on Windows.
The backend prints the resolved path, the Chrome it will print with, and a
readiness line per AI seat at startup; a CLI that is missing or signed out is
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
  index.ts            # Express app: mounts 25 routers under /api
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
                      #   providerCatalog.ts is the ONE list of seats and of
                      #   retired ids; jobFields.ts the job fields a posting
                      #   is classified into (stable ids, never reused); providerModels.ts each seat's model-name
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
                      #   addMissingColumns (never fatal), then the one-time
                      #   move of `templates` rows to files
                      #   (templateFileMove.ts, schema_meta
                      #   `templates_moved_to_files`, never fatal; recorded
                      #   row by row, so only a row it could not WRITE is
                      #   tried at the next start), then the one-time switch
                      #   of credits to dollars (dollarSwitch.ts, schema_meta
                      #   `credit_unit`, never fatal - see "Money" below),
                      #   then the migrations.
                      #   An older build reads users.plan: rolling back means
                      #   renaming it back first (README, "Plans are now subscriptions").
                      #   Saved templates are NOT a table any more:
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
                      #   a reporter's payout (see "Money" below).
                      #   refundRequests.ts (asking, and the admin queue) and
                      #   contact.ts (GET /api/contact is PUBLIC, no session)
                      #   are described under "Money" below. generation.ts is
                      #   the queue's HTTP side - see services/queue/ below for
                      #   its run kinds, the release route and the per-file
                      #   download. import.ts's GET /tabs lists an addressable
                      #   sheet's tabs (`listAddressableSheetTabs`: the
                      #   resolveAddressableSheet guard, then the sheets
                      #   client's listSheetTabs) with `defaultTab` = today's;
                      #   POST / still reads a tab's rows. POST
                      #   /resume/generate (synchronous, admin output
                      #   template, refundable as `charge:`) is KEPT for any
                      #   caller, but the builder queues every build now.
  scripts/            # operator tools, each behind an npm script: mail:doctor,
                      #   sheets:login, sheets:doctor, migrate:legacy,
                      #   ai:rollback. The doctors share one shape -
                      #   walk the real chain in order, stop at the first break,
                      #   name the remedy - because each diagnoses a failure whose
                      #   single error message covers several causes.
  services/ai/        # provider-agnostic transport; one directory per provider
  services/jobAnalysis/ # THE way to a job analysis: gate.ts's
                      #   `getOrCreateAnalysis` (the only caller of the analysis
                      #   prompt - test/analysisGate.test.js greps for any
                      #   other), identity.ts (link key, content hash),
                      #   facts.ts (salary, filter facts), submit.ts (a batch's
                      #   analyses at submission, sheet first). See "Job
                      #   analysis runs once" below.
  services/queue/     # on-disk generation queue (survives a restart). One LANE
                      #   per real resource - one per seat, `cli`, `codex` and
                      #   `gemini` (`laneFor`) - each sized from its seat's own
                      #   variable. A restored row naming a lane this build
                      #   lacks is moved to one it has. A task row's `data` is a
                      #   hand-picked PROJECTION built by index.ts's `taskRow`,
                      #   not the Task serialized, so a new field must be named
                      #   there AND in the restore mapper or it silently does
                      #   not persist. The payload persists whole, which is why
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
                      #   like an order - the admin's output template no longer
                      #   files any queued build). An immediate run is LEASED to
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
                      #   Fallback Role any more.
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
  test/               # node:test, 122 files; fixtures/cli, codex and gemini
                      #   replay real CLI streams (`recorded-` is a capture,
                      #   `constructed-` a real envelope around a fake answer)
frontend/src/
  app/                # App Router pages: /, /settings/*, /admin/*, /jobs,
                      #   /orders, /credits (+ /credits/invoice, drawn with no
                      #   shell - navModel's isBareRoute). /account redirects,
                      #   and so does /settings/plan, to /settings/subscription
                      #   (a static redirect() the client follows on hydration;
                      #   the root layout's shell streams first, so it is
                      #   never an HTTP 307).
                      #   /admin/profiles, /admin/profiles/new and
                      #   /admin/profiles/[id] are EVERY builder's own profiles
                      #   and their editor, whatever the path says. /report
                      #   (Report Jobs) is a REPORTER's home, behind
                      #   AuthGate's `ReporterOnly` (an admin may open it, a
                      #   user is told what it is for); until Phase 7 it is
                      #   their own sheet and a "later release" note.
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
                      #   RefundRequestHistory (the Refund Requests tab). A
                      #   colour on a .tl-table cell goes on an inner span - the
                      #   unlayered td rule beats a utility on the td itself.
                      #   RefundRequestDialog is "Ask for refund" from all three
                      #   places a charge shows (a purchase's Action column, a
                      #   `generation-reserve` row of Credit History, a resume
                      #   on /orders/[id]); it reads the server's
                      #   `/refund-requests/options` and never sends an amount.
                      #   PayDialog is now only an alias of ui/Dialog.tsx.
                      #   The administrators' queue is app/admin/payments/
                      #   RefundQueue.tsx, the `?tab=refunds` of Payments, where
                      #   every "New refund request" notice links.
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
                      #   also holds the two sheet LAYOUTS and the Analysis
                      #   cell's states, which test/frontendAnalysis.test.js
                      #   holds to JOB_SHEET_COLUMNS and parseAnalysisCell. The
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
                      #   API; lib/refundDisplay.ts how a request reads and which
                      #   buttons it gets, with no request in it, so
                      #   test/frontendRefunds.test.js runs it (and the reason
                      #   and amount rules it copies) against the server's code.
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
moved one is never looked at again - and the README's "Saved templates are
files" says how to roll back and run it again. Saved files are not
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
content can arrive from the client without being re-parsed. A template's
`.section-soft-skills` / `.section-strengths` markup is stripped at compile time
only when the switch is off, and per-item skill loops are rewritten into
categories only for `categorized` (the compile cache is keyed on the markup plus
those choices).

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
always three decimals, `$0.023`), plus `parseProviderCents` for an amount a
provider reports (exact; `12.505` is not a match for 1250 cents). The frontend's
`lib/format.ts` mirrors both, and test/frontendMoney.test.js runs each pair over
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
prices go to $0.000 BY RULE (an absent `pricePerResumeMilli` reads as 0) - the
settings row is deliberately NOT rewritten, because that would change what
migration 001 snapshots for `ai:rollback`. It is safe to have not run: every
dollar column starts at 0, so old data already reads as reset. A ROLLBACK
across it is not lossless (README, "Credits are dollars"): dollars held by a
run in flight are never refunded (the older build sees `units = 0`, then
closes the reservation, and a closed one takes no refund here), and the first
settings save of any kind rewrites every model without `creditsPerResume`, so
an older build prices them all at 1 credit.

**Reporter payouts** (owner decision A4). A reporter's earnings are paid
OUTSIDE the app; an administrator records each one with POST
/api/admin/accounts/:id/payout, a `reporter-payout` ledger row carrying their
note (`recordReporterPayout` -> creditRepository's `debitReporterPayout`). ONE
conditional UPDATE takes it - `role = 'reporter' AND balance_milli >= amount` -
and it is refused, never clamped like `applyAdjustment`'s revoke (409
`not-a-reporter` / `insufficient-balance` with `balanceMilli`): a record that
says less was paid than was is wrong. Keyed `payout:<account>:<requestId>`, so
a repeated `requestId` answers `recorded: false` with the first row. The
reporter gets a notice (link `/credits`). Reporters cannot buy: /api/payments
is `requireUser`, and so are refund-requests' /options and POST - a purchase
refund gives back the UNSPENT balance, which for a reporter is earnings.

**Refund requests** (owner decision M3; `services/refunds`,
`database/refundRequestRepository.ts`, `routes/refundRequests.ts`). Anybody asks
about their OWN purchase or resume, with a reason; an administrator moves it
Requested -> Approved (no money), Requested|Approved -> Declined (reason
required, final) or -> Refunded (the money moves in the same step, final). The
state machine is in the WHERE clauses; a repeat of the same action answers 200
`changed: false` and moves nothing. ONE OPEN REQUEST PER ITEM is a partial
UNIQUE index on `refund_requests(item_key) WHERE state IN ('requested',
'approved')`, not a route check. An item is one of four names, and a resume has
exactly one: `payment:<id>`; `order-item:<id>` (durable - `order_items.cost_milli`
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
`refundAmountMilli`. A refund from the payments list closes the payment's open
requests (`closeRequestsForRefundedPayment`). The frontend's `lib/credits.ts`
knows the new ledger reasons, `refund-request` and `purchase-refund-failed`
(drift-checked by test/frontendMoney.test.js).

**Notifications are no longer broadcast-only.** `notifications.recipient_id`
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
An older build has no recipient filter and reads EVERY row as an announcement,
so a rollback deletes `WHERE recipient_id IS NOT NULL` first (README, "Asking
for a refund") - or every bell shows other people's refund notices, emails and
reasons included.

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
0..1,000,000 ($0.000-$1000.000), 0 = free (`config/pricePerResume.ts`). There is
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
(promptService.ts) - today only the analysis prompt's `[[jobFieldList]]` -
and promptAssembly keeps it in the cacheable stable part instead of starting
the call's data at it. Create, update,
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
hold is lifted by a fresh `claude auth status` on `oauth_token` that STARTED
after the hold was set. The admin Settings page's seat check
(`GET /api/admin/ai/health`) asks every seat with `health({ fresh: true })`,
skipping the minute's cache, which is what makes it the place to lift a hold;
Codex keeps no holds. Its health check sends no prompt: `gemini
--version`, then the sign-in files under the CLI's home.

Tests never spawn a browser, a subprocess or a network call: each CLI provider
replays recorded event streams from `test/fixtures/cli`, `test/fixtures/codex`
and `test/fixtures/gemini` through an injected runner, and storage tests point `DB_DIR` and
`TAILOR_STATIC_DIR` at temp dirs. No real Google account has answered through
the Gemini seat: its successful fixtures are the real 0.62.0 CLI's envelopes
around fake answers, and the file names say so.

## Job analysis runs once

**A posting is analysed exactly once, ever** (owner decisions J0, J1, J3, J5,
J8, P5, P7; PLAN check 1). `services/jobAnalysis/gate.ts`'s
`getOrCreateAnalysis({ jd, link, sheetRow?, requestedBy?, storedOnly?, signal? })`
is the only function that runs the analysis prompt - test/analysisGate.test.js
reads every source file and fails on any other that names
`analyze-job-description`, builds or parses its completion, or keeps an
analysis path of its own. It answers, in order: (0) a Google Sheet row's own
analysis, read BY THE SERVER from the row's protected Analysis cell, and only
when the cell was written for the posting in the row NOW (`SheetRowAnalysis.
posting` / `analysisMatchesPosting`: a replaced posting, or rows sorted under
the protected columns, leave another posting's cell behind) - the stored row
it names, else its content registered with `source = 'sheet'` and no model
call, which needs the posting keys the cell records; (1) the stored row of the posting, by its normalised link and
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
found with (`attachLinkKey`, NULL only). `merged_at` is the Job Data Lake's.

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
`ts_sci`). The tailoring prompt is given none of the three (pinned by
test/tokenBudget.test.js). The analysis prompt's variables are `jobFieldList` (stable, before the
posting, so the cached system part is byte-identical across postings - test
pins it), `jobLink` and `jobDescription`; an administrator's record that never
mentions `[[jobFieldList]]` is flagged `predatesJobField` and gets
`buildAnalysisFactsOverride()` appended to every turn - the seniority words
(`SENIORITY_VALUES`, which the filter judges) as well as the three keys. The analysis model is
`analysisModelId` in the admin settings ('' = the app default model; a stale
one falls back with a warning; a save CHANGING it to a model that cannot run
is refused by name) - never in an ordinary account's payload.

**The Job Filter** (routes/jobs.ts) makes no model call of its own (J8): a row
whose link is stored is judged on that analysis with no page fetch; otherwise
the page is fetched and handed to the gate. The verdict is
`evaluateJobFilterAnalysis(jobFilterAnalysisOf(analysis))`. The
`filter-google-sheet-job` prompt is retired (an edited copy of it is not
listed), and so are the `AI_*_TIMEOUT_MS_FILTER` budgets.

**The app sheet's six columns** (J5): `JOB_SHEET_HEADERS` ends Job Field,
Salary, Job Hash, Analyzed At, Lake Status, Analysis (K-P; Job Hash and Lake
Status are the lake's, written `null` = left alone). Only the app's OWN sheets
(`isAppOwnedSheet`: allocated to an account) get them; a shared source keeps
analyses in the database only. They are a protected range over the six whole
columns, header included, `warningOnly: false`, editors = only the server's
identity (`getCredentialEmail`: the service account's `client_email`, or Drive
`about` for a `sheets:login` credential), `domainUsersCanEdit: false` - added
by `formatJobSheetTab` on a new tab, and checked on every `verifyJobSheetTab`
(every verifying ensure, every sheet run, every write-back: ONE read of grid
size, protections and header row, then at most one `:batchUpdate` that
`appendDimension`s the grid past an older build's twelve columns, rewrites a
stale header and puts the protection back, logging the repair - and, in that
same atomic call, CLEARS the Analysis column below the header
(`analysisClearRequest`; P only, K and L may be an old tab's notes), since it
was writable meanwhile). A sheet's Analysis cell is trusted only when the
protection was found INTACT in that run, so every cell ever trusted was
written by the program under the protection. A sheet run or write-back
verifies with `onlyJobTabs`: a tab whose row 1 is not the job header (its
first eight, any build's) and is not an empty `MM/DD/YYYY` tab is the
person's own (`isJobSheetTab`) - not re-headered, protected, read or written
(`jobTab: false`). At a sheet
submission (`sheet: { spreadsheetId?, tabName }` + each job's
`sourceRowNumber`) the rows' Company and Job Link and their six analysis cells
are read in ONE batched call (`values:batchGetByDataFilter`, B:D and K:P per run
of consecutive rows); a row that no longer names the job's company (or link) is
neither read nor written; a cut (`...[cut at 50,000 characters]`) or
unreadable cell falls back to the stored row it names, then the store, then
the gate, logged with its row. The cell records its posting's keys
(`{ v, id, posting: { hash, link }, jobField, analysis }`); `cellIsForPosting`
decides whether it is the row's. A row whose cell was empty, or held the
program's cell for ANOTHER posting, is written back once per row and analysis
(`analysisColumns.ts`'s `queueAnalysisWriteBack`, batched per spreadsheet for
1.5 s, RAW, after re-reading the rows: skipped, and NOT settled, when moved;
skipped when the cell already holds this posting's analysis, when it is not
the program's JSON, or when it is empty but K:O hold something - a spare
column an older build's tab left that somebody typed into; a stale program
cell is replaced whole, Job Hash and Lake Status emptied; `settled` is keyed
on row + analysis id, and a tab whose protection had to be put back is
forgotten from it; best-effort, never fails a resume).
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
more. The sheet panel sends `sheet: { tabName, spreadsheetId? }` (no id for
the account's own sheet) and each row's `jobLink`, never a cell; on the own
sheet it reads K:P in a SECOND, best-effort range read (a tab an older build
made has a grid that ends at L, and Google refuses a range past it - the rows
then say *When built*) to show which rows skip analysis. Admin -> Settings ->
General has the Analysis model select (its own Save; a stored model that
stopped running stays listed as "cannot run here"); Admin -> Prompts offers no
New Variant, Duplicate, Save Active or model override for the analysis
feature, and pills `predatesJobField` / `predatesSectionSwitches`. The profile
editor's Extracting prompt select is gone with `analyzeJobPromptId`.
test/frontendAnalysis.test.js runs every copy here against the server's code.

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
