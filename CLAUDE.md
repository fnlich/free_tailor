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
npm test                       # backend node:test suite (~60s with the tsc step, 2178 tests in 158 files)
npm run dev                    # backend watch + frontend dev server (Turbopack; see next.mjs below)
```

Facts worth knowing before you build:

- **`npm run install:all` after every pull, from the repository root.** A pull
  brings `package.json` entries but not packages; the symptom is `TS2307` /
  `Cannot find module` naming a dependency that is plainly listed. It passes
  `--include=dev` to all three installs: the repository builds from source and
  needs its devDependencies (the root's `concurrently`, the backend's
  `typescript` / `ts-node-dev`, the frontend's `tailwindcss` / `typescript`),
  and an npm with `NODE_ENV=production` or `omit=dev` leaves them out of a plain
  install and REMOVES them if present; `--include=dev` beats both (measured on
  npm 10.9.4). The root `dev`, `dev:live` and `dev:poll` - the three scripts
  that start `concurrently`, command lines unchanged - have npm `pre` hooks
  (`predev`, `predev:live`, `predev:poll`; npm 10 runs one for a name with a
  colon too) running `node scripts/checkInstall.mjs`, from a ROOT `scripts/`
  beside the backend's and the frontend's: every name in the root, backend and
  frontend `dependencies` + `devDependencies` must have
  `node_modules/<name>/package.json`, else ONE message - what is missing per
  package (five names, then "and N more"), `npm run install:all` from the
  repository root by its path, and a hint that npm skips devDependencies only
  when its settings as a script sees them say so - and exit 1, so npm never
  reaches `concurrently` (the owner's Windows log ended on cmd's *'concurrently'
  is not recognized ...*: the root's own node_modules was gone). Silent and exit
  0 otherwise, and never throws; npm skips it while `ignore-scripts` is on
  (measured). Its decisions are `scripts/installCheck.mjs` (no imports, no
  process or console: `missingPackages`, `installAdvice`,
  `devDependenciesOmitted`, `npmSettingsFrom`, `scriptBefore`,
  `GUARDED_SCRIPTS`), run by test/installCheck.test.js, which also holds every
  root script starting `concurrently` to its hook; its two checks of this
  checkout skip, saying why, where the root's or the frontend's node_modules
  was never made (a backend-only install), and fail on one short a package. The devDependencies sentence
  is a HINT, worded so, pointing to `npm config get omit` (npm's own answer,
  which agreed with the install in every case measured): npm passes a setting to
  a script only when it differs from npm's default, and a deprecated one
  (`production`, `dev`, `also`) never; a variable already in the environment the
  script just inherits. So a script sees `npm_config_omit` /
  `npm_config_include` from an .npmrc, the environment or the command line
  EXCEPT an omit=dev from an .npmrc or the command line while
  NODE_ENV=production is already in the environment (then the default: the
  script sees NODE_ENV alone, as it does beside an .npmrc's production=false
  that makes npm install them after all); `npm_config_production` only from the
  environment; an exported empty `npm_config_omit`, which npm ignores, reads
  exactly as `--omit=`, which it obeys; and NODE_ENV=production whenever npm is
  leaving devDependencies out - npm sets it. installCheck.test.js runs the
  omit=dev and production=false cases through the real npm.
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
  the system temp dir, which filled a disk. It also sets DB_DIR to `<that
  directory>/db`, over the environment: a test that loaded the PDF generator
  before `useTempStorage` used to open the REAL database (test/testRunner
  .test.js holds it). `TAILOR_KEEP_TEST_TMP=1` keeps the directory and prints
  where. A test that writes anywhere but `os.tmpdir()` escapes it. And it
  sets `TAILOR_GOOGLE_CREDENTIAL_SEARCH=off` with `GOOGLE_CREDENTIALS_PATH`
  and `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` empty, over the environment and `.env`
  (an exported empty value counts as set): the credential search
  (googleSheets.ts `resolveCredentialPath`) also looks beside the compiled
  code, so a checkout holding the owner's real credential in backend/ lent
  it to every test, and each test sign-in allocated a REAL spreadsheet in
  that Drive (440 "Free Tailor - admin@example.com" and kin). test/helpers.js
  sets the same three as it loads (for a file run with `node --test` alone)
  and exports `withCredentialSearch`, which turns the search on for one scope
  - only a test that wrote its own fake credential (and fakes `fetch`) uses
  it. Every e2e preload (each `stub-*.js` and fake-providers.js, read off the
  folder) requires test/e2e/no-google.js first, and a backend needing no stub
  loads that alone; testRunner.test.js holds all of it, every command
  naming `dist/index.js` - in the e2e README and in each script's own
  comments - to loading one of them, and fails on a line there that starts a
  backend another way (the root `npm run dev` and kin, the backend's `dev` /
  `start`, ts-node-dev: none takes a preload - shell.js named `npm run dev`;
  two passages telling the root dev script's history are named in the test). Not
  an operator setting: not in operational.ts or .env.example. NEVER run a
  test file any other way, and never weaken this.
- **The suite is 2178 tests in 158 files**, 4 skipped (counted on the owner's
  Windows machine at the end of v4.2, not re-measured on Linux). 16 of them fail there for reasons of that machine, not of the code:
  Windows has no exec bit, symlinks need a privilege, the CLIs are `.cmd` shims
  and the root `.env` is read into the test process. A red run there is not
  evidence that an edit broke something - diff the failing titles against the
  owner's list of the 16 instead of expecting green.
- **`npm run lint --prefix frontend` exits 1 on a clean checkout** — 3
  pre-existing `react-hooks/set-state-in-effect` errors, ALL THREE in
  `src/bid-assistant/App.jsx` (lines 271, 305, 381; `src/app/page.tsx`
  contributes none), and no warnings.
  Not a build gate: `next build` does not run ESLint. Do not treat a red lint as
  something your change caused without checking `git stash` first.
- **A stale `frontend/.next/dev` fails `next build`'s type check.** The
  frontend's tsconfig includes `.next/dev/types/**`, which only `next dev`
  (Turbopack, the root `npm run dev`) writes, so after a pull or a change that
  deletes a page, `npm run build --prefix frontend` and the production-style
  `dev` fail with `TS2307: Cannot find module '../../../src/app/<page>/page.js'`
  from `.next/dev/types/validator.ts`. Delete `frontend/.next/dev` (or run
  `npm run dev` once) - README Troubleshooting has the row.
- **Dark mode does not work the way it looks.** `globals.css` ends with a block
  that remaps light utilities under `html.dark` (`html.dark .bg-white { ... }`).
  That block is **unlayered** while every Tailwind utility sits in
  `@layer utilities`, so it beats `dark:` variants outright — on
  `class="bg-white dark:bg-slate-900"` the shim wins and the variant is
  ignored. 30 of the 31 App Router pages carry no `dark:` at all (only
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
  Next's own docs are in frontend/node_modules/next/dist/docs/. **Turbopack's
  build cache can ship a stale stylesheet.** From 16.3 `next build` keeps a
  persistent cache in `frontend/.next/cache/turbopack` (~60 MB; on by default,
  `experimental.turbopackFileSystemCacheForBuild`), and one such cache
  emitted a globals.css hours older than the source - no `.tl-multiselect*`
  rules, a removed `.tl-nav-out` back - through `touch globals.css` and
  "Compiled successfully in 2.1s"; the list boxes rendered unstyled and two
  e2e claims failed on it. A cold build (the directory deleted) was right; a
  fresh cache did notice a later change, so a cache can get into this state
  without always being in it. `next.config.ts` therefore sets
  `turbopackFileSystemCacheForBuild: false` (owner's decision, 2026-10-20), so
  a build starts cold and the directory is no longer written. A leftover
  `frontend/.next/cache/turbopack` from an older build is never read, but
  delete it if you see old styles; `next dev`'s own cache is
  `frontend/.next/dev/cache/turbopack`, deleted the same way. A cold compile
  costs ~5 s against 0.4-2 s warm. README Troubleshooting has the row.
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
reported, not fatal. A database an older build never finished upgrading IS
fatal, before anything else: one `[db] The database at <path> has not finished
upgrading: <what is missing>. Start build ac3df79 once on this database ...`
line and exit code 1 (database/upgradeGuard.ts, below) - start ac3df79 on that
`DB_DIR` once, then this build. So is a database holding an old table AND its
replacement, with rows in each (an older build was started on a database this
one had upgraded): one `[db] The database at <path> has both a "profiles" table
(what build 4.1 called a resume) and a "resumes" table, and both hold rows ...`
line (or the same for `profile_groups` beside `profiles`) and exit code 1
(database/glossaryRename.ts, below) - restore the backup taken before
upgrading, then start this build on it. The first start on a database build 4.1
wrote renames its tables and stored keys in place and prints one `[db] Renamed
for v4.2: ...` line, as does any later start that renames or drops something
(an older build re-creates an empty table at every start; this build drops it
and says so there); a start with nothing to do prints nothing of it.

To sign in, `.env` needs Google OAuth (`GOOGLE_CLIENT_ID`) or SMTP.
`ADMIN_EMAILS` (else an `SMTP_USER` that is an address) names the
administrators - promoted at every sign-in and start, never demoted
(`config/adminIdentity.ts`) - and every other sign-in is a `user`; arrival
order decides nothing, and with neither set there is no administrator.

## Layout

```
backend/src/
  index.ts            # Express app: mounts 28 routers under /api
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
                      #   settingDefaults.ts is the .env half of EVERY setting
                      #   an administrator may leave unset (owner decisions
                      #   S1-S3): stored > .env > code default, everywhere.
                      #   Pure env reads, its rows spread into operational.ts
                      #   (`SETTING_DEFAULT_VARIABLES`). The app-settings row
                      #   (aiModelConfig.ts `composeSettings`) stores ONLY what
                      #   an administrator set of the fields with a .env
                      #   default (`DEFAULTED_SETTING_KEYS` /
                      #   `APP_SETTING_ENV_VARIABLES`); every writer starts
                      #   from `storedRowOf(current)` and changes only what it
                      #   is about, so a save never freezes a value merely in
                      #   effect. `null` in PUT /api/admin/settings removes one
                      #   (Reset to default; `[]` for paymentLimits and '' for
                      #   defaultModelId too; '' for analysisModelId is the
                      #   admin's "the default model", stored). The admin
                      #   payload carries `settingSources` ('admin' | 'env' |
                      #   'default', where the value IN EFFECT came from) and
                      #   `settingDefaults` (what Reset gives), never the
                      #   user payload; the contact editor's and the lake
                      #   settings' payloads carry the same two maps.
                      #   PAYMENT LIMITS resolve PER METHOD: a stored row
                      #   stands for its own method, a method the row leaves
                      #   out is `.env`'s (else the code's), and the admin
                      #   payload's `paymentLimits` is every method in effect,
                      #   known ones first; `paymentLimitSources` says, per
                      #   method, whose row it is and which PAYMENT_* names
                      #   set it (only those). A save's rows MERGE by method
                      #   - `{ target, reset: true }` removes one method's
                      #   row, `null`/`[]` all of them - so a page sends only
                      #   the methods that changed (payments/limitDraft.ts
                      #   `limitChanges`). `staleDefaultModelId` names a
                      #   default model stored here that cannot run now
                      #   (another is in effect, and `settingSources` is
                      #   THAT one's); Admin -> Models says so and offers
                      #   Reset. DEFAULT_MODEL / ANALYSIS_MODEL are TEXT here (a
                      #   record id or display name) judged per read against
                      #   the runnable models, warned once when unusable.
                      #   OUTPUT_PATH_PREFIX is the `outputPathPrefix` field's;
                      #   OUTPUT_PATH_SUFFIX is a PER-ACCOUNT default, not an
                      #   app setting (its source, 'account' | 'env' |
                      #   'default', is services/outputPath.ts's). The three
                      #   SUBSCRIPTION PRICES (`premiumPriceMilli`,
                      #   `premiumPlusPriceMilli`, `premiumMaxPriceMilli`;
                      #   SUBSCRIPTION_<TIER>_PRICE_USD, `envSubscriptionPriceMilli`)
                      #   are served in thousandths, null = not offered (the
                      #   code default), and SAVED as `premiumPriceUsd`...
                      #   in dollars: '' or $0 stores 0, the admin's "not
                      #   offered" that beats .env (the override is kept in
                      #   that stored form), `null` resets, above $10,000 /
                      #   junk is refused with `field` and code `bad-price`,
                      #   and a `...PriceMilli` key in a save is refused
                      #   (`bad-price-field`); .env's 0 is not offered and
                      #   above $10,000 clamps; a stored price this app never
                      #   writes is dropped with one warning
                      #   (`withoutUnsetOverrides`). `getSubscriptionPrices()`
                      #   is the services' read, and THROWS when the settings
                      #   cannot be read - the renewal sweep relies on it.
                      #   Junk in .env (`envSubscriptionPriceMilli`'s
                      #   `unreadable`) or that dropped stored price, with no
                      #   price under it, is not offered too, but is no
                      #   DECISION: `getSubscriptionPriceReading()` (the
                      #   sweep's read) lists it as `unreadable`
                      #   (SettingsState.unreadablePrices), and the sweep
                      #   holds what renews as that tier rather than end it. A
                      #   new such field: its env reader here, its name in
                      #   APP_SETTING_ENV_VARIABLES, its code default, a row
                      #   in SETTING_DEFAULT_VARIABLES, `readings` and
                      #   `defaults` in composeSettings, .env.example, README,
                      #   and a case in test/settingDefaults.test.js - and on
                      #   its page (owner decision S4) a copy in frontend
                      #   lib/settingSources.ts's table (no runtime import;
                      #   test/frontendSettings.test.js holds it to this one),
                      #   a components/ui/SettingSource.tsx line under its box
                      #   ("Set here" | "From .env (NAME)" | "Default", and
                      #   Reset to default - the field sent as `null` - while
                      #   Set here), and a save that sends only what changed
                      #   (`changedSettings`): a form that sent every box
                      #   would mark every one Set here, frozen at that day's
                      #   .env.
                      #   The BUILD MODES are such fields (see "Builder modes
                      #   and the suitable resume" below). buildModes.ts, a
                      #   leaf, holds `BUILD_MODES` (suitable, partial, full),
                      #   their labels (Choose Suitable Resume, Partial
                      #   Tailor, Fully Tailor), `BUILD_MODE_PRICE_FIELDS`
                      #   (each mode's setting, request field and .env name)
                      #   and `parseBuildModePriceInput`. `defaultBuildMode`
                      #   (DEFAULT_TAILOR_MODE in any case; junk warns once
                      #   and reads `partial`) is the mode Build Resumes
                      #   starts on and the mode a run that names none runs
                      #   in. The three PRICES per resume (`suitablePriceMilli`,
                      #   `partialPriceMilli`, `fullPriceMilli`;
                      #   RESUME_<MODE>_PRICE_USD, `envBuildModePriceMilli`)
                      #   are served in thousandths, $0 until somebody sets
                      #   one (free, on purpose), and SAVED as
                      #   `suitablePriceUsd`... in dollars: `null` resets, ''
                      #   is refused (a price is required), a `...PriceMilli`
                      #   key is refused (`bad-price-field`), junk or above
                      #   $1,000 is `bad-price` with `field`; .env's above
                      #   $1,000 clamps, and its junk reads $0 and is listed
                      #   in the admin payload's `unreadableModePrices`.
                      #   `getBuildModePrices()` is the services' read, and
                      #   THROWS when the settings cannot be read. The
                      #   builder's other default is `defaultProfileId` (a
                      #   profile of the administrator's, '' = automatic;
                      #   stored whole, no .env default). A model record
                      #   carries no price. What an older build stored is read
                      #   past, never a failure, and dropped by the next
                      #   write: a model's price, the retired builder target
                      #   (`defaultResumeSelection`, `defaultResumeId`) and a
                      #   tailoring mode (`tailorMode`; the keys are
                      #   `RETIRED_SETTING_KEYS`).
                      #   sectionCatalogue.ts is THE catalogue of a resume's
                      #   sections and the one place the section order's
                      #   semantics live (see "Resumes, templates and the
                      #   section switches" below); pure, mirrored by
                      #   frontend/src/lib/sectionCatalogue.ts, drift-tested.
                      #   providerCatalog.ts is the ONE list of seats (TYPES)
                      #   - `coerceProviderId` answers null for any other id,
                      #   with no alias or retired-id map; aiProviders.ts the
                      #   PROVIDERS -
                      #   every place a type runs, see "Providers of one type"
                      #   below; jobFields.ts the job fields a posting
                      #   is classified into (stable ids, never reused);
                      #   industries.ts the industries it is filed under
                      #   (closed list, stable ids, `not_specified`; the
                      #   keywords an older analysis's free text is read
                      #   by); conceptTools.ts the concepts a posting may name
                      #   and the tools they are built with (the tailoring's
                      #   `[[conceptToolsJson]]`; closed, ~40 rows, and
                      #   `termPattern`, the whole-word matcher every tailoring
                      #   check uses); providerModels.ts each seat's model-name
                      #   list; buildModes.ts the three build modes and what
                      #   each costs per resume (thousandths of a dollar, see
                      #   "Builder modes and the suitable resume" below);
                      #   modelErrors.ts the two model refusals;
                      #   accountSubscriptions.ts the account TIERS (Default,
                      #   Premium, Premium+, Premium Max), their caps on how
                      #   many PROFILES (people) an account keeps
                      #   (`profileLimit`: 1, 5, 25, none; counted by
                      #   database/profileLimit.ts, below - resumes are never
                      #   counted) and `features` (the Subscription page's
                      #   card lines, which state the profile count and "Any
                      #   number of resumes in each"; never read as
                      #   switches), PAID_SUBSCRIPTION_IDS (all
                      #   but Default), SUBSCRIPTION_PERIOD_DAYS (30),
                      #   MAX_SUBSCRIPTION_PRICE_MILLI ($10,000) and
                      #   SUBSCRIPTION_PRICE_FIELDS (each paid tier's setting,
                      #   request and .env names). SELF-SERVE: an account buys
                      #   a tier from its credit balance (services/subscriptions,
                      #   below); an administrator may still set any account's,
                      #   which ends a paid one. The tier is a "subscription" in code, API, UI
                      #   and database (it was "plan"; the word is not used for
                      #   it anywhere now, and test/subscriptionRename.test.js
                      #   greps frontend/src to keep it so). Not the AI
                      #   "subscription seats", which share only the word.
                      #   middleware/auth.ts's requireSubscription(min) gates
                      #   on it (403 `subscription-too-low`) and IS satisfied
                      #   by being an admin (`hasSubscription`, owner decision
                      #   B1), but NO router uses it now: routes/profiles.ts
                      #   was the only one, and profiles are open to every builder
                      #   on every subscription - the tier's limit is a count
                      #   of profiles checked when one is made, not a guard on
                      #   a route. Nor is there a lock on a run any more: it
                      #   builds exactly ONE profile on every subscription
                      #   (400 `one-profile-per-run` otherwise,
                      #   services/resumeChoice.ts), and a profile may hold
                      #   any number of resumes, so a Default account builds
                      #   in every build mode. `requireSubscription` and
                      #   `SubscriptionTooLowError` stay as the guard a
                      #   future tiered route would use (test/auth.test.js
                      #   runs it, and test/routeAccess.test.js already knows
                      #   its level).
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
                      #   runs, in ONE IMMEDIATE transaction taken before
                      #   anything is read (a second opener of a new file
                      #   waits, and never sees a users table before its
                      #   stamp): for an EXISTING database (one with a `users`
                      #   table) the startup guard, then the vocabulary step
                      #   (glossaryRename.ts, below), then SCHEMA; for a fresh
                      #   one SCHEMA, then `stampCurrentDatabase`. Then
                      #   addMissingColumns (never fatal; ADDED_COLUMNS holds
                      #   only columns added since ac3df79 - today
                      #   users.output_path_suffix, orders.output_root, the
                      #   six users.subscription_* columns of a paid tier,
                      #   resumes.profile_id, the profile a resume is filed
                      #   under (NULL until it is filed), and
                      #   order_items.resume_label, profile_label and
                      #   match_json, what a run chose for the item (NULL on
                      #   an item an older build wrote) - and
                      #   every new column goes there AND in SCHEMA, never in
                      #   the guard's frozen list), then
                      #   addIndexesAfterColumns (INDEXES_AFTER_COLUMNS: every
                      #   index naming an added column - in SCHEMA it would
                      #   fail every upgraded boot - idx_users_subscription_due,
                      #   partial, and the tree's idx_resumes_owner_profile
                      #   among them; the tree's idx_profiles_owner is made
                      #   there too), then the migrations.
                      #   subscriptionRepository.ts is the ONLY writer of the
                      #   six subscription_* columns (base, period_start,
                      #   paid_through, period_price_milli, renews, next; all
                      #   NULL unless the tier is paid; read by their own
                      #   queries, never USER_COLUMNS) - bar
                      #   userRepository.updateUser, which clears them
                      #   (`BILLING_CLEARED_SQL`) when an administrator CHANGES
                      #   the tier, or moves the role away from user (the
                      #   tier then returns to its base). Every change is its
                      #   `changeSubscription(userId, decide)`: ONE IMMEDIATE
                      #   transaction reading the row, the caller's `decide`
                      #   (throw = refuse, nothing written), the charge
                      #   (creditRepository.debitSubscriptionCharge, a
                      #   savepoint), then the UPDATE conditional on the
                      #   paid_through it read; `lapseWhenShort` ends the tier
                      #   when a renewal's charge is refused. The sweep's
                      #   `DUE_SUBSCRIPTIONS_SQL` pages by (paid_through,
                      #   rowid) AFTER the last page - the index's own order,
                      #   nothing sorted - so due rows left as they were (held,
                      #   failed) never hide the ones behind them.
                      #   THE STARTUP GUARD (upgradeGuard.ts, owner decision
                      #   L1): the code that upgraded older databases - the
                      #   migrations 001 and 003-008, the switch of credits to
                      #   dollars, the move of saved templates into files, the
                      #   users.plan rename, the lake's facts fill - is gone,
                      #   so a database build ac3df79 did not finish would read
                      #   WRONGLY here, not fail. `assertUpgradeFinished`
                      #   refuses one unless schema_meta has
                      #   `provider_schema_version` = 8,
                      #   `credit_unit` = 'usd-milli' and
                      #   `templates_moved_to_files` (not `"complete": false`),
                      #   `users` has `subscription` (not `plan`), every table
                      #   it has carries each column ac3df79 adds to an
                      #   existing table (`UPGRADE_ADDED_COLUMNS`: that
                      #   build's addMissingColumns and the Bid Assistant's
                      #   two, less the three this build never makes; a
                      #   table it lacks is not asked about - SCHEMA makes
                      #   it whole), and no `job_lake` row has `job_type IS
                      #   NULL`. The marks alone are not enough: ccd70b3 to
                      #   1df7275 wrote all four before `users.sheet_layout`
                      #   and others existed, and such a database, let in
                      #   and stamped, failed every account read. A typo in
                      #   the list would refuse every upgraded database, so
                      #   the test checks each is a column this build makes:
                      #   `DatabaseNotUpgradedError
                      #   { databasePath, problems }`, "The database at <path>
                      #   has not finished upgrading: <phrases, '; '>. Start
                      #   build ac3df79 once on this database to finish its
                      #   upgrade, then start this build." (a migrations
                      #   phrase adds that they wait for an administrator when
                      #   none exists - ac3df79 makes an EXISTING account at the
                      #   ADMIN_EMAILS address one as its backend starts, else
                      #   somebody signs in through ac3df79's frontend, which
                      #   README Upgrading says to build and start for it). A
                      #   database that passes is stamped
                      #   `schema_meta.baseline_build` = ac3df79, once, and
                      #   later starts read ONLY the stamp (the lake check
                      #   would read every row); that first stamp also deletes
                      #   the `job_reports` records whose lake row is gone. A
                      #   fresh database is stamped with the three schema_meta
                      #   marks and the stamp (`stampCurrentDatabase`).
                      #   openAtStartup.ts is index.ts's SECOND import (after
                      #   config/env, before any route): modules that read the
                      #   database as they LOAD (the PDF generator reads the
                      #   skill library) would otherwise hit the refusal first,
                      #   as a stack trace; there it prints `[db] <message>`
                      #   and exits 1 (test/upgradeGuard.test.js spawns it,
                      #   and holds the README's quotes of the line to it).
                      #   There is no rollback (L1): nothing documents going
                      #   back, and a database this build CREATED has no
                      #   `templates` table and no `users.sheet_tab_*` or
                      #   `job_lake.report_ref` - an upgraded one keeps them,
                      #   and its migration logs and settings snapshots in
                      #   app_settings, unread.
                      #   THE VOCABULARY STEP (glossaryRename.ts, v4.2):
                      #   `renameRetiredVocabulary(db)` brings a database
                      #   written under build 4.1's words to the current
                      #   ones, once and in place - nothing converted and
                      #   no row deleted. v4.1 stored a resume as a
                      #   "profile" and a list of resumes as a "group"; v4.2
                      #   calls them a resume and a profile. It runs in
                      #   getDb()'s one transaction AFTER the guard (which
                      #   still reads ac3df79's names, so it must come
                      #   first) and BEFORE SCHEMA: SCHEMA creates
                      #   `resumes`, and run first it would put an empty
                      #   one beside the old table and hide every resume. A
                      #   throw rolls the guard's first stamp, the renames
                      #   and SCHEMA back together, and `[db] Renamed for
                      #   v4.2: ...` is printed once, after the COMMIT.
                      #   Two blocks, each behind a shape test of its own,
                      #   in this order because the second renames INTO the
                      #   name the first vacates: the RESUME block, when
                      #   `profiles` has a `disabled` column (the ONLY thing
                      #   that tells build 4.1's table of resumes from this
                      #   build's table of profiles, which must never gain
                      #   one), and the PROFILE block, when `profile_groups`
                      #   exists, so a database only the first block
                      #   reached still gets the second. The frozen
                      #   constants: `RENAMED_TABLES` (`profiles` ->
                      #   `resumes`, `profile_groups` -> `profiles`; one
                      #   lookup, never a chain), `RENAMED_COLUMNS`
                      #   (`order_items.profile_id` / `profile_name` ->
                      #   `resume_id` / `resume_name`,
                      #   `tailor_cache.profile_id` -> `resume_id`) and
                      #   `MOVED_JSON_KEYS`: a resume's `profileSettings` ->
                      #   `resumeSettings`; the app settings'
                      #   `defaultProfileId` -> `defaultResumeId` and THEN
                      #   v4.1's `defaultGroupId` -> `defaultProfileId` (that
                      #   order, or the new key would read a resume id; the
                      #   builder has no default RESUME now, so the first
                      #   move leaves a key the settings read past and the
                      #   next write drops);
                      #   five keys of a queued task in
                      #   `generation_tasks.data`, so a task queued before
                      #   the upgrade restores and builds. A JSON move
                      #   happens only where the old key is there and the
                      #   new one is not: nothing is overwritten, and a
                      #   second run changes nothing. STRAYS: where the old
                      #   name and the new both exist, the one that is
                      #   EMPTY is dropped (an unfinished start made an empty
                      #   `resumes` beside the old table; an older build
                      #   re-created an empty `profiles` or `profile_groups`
                      #   beside the renamed one) and the other kept; two
                      #   that both hold rows are refused with
                      #   `VocabularyConflictError` (`databasePath`,
                      #   `tables`), which openAtStartup.ts
                      #   prints as `[db] <message>` before exiting 1 with
                      #   nothing touched, not even the guard's first
                      #   stamp. There is no marker and NO MIGRATION STEP (the
                      #   numbered ones stop at 10, and there is no 11: the
                      #   structure is the state; LATEST_SCHEMA_VERSION
                      #   stays 10), and a start with nothing to rename
                      #   costs two sqlite_master lookups and one table_info
                      #   read. Left in the old spelling on purpose:
                      #   `UPGRADE_ADDED_COLUMNS`' keys (ac3df79's
                      #   `profiles`, `profile_groups`, `answers`),
                      #   `repointedProfiles` in the
                      #   `templates_moved_to_files` marker, a group's
                      #   stored `profileIds` (unread) and
                      #   `answers.profile_id`, the Bid Assistant's column,
                      #   which holds resume ids. The step files no resume
                      #   under a profile: that is lazy, at the first read of
                      #   its account's resumes (see "Profiles and their
                      #   resumes" below).
                      #   Saved templates are NOT a table:
                      #   templateFiles.ts is their store, `<id>.json` in
                      #   static/templates (see the note under this block);
                      #   templateRepository.ts keeps the four signatures it
                      #   had, plus the template_overrides table.
                      #   resumeRepository.ts is the `resumes` table
                      #   (`DocumentTable<Resume>('resumes')`, types/
                      #   resume.ts): a stored resume, scoped to its owner
                      #   HERE rather than in the routes, and where a resume
                      #   is FILED under its profile (see "Profiles and their
                      #   resumes" below): `createResumes` is every create,
                      #   `saveEditedResume` every edit (a row deleted
                      #   meanwhile is 404, never recreated), `deleteResume`
                      #   takes the Bid Assistant's answers for the resume
                      #   with it and re-points its profile's default, and
                      #   the raw `saveResume` / `saveResumes` are for tests,
                      #   seeding and the Bid Assistant's whole-record edit.
                      #   profileTree.ts is the tree itself: the people's
                      #   `DocumentTable`, read through `toProfile`;
                      #   `inTreeTransaction`, the ONE IMMEDIATE transaction
                      #   on ONE connection that every write to the tree runs
                      #   in; `placeNewResume`; the default rules' writes
                      #   (`adoptAsDefaultIfNone`, `repointDefaultAfterLeaving`,
                      #   `ensureDefault`); `deleteAnswersFor`;
                      #   `fileUnfiledResumes`, the lazy filing;
                      #   `summarizeProfiles`; the `?profileId=` checks
                      #   (`readRequestedProfileId`, `requireOwnProfile`) and
                      #   the refusals (`ProfileRefusal`,
                      #   `ProfileNotFoundError`, `ResumeNotFoundError`).
                      #   profileRepository.ts is the people's API over it
                      #   (types/profile.ts, scoped the same way):
                      #   `listProfileSummariesFor` / `getProfileSummaryFor`
                      #   (counted, as `ProfileSummary`), `createProfileFor`,
                      #   `updateProfileFor`, `moveResumesIntoProfile` and
                      #   `deleteProfileFor`, each ONE transaction with the
                      #   limit counted inside it; `listProfilesFor` /
                      #   `getProfileFor` answer the stored documents, for a
                      #   reader that needs the default's id and not the
                      #   counts, and `saveProfile` is a raw write for
                      #   seeding. A profile is a person: it lists no
                      #   resumes (a v4.1 group's member list is never read)
                      #   and /api/profiles is open to every builder on
                      #   every subscription.
                      #   profileLimit.ts is the subscription's cap, apart
                      #   from the resume repository:
                      #   `countProfilesForOwner`, `ProfileLimitError` (402
                      #   `profile-limit`) and `assertCanAddProfile` keep the
                      #   names the cap has always had, and count the
                      #   owner's PROFILES (their rows in `profiles`, through
                      #   idx_profiles_owner), never their resumes.
  database/migrations # the runner, `runDataMigrations(db, steps = MIGRATIONS)`
                      #   (never throws; the version is written after EACH
                      #   step; a step may defer, which stops the ones after
                      #   it), `SCHEMA_VERSION_KEY` and BASELINE_SCHEMA_VERSION
                      #   = 8. 001 and 003-008 ran on every database the guard
                      #   admits, so what they produced is in SCHEMA and the
                      #   seeded defaults. This build's steps run from 9, one
                      #   file each, on fresh databases too (stamped at 8, each
                      #   then finds nothing): 9 settings-defaults
                      #   (settingsDefaults.ts) takes out of the app-settings
                      #   row every field with a .env default still EQUAL to
                      #   its old code default (written out in the step, not
                      #   read from the code), so it follows .env; idempotent.
                      #   10 orders-output-root (ordersOutputRoot.ts) gives
                      #   every run without an `output_root` the folder its
                      #   recorded files name - up to the folder that is its
                      #   sanitized order number, under the output folder in
                      #   effect - and leaves NULL a run that recorded none;
                      #   defers while the column is missing.
                      #   `LATEST_SCHEMA_VERSION` (10) is what a fresh
                      #   database ends at; the v4.2 vocabulary step is not
                      #   a numbered one (glossaryRename.ts, above). Adding
                      #   a seed model needs a step: stored
                      #   `aiModels` is read verbatim, never unioned with the
                      #   defaults, so a seed reaches fresh installs only.
                      #   test/migrationRunner.test.js holds the runner to
                      #   all of this with steps of its own (9, 10, 11);
                      #   test/settingDefaults.test.js holds step 9,
                      #   test/outputPath.test.js step 10.
  extractors/         # reading a template's styles back out of its HTML
  generators/         # PDF (puppeteer), DOCX (html-to-docx), Handlebars.
                      #   pdfGenerator.ts holds THE render gate every output
                      #   goes through (`prepareResumeRenderData` ->
                      #   `applySkillsLimit`) and the compile step's markup
                      #   rewrites - see "Resumes, templates and the section
                      #   switches" below. sectionLocator.ts is the ONE answer
                      #   to "where is this section in a template's markup"
                      #   (`SECTION_LOCATORS`, `findSections`, `locateSections`,
                      #   `parentKeyOf`, `inferNativeSectionOrder`), a leaf the
                      #   strip/guard, the reorder and the template read all
                      #   use; extraSectionsMarkup.ts expands the
                      #   `{{> extra-sections ...}}` macro into the generated
                      #   blocks of the nine section kinds beyond the classic
                      #   six and of the custom sections (and holds
                      #   `insertStyleOnce`, the one way a compile step puts a
                      #   stylesheet in the head); plainSkillsMarkup.ts is the
                      #   Plain layout's safety net for a grid of category
                      #   cells (`fitPlainSkillGroups`, see "Resumes,
                      #   templates and the section switches" below).
                      #   docxGenerator.ts prints its blocks in
                      #   `effectiveSectionOrder`.
                      #   coverLetterGenerator.ts adds the
                      #   greeting and sign-off the prompts tell the model to
                      #   leave out, and splits paragraphs on a blank line, or
                      #   on every line break when the letter has none
                      #   (`splitCoverLetterParagraphs`).
  integrations/       # Stripe, Cryptomus, Google Sheets - one file per service.
                      #   Every Sheets/Drive call goes through `fetchWithBackoff`
                      #   (429: jittered exponential backoff, Retry-After
                      #   honoured, 5 retries, 32s cap); analysis data and the
                      #   filter's verdicts are written RAW, never USER_ENTERED.
                      #   The credential: the file GOOGLE_CREDENTIALS_PATH (else
                      #   GOOGLE_SERVICE_ACCOUNT_KEY_PATH) names, then the
                      #   default names in the cwd, cwd/backend and beside the
                      #   compiled code - the defaults skipped while
                      #   TAILOR_GOOGLE_CREDENTIAL_SEARCH=off, which only the
                      #   test runner, test/helpers.js and test/e2e/no-google.js
                      #   set (see "`npm test` builds first").
  middleware/         # auth, uploads, publicError.ts - what a failure may
                      #   tell whom (see "The AI layer" below) - and
                      #   requestSignal.ts, the abort signal a model call gets
                      #   when the client goes away (one controller per
                      #   response), shared by routes/resume.ts and
                      #   routes/resumes.ts.
  routes/             # one file per /api/* area. resumes.ts (/api/resumes)
                      #   also holds POST /resumes/preview, the resume editor's
                      #   live preview (see "Resumes, templates and the section
                      #   switches" below), POST /resumes/import and /upload,
                      #   and POST /resumes/entries/bullets,
                      #   the editor's Write with AI (services/entryBullets.ts:
                      #   free, one call per account at a time, the app
                      #   default model, nothing stored); its two GETs serve
                      #   each resume with its derived `matchKeywords`.
                      #   (resume.ts, at /api/resume, is the builder's:
                      #   models, skills, analysis and its ONE preview, POST
                      #   /resume/preview, which chooses a profile's resume
                      #   or draws held content again - see "Builder modes
                      #   and the suitable resume"; there is no
                      #   /resume/preview-all.)
                      #   profiles.ts (/api/profiles) is the people's router,
                      #   requireUser and nothing more - every builder, on
                      #   every subscription: list and read (a
                      #   `ProfileSummary`), make, rename, choose the default
                      #   resume, move resumes in, delete. It files the
                      #   viewer's old resumes first, and refuses with
                      #   PublicErrors that carry a code (see "Profiles and
                      #   their resumes" below). resumes.ts's creates take
                      #   `?profileId=`.
                      #   accounts.ts refuses an admin
                      #   disabling, demoting or deleting their OWN account
                      #   (409 `own-account`; another admin may), and its
                      #   last-admin guard (`wouldStrandInstall`) counts ANY
                      #   role but admin as losing one - not `user` by name.
                      #   It also takes `role` user|reporter|admin (anything
                      #   else 400 `bad-role`, never a quiet user) and a
                      #   `subscription` this build has (anything else 400
                      #   `bad-subscription`; `readRole` / `readSubscription`
                      #   read both on POST - before anything is created -
                      #   and PATCH alike), serves each
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
                      #   refundRequests.ts (a reporter's payout request, an
                      #   account's own requests, and the admin queue - there
                      #   is no route to ASK for a refund, not even a 410),
                      #   subscription.ts (/api/subscription, requireUser: the
                      #   account's own tier bought from its balance - GET /,
                      #   POST /subscribe { subscription, chargeUsd },
                      #   /downgrade, /cancel, /resume; services/subscriptions
                      #   below) and
                      #   contact.ts (GET /api/contact is PUBLIC, no session)
                      #   are described under "Money" below. generation.ts is
                      #   the queue's HTTP side - see services/queue/ below for
                      #   its run kinds, the release route and the per-file
                      #   download, and "Builder modes and the suitable
                      #   resume" for what a run names, chooses and costs
                      #   (its body is `profileId` and `buildMode`; its quote
                      #   and its 202 say the mode, never a profile count).
                      #   import.ts's GET /tabs lists the caller's
                      #   OWN sheet's tabs (`listAddressableSheetTabs`: the
                      #   resolveAddressableSheet guard - own sheet only, any
                      #   other id 404, an admin's too - then one listing and
                      #   ONE batched read of every tab's row 1), each with
                      #   `layout` job | blank | other, `defaultTab` All;
                      #   POST / still reads a tab's rows. There is no POST
                      #   /resume/generate (and no /resume/download) any more:
                      #   every build is queued; a `charge:` refund request one
                      #   made still reads and decides (services/refunds).
                      #   generatedFiles.ts is the owner check of the one
                      #   path-taking download, GET /api/generated/* (its
                      #   handler, mounted inline by index.ts,
                      #   `generatedFileFor`): asked of the path as the server
                      #   OPENS it - utils/generatedPath's
                      #   `resolveGeneratedFile` spellings, empty and dot
                      #   segments resolved, then through the native realpath -
                      #   never the raw parameter, which let `a//b` and `./a/b`
                      #   read another account's run. Served only when the
                      #   asker is its ONE owner: a file nobody claims is
                      #   nobody's (404). `ownersOfGeneratedFile`
                      #   (orderRepository) claims by an item's recorded path
                      #   (case folded) and by the run's FOLDER,
                      #   `orders.output_root` (absolute `<output folder>/
                      #   <rendered prefix>`, written by createOrder's
                      #   `outputRootFor`; one NOCASE index seek per folder
                      #   above the file, idx_orders_output_root), so a file is
                      #   the run's before (or without) its item recording it,
                      #   whatever the prefix says later; a run with a NULL
                      #   root claims only its recorded files;
                      #   test/orderFileAccess.test.js sends the spellings raw.
                      #   auth.ts's PUT /account { outputPathSuffix } and POST
                      #   /output-path/preview are a builder's (requireUser;
                      #   the name stays PATCH's) - see "Where resumes are
                      #   filed" below; admin.ts's POST /output-path/preview
                      #   previews an unsaved prefix, and PUT /settings passes
                      #   an `OutputPathError`'s `field` and `code` on.
  scripts/            # operator tools, each behind an npm script: mail:doctor,
                      #   sheets:login, sheets:doctor. The doctors share one
                      #   shape -
                      #   walk the real chain in order, stop at the first break,
                      #   name the remedy - because each diagnoses a failure whose
                      #   single error message covers several causes.
  services/ai/        # provider-agnostic transport; one directory per provider
                      #   TYPE, one adapter per PROVIDER (registry.ts keyed by
                      #   provider id), providerPool.ts which provider of a
                      #   type a call runs on
  services/jobAnalysis/ # THE way to a job analysis: gate.ts's
                      #   `getOrCreateAnalysis` (the only caller of the analysis
                      #   prompt and the Job Facts (Filter) prompt, its two
                      #   calls - test/analysisGate.test.js greps for any
                      #   other), identity.ts (link key, content hash),
                      #   facts.ts (the facts answer, salary, filter facts),
                      #   jobFieldLine.ts (the code's job field question on the
                      #   facts call), submit.ts (a batch's analyses at
                      #   submission, sheet first). See "Job analysis runs
                      #   once" below.
  services/queue/     # on-disk generation queue (survives a restart). One LANE
                      #   per PROVIDER (lane id = provider id: `claude-cli`,
                      #   `codex-cli`, `gemini-cli` for the built-ins, `prv-...`
                      #   for an added one), each as wide as its
                      #   `concurrency_max_requests`, re-read live; a task names
                      #   its POOL (`laneFor` = its model's type) and is placed
                      #   with a serving provider of it - see "Providers of one
                      #   type" below. A restored row naming a lane this process
                      #   lacks (a removed provider) goes to the pool of the
                      #   type its choice resolved to (`restoredLane`); a
                      #   provider no catalog knows lands in the first seat's
                      #   (`laneFor`). A task row's `data` is a
                      #   hand-picked PROJECTION built by index.ts's `taskRow`,
                      #   not the Task serialized, so a new field must be named
                      #   there AND in the restore mapper or it silently does
                      #   not persist (`ranOn`, the provider it last ran on, is
                      #   one such). The payload persists whole, which is why
                      #   a task's price lives on it (`payload.costMilli`: its
                      #   build mode's price when it was submitted), and the
                      #   run's mode (`payload.buildMode`; absent on a task
                      #   queued before v4.2, which builds Partial), and
                      #   its job's stored analysis (`payload.analysisId`, set
                      #   at submit or stamped on every task of the job by the
                      #   first to obtain it - `recordJobAnalysis`) - so does
                      #   the task's label, which is how a task keeps what the
                      #   run chose for it (`label.resumeLabel`,
                      #   `label.profileLabel`, `label.match`; a restored
                      #   task never chooses again) - and so does
                      #   `batch.shared`, which is why a batch's mode
                      #   (`shared.buildMode`) and its
                      #   KIND are there: `shared.kind = 'order' | 'immediate'`
                      #   (`isOrderBatch`, `isImmediateBatch`; submit body
                      #   `mode`, default immediate - nothing else is read
                      #   for it, so an old script's `asOrder: true` is an
                      #   immediate run; a batch naming neither kind is never
                      #   one the routes submit - `batchKind` null, no lease,
                      #   no priority).
                      #   EVERY run gets an `orders` row (`orders.kind`;
                      #   immediate rows number `FT-RUN-...`, are
                      #   hidden from listOrdersForUser and the order routes'
                      #   `mine()`, and are filed like an order: under the run's
                      #   place, `payload.output` (`RunOutputPlace` - output
                      #   folder, rendered prefix, the submitter's folder path
                      #   and the day, fixed at submit by services/outputPath.ts
                      #   `planRunOutput` and stamped on every task once the
                      #   order has its number; the order's `output_root` is
                      #   the same folder). An immediate run is LEASED to
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
                      #   `jobMeta.title` (`resolveTaskRole`) - cover letter,
                      #   the folder path's `{{role}}` (`unknown` when still
                      #   empty), files and result alike; the builder has no
                      #   Fallback Role. A task with no `payload.output` (one
                      #   queued before runs carried their place) is given its
                      #   run's from the order (`placeOfPlacedRun`: the
                      #   recorded folder, else the prefix in effect rendered
                      #   for its number and day).
  services/outputPath.ts # where an account's resumes are filed: its own
                      #   folder path and where the one in effect came from,
                      #   the two previews, and `planRunOutput`, the one place
                      #   a run's folder is worked out - see "Where resumes are
                      #   filed" below.
  services/subscriptions/ # self-serve tiers paid from the credit balance (see
                      #   "Money" below): billing.ts the pure rules (days
                      #   left, the unused credit, the upgrade's charge, the
                      #   renewal period, `offerFor`, `renewalDecision`; a
                      #   money module), errors.ts the refusals
                      #   (`SubscriptionRefusal`, `SubscriptionShortError` -
                      #   402 `insufficient-credits`), index.ts the view and
                      #   the four changes, `renewDueSubscriptions` /
                      #   `renewOrLapse`, `applyAdministratorChange` (Accounts'
                      #   PATCH: updateUser with the account and its paid
                      #   period read either side, in ONE IMMEDIATE
                      #   transaction), `reportEndedByAdministrator` and
                      #   `describeDisabledPaidTier` (the Accounts notes, and
                      #   the notice) and the clock seam
                      #   (`setSubscriptionClockForTests`), notices.ts what an
                      #   account is told after a change commits, renewal.ts
                      #   the sweep's timer - started from index.ts's listen
                      #   callback by `startSubscriptionRenewalAfter`, its
                      #   first pass once the queue restore's
                      #   `reconcileCredits` has given back abandoned
                      #   reservations (a renewal is decided on the balance),
                      #   never on import, unref'd, never two passes at once.
  services/tailorCache.ts # the tailoring cache (owner decision P6): the model's
                      #   answer to a tailoring (revised, when the revise pass
                      #   changed it) or a cover-letter call, reused for the
                      #   same unchanged resume, posting, model and prompts -
                      #   see "The tailoring cache" below.
  services/extraSections.ts # the render data of the nine section kinds beyond
                      #   the classic six and of the custom sections, prepared
                      #   (dates joined, links policed by the renderer's own
                      #   rules) under the resume fields' names; pure.
  services/profileRules.ts # the rules of profiles (people) and their resumes
                      #   that need no database - pure, types only, so a test
                      #   loads it alone: `personKey`, `profileNameForPerson`,
                      #   `readProfileName` (UNTITLED_PROFILE_NAME,
                      #   MAX_PROFILE_NAME_LENGTH = 100),
                      #   `effectiveDefaultResumeId`,
                      #   `repointedDefaultResumeId`, `oldestFirst` and
                      #   `resumeLabelOf` (a resume's headline, unless that is
                      #   empty or the normaliser's 'Professional'; else its
                      #   name; else 'Untitled resume'). See "Profiles and
                      #   their resumes" below.
  services/resumeDocument.ts # a stored resume as a document: built, normalised
                      #   and read here - `buildNewResume`,
                      #   `buildUpdatedResume`, `buildPreviewResume`,
                      #   `normalizeResumePayload` / `normalizeResumeSettings`,
                      #   the settings' getters (`getResumeSections` for the
                      #   three switches) and `resumeForTemplate` - see
                      #   "Resumes, templates and the section switches".
                      #   resumeService.ts, the tailoring, is another module.
  services/resumeImport.ts # a resume file read as an upload: GATED first
                      #   (`assertLooksLikeResume`: a name and some field a
                      #   resume has, so a package.json is refused), then
                      #   normalised - `buildImportedResumes`,
                      #   `readResumeImportDocument`. The one module that
                      #   still reads v4.1's spellings (see "Conventions from
                      #   the history").
  services/resumeChoice.ts # which resume a run builds for each job, and what
                      #   that costs; a MONEY module (test/money.test.js lists
                      #   it). routes/generation.ts calls it in this order,
                      #   before anything is reserved or asked of a model:
                      #   `readRunRequest` (the body's shape: ONE `profileId`,
                      #   `buildMode`, `previewedResumeId`, the held content
                      #   and its tokens), `resolveRunTarget` (the profile, its
                      #   ENABLED resumes newest first, its effective default;
                      #   files the caller's unfiled resumes first), `planRun`
                      #   (a resume and its `TaskMatch` per job),
                      #   `checkPreview` (409 `preview-changed`) and `priceRun`
                      #   / `quoteRun` (jobs x the mode's price, the floor for
                      #   held content no token vouches for). Its refusals are
                      #   `RunRequestError`s. See "Builder modes and the
                      #   suitable resume".
  services/resumeKeywords.ts # a resume's keywords, COMPUTED and never stored:
                      #   `keywordsOf` (pure), `matchKeywordsOf` (a 512-entry
                      #   memo that writes nothing back), `KEYWORDS_VERSION`,
                      #   the vocabulary and its class rules, `TERM_SYNONYMS`,
                      #   and `scanVocabulary`, which the matcher reads a
                      #   posting's text with.
  services/resumeMatch.ts # the suitable resume of a profile for a posting; pure:
                      #   `scoreResumeForJob`, `chooseForJob` and `TaskMatch`,
                      #   the explanation an order item keeps.
  services/sampleResume.ts # `SAMPLE_RESUME` (the gallery's invented person),
                      #   `SAMPLE_TAILORED_CONTENT` and `withSampleDefaults`
                      #   (the editor's preview borrows what a draft leaves
                      #   empty); never a save, a generation or a prompt.
  services/entryBullets.ts # Write Entry Bullets: the editor's Write with AI /
                      #   Improve with AI on one experience, project or
                      #   volunteering entry - the prompt values
                      #   (`buildWriteEntryBulletsPromptValues`), the refusals
                      #   by code, the call on the app default model, the
                      #   answer held to `cleanBullets` and cut to eight.
  services/tailorContract.ts # what the tailoring prompt is promised about the
                      #   code: the lists it is sent (`buildTailorLists`, the
                      #   posting's own spelling, no library), the seeded
                      #   per-resume draws (`tailorSeed`, `mulberry32`), the
                      #   composed title, the restored roles, the eight-bullet
                      #   cap, the banned vocabulary, the dash and numeral
                      #   backstops. Pure; resumeService puts it together - see
                      #   "Prompt variables are the code's, strictly".
                      #   `postingTermLists` is the part of the lists that
                      #   needs nothing else (the skills, the concepts, the
                      #   five a posting leans on), which the matcher reads in
                      #   place of the whole of `buildTailorLists`;
                      #   `isCompanyDescriptionLike` and `words` are exported
                      #   for the keywords and the matcher, and
                      #   `buildTailorLists`' output is byte-identical (the
                      #   golden literals pin it).
  services/reviseCoverage.ts # the revise pass's pure half: missing terms,
                      #   the source resume's evidence for them
                      #   (`resumeEvidence`, `supportedTerms`), its dropped
                      #   figures (`droppedResumeFigures`), its prompt values,
                      #   `mergeRevision`.
                      #   resumeService's `tailorResume` makes the call.
  services/sheets/    # each account's OWN job sheet (accountSheet.ts), the
                      #   program's analysis columns (analysisColumns.ts), and
                      #   jobExport.ts's `appendJobRows` - the writer Find
                      #   Jobs' Export into Sheet appends to All with (see
                      #   "The export writer" below).
  services/skillGroups.ts # THE reader of the model's Technical Skills block
                      #   (`skillGroups`), for the tailoring parse and the
                      #   render gate alike: sanitise the shape, find the
                      #   soft-skill group, flatten for Plain. Pure - see
                      #   "Resumes, templates and the section switches".
  services/templateChoice.ts # THE answer to "which template is this resume
                      #   drawn with" - resolveTemplateForResume, for the live
                      #   preview, /resume/preview and the
                      #   queue. Do not write a
                      #   second copy of the fallback.
  bidAssistant/       # the Bid Assistant's own prompt building, and database.js.
                      #   Every answer is told to use only the candidate data
                      #   (aiHelper.ts `buildBatchPrompt`, `SYSTEM_PROMPT`, and
                      #   the default template - kept equal in routes/
                      #   bidAssistant.ts and the page's lib/promptTemplate.js),
                      #   and each role is sent with its own bullets.
                      #   Its job board is SHARED (deleting a job, which takes
                      #   every account's answers, and the one Ask AI template
                      #   are requireAdmin); sheet sources carry an `account_id`
                      #   (in the CREATE; no table is rebuilt or altered at
                      #   load - an owner-less row an older build saved is
                      #   listed for all and changed by an admin only, and a
                      #   deleted account's is listed to admins only); answers
                      #   are scoped through the reader's own resumes, and so
                      #   is a job's `has_answers`. THE BID ASSISTANT STILL
                      #   CALLS A RESUME A "PROFILE": its pages, its routes
                      #   (/api/bid-assistant/profiles), `profileId` and the
                      #   `answers.profile_id` column keep that word, and the
                      #   column holds resume ids. It reads and writes the
                      #   stored resumes through resumeRepository and
                      #   resumeDocument. Its create is
                      #   resumeRepository.createResumes, like every other
                      #   create: the resume is placed under its person's
                      #   profile, and the profile limit is counted only when
                      #   that makes a new profile (a third resume of one
                      #   person is allowed, a new person obeys the limit).
                      #   Its whole-record edit is the raw `saveResume`,
                      #   which keeps the stored placement. Answers are keyed
                      #   by resume id alone and ids are reusable, so
                      #   deleting a resume deletes its answers
                      #   (resumeRepository.deleteResume), deleting a PROFILE
                      #   deletes its resumes' answers in the same
                      #   transaction (profileRepository.deleteProfileFor),
                      #   and loading database.js sweeps any left orphaned
                      #   (`answers.profile_id` against `resumes.id`).
  types/, utils/      # shared types; path, storage and filename helpers
backend/
  static/             # shipped defaults, never written at runtime EXCEPT
                      #   templates/, which also holds saved templates - and
                      #   not all read the same way: see the note under this block
  test/               # node:test, 158 files; fixtures/cli, codex and gemini
                      #   replay real CLI streams (`recorded-` is a capture,
                      #   `constructed-` a real envelope around a fake answer).
                      #   sectionCatalogue.test.js, sectionOrder.test.js and
                      #   entryBullets.test.js hold the section catalogue and
                      #   order, every built-in's render in a stored order, and
                      #   Write Entry Bullets. glossaryRename.test.js holds
                      #   the v4.2 vocabulary (database/glossaryRename.ts and
                      #   the rename of the code): a fresh database is born
                      #   with the new names; a database as build 4.1 left
                      #   it, stamped by it or not yet, opens renamed and
                      #   intact, its queue rows converted, a Bid Assistant
                      #   answer kept, ONE `[db] Renamed` line printed and a
                      #   second open changing nothing, and one only the
                      #   resume rename reached gets only the profile
                      #   rename; an empty stray table is dropped and two
                      #   with rows are refused, by name, with the server's
                      #   exit 1 before any route loads; the startup guard's
                      #   column list is ac3df79's; GOLDEN literals pin what
                      #   a model is told and every tailoring cache key to
                      #   build 4.1's, so no cached tailoring misses; the
                      #   Bid Assistant's members exist in the renamed
                      #   modules; and source scans fail on a retired name,
                      #   path or compiled module, on a page that calls the
                      #   account a profile, on a profile spelling outside
                      #   its own files and on a "group" that is not another
                      #   sense (skill groups, the Grouped layout) or in a
                      #   file waiting to be replaced - each pattern with a
                      #   self-test that it catches its shapes and none of
                      #   the spellings that stay. Its G-3 compares against a
                      #   snapshot of the pre-stage files only when
                      #   `V42_PRE_G_FILES` names them. The six docs (this
                      #   file, the READMEs, .env.example) are scanned for
                      #   the retired names too, the release notes aside: a
                      #   current line may name one only to say what it was.
                      #   profileTree.test.js holds the profile tree (see
                      #   "Profiles and their resumes" below): placement, a
                      #   body that never places, the limit on people (two
                      #   creates racing included), edits and reused ids, the
                      #   default resume, move, delete, no tier gate, stale
                      #   pages, the summaries, that the lookups seek on the
                      #   two indexes, the tree invariant, and the lazy filing
                      #   of a database built as v4.1 left it. helpers.js's
                      #   `seedProfileWithResumes(owner, name, inputs)` seeds
                      #   a person with resumes, going round the routes and
                      #   the limit, for a test that needs a tree.
                      #   buildModes.test.js holds the three build modes over
                      #   the real routes and queue, with stub seats that
                      #   count their calls per call site (Choose Suitable
                      #   Resume asks for no tailoring; the labels and order
                      #   items, a restart, a deleted pick, the one-profile
                      #   refusals, the previews); modePricing.test.js the
                      #   prices per mode (stored, .env and code values, the
                      #   refusals by box, the quote equal to the charge,
                      #   tokens and the floor, the refunds);
                      #   resumeKeywords.test.js and resumeMatch.test.js the
                      #   keywords and the matcher, the worked example on
                      #   both of its paths.
frontend/src/
  app/                # App Router pages: /, /settings/*, /admin/*, /jobs
                      #   (Find Jobs - see "The Job Data Lake" below),
                      #   /jobs/filter, /orders, /credits (+ /credits/invoice,
                      #   drawn with no shell - navModel's isBareRoute). There
                      #   is no /account or /settings/plan redirect any more -
                      #   a Next 404.
                      #   /admin/profiles is the PROFILES DASHBOARD, "My
                      #   Profiles", for EVERY builder on every subscription
                      #   (its rail label is "Profiles"): a profile is a
                      #   person, and the page has two tabs - Profiles (N), a
                      #   card per person, and All resumes (M), a card per
                      #   resume (`?tab=resumes`; anything else reads as
                      #   Profiles) - each with a search and a Grid | List
                      #   view. /admin/profiles/[profileId] is one profile's
                      #   page: its resumes, the default marked. The resume
                      #   pages are /admin/resumes/new[?profile=<id>] - the
                      #   template chooser (no `template`) or a new resume's
                      #   editor (?template=<id>[&layout=flat][&profile=<id>];
                      #   `template=` alone starts with none -
                      #   lib/resumeGallery.ts `readStartChoice`) - and
                      #   /admin/resumes/[id], the editor, whose address
                      #   survives a Move to another profile. There is no
                      #   /admin/groups: the v4.1 Groups page is gone, a Next
                      #   404 with no redirect (a stale frontend/.next/dev
                      #   still names it: see its bullet above). A v4.1
                      #   bookmark, /admin/profiles/<resumeId> (that address
                      #   was a resume's editor), finds no profile, asks for a
                      #   resume of that id and `router.replace`s to its
                      #   editor; the id `new` replaces itself with
                      #   /admin/resumes/new and the same query string; any
                      #   other id says "That profile was not found. It may
                      #   have been deleted." with a link to My Profiles.
                      #   /report (Report Jobs) is a REPORTER's home, behind
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
                      #   a new reporter page is added there AND to that list;
                      #   it also fails on a literal link that names no page
                      #   (an href, a router.push or redirect, a `*_PATH`
                      #   constant, a notice's `link`).
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
                      #   `canSee(item, role)`, `settingsTabsFor`. A
                      #   SUBSCRIPTION never hides an entry: one with `needs`
                      #   (and `feature`, its lock) is drawn LOCKED below that
                      #   tier - `isNavLocked(item, role, subscription)`,
                      #   admins exempt - as a button.tl-nav-item that opens
                      #   the lock's dialog (AppSidebar; from the phone drawer
                      #   it hands focus to the menu button first, which the
                      #   dialog gives back). No entry has `needs` now - the
                      #   mechanism stays for a future tiered entry, and
                      #   frontendRoles.test.js holds that nothing is locked on
                      #   any tier. There is ONE Profiles entry, open to every
                      #   builder, and no Groups row; it is lit on
                      #   /admin/profiles and below it AND under /admin/resumes
                      #   (`NavItem.alsoActiveOn`, which `activeHref` honours:
                      #   the longest path that matches, an entry's own or one
                      #   of its aliases, wins, and the answer is always the
                      #   entry's `href`), so the chooser and the editor light
                      #   it. Every entry is a page of the app
                      #   (frontendRoles.test.js
                      #   holds every href to `/`): Find Jobs is /jobs, and a
                      #   builder's way to their sheet is its "Go to my
                      #   sheet". AppShell asks GET /api/sheet for a REPORTER
                      #   only, for the account menu's link.
                      #   A reporter's rail is Report Jobs, Credits, Settings
                      #   (Account, Job Sheet); their account menu has their
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
  components/resume/  # The resume pages, laid out AND drawn after FlowCV's
                      #   (owner's requests, 2026-10-19), all on the editor's
                      #   desk and tokens (app/admin/layout.tsx gives every
                      #   route lib/profileDashboard.ts `isProfilesDeskRoute`
                      #   names - /admin/profiles, a profile's page,
                      #   /admin/resumes/new and /admin/resumes/<id> - a bare
                      #   <main>; their pages pad their own loading and error
                      #   states; the dashboard and a profile's page are
                      #   components/profiles/, below).
                      #   THE CARDS: ResumeCards.tsx draws a resume as a card
                      #   (`ResumeCard`) or as a row of the List view
                      #   (`ResumeRow`): its first page (`ResumeThumb`, POST
                      #   /resumes/preview with `resume: {}`, its id and
                      #   `sample: false`, asked once the card is near the
                      #   screen; the last 24 pages are kept by `id:updatedAt`,
                      #   so a save is a new key, and a request in flight is
                      #   shared - a switch of tab or of Grid / List unmounts
                      #   every card, and a fresh request for each would draw
                      #   the same pages again), its headline (`resumeLabel`),
                      #   "Edited ... ago · <template>", the ★ Default and
                      #   Disabled badges and ActionMenu.tsx's ⋮ (its items
                      #   are the page's, components/profiles/useResumeActions;
                      #   a role=menu with arrow keys, opening upward near the
                      #   window's foot; an item's press hands focus back to
                      #   the ⋮ button BEFORE it runs, so a dialog it opens
                      #   returns focus there). The dashed New resume tile is
                      #   never locked: resumes are not counted.
                      #   THE CHOOSER (app/admin/resumes/new/page.tsx
                      #   without `template`; Suspense around
                      #   useSearchParams): TemplateChooser.tsx - the filter
                      #   pills (All Templates + each category some template
                      #   has), "Import existing resume" (a resume PDF or a
                      #   resume JSON file, useResumeImport.ts - which takes
                      #   the profile the address names and files the
                      #   resumes under it - and its
                      #   transient `chooseFile` input), the grid of gallery
                      #   previews (PageThumb.tsx: an A4 frame scaled to its
                      #   box by a ResizeObserver; a resume's page is a srcdoc frame
                      #   with every sandbox flag off; a new `src` is a new
                      #   frame - the iframe is keyed by it - because a loaded
                      #   frame sent elsewhere adds a browser-history entry)
                      #   and the details dialog (own chrome,
                      #   `useDialogLayer`; Previous/Next and the arrow keys
                      #   step through the filtered list - the arrows from
                      #   anywhere but the switch; a
                      #   Technical skills switch, role=group aria-label
                      #   "Technical skills", Grouped / Plain, redraws the page
                      #   - every template prints both - opening on Grouped
                      #   and kept across Previous/Next; Use this template is
                      #   never off - any resume may use any template). The
                      #   heading is "Start building a resume", with " for
                      #   {name}" when `?profile=` names a profile of the
                      #   viewer's, and the back link names that profile (and
                      #   goes to its page) or says "My Profiles". Nothing
                      #   gates the page: resumes are not counted. Use this
                      #   template (`onUse(template, layout)`) goes to
                      #   /new?template=<id>[&layout=flat, the layout
                      #   shown][&profile=<id>] (`startResumeHref`), whose
                      #   editor gets `start` (lib/resumeDraft.ts
                      #   `draftForNewResume`) and asks ImportStartDialog.tsx's
                      #   "Import your existing resume": Import resume uploads
                      #   the PDF (the server saves the resume - under the
                      #   profile named, else by the person's name), PUTs the
                      #   chosen template and layout on it and replaces the
                      #   address with its editor; Start from blank closes.
                      #   Their styles are resumePages.module.css; the
                      #   decisions with no React in them - the filters, a
                      #   template's gallery page in either layout
                      #   (`templatePreviewPath`, which Admin -> Templates'
                      #   View and its own Grouped / Plain switch frame too),
                      #   its feature lines, the start links
                      #   (`startResumeHref(template, layout, profileId)`,
                      #   `startWithoutTemplateHref`) and their
                      #   reading, "Edited ... ago", Duplicate's body (no id,
                      #   times, `disabled`, profile or keywords - it KEEPS the
                      #   template; the model through
                      #   savableModelChoice, lib/resumeModelChoice.ts),
                      #   Download's file (the resume less its `profileId` and
                      #   `matchKeywords`, a file Import takes back) - are
                      #   lib/resumeGallery.ts, types only, run against the
                      #   server's categories, save and import by
                      #   test/frontendEditorHelpers.test.js and
                      #   frontendProfiles.test.js.
                      #   THE EDITOR: ResumeEditor owns the draft and the save
                      #   on that desk. It reads the resume's profile
                      #   (`profilesApi.get`; a 404 is tolerated - the profile
                      #   is then not the viewer's to open) and takes a new
                      #   resume's from the page, which stays the only reader
                      #   of `?profile=`: the first save is
                      #   `resumesApi.create(payload, { profileId })`, or with
                      #   none the server files the resume by the person's
                      #   name. A sticky bar: the profile's name ("Profiles"
                      #   where it cannot be read) is the way back - Back, Save
                      #   and leaving go to that profile's page, else to My
                      #   Profiles, and nothing pushes the bare list - then the
                      #   Content / Customize tabs
                      #   (role=tablist "Editor
                      #   views"; BOTH panels stay MOUNTED under `hidden`, so
                      #   #resume-template and the layout radios are in the
                      #   DOM on either tab), the unsaved state and Save
                      #   (`form="resume-editor-form"`, outside the form), and
                      #   under 1100px the Form / Preview switch (role=tablist
                      #   "Editor", exactly "Form" / "Preview" -
                      #   e2e/preview-vibration.js clicks it). The look is
                      #   resumeEditor.module.css's: tokens on `.editor` (and
                      #   `.tokens`, which the portalled Add content dialog
                      #   carries through Dialog's `className`), restated under
                      #   html.dark; the kit's .tl-* pieces restyled INSIDE the
                      #   editor only (its dark input rules out-rank the shim's
                      #   on purpose); DM Sans from editorFont.ts (next/font,
                      #   `--font-editor`, read by the editor alone); every grid
                      #   track `minmax(0, 1fr)` - an `auto` one grew to a
                      #   nowrap title's width and scrolled a phone sideways.
                      #   Content is a column of collapsible SECTION CARDS
                      #   (SectionCard.tsx: h2 > button[aria-expanded] stretched
                      #   over the whole head, CLOSED until opened - the card
                      #   Add content just made opens - a body that stays
                      #   MOUNTED while closed, so the e2e scripts' DOM clicks
                      #   on #resume-include-* always land; the grip and Move
                      #   up/down appear on hover or focus, and on a touch
                      #   screen while the card is open; in SectionSlot.tsx,
                      #   native HTML5 drag and drop armed from the grip), in
                      #   the order `effectiveSectionOrder(draft.sectionOrder
                      #   ?? [], template.nativeSectionOrder ??
                      #   DEFAULT_SECTION_KINDS, presenceOf(draft))`: the
                      #   header card (EditorHeaderCard.tsx, its pencil opens
                      #   the Basics panel), one card per section (EntrySection
                      #   .tsx for every entry kind and the custom sections;
                      #   ContentCards.tsx: SummaryCard, InterestsCard,
                      #   BasicsPanel; SkillCards.tsx: TechnicalSkillsCard,
                      #   SoftSkillsCard), "+ Add content" (AddContentDialog
                      #   .tsx: the non-default kinds not yet listed, and a
                      #   Custom section with a title). Customize is parts.tsx's
                      #   SettingsCard four times: TemplateCard and LayoutCard
                      #   (TemplateCard.tsx: the picker, which lists every
                      #   enabled template - no "(used by ...)", no disabled
                      #   option; the layout radios and
                      #   "Use the template's order"), GenerationSettings
                      #   Card.tsx - the model, the Building prompt ("Used when
                      #   this resume is built with Partial Tailor. Fully Tailor
                      #   runs Tailor Resume (Fully); Choose Suitable Resume
                      #   builds the resume as written.") and the file names,
                      #   with no Tailoring choice, because the mode is the
                      #   RUN's (`ResumeSettings.tailorMode` is gone, and a
                      #   stored one is read past) - and the read-only
                      #   KeywordsCard (components/profiles/): the job titles
                      #   and the skills and technologies the server read from
                      #   the resume, or "Keywords appear once the resume is
                      #   saved." for a new one. A row opens EntryEditor.tsx in
                      #   the column's place (the column stays mounted under
                      #   `hidden`); Done drops a blank entry; its bullets box
                      #   has Write with AI / Improve with AI (useWriteBullets
                      #   .ts: one AbortController, aborted on unmount, Undo
                      #   while the box still holds the answer), through
                      #   `resumesApi.writeBullets` and nothing else. The
                      #   first drag, move, add or remove turns a null
                      #   `draft.sectionOrder` (= follow the template, sent as
                      #   `[]`) into the displayed list. lib/sectionCatalogue.ts
                      #   is the catalogue mirror (the shared fields of the
                      #   backend's config/sectionCatalogue.ts plus the UI half:
                      #   icon, entryNoun, fields, rowTitle/rowMeta, aiKind)
                      #   and the order helpers, `import type` only, held to
                      #   the backend copy by test/frontendEditorHelpers
                      #   .test.js. parts.tsx keeps ChipList, AddInput,
                      #   SectionSwitch, the notes. ResumeDraftPreview frames the server's render in two
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
                      #   what the preview is sent, the template a draft or a
                      #   card is drawn with (`effectiveTemplateId`,
                      #   `drawnTemplate`), the sample-text notice and
                      #   placeholders, what
                      #   an unticked section keeps - are lib/resumeDraft.ts,
                      #   which imports types only so test/frontendHelpers,
                      #   frontendEditorHelpers and frontendTailoring.test.js
                      #   can load it (the last holds what it saves and
                      #   previews to the settings the server reads - no
                      #   `hardSkillOrdering`, no `coverLetterPromptId`, no
                      #   `tailorMode`). An
                      #   unticked Soft Skills / Strengths box shows only its
                      #   switch and "N kept"; nothing is deleted. The
                      #   switches' copy (SkillCards.tsx for Soft skills, the
                      #   Strengths card in EntrySection.tsx) says what a TAILORED
                      #   resume does with them: Soft Skills on prints the
                      #   posting's soft-skill group in that section (off, it
                      #   is the last group of Technical Skills), Strengths
                      #   prints the person's own, as typed.
  components/profiles/ # The Profiles pages: a profile is a PERSON and holds
                      #   that person's resumes, and every builder has the
                      #   pages on every subscription. They sit on the resume
                      #   desk: profiles.module.css (the tabs, the search, the
                      #   View switch, the list rows, the badges, the dialogs
                      #   and the keyword chips) works beside
                      #   resumePages.module.css, which keeps the page, the
                      #   cards, the ⋮ menu and the dashed tiles, and uses the
                      #   editor's tokens (`--ed-*`), restated under html.dark,
                      #   so nothing here needs a `dark:` variant; the dialogs
                      #   are portalled to <body>, so each carries the editor's
                      #   `.tokens` and font through Dialog's `className`.
                      #   THE DASHBOARD (app/admin/profiles/page.tsx, "My
                      #   Profiles"; Suspense around useSearchParams): a
                      #   welcome line (`describeHoldings`), a usage line
                      #   ("1 of 1 profiles used on the Default subscription")
                      #   counted from the page's OWN list of profiles
                      #   (`useProfileLimit`, in useResumeActions.tsx: the
                      #   session's `profilesUsed` goes stale the moment a
                      #   profile is deleted here, and would leave New profile
                      #   locked), the at-the-limit and over-the-limit notices
                      #   (an account over its limit keeps and uses everything
                      #   and cannot add another), Import (a resume PDF or JSON
                      #   file, each resume filed under its person; a JSON
                      #   import's notice names the profiles it made) and
                      #   Create New. Two tabs (role=tablist; the arrow, Home
                      #   and End keys): Profiles (N), a card per person
                      #   (ProfileCards.tsx: the
                      #   first page of its default resume, its name, "N
                      #   resumes", "Edited ... ago"; ⋮ Open, Rename, New
                      #   resume, Delete), and All resumes (M), a card per
                      #   resume (components/resume/ResumeCards.tsx, with the
                      #   profile's name as a link). The tab is the address,
                      #   `?tab=resumes`, written with `router.replace(href, {
                      #   scroll: false })`; anything else reads as Profiles.
                      #   Each tab has its SearchBox (type=search; a role=status
                      #   line, "1 of 2 profiles match.", only while something
                      #   is typed; Clear hands focus back to the input - a
                      #   profile matches by its name or by any of its resumes'
                      #   label or name, a resume by its label, its name or its
                      #   profile's name) and the one View: Grid | List
                      #   (ViewToggle, two aria-pressed buttons; `useViewMode`
                      #   reads localStorage `freeTailor.profiles.view` in a
                      #   lazy initialiser and writes it on every change,
                      #   guarded: a storage that is missing or throws reads
                      #   Grid). The dialogs are ProfileDialogs.tsx's, each a
                      #   kit Dialog mounted only while open: ProfileNameDialog
                      #   ("New profile", "Rename profile"), NewResumeDialog
                      #   ("New resume"), DeleteProfileDialog ("Delete {name}?"),
                      #   MoveResumesDialog ("Move {label}") and KeywordsDialog
                      #   ("Keywords"). Create New on Profiles names a person
                      #   (ProfileNameDialog) and opens that profile's page; on
                      #   All resumes it asks whose the resume is
                      #   (NewResumeDialog: the profiles, and "A new profile";
                      #   skipped when there is exactly one profile, a name
                      #   alone when there is none) and opens the chooser for
                      #   it. Only New profile is locked at the limit: the tile
                      #   and Create New (`data-new-tile="profile"`,
                      #   `data-locked-feature="more-profiles"`, "Needs <tier>",
                      #   pressable) and "A new profile" in the New resume and
                      #   Move dialogs; the New resume tile
                      #   (`data-new-tile="resume"`) never is.
                      #   A PROFILE'S PAGE
                      #   (app/admin/profiles/[profileId]/page.tsx): the way
                      #   back to My Profiles, the name with its Rename pencil,
                      #   "N resumes · Edited ...", the line "★ is the default
                      #   resume: Fully Tailor builds it. Choose Suitable
                      #   Resume and Partial Tailor pick, for each job, the
                      #   resume here whose keywords match the posting best.",
                      #   ⋮ Rename / Delete profile, New resume
                      #   (`newResumeHref(profile.id)`) and Import resume
                      #   (`useResumeImport(profile.id)`), the same Grid | List,
                      #   the default resume first with its "Default" badge
                      #   (`data-default-resume`), and a warning where the
                      #   chosen default is disabled ("{label} is disabled, so
                      #   Fully Tailor builds {other label} until it is
                      #   enabled.") or every resume is. Delete profile
                      #   (DeleteProfileDialog) says what it will do before the
                      #   press, in the owner's words (`deleteProfileWording`):
                      #   "You can't undo this. Every resume in this profile will be
                      #   deleted with it and can't be recovered.", the confirm
                      #   "Delete profile and its resumes" (a profile with no
                      #   resume: "This can't be undone." and "Delete
                      #   profile"); the dashboard then says "Deleted {name} and
                      #   its resumes." (flashNotice.ts keeps the sentence in
                      #   sessionStorage for the one navigation). A resume's ⋮
                      #   (`useResumeActions`, shared by All resumes and a
                      #   profile's page): Edit, Set as default (an enabled
                      #   resume that is not already the chosen default),
                      #   Duplicate (in the same profile and on the same
                      #   template; never locked), Move to another profile...
                      #   (MoveResumesDialog: a radio list and "A new profile",
                      #   which is made WITH the resume, all or nothing),
                      #   Keywords (KeywordsDialog; KeywordChips.tsx draws the
                      #   job titles and the skills and technologies, there and
                      #   in KeywordsCard.tsx, the editor's read-only card),
                      #   Download JSON, Disable / Enable and Delete (a
                      #   window.confirm). After
                      #   a card leaves the page - a resume deleted or moved
                      #   out, a profile deleted - focus goes to the next card,
                      #   else the previous, else the New tile (List view
                      #   has none: then the page's Create New,
                      #   `data-new-fallback`) (focusAfterRemoval.ts). A
                      #   change refused with a 404 or 409 (the resume or
                      #   profile is gone or changed in another tab) reads
                      #   both lists again (`isStaleRefusal`); a dashboard
                      #   whose FIRST read failed draws only the error and
                      #   Try again, never "0 profiles". lib/profileDashboard.ts
                      #   holds the decisions with no React in them and imports
                      #   TYPES ONLY, so backend/test loads it: the tabs
                      #   (`readDashboardTab`, `dashboardHref`), the view
                      #   (`VIEW_MODE_KEY`, `readViewMode`, `writeViewMode`),
                      #   the addresses (`isProfilesDeskRoute`, which
                      #   app/admin/layout.tsx asks instead of keeping a
                      #   pattern of its own, `profilePageHref`,
                      #   `newResumeHref`, `readProfileParam`), `resumeLabel`
                      #   (the server's `resumeLabelOf`: the headline unless it
                      #   is empty or 'Professional', else the name, else
                      #   'Untitled resume'), `sortProfiles` (newest edit
                      #   first, then id), the searches (`matchesQuery`,
                      #   `filterProfiles`, `filterResumes`) and the sentences
                      #   (`describeHoldings`, `describeMatches`,
                      #   `deleteProfileWording`, `keywordPreview`).
                      #   test/frontendProfiles.test.js runs them, and the
                      #   clients they sit on, against the server and the real
                      #   routes; test/e2e/profiles.js drives the pages.
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
                      #   BuyCreditsDialog uses ui/Dialog.tsx directly.
                      #   The administrators' queue is app/admin/payments/
                      #   RefundQueue.tsx, the `?tab=refunds` of Payments, where
                      #   every "New refund/payout request" notice links: a
                      #   payout row is marked Payout with its balance now, and
                      #   its Refunded is "Record payout" - an amount prefilled
                      #   with the smaller of what was asked and the balance now,
                      #   and a note, both checked by lib/reporterPay.ts's
                      #   `payoutProblem`, the one Admin -> Accounts uses.
  components/subscription/ # Settings -> Subscription and the LOCKS.
                      #   SubscriptionCards.tsx (a card per tier, side by side
                      #   - subscription.module.css's grid, tokens only, four,
                      #   two or one across by a container query on the
                      #   width the cards have, never three and one, which an
                      #   auto-fit grid drew on most laptop windows - with its
                      #   price, features and the one action: Subscribe,
                      #   Upgrade · $X, Switch at renewal, Keep, or the words
                      #   where there is none), SubscriptionStatus.tsx
                      #   ("Current subscription": where it came from, the
                      #   paid period's rows, Cancel and Keep). The page
                      #   (app/settings/subscription/page.tsx) asks before
                      #   buy, switch and keep (SpendConfirm kind
                      #   `subscription`; a purchase through `buyQuestion`,
                      #   which asks about an Upgrade · $0 the unused days
                      #   cover as nothing now and the price at its first
                      #   renewal - $0 now alone would not be asked), Cancel
                      #   in a kit Dialog of its own, and on 409
                      #   `charge-changed` reads the view again and says so.
                      #   What a change did is said in the section it was
                      #   asked from (a card's above the cards, Cancel's and
                      #   Keep's under them), scrolled to and focused. Every
                      #   word and button is lib/subscriptionDisplay.ts's
                      #   (`cardAction`, `buyQuestion`, `statusSummary`,
                      #   `changeMessage`, `cancelQuestion`, `billingLine` and
                      #   `overrideQuestion` for Admin -> Accounts), over
                      #   lib/subscriptionBilling.ts's client,
                      #   which sends back the amount shown as `chargeUsd`;
                      #   test/frontendSubscription.test.js runs both against
                      #   the real routes. LockedFeature.tsx is every lock:
                      #   `useLockedFeature` (its dialog, "Locked: <what>",
                      #   Go to subscription and Close), `LockButton`,
                      #   `ChoiceCard` (a `.tl-choice` radio card that may be
                      #   locked - the lock beside the label, never inside it,
                      #   `data-locked-choice` - and may carry a `hint`, muted
                      #   text under its label that never says which
                      #   subscription a thing needs; a card that is never
                      #   locked passes neither `lock` nor `onLocked`, as the
                      #   builder's three build-mode cards do),
                      #   `ProfileLimitLink` (after a 402 `profile-limit`).
                      #   The ONE LOCK LEFT is `more-profiles`
                      #   (`LockedFeatureId` has no other member): adding a
                      #   PROFILE past the tier's count - the dashboard's New
                      #   profile tile and Create New, and "A new profile" in
                      #   the Move and New resume dialogs. A run has no lock (it
                      #   builds one profile on every tier) and a resume is
                      #   never counted, so New resume, Duplicate and Import
                      #   are never drawn locked and no page is a locked panel
                      #   (`LockedPanel` is gone). The words are
                      #   lib/subscriptions.ts `describeLock('more-profiles',
                      #   account)` (with copies of
                      #   the tiers' names and caps, `SUBSCRIPTION_PROFILE_LIMITS`,
                      #   drift-tested in
                      #   frontendHelpers.test.js) - and, for what the SERVER
                      #   refused, `describeProfileLimitRefusal`, worded from
                      #   the refusal (a 402's `limit` names its tier), never
                      #   the session, which is behind
                      #   the server whenever a refusal reaches a page that
                      #   offered the thing. `hasSubscription` and
                      #   `subscriptionAtLeast` stay, held to the backend's, as
                      #   the guard a future tiered route or rail entry would
                      #   use; no page calls the first and no rail entry has
                      #   `needs`. The icon is IconLock, never
                      #   a "Premium" pill. SubscriptionStatus says a profile
                      #   is a person and holds any number of resumes.
  components/SpendConfirm.tsx # What is asked before anything spends credit,
                      #   with "Do not show again": `useSpendConfirm().ask({
                      #   kind, title, price }, start)` - skipped kind starts at
                      #   once; else priced, and asked when lib/spendConfirm.ts
                      #   `confirmNeeded` says (Generate Immediately always,
                      #   an order or a subscription only when it takes credit
                      #   or the cost is unknown); the amount, the balance after,
                      #   Proceed off when short (`spendFigures`). When the
                      #   cost cannot be worked out (a quote that failed is a
                      #   cost NOT KNOWN, never $0) it says "What this costs
                      #   could not be worked out just now. It is taken from
                      #   your credit at the price per resume of the builder
                      #   mode you chose." - a model has no price - and a
                      #   subscription's says only the first sentence. Nothing
                      #   starts for a page or dialog that unmounted while its
                      #   price was worked out (a `mounted` ref). Keys
                      #   `freeTailor.spendConfirm.{order,immediate,
                      #   subscription}.skip`, one per kind; the older
                      #   `freeTailor.immediateConfirm.skip` is never read.
                      #   Mounted only while open (the box starts unticked).
                      #   It replaced ImmediateRunConfirm, and keeps owner
                      #   decision B4's sentence (`IMMEDIATE_WARNING`).
  bid-assistant/      # the largest single feature directory here, and the only
                      #   JSX: its own App, components and stylesheet. Its
                      #   failures go through lib/apiBase.js's readError /
                      #   responseError, then messageWithDetail like the rest
  components/ui/      # The kit every page is built from: kit.tsx (Page,
                      #   PageHeader, Section, Card, Field, Notice, ErrorNotice,
                      #   Pill, EmptyState, Spinner), SettingSource.tsx (where
                      #   an admin setting's value came from, and its Reset to
                      #   default - lib/settingSources.ts decides the words),
                      #   MultiSelect.tsx (a box of several values: chips, then
                      #   an input that is the combobox over a multiselectable
                      #   listbox, creatable and split as told; Escape closes
                      #   the list and stops there - `nativeEvent.
                      #   stopImmediatePropagation`, because React's listener
                      #   and Dialog's share the document - never a dialog
                      #   around it; the active option, moved by the keyboard,
                      #   scrolled into the LIST's view (its scrollTop, never
                      #   scrollIntoView; never after the pointer moved it),
                      #   and one chosen from a filtered list still the active
                      #   one once the list is whole (`activeAfterChoice`); its
                      #   decisions lib/multiSelect.ts, its look
                      #   the .tl-multiselect* rules, with a dark input rule
                      #   that out-ranks the shim's, the box's dark border the
                      #   shim's --border-strong like the native boxes beside
                      #   it, and the active option outlined in --accent-ink
                      #   - the tint alone was 1.1:1 - and in Highlight under
                      #   forced colors)
                      #   and Dialog.tsx (the one
                      #   modal - its `className` is added to the panel, for a
                      #   page that draws its dialogs in its own look - portal,
                      #   Escape for the TOP dialog only, one
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
                      #   open with an h2, not a PageHeader. /admin/templates
                      #   is not a tab, and does open with a
                      #   PageHeader; the Profiles pages and the resume pages
                      #   draw their own desk and h1 (resumePages.module.css,
                      #   profiles.module.css), and the resume editor
                      #   its own bar, under an sr-only h1.
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
                      #   downloads, the release request, how a run ended - are
                      #   lib/immediateRun.ts, and the sheet panel's rows
                      #   (components/SheetsSourcePanel) lib/sheetRows.ts, both
                      #   run by test/immediateRunHelpers.test.js; sheetRows.ts
                      #   also holds the own sheet's LAYOUT (C:F, then G, H
                      #   and L) and the Analysis cell's states, which
                      #   test/frontendAnalysis.test.js holds to
                      #   JOB_SHEET_COLUMNS and parseAnalysisCell. A run builds
                      #   exactly ONE profile (a person) in ONE build mode, on
                      #   EVERY subscription: the page has no Single / Multiple
                      #   choice, no list or group of profiles and no lock on a
                      #   run. Building by hand and building from the sheet
                      #   share one `selectedProfileId` and one
                      #   `buildModeChoice`, drawn by a `ProfileSelector` (the
                      #   profiles that have an enabled resume, newest edit
                      #   first, "{name} (N resumes)"; `#manual-profile`,
                      #   `#sheets-profile`) and by components/builder/
                      #   BuildModeChoice.tsx - Choose Suitable Resume, Partial
                      #   Tailor and Fully Tailor as three `ChoiceCard`s that
                      #   are never locked (radios `manualBuildMode`,
                      #   `sheetsBuildMode`, value = the mode's id), each
                      #   saying what the mode does (lib/buildModes.ts
                      #   `BUILD_MODE_CHOICES`) and, once /resume/models has
                      #   answered, "Free." or "$0.02 a resume.". The page
                      #   starts on the administrator's Default profile (else
                      #   the first) and Default builder mode
                      #   (`startingProfileId`, `startingBuildMode`), and a line
                      #   under the cards says which resume a run builds
                      #   (`buildModeNote`, `[data-build-mode-note]`). A request
                      #   is `{ profileId, buildMode, jobs, ... }` with no
                      #   template: the server draws the chosen resume on its
                      #   own. A change of mode, profile or model drops the
                      #   preview, which was that mode's work. Every Generate
                      #   Immediately and every Order goes through ONE gate,
                      #   `confirmSpend` -> components/SpendConfirm.tsx's
                      #   `useSpendConfirm().ask`, priced by
                      #   lib/generationQueue.ts `estimateRun` (the quote of a
                      #   `quoteBody` - the profile, the mode, placeholder jobs,
                      #   the model and, finalising previews, their content AND
                      #   tokens as the submission carries them: content whose
                      #   token expired is charged at least the dearer tailoring
                      #   mode); the quote is exact, jobs x the mode's price,
                      #   so no line says "up to"; while it prices, the run
                      #   buttons wait (`runBusy`) and say "Checking the
                      #   price..." (the button, or CostLine's `pricing` beside
                      #   the sheet panel's); frontendSpendConfirm.test.js holds
                      #   every run handler to it, the page read CRLF or LF
                      #   alike. The cost line
                      #   is components/builder/CostLine.tsx and an order's
                      #   receipt (its poll and Cancel) components/orders/
                      #   OrderReceipt.tsx (`placedOrderFrom`), both moved out
                      #   for every page that orders - Find Jobs' Order
                      #   Immediately draws them, and ProfileSelector and
                      #   BuildModeChoice, too; the starting profile and mode,
                      #   what still blocks a run and the files are
                      #   lib/runChoices.ts (`startingProfileId`,
                      #   `profileBlocker`, `startingBuildMode`,
                      #   `buildModeNote`, `defaultRunFormat`; its one runtime
                      #   import is ./buildModes). With Auto-generate off,
                      #   Analyze & Preview asks the server to choose and draw
                      #   the resume as a run would for this posting
                      #   (`resumeApi.preview({ profileId, buildMode,
                      #   analysisId, ... })`; there is no preview-all and no
                      #   Multiple flow, and the v4.1 lib/builderPreviews.ts
                      #   that served it is gone) and keeps the answer as the
                      #   preview's choice (`previewChoice`: the resume, its
                      #   label, its `match`). Choose Suitable Resume shows the
                      #   chosen resume AS WRITTEN - no ATS pill, no Manual
                      #   Edits - and Generate Immediately sends its
                      #   `previewedResumeId` alone (the server refuses content
                      #   for that mode). Partial and Fully Tailor show the
                      #   tailored resume,
                      #   with the pill and Manual Edits, redraw it through
                      #   `{ resumeId, tailoredContent }` and finalise with
                      #   `previewedResumeId` and the content and token keyed
                      #   by that resume. The preview's note is "{resume
                      #   label} · {describeChoice(match)}" (lib/orders.ts;
                      #   `[data-preview-choice]`); a posting too short to
                      #   analyse is drawn as written in every mode, so with no
                      #   pill or Manual Edits either; and a 409
                      #   `preview-changed` shows the server's sentence and
                      #   drops the preview. Under the Model box Fully Tailor
                      #   says "Defaults come from {default resume label}, the
                      #   profile's default resume." and the other modes "Each
                      #   resume uses its own model; one chosen here applies to
                      #   this run only."; the progress line, the rows of the
                      #   finished resumes (ImmediateRunFiles) and a failed
                      #   download name the resume the run chose
                      #   (` · {resumeLabel}`, from `BatchTask.resumeLabel`).
                      #   A tailored preview's "Manual Edits (JSON)" box offers
                      #   only what an edit can change (lib/tailoredDraft.ts:
                      #   title, summary, each role's bullets, skillGroups -
                      #   the soft group
                      #   marked `soft: true` - and coverLetter), plus each
                      #   role's company, title and dates, which only say which
                      #   role the bullets are - the parse restores them from
                      #   the resume, and the dates are how its `closestStint`
                      #   tells two stints apart; no description, no place.
                      #   TAILORED_DRAFT_NOTE says so, and that the title
                      #   counts only without a headline. It sends
                      #   that back for the server to finish against the
                      #   resume; frontendTailoring.test.js holds the edit to
                      #   finish exactly as the whole content does. There is no
                      #   skill-confirm panel: nothing a tailoring prints is
                      #   checked against the library, so no answer carries a
                      #   list of skills to confirm (the resume editor's add
                      #   still goes through /skills/confirm).
  components/, lib/   # UI and the API client. Shared bits worth knowing before
                      #   writing another copy: lib/format.ts (one formatDate for
                      #   every page, and formatMoney / parseDollars /
                      #   toDollarInput for every amount - see "Money"),
                      #   lib/ledger.ts and lib/paymentDisplay.ts (how a ledger
                      #   row and a payment read), lib/sheet.ts (the spreadsheet range
                      #   parsers), lib/userMessage.ts (userMessage / messageWithDetail -
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
                      #   lib/buildModes.ts is a copy of the server's
                      #   config/buildModes.ts - `BUILD_MODES`, `isBuildMode`,
                      #   `BUILD_MODE_LABELS`, `BUILD_MODE_PRICE_SETTINGS` (the
                      #   setting each mode's price is served under) and
                      #   `BUILD_MODE_CHOICES` (the three mode cards' words,
                      #   which never name a subscription) - and imports
                      #   nothing; lib/settingSources.ts's
                      #   `MODE_PRICE_REQUEST_FIELDS` (setting -> the `...Usd`
                      #   name a save sends it under) is a copy of
                      #   `BUILD_MODE_PRICE_FIELDS`'s request names.
                      #   test/frontendHelpers.test.js and
                      #   frontendProfiles.test.js hold the first to the
                      #   server's; frontendSettings.test.js and
                      #   frontendMoney.test.js the second. lib/api.ts speaks
                      #   the server's shapes: `profilesApi` answers a
                      #   `ProfileSummary` (the resumes counted, never listed),
                      #   `resumesApi.create / uploadPdf / importJson` take
                      #   `{ profileId }` (sent as `?profileId=`) and
                      #   `resumeApi.preview` takes `{ profileId, buildMode }`
                      #   (it chooses a resume) or `{ resumeId,
                      #   tailoredContent }` (it draws held content again);
                      #   `TaskMatch` is the explanation an order item keeps,
                      #   and lib/orders.ts `describeChoice(match)` words it
                      #   once, for the order's page and the builder's
                      #   preview note.
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
**`'chain'` and `'coinbase'` stay in `PaymentProvider`** as display names
only, so their rows still read: no variable of theirs is read (the crypto
method's unavailable reason names Cryptomus's two alone), and refunding one
gets the one sentence that cannot be wrong about where it was taken (*Send the
funds back from wherever this payment was taken, then adjust the balance from
the accounts page.*). `chain_invoices`, `chain_cursors` and `chain_orphans` are
left in any database that has them, never read - the `CREATE TABLE`
statements are gone from `database/sqlite.ts`, the tables are not dropped.

All dynamic data lives in SQLite, except saved templates. `backend/static` is
never written, except `static/templates`, which also holds saved templates -
and its three kinds of default are read three different ways. The skill library is
copied into the database once, on first use, and read from there. A built-in
prompt is read from its file until an administrator edits it; from then on its
database row wins. **Built-in templates are read from `backend/static/templates`
on every request** and never copied: the database holds only an override row
per built-in (`template_overrides` - name, description, disabled; any other
key a row carries, an older build's `skillsLayouts` among them, is not read)
laid over the file, so editing a shipped template's JSON changes every install
at its next request.

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
are never written. An id is taken exactly as its file carries it - no folding
of case or `_`, no rename aliases - and a resume's `preferredTemplate` is
stored as given, trimmed, because the editor, the resume cards and the
template chooser compare ids as they are. A write that fails
throws `TemplateStoreError`, which the template routes answer with "Template
could not be saved." and a ref. The rows ac3df79 moved out of an older
database's `templates` table are left there, never read (the guard requires
that move's `templates_moved_to_files` record, complete). Saved files are not
gitignored, so they show in `git status` and can be committed to ship them.
Startup prints whether the directory is writable, and names any `.json` there
no id can have (not offered), under `Database:`.

## Profiles and their resumes

Owner decisions D11-D18 (v4.2, 2026-10-21). A profile is a PERSON and holds
that person's resumes; an account keeps several profiles, and every resume
sits in exactly one. The tree is written by `database/profileTree.ts`, by
`database/profileRepository.ts` (the people) and by
`database/resumeRepository.ts` (the resumes), and the rules that need no
database are `services/profileRules.ts`'s. A resume's place under its profile
is what "filed" means in this section - not "Where resumes are filed" below,
which is the folders a build's files go to.

**Three words.** A **profile** is a person: `Profile` and `ProfileSummary`
(types/profile.ts), the `profiles` table, `/api/profiles`. A **resume** is one
resume document: `Resume` (types/resume.ts), the `resumes` table,
`/api/resumes` (the builder's `/api/resume/*` is another router). The
**account** is the signed-in user's own settings: Settings -> Account, the
`users` table. The names of the cap keep the word "profile" because they mean
a person - `profileLimit`, `profilesUsed`, `ProfileLimitError` with the wire
code `profile-limit`, `orphanedProfiles` - and they count people now, where
build 4.1 counted resumes with them; the run's v4.1 names (`profileIds`, which
carried resumes) are gone: a run names ONE profile (see "Conventions from the
history").

**The tree** (D11). `Resume.profileId` is the one pointer: in the resume's
document, and mirrored to the column `resumes.profile_id` on every save (the
indexed-columns map in resumeRepository.ts, as `ownerId` is to `owner_id`). A
profile stores NO member list, so a resume cannot be in two profiles, a
deleted resume leaves nothing behind to clean, and an id that comes back (an
import keeps a free id; the Bid Assistant takes the client's) can never rejoin
somebody else's profile. A profile is `{ id, ownerId?, name, defaultResumeId?,
createdAt, updatedAt }` and is read ONLY through `toProfile(raw)` (the people's
`DocumentTable` revives through it), which keeps those keys and no others: a
v4.1 group's member list (`profileIds`) is never read and the profile's next
write drops it for good, and a blank name reads as 'Untitled Profile'.
**`profiles` has no `disabled` column and must never gain one**:
glossaryRename.ts tells it from build 4.1's table of resumes of the same name
by that column alone (see database/ above). `DocumentTable`'s indexed columns
may be null (an unfiled resume's `profile_id`), and every method of it takes an
optional connection (below). `resumes.profile_id` is in SCHEMA and in
ADDED_COLUMNS, never in the guard's frozen list; `idx_resumes_owner_profile`
(`owner_id, profile_id`) and `idx_profiles_owner` (`owner_id, created_at`) are
in INDEXES_AFTER_COLUMNS. Neither table had an index on the owner, so a
profile's resumes, an owner's profiles in age order, the count behind the
limit and the filing query would each be a scan; test/profileTree.test.js pins
that they seek on these.

**What /api/profiles answers** is a `ProfileSummary`: a profile with its
resumes COUNTED and never listed - `{ id, name, ownerId?, createdAt, updatedAt,
lastEditedAt, resumeCount, enabledResumeCount, defaultResumeId,
chosenDefaultResumeId }`. `ownerId` is there only on an administrator's
`?allOwners=true` list; `lastEditedAt` is the later of the profile's own
`updatedAt` and its newest resume's; `defaultResumeId` is the EFFECTIVE default
(null only for a profile with no resume) and `chosenDefaultResumeId` the stored
choice (null while none is stored), both under "The default resume" below. The
list is newest edit first, then id, read by `summarizeProfiles` with one
`GROUP BY profile_id` query for the counts and the newest edit and one for the
resumes behind the effective defaults - not a query per profile.

**Placement is the repository's, and a body never places** (D12). A NEW resume
is placed by `placeNewResume`, in the caller's transaction: (1) on the profile
the request names with `?profileId=`, which must be the caller's OWN - an
administrator's included - else 404 `profile-not-found` (a repeated or
non-text `?profileId=` is 400 `bad-profile-id`); (2) otherwise on the caller's
OLDEST profile (`created_at`, then id) whose name has the same person key
(below) as the resume's name; (3) otherwise on a new profile named for the
person. Only (3) makes a profile, so only (3) counts the limit: adding a
resume to a person who has a profile costs nothing, on any tier. A `profileId`
in a request body is read by nothing. `buildNewResume`, `buildUpdatedResume`
and `buildImportedResumes` do not carry it (an import file's entries and the
Bid Assistant's JSON editor included), so a create is placed by (1) to (3)
whatever the body says. PUT /api/resumes/:id is `saveEditedResume`: it reads
the row AGAIN inside its transaction and takes the owner and the profile from
it, so a Move that landed meanwhile is not undone and a body cannot hand a
resume to another profile or account; a row that is gone, or that another
account took by reusing the id, is 404 `resume-not-found` - never an upsert,
which a plain `DocumentTable.save` would be, recreating a resume deleted
meanwhile; and a stored resume that was never filed is filed first. The Bid
Assistant's whole-record edit goes through the raw writer (below), which keeps
the stored placement.

**One transaction, one connection.** Every write to the tree - `createResumes`,
`saveEditedResume`, `deleteResume`, the raw writers, `createProfileFor`,
`updateProfileFor`, `moveResumesIntoProfile`, `deleteProfileFor` and filing -
is ONE IMMEDIATE transaction on ONE connection (`inTreeTransaction`:
`db.inTransaction ? fn(db) : db.transaction(() => fn(db)).immediate()`;
nothing inside awaits, and a nested call joins the open one). The write lock
is taken before anything is read, so a decision made from a read - the profile
limit, "is this id free", "which profile is this person's" - is still true
when the write lands, across processes as within one. Every helper,
`DocumentTable` included, runs on the connection the transaction holds: a
statement sent through a second connection from inside it waits out the 5 s
busy timeout and fails with SQLITE_BUSY (a test that reloads database/sqlite
leaves an older module holding an older connection). A read for display
(`summarizeProfiles`) needs no transaction.

**Creates.** `createResumes(account, built[], { profileId? })` is EVERY create -
POST /api/resumes, /api/resumes/import and /api/resumes/upload, and the Bid
Assistant's - and does, in one transaction: file the account's old unfiled
resumes (so the limit is counted against the profiles they make); check every
id is free (409 `resume-id-taken`, never an overwrite; two entries of one
batch naming one id count) and give a requested id of `new` - the chooser's
address, /admin/resumes/new - a fresh uuid; place each resume (a later entry of
one batch sees the profile made for an earlier one, so two resumes of one
person share one new profile); adopt it as its profile's default when that has
none; and save it, owned by the account. A refusal anywhere writes nothing: no
resume and no new profile. `createResumesWithProfiles` is the same and also
answers the profiles it made, for the import's answer. The raw writers
`saveResume` / `saveResumes` (tests, seeding, and the Bid Assistant's
whole-record edit) place a NEW row at once - on the `profileId` it carries when
that is a profile of the same owner, else by (2) and (3) - and never count the
limit, as filing does not; an existing row keeps its stored placement, for as
long as that is still a profile of its owner.

**The person key** (services/profileRules.ts). `personKey(name)` is the key of
the name a profile would be GIVEN (`profileNameForPerson`, below): the name in
Unicode NFC, trimmed, every run of whitespace one space, cut to
MAX_PROFILE_NAME_LENGTH, lower-cased - the cut is part of the key because a
profile stores the CUT name, and a key of a longer resume name could never match
it (a 150-character name made a new profile for every resume of that person, and
a 402 on a Default account). So
'jane  DOE ' and 'Jane Doe' are one person; a blank or non-text name has the
key of 'Untitled Profile', so resumes nobody named share ONE profile of that
name. Placement compares it with each profile's CURRENT name, so renaming a
profile changes whose resumes join it (an old group is a profile with a name,
and a resume named for it joins it). `profileNameForPerson(name)` is the name
a profile made for a person gets: the tidied name cut to MAX_PROFILE_NAME_LENGTH
(100) characters as a person counts them (an emoji is one), or 'Untitled
Profile'. `readProfileName` is for a name somebody TYPES: blank is 400
`profile-name-required`, over 100 characters 400 `profile-name-too-long` -
never cut quietly, since a name the person did not choose would be a surprise
on a card.

**The limit counts people** (D15; database/profileLimit.ts). The tier's
`profileLimit` (Default 1, Premium 5, Premium+ 25, Premium Max none) caps how
many PROFILES an account keeps; resumes are unlimited in every profile on every
tier and are never counted. `countProfilesForOwner(ownerId, db?)` counts the
owner's rows in `profiles` - an empty profile counts, or the cap would be free
to dodge. `assertCanAddProfile(account, db, adding = 1, { forPerson? })` is
called INSIDE the transaction of every write that makes a profile, on that
transaction's connection, and for nothing else: `POST /api/profiles` (with or
without `resumeIds`) and a resume create whose placement reaches (3). So two
creates racing at the limit cannot both pass (one wins), and an import is all
or nothing: the entry that would pass the limit refuses the file, and no
resume and no profile is written. Administrators are exempt. Over the limit is
402 `profile-limit` with `limit` beside the sentence, in two forms. Making a
profile: *The {Default} subscription allows {1 profile} and this account has
{1}. Delete one, or move up to a higher subscription on the Subscription
page.* A resume for a person who has no profile yet, with no `?profileId=`:
*This resume is for {Bob Lee}, who has no profile yet, and the {Default}
subscription allows {1 profile} - this account has {1}. Add it from one of your
profiles, or move up to a higher subscription on the Subscription page.* (the
braces mark what is filled in: the tier's label, "N profile(s)", the count and
the person's name). `profilesUsed` on /auth/me and Admin -> Accounts is the
same count of FILED profiles. Old resumes are filed lazily (below), so the
count is only as complete as the filing: `describeAccount` (/auth/me, and the
sign-in answer) files the account's own resumes first, so the session never
understates the limit; Admin -> Accounts' list does NOT (a list read should not
write other accounts' data), so an upgraded account shows fewer there until its
owner next opens the app - and a page deciding an "at the limit" lock should
read the session's `profilesUsed` or GET /api/profiles, never the admin list.
Deleting an account (DELETE /api/admin/accounts/:id) files the target's
resumes first, then leaves its
profiles and resumes where they are and answers `orphanedProfiles` and
`orphanedResumes`, with the note *{R resume(s)} in {P profile(s)} belonged to
that account and still exist. They are visible to administrators only until
they are reassigned or deleted.* when there are any.

**An account over its limit keeps everything.** Old resumes filed by their
person's name (filing ignores the limit), or a tier lowered by an
administrator, can leave an account with more profiles than its tier allows:
it keeps and uses all of them - adds, edits, moves and deletes among them - and
cannot make another. Taking somebody's work away because a dropdown changed
would be the wrong way round.

**Tier copy** (config/accountSubscriptions.ts; test/subscriptionBilling.test.js,
test/subscriptionRoutes.test.js and test/profileTree.test.js pin it). Each
tier states its profile count and that a profile holds any number of resumes.
Default: *One profile, with any number of resumes. Everything else in the app
is included.*, features '1 profile', 'Any number of resumes in each',
'Everything else in the app'. Premium: *Up to five profiles, each with any
number of resumes.*, 'Up to 5 profiles', 'Any number of resumes in each'.
Premium+: *Up to twenty-five profiles.*, 'Up to 25 profiles', 'Everything in
Premium'. Premium Max: *Unlimited profiles.*, 'Unlimited profiles',
'Everything in Premium'. No tier names a group or a build for several
profiles; `features` are words, never switches.

**The default resume** (D13). `Profile.defaultResumeId` is the resume a run
builds from in Fully Tailor mode, and the one a tie between resumes goes to
(see "Builder modes and the suitable resume": a run reads the EFFECTIVE
default, below). It is not the app settings' `defaultProfileId`, which is the
administrator's choice of the profile the builder starts on. The
FIRST resume in becomes it (`adoptAsDefaultIfNone`, run in the placing
transaction before the resume is written: a profile with no valid default -
none stored, or one that is no longer one of its resumes - takes the joiner).
When the default LEAVES, deleted or moved to another profile, it is re-pointed
to the OLDEST ENABLED resume left, else the oldest, else the profile stores none
(`repointDefaultAfterLeaving`, run after the resumes have gone; "oldest" is
`created_at`, an unreadable date last, ties to the lower id); a profile that
receives moved resumes and has no valid default gets one the same way
(`ensureDefault`). DISABLING the default writes NOTHING: the choice is kept,
and enabling the resume brings it back. A consumer reads the EFFECTIVE default,
`effectiveDefaultResumeId(chosen, members)`: the chosen one while it is an
ENABLED resume of the profile, else the oldest enabled, else the oldest - even
when every resume is disabled, so a reader that must build an enabled resume
checks `disabled` itself (`enabledResumeCount` says whether there is one; a
run's `resolveRunTarget` refuses a profile with none before it looks at the
default) - and null only for a profile with no resume. `PUT /api/profiles/:id {
defaultResumeId }` must name an ENABLED resume of that profile: one that is not
its own, or none, is 400 `default-not-member`; a disabled one is 409
`default-disabled`.

**Move.** `POST /api/profiles/:id/move { resumeIds }` moves resumes into a
profile, and `POST /api/profiles { name, resumeIds }` makes a profile
(counting the limit) and moves them in, in the same transaction. ALL OR
NOTHING: a resume that is not there, or that the viewer may not see, is 404
`resume-not-found` and none moves (an administrator sees any); a resume whose
owner is not the profile's owner is 409 `profile-owner-mismatch`, which only an
administrator can reach; an empty list is 400 `nothing-to-move`. The list is
read as distinct ids in order, anything that is not text left out, and a
resume already in the target is not counted as moved. A moved resume keeps its
`updatedAt` and everything else of its document but `profileId` (which
`writePlacement` sets with the column): moving is not editing it, and lists,
thumbnails and the order a run builds in all key on that time. The profile each
resume came from re-points its default when the default left, and the target
takes one if it had none. The answer is `{ moved, profiles }`: the target and
every profile a resume came from, counted after the move.

**Delete** (D14). `DELETE /api/profiles/:id` deletes the profile, EVERY resume
in it and those resumes' Bid Assistant answers (`deleteAnswersFor`), in ONE
IMMEDIATE transaction, and answers `{ deleted: true, deletedResumes }`. There
is no count to send and no 409 for a profile that still holds resumes - the
page warns, and "all the resumes in the profile" is the rule - so a resume
added after the person was warned goes too, and an empty profile deletes. An
administrator reaches any profile by id; anyone else, only their own. A queued
build of a deleted resume fails as for any deleted resume (`ResumeGoneError`,
*This resume was deleted before it could be built.*, 410, not retried) and the
queue's `taskFinished` hook refunds the price it was charged
(test/buildModes.test.js runs it). One resume's
delete (`DELETE /api/resumes/:id`, `deleteResume`) takes that resume's answers
with it and re-points its profile's default.

**The routes.** `/api/profiles` is `requireUser` and nothing more: every
builder, on every subscription, and an administrator reaches any profile by id
(a reporter is refused as everywhere, 403 `role-not-allowed`). A router-level
step files the viewer's own old resumes before any route runs, so the first
read of an account that still has some WRITES, once (lazy filing, below).
Every refusal is a `PublicError` - a sentence written for anybody, with a code
a page can branch on - sent through `sendPublicError`, so the body is
`{ error, code, ...extra }`.

| Route | Takes | Answers |
|---|---|---|
| GET `/api/profiles` | `?allOwners=true` (an administrator's; ignored for anyone else) | 200 `ProfileSummary[]`: the caller's own, or every account's with `ownerId` |
| GET `/api/profiles/:id` | | 200 `ProfileSummary`; 404 `profile-not-found` |
| POST `/api/profiles` | `{ name?, resumeIds? }` and no other key | 201 `ProfileSummary`; counts the limit; a blank or absent name makes 'Untitled Profile'; the listed resumes are moved in, all or nothing |
| PUT `/api/profiles/:id` | `{ name?, defaultResumeId? }` | 200 `ProfileSummary` |
| POST `/api/profiles/:id/move` | `{ resumeIds }` | 200 `{ moved, profiles }`, `profiles` a `ProfileSummary[]` |
| DELETE `/api/profiles/:id` | | 200 `{ deleted: true, deletedResumes }` |

The resumes' routes (`/api/resumes`) change thus. POST `/`, `/import` and
`/upload` take `?profileId=`: `/upload` checks it BEFORE the model is asked (a
profile that is not the caller's is 404 and nothing is extracted) as well as at
the save, and `/import` before it reads the file. An import answers 201
`{ resumes, imported, keptIds, profileIds, createdProfiles }` - `profileIds`
the distinct profiles in file order, `createdProfiles` an array of
`{ id, name }` for the ones it made - and without a `?profileId=` files each
entry by its person, in file order. GET `/` and GET `/:id` file the viewer's
old resumes first, and every resume in every answer carries its `profileId`.
PUT `/:id` is `saveEditedResume` and DELETE `/:id` is `deleteResume`.

Refusals, by status and code:

| Status and code | When | Sentence |
|---|---|---|
| 402 `profile-limit` + `limit` | a profile would pass the tier's count | the two above |
| 404 `profile-not-found` | no such profile, or (for anyone but an administrator) not the caller's; a `?profileId=` that is not the caller's own, an administrator's too | *That profile was not found. It may have been deleted; reload the page.* |
| 404 `resume-not-found` | a resume to move that is not there or not the viewer's; an edit whose row is gone or was taken by another account | *One of those resumes was not found. It may have been deleted; reload the page.* |
| 400 `bad-profile-id` | a repeated or non-text `?profileId=` | *Name one profile for the resume.* |
| 400 `nothing-to-move` | no resume listed to move, or a `resumeIds` that is not a list | *Choose the resumes to move.* |
| 400 `use-move` | a PUT naming `resumeIds` | *A profile's resumes are not changed here: move them with Move.* |
| 400 `nothing-to-change` | a PUT naming neither a name nor a default resume | *There is nothing to change: send a name or a default resume.* |
| 400 `profile-name-required`, `profile-name-too-long` | a name typed for a profile (a PUT, or a POST with a non-blank one) | *Give the profile a name.* / *A profile name can be at most 100 characters.* |
| 400 `default-not-member` | a default that is not one of the profile's resumes | *The default resume must be one of this profile's resumes.* |
| 400 `stale-page` | a POST /api/profiles with any other key | *This page is out of date; reload it before saving.* |
| 409 `default-disabled` | a default that is disabled | *That resume is disabled, so it cannot be the default. Enable it first.* |
| 409 `profile-owner-mismatch` | a move into a profile of another account (only an administrator can ask) | *A resume can only move to a profile of the account it belongs to.* |
| 409 `resume-id-taken` | a create naming an id another resume holds, checked inside the transaction (the Bid Assistant checks first, in its own words) | *A resume with this id already exists.* |

**Stale pages** (D27). Until v4.2 POST /api/profiles took a RESUME's body, and
a stale editor tab - or a script - still sends one; read as a profile it would
quietly make a person out of a resume, and count the limit. So the route takes
`{ name?, resumeIds? }` and nothing else: any other key, or a body that is not
an object, is 400 `stale-page`. PUT and DELETE need no such check: a resume's
id names no profile, so they are 404 `profile-not-found`, and a PUT naming
`resumeIds` (a v4.1 Groups page's save) is 400 `use-move`.

**Lazy filing, instead of a data migration** (D17; owner decision: no
migration). The structural step only renames and LATEST_SCHEMA_VERSION stays
10, so a database from v4.1 opens with every resume's `profile_id` NULL and its
old groups as profiles under their names. `fileUnfiledResumes(db, ownerKey)`
files an owner's resumes that sit under no valid profile - none, one that is
gone, or one of another account (`UNFILED_RESUMES_SQL`: `resumes r LEFT JOIN
profiles p ON p.id = r.profile_id AND p.owner_id = r.owner_id WHERE r.owner_id
= ? AND p.id IS NULL AND json_valid(r.data) ORDER BY r.created_at, r.id`) - oldest first, by the
placement rule's (2) and (3), so a profile made earlier in the pass is seen by
the later resumes, one person's resumes share one profile, and the oldest
becomes its default ("the first resume in is the default"). It IGNORES the
limit (an account with old resumes of three people on Default ends with three
profiles, and cannot make a fourth) and writes the document's `profileId` and
the column and NOTHING else: `updated_at` and the document's `updatedAt` do not
move, because lists, thumbnails and the order a run builds in key on them, and
a profile it makes takes the dates of the resume it was made for, so the
dashboard does not show every old person as edited just now. With nothing to
file the check is TWO reads and no write lock: `HAS_UNFILED_RESUME_SQL`, a true
index seek (`owner_id = ? AND profile_id IS NULL` on
`idx_resumes_owner_profile`, first row enough), and, only when that finds
nothing, `HAS_DANGLING_RESUME_SQL`, which is NOT a seek: it walks the owner's
resumes in that index and probes `profiles` by primary key for each, to catch a
pointer to no profile (only a hand edit makes one - deleting a profile deletes
its resumes - so it is a safety net, and O(the owner's resumes) on every
profiles route). With something, the list is read again under the lock, since
another process may have filed it. A row whose `data` is not JSON (`json_valid`
leaves it out of all three statements, so it never keeps the check true for its
owner) or that has no owner is left alone. It files the VIEWER's resumes
only, when they are READ: in every /api/profiles route (router-level), in GET
/api/resumes and GET /api/resumes/:id, in /auth/me's `describeAccount`, inside
every create, profile create and move (before the limit is counted, so the limit
sees the profiles filing makes), and on an edit of a stored resume that was
never filed - the Bid Assistant's whole-record PUT included
(`resumeRepository` `saveRawIn` files the owner's unfiled resumes by their
STORED names before the body's name can place the row, so a rename in the body
never splits one person across two profiles). Another
account's resumes wait for their own read, and an administrator's
`?allOwners=true` list can still show them with no `profileId`. An old group is
a profile like any other and its member list is never read, so resumes are
filed by NAME and not by the group they were in: a resume named "Zed Zee" joins
an old group called "Zed ZEE" (the same person key), and nothing is deleted.

**Not carried over.** An old group's member list, and a resume's own
Partial/Fully choice: Partial or Fully Tailor is the RUN's now (see "Builder
modes and the suitable resume"), `ResumeSettings.tailorMode` and
`getResumeTailorMode` are gone, and a resume stored with a `tailorMode` is read
past and loses it at its next save.

**No template rule** (D16). Any resume may use any template:
`resolveTemplateForResume` takes the requested template, else the resume's
own `preferredTemplate`, else `default`, and no server code ever refused a
template another resume already uses - the profile tree adds none. The pages of
v4.1 did enforce a rule of their own (a template another resume used was not
offered, and Duplicate dropped the template); it is gone from them too: the
editor's picker and the chooser's Use this template offer every enabled
template, and Duplicate keeps the template (see components/resume/ above).

**The Bid Assistant** (D18) keeps every word, path, field and table, and one
call of it changed: its create. It called `assertCanAddProfile(viewer)` and
then a raw save, which under a limit on people would refuse a third resume of
one person as if it were a new person; it now calls
`resumeRepository.createResumes(viewer, [built])`, so one limit is honoured by
both doors into the table. Its whole-record PUT stays on the raw `saveResume`
and its delete on `deleteResume`. Deleting a PROFILE takes its resumes' answers
with it in the same transaction, in plain SQL (`deleteAnswersFor`):
bidAssistant/database.js opens its own connection as it loads and creates its
tables then, so the answers table exists only once it has, and the orphans an
earlier build left are swept when it loads.

**Tests.** test/profileTree.test.js holds all of the above over the real
routers (see test/ above). A test that needs a tree and is not about how it
grows seeds one with `seedProfileWithResumes(owner, name, inputs)` in
test/helpers.js, which goes round the routes and the limit on purpose: a seed
is not a request, so a Default account can be given three people to prove what
it may then do.

**Where v4.2 stands.** It is built, backend and pages: the tree (above), the
builder modes (see "Builder modes and the suitable resume") and the pages that
speak them - the Profiles dashboard and a profile's page, the template chooser
and the resume editor, Build Resumes, Find Jobs' Order Immediately, the
receipts and the order pages, Admin -> Settings and Admin -> Models (see the
layout above). Nothing of the old multi-profile builder is left in
frontend/src: no page sends a `profileIds` list or calls the preview-all
route, no page draws a price on a model, reads a retired setting, offers a
per-resume Partial/Fully choice or limits a resume to a template another
resume uses, and the resume pages count nothing against `profileLimit` (only a
new PROFILE is counted, and locked at the limit). Download JSON writes the
resume without the derived `matchKeywords` and the `profileId` it is filed
under, a file Import takes back. Every frontend copy of a server table is held
to it by a drift test, and none is red on purpose any more.

## Resumes, templates and the section switches

A resume's choices are three fields of `ResumeSettings`:
`technicalSkillsLayout` (`'categorized' | 'flat'`, shown as **Grouped** /
**Plain**, absent = categorized) and the booleans `includeSoftSkills` and
`includeStrengths`, absent = false - which is what every resume rendered before
they existed, so they needed no migration. Read them with `resumeDocument`'s
getters (`getResumeSections` for all three); a save keeps a stored value
when the payload omits it, and only a boolean decides. `Resume.softSkills` is
the person's own list (trimmed, case-insensitively unique, 50 x 100 chars).

**The render gate** is `applySkillsLimit` in `generators/pdfGenerator.ts`: every
path - the live preview, the PDF, the DOCX, the queue, the gallery - empties a
switched-off section there, whatever content it was handed, because batch and
queued content can arrive from the client without being re-parsed. It also
decides the Technical Skills block, and NOTHING on any path pads it from the
skill library or reorders it by library priority (`padSkillCategories`, the
five-by-five fill and the gate that dropped `CI/CD` are gone); only (2) and (3)
below still file and filter by it. In order: (1)
tailored content's `skillGroups` (the model's block; `services/skillGroups.ts`
is the one reader, shared with the parse: `sanitizeSkillGroups` - shape only,
12 groups x 40 skills - `findSoftSkillGroup`: a `soft: true` group, else the
one headed `softSkillGroupHeading`, else the LAST group only under one of
`SOFT_SKILL_GROUP_HEADINGS`, never just "the last" - and `flattenSkillGroups`):
Grouped prints them verbatim, Plain as one headless list in the same order
with case-insensitive repeats removed, and the soft-skill group goes to the
Soft Skills section while that switch is on as the TEMPLATE leaves it (so on
burgundy-rule, navy-rule, charcoal-sidebar and ink-ledger it stays in the
block) and stays in the block, under its heading, while it is off; a block
left empty is the resume's own skills; (2) older content with only
`hardSkills` (or `skills`), unpadded: Plain that list, unfiltered, in its
order; Grouped under the author's headings when the resume has any
(`buildAuthoredSkillCategories`: every skill, the author's heading order, a
skill they never placed under the library's heading at the end), else
regrouped under the library's headings in `SKILL_CATEGORY_ORDER`,
library-known skills only (`groupClaimedSkills`); (3) otherwise the resume's
own (`ownSkillCategories`), unpadded: Plain the library-known skills in the
person's order, in the library's spelling (`normalizeLibraryHardSkills`);
Grouped the author's grouping as typed, else `groupClaimedSkills` - the
library's headings in their order, the person's order under each,
library-known skills only. With no soft group routed the Soft Skills section
is the content's `softSkills`, else the resume's own. Strengths are ALWAYS
the resume's own (the tailoring prompt writes none; a content `strengths`
is never printed). `prepareResumeRenderData`'s tailored branch prints the
title as composed (`tailoredContent.title`, else the resume's headline, both
through `sanitizeTitleForATS`, which keeps letters, digits and `| ( ) / , . &
+ # · -` and turns any other symbol into a space), blanks every role's
`description` and keeps at most 8 bullets (`MAX_TAILORED_BULLETS`, the
backstop for content the parse never saw). test/tailoredRender.test.js holds
all of it in every built-in, both layouts, both switch states, and the DOCX;
test/skillGroups.test.js the module. At compile time
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
rewritten. EVERY template prints BOTH layouts, and the compile cache is keyed
on the markup plus the choices, so each compiles to two variants that differ
only in Technical Skills. `categorized` rewrites the skills markup into one
line per group (`rewritePerItemSkillLoops`): the box per skill (`default`,
`azure-stack`, the manual builder), the item per skill (fourteen built-ins),
and a JOINED line - a `p|div|li|span|td` holding nothing but an optional bold
label and `{{join hardSkills "sep"}}` (`JOINED_SKILLS_LINE`; the owner's
uploaded `ats-*` templates, which printed Grouped as one run-on paragraph) -
a `p`, `div` or `li` repeated per group, a `span` or `td` kept whole with the
groups inside it, `<br>` between them (`JOINED_LINE_BLOCKS`: copies of a span
ran their groups together, copies of a td added table columns);
`{{#if category}}<strong>{{category}}:</strong> {{/if}}` in the label's place,
the separator kept; a join in an attribute, beside other text or over
anything but `hardSkills` is left alone. A span loop over the
lines (`{{#unless @last}} • {{/unless}}`) is not rewritten:
`enforceSkillCategoryLineBreaks` turns its lines into heading blocks after
the render, its separator included. `flat` instead runs the PLAIN NET
(generators/plainSkillsMarkup.ts `fitPlainSkillGroups`): the element a
`{{#each skillCategories}}` loop sits directly in, and which holds nothing
else (only whitespace and `{{#if ...}}` openers before the loop; after its own
`{{/each}}` - sectionLocator's `sectionLoops` finds it - only whitespace, one
`{{/if}}` per opener and the element's closing tag; never a void element or
html/head/body), gets `data-plain-skills`,
and one `<style id="plain-skills-style">` goes in before `</head>` (else right
after a leading doctype, else first - `insertStyleOnce`) making each child of
it span the row: `grid-column:1/-1`, `column-span:all`, no float, width auto,
`height:auto`, `min-height:0`, all `!important` - which beats a child's own
inline style, so a holder with a divider, a badge or a photo after the loop
once took their sizes in Plain; such an element is the template's column, and
is left as written. Flat reaches such a design as
ONE headless group, which sat in one third-width cell of Burgundy Rule's and
Navy Rule's grids; those two also carry a rule of their own in `cssContent`,
`.skill-category:not(:has(.skill-category-title)) { grid-column: 1 / -1;
min-height: 0; }`, so their Plain row does not depend on the net finding their
loop (measured in Chrome: either alone spans the row; neither left the old
228px cell).
Charcoal Sidebar's loop follows a closing tag, so it is not marked (its
sidebar needs nothing). test/templateLayouts.test.js and
test/skillsLayoutRender.test.js hold all of it, and test/e2e/skills-layouts.js
lays every template out in a browser in both layouts and drives the two
Grouped / Plain switches.
Two guards run on every template's markup, built-in or uploaded, last:
`guardEmptyCategoryHeadings` (the flat layout's headless group) and
`guardEmptyDescriptions` - any element holding only `{{description}}` is
wrapped in `{{#if description}}`, because every built-in kept an empty,
margined wrapper for a tailored role's blank description. It takes an inner
`{{#if description}}{{description}}{{/if}}` whole or not at all (a block that
opens inside the element and closes outside it is left as written), and a
result that would stop markup that parsed from parsing is dropped for the
markup as it was - every rung of `compilableMarkup` runs it, so its fallbacks
could not rescue a bad cut (test/tailoredRender.test.js). After the compile,
`enforceSkillCategoryLineBreaks` turns a "Heading: a, b" line into a heading
block for the headings this render actually has (`skillCategories`, escaped),
not a fixed list of the library's. The DOCX draws its own sections from the
gated lists, so it never needed the finder; it prints no paragraph for an
empty description either.

**The template decides the switches too.** A switch that the generation's
template has no section for counts as OFF everywhere: read the resume through
`resumeForTemplate(resume, template)` (`resumeDocument`), which every render
entry point does (`generateResumePDF`, `generatePreviewHTML`,
`generateResumeDraftPreviewHTML`, and `generateResumeDOCX`, which takes the
template for exactly this) and every tailoring caller does before
`tailorResume` / `parseTailoredResumeContent` / `finaliseHeldContent`
(`/resume/preview` - which resolves the chosen resume's template before
tailoring - and `runResumeTask`), and the gallery does too. A new output or
tailoring path that skips it prints a section the PDF does not, or routes the
model's soft-skill group to a Soft Skills section the template does not have,
where it never prints.

**Every section is reorderable, and nine more kinds exist.**
`config/sectionCatalogue.ts` is THE catalogue (`SECTION_KINDS`: fifteen kinds
in canonical order - the classic six in the DOCX's fixed order `summary,
strengths, skills, softSkills, experience, education`, then `certifications,
projects, volunteering, awards, publications, courses, languages, interests,
references`; `DEFAULT_SECTION_KINDS` = the classic six + certifications, the
cards every resume shows; a custom section is `custom:<key>`, the key
`[a-z0-9-]{1,40}`, client-minted) and the ONE place the order's semantics live
(`presenceOf`, `cleanSectionOrder`, `sectionSortKey`,
`effectiveSectionOrder(stored, native, presence)`); the frontend keeps a copy
(frontend/src/lib/sectionCatalogue.ts) that test/frontendEditorHelpers.test.js
runs beside it. The new kinds are lists on the resume (`projects`,
`languages`, `awards`, `publications`, `volunteering`, `courses`, `interests`,
`references`, `customSections`; types/resume.ts), normalised like every other
list (omitted or non-array keeps, `[]` clears, blank entries dropped, 50 per
list, 10 custom sections) with no switch: a kind prints when it has an entry.
`Resume.sectionOrder` is the person's order and the record of added sections:
ABSENT means the template's own order (every older resume) and the normaliser
NEVER fills it in; omitted keeps it, re-cleaned against the custom sections
just saved; `[]` clears it to absent; a list is stored as its valid refs, as
given, nothing appended (a listed kind with no entries is an added, empty
section). It is excluded from the tailoring cache's `resumeFingerprint` and
is not in `profileJson`. The PDF honours it at COMPILE time
(`normalizeTemplateSkillsSections`: expand the macro -> strip/guard the two
switched sections -> `reorderTemplateSections` only when an order is stored ->
the skills rewrites (Grouped) or the Plain net (Plain) -> the baseline
`<style id="xs-style">` in the head):
`generators/sectionLocator.ts` finds every section (marker class
`section-<kind>` - every built-in carries them now, default and
charcoal-sidebar were given theirs - then `data-section`, then the heading
heuristic the switches always used), groups them by the element they sit in
(`parentKeyOf`: a section never leaves its template's column), and refills
each group's slots sorted by `sectionSortKey` (listed: its place; unlisted:
after the listed ones in the template's order); a result that would not parse
is dropped for the template's own order, warned once, and an unfound kind is
warned once per template and kind - never a failed render. The compile cache
key carries the order and the custom keys (LRU 128). The nine kinds print
through ONE macro line per template, `{{> extra-sections sectionClass=...}}`,
which `generators/extraSectionsMarkup.ts` expands BEFORE Handlebars into one
guarded block per kind the template does not name itself (the owner's
uploaded `ats-*` templates loop over `certifications`; never printed twice)
and one per custom section (`{{#with (lookup @root.customSectionsByKey
"<key>")}}`), each marked like a built-in's section so the reorder can move
it; every built-in carries the line once, in its main column after Education
(the manual builder too); an uploaded template prints the kinds nowhere until
it carries it. `services/extraSections.ts` prepares the lists (dates, a
link's http(s) href) under the fields' own names, spread after `...resume`
by `prepareResumeRenderData`. Two more template fields are derived on every
read and stripped before any write, like `supportsSoftSkills`:
`printsSections` and `nativeSectionOrder` (`services/templateImport.ts`,
memoised by markup) - the second is what the editor shows a resume with no
stored order in, by the same locator the PDF moves with. The DOCX iterates
`effectiveSectionOrder(stored, canonical, presence)` and prints a filled kind
whether or not the PDF's template has the macro. test/sectionOrder.test.js
holds all of it over every built-in; test/sectionCatalogue.test.js the
catalogue and the normalisers.

Every template prints both layouts, so there is NO layout list: `Template`
has no `skillsLayouts`, the built-ins' JSON states none, and one an older
build wrote into a saved file or an override row is not read
(`normalizeTemplateRecord` builds a record from the known fields, and the next
write of a saved file drops it). `PATCH /api/templates/:id` takes `{ name?,
description?, disabled? }` and answers a body naming none of them 400 *There
is nothing to change: send a name, a description or disabled.* - a stale
page's `{ skillsLayouts }` would otherwise bump `updatedAt` (the gallery's
order) and rewrite a saved file for nothing. `services/templateChoice.ts`'s
`resolveTemplateForResume(resume: Pick<Resume,'preferredTemplate'>,
requested?, { allowDisabledRequested })` takes the requested template, else the
resume's own, else `default` - the first that exists and is enabled (a
disabled REQUESTED one for an administrator's preview) - else the first
enabled template of `getAllTemplates()` (newest first), else null, which every
caller turns into `noTemplateAvailable()`; the layout plays no part, and the
editor's picker (TemplateCard.tsx) and the chooser's Use this template offer
every enabled template.
The template chooser's details and Admin -> Templates' View each draw a
Grouped / Plain switch (role=group aria-label "Technical skills") that frames
`templatePreviewPath(id, layout)`, each layout in a NEW frame (PageThumb keys
its iframe by `src`, the View by its address): a loaded frame pointed at
another address adds a browser-history entry per press, and Back then turned
the page back under a switch still naming the other layout. The details' arrow
keys leave the switch alone, and the View joins the dialog stack
(`useDialogLayer`) and takes focus as the details do, giving it back to its
View on close; test/e2e/skills-layouts.js checks all three. The editor's
layout radios change only the
layout. `supportsSoftSkills` / `supportsStrengths` are derived from the
markup on every read and stripped before a stored row is written. A template's
`category` (`config/templateCategories.ts`: simple | modern | creative) files it
under the new-resume chooser's filters: every built-in states one in its JSON
(test/templateLayouts.test.js holds them, and that each category has some), a
saved template keeps one its JSON states, and any other word is dropped by the
reader (`normalizeTemplateRecord`), the import and the file writer alike. No
route sets it; the frontend's copy of the list is lib/resumeGallery.ts's.

`POST /api/resumes/preview` (any signed-in account, body `{ resume,
resumeId?, templateId?, sample? }`, answers `{ html, templateId, page: { widthPx,
heightPx, contentHeightPx }, sampled }`) renders a DRAFT untailored through the same
pipeline as generation - with one difference, unless the body says `sample:
false` (the boolean; the dashboard's resume thumbnails, which draw the stored
resume as `{ resume: {}, resumeId, sample: false }` and answer `sampled:
[]`): whatever the draft leaves empty
is drawn from the gallery's sample person (`withSampleDefaults`,
`services/sampleResume.ts`, which also holds `SAMPLE_RESUME`), per field for
single values and per section for lists, Strengths and Soft Skills only while
their switch is on for the template (it runs after `resumeForTemplate`).
`sampled` names what was filled, from `SAMPLE_FIELDS` and in that order:
`name, title, email, phone, location, linkedin, summary, experience,
education, skills, strengths, softSkills`. It is applied in that route and
nowhere else - never a save, a generation, a PDF/DOCX or a prompt -
and test/sampleDefaults.test.js fails if anything else calls it. `buildPreviewResume` never throws and takes only the
three render settings from the draft; nothing is saved, no subscription limit is
checked, no model is asked, no credit moves (test/resumeDraftPreview.test.js runs
with every seat locked to prove it). The document carries
`PREVIEW_CONTENT_SECURITY_POLICY` as a meta right after its doctype - before it
would flip the page into quirks mode and away from the PDF's layout. The
gallery's `GET /api/templates/:id/preview` sends the same policy as a header
and takes `?layout=&softSkills=&strengths=`; it draws the sample person
TAILORED (`SAMPLE_TAILORED_CONTENT`, the same file: a composed title, model
`skillGroups` ending in a `soft: true` "Professional Skills" group, no role
descriptions, at most 8 bullets) through the tailored branch, read through
`resumeForTemplate`, so it shows what a generated resume prints;
test/sampleDefaults.test.js fails if any file but pdfGenerator.ts and
sampleResume.ts names either sample.

## Where resumes are filed

Owner decisions O1-O4. `<outputBaseDir>/<prefix>/<suffix>/<file name>`, and
every word of it is utils/outputStorage.ts's: the tokens, spelled the
owner's way - `{{user_email}}`, `{{order_number}}`, `{{date}}`,
`{{profile_name}}`, `{{company_name}}`, `{{role}}`, `{{row_number}}` (no
spaced or aliased spelling) - the two validators and the one renderer.

- **The prefix** is the administrator's: `outputPathPrefix` in the
  app-settings row (an S2 field: stored > `OUTPUT_PATH_PREFIX` > the code's
  `/{{user_email}}/{{order_number}}`). `validateOutputPrefix`: only
  `user_email`, `order_number`, `date` and text, `{{order_number}}` exactly
  once and ALONE in its folder - it is what makes every run's folder its own.
  A save is refused with an `OutputPathError` (400 `output-path-invalid`,
  `field: 'outputPathPrefix'`, PUT /api/admin/settings passes both on); the
  admin payload carries `outputPathPrefix` (no rendered path: that is the
  route's), and POST /api/admin/output-path/preview `{ outputPathPrefix?,
  outputBaseDir? }` answers `{ path, problems, notes }` - the whole path, base
  included, with the default suffix and sample values - for a prefix not saved
  yet (`null` = what Reset gives) and an output folder as its box holds it
  (General asks again when either box changes, OutputPathBox's `previewKey`).
  A save that changes the output folder in effect - a Reset included - creates
  and checks it first (`ensureWritableOutputDir`), refusing the save if it
  cannot.
- **The suffix** is each account's: `users.output_path_suffix` (NULL =
  `OUTPUT_PATH_SUFFIX`, else `/{{date}}/{{profile_name}}/{{company_name}}/{{role}}`),
  read and written by its own query (`getOutputPathSuffix` /
  `setOutputPathSuffix`, never on UserAccount or the session).
  `validateOutputSuffix`: only `date`, `profile_name`, `company_name`, `role`,
  `row_number` and text around them in a folder. Both: at most 8 folders, no
  `.`/`..` or empty folder, no leading drive letter or `~`, leading and
  trailing `/` optional; the canonical spelling is what is stored; every
  problem is a sentence naming the token or folder at fault (a token in the
  other half's place is "misplaced", with whose it is). services/outputPath.ts
  is the account's half: GET /api/auth/account adds `outputPathSuffix`
  (null when unset), `outputPathSuffixSource` ('account' | 'env' |
  'default'), `effectiveOutputPathSuffix` and `defaultOutputPathSuffix` - for
  a builder only, a reporter's says nothing of it; PUT /api/auth/account `{
  outputPathSuffix }` (requireUser; `''`/`null` resets; a stored one that no
  longer passes is not used, warned once); POST /api/auth/output-path/preview
  `{ outputPathSuffix? }` -> `{ path, problems, notes }` (the asker's own
  email, a sample order number and today, their first resume's name else
  "Sample Profile", Acme, Software Engineer, row 2; no base - a server path is
  the administrator's; `notes` is non-refusing advice: no `{{company_name}}`).
  `outputPathUsesJobTitle` (the builder's Role box) is THE CALLER's suffix
  using `{{role}}` - GET /api/resume/models passes it to `getUserAppSettings`.
- **Rendering** (`renderOutputPrefix` / `renderOutputSuffix` /
  `renderOutputPath`) substitutes each folder's values in one pass, THEN
  sanitizes it whole (`sanitizePathSegment`): `{{date}}{{profile_name}}` is
  one folder, no value adds or climbs one, an empty folder is `unknown`.
  `{{user_email}}` is the account's email (`accountFolderName`). A role
  still empty after `resolveTaskRole` renders `unknown`.
- **A run's place is fixed at submit**: POST /generation/batches calls
  `planRunOutput(account)` (base, prefix, the submitter's suffix, the day),
  passes `rootFor` to `createOrder` - which renders `orders.output_root`
  INSIDE its insert, where the number is issued - and stamps `placeFor(number)`
  on every task as `payload.output` (persisted whole). `getGeneratedOutputPath`
  files under it; without one (a script, a test) it uses the settings in
  effect with `unknown` account and order. Two resumes of ONE run never share
  a file: the default suffix renders one folder for two postings with one
  title at one company, and the generators overwrite, so each queued task
  claims its stems first (services/queue/runFiles.ts `claimRunFileStems`,
  keyed by its batch and `Assignment.seq`): a stem another task of the run
  claimed in this process or recorded on its order item
  (`recordedRunFilePaths`) gets `_2`, `_3`... on the resume and cover letter
  alike; a retry or restored task keeps its own; forgotten at
  `batchFinished`. The per-resume FILE NAME templates stay, and read the
  folder tokens' spellings (`{{profile_name}}`, `{{company_name}}`,
  `{{role}}`, `{{row_number}}`, `{{date}}`, `{{order_number}}`,
  `{{user_email}}`, the defaults' and the editor's) beside their old ones
  (`{{profile name}}`, ... - `FILE_NAME_TOKEN_ALIASES`);
  `companyFolderNameTemplate` is gone (a stored one is not read and the next
  save drops it).
- **A run is read where it was written.** Recorded paths are relative to the
  output folder, and a run keeps the one it was placed in, so every reader
  that has the order - the per-file and order downloads, the zip, retention -
  resolves through utils/generatedPath.ts `resolveRunFile(path,
  order.outputRoot)`: under the run's own base (`runBaseDir`: `output_root`
  less the leading folders the path shares with it) first, then under the
  folder in effect (a tree an administrator moved across). Only the
  path-taking GET /api/generated/* (no page uses it) resolves under the folder
  in effect alone. An order a builder reads never carries `outputRoot`
  (routes/orders.ts `view`): it is a server path.
- **Ownership** is the run's folder (see generatedFiles.ts above); migration
  10 gave the runs placed before theirs. Retention deletes recorded paths and
  prunes what that empties up to the output folder each was found under, so a
  run's folder goes with its last recorded file; nothing in it needs the
  prefix.
- **The pages** (O5) never render or judge a path: both boxes are
  components/settings/OutputPathBox.tsx - the tokens as chips that insert
  at the caret, and a preview from the server's route, asked once the typing
  stops (lib/outputPath.ts `OUTPUT_PATH_PREVIEW_DELAY_MS`), each request
  aborting the one before and an answer shown only while it is for what the
  box holds (`createLatestGate`); a value the server would refuse shows its
  sentences under the box before anything is saved, and a save's refusal
  (`field`) goes under it too. Admin -> Settings -> General has Output folder
  and Output prefix, each with its source and Reset (the old folder template
  box and its client-side preview are gone); Settings -> Account has
  **Resume files** (components/settings/ResumeFilesSection.tsx, read with
  GET /auth/account - the session's /auth/me carries none of it), its source
  "Your own" or "Default" (`suffixSourceLabel`: never which .env line), Save
  and Reset to default, and not drawn for a reporter - by the SESSION's role,
  so an answer saying the account was made one since (GET /auth/account
  answers every role; no refusal re-reads the session there) goes to
  AuthContext's `adopt`, which redraws the page without it, and a builder's
  answer with no folder path is a failed read with Try again.
  lib/outputPath.ts's chip lists are held to `OUTPUT_PREFIX_TOKENS` /
  `OUTPUT_SUFFIX_TOKENS` by test/frontendSettings.test.js, which also drives
  lib/auth.ts's three calls against the real routes. The resume editor's
  Company folder name box is gone; its file NAME boxes stay.

## Builder modes and the suitable resume

Owner decisions D19-D25 (v4.2, 2026-10-21; decision 10 makes every run one
profile). config/buildModes.ts (a leaf), services/resumeKeywords.ts and
services/resumeMatch.ts (pure), services/resumeChoice.ts (a money module),
routes/generation.ts, routes/resume.ts, services/queue/resumeTask.ts,
services/credits/previewToken.ts and database/orderRepository.ts carry it. A
profile, its resumes and its default resume are "Profiles and their resumes"
above; this section is what a RUN does with them.

**Three modes** (D19). `BuildMode` is `'suitable' | 'partial' | 'full'`
(`BUILD_MODES`), named for a person by `BUILD_MODE_LABELS`: *Choose Suitable
Resume*, *Partial Tailor*, *Fully Tailor*. The mode belongs to the RUN, not to a
resume or a model: the request's `buildMode` (`mode` already means order or
immediate), snapshotted on every task as `payload.buildMode` and on the batch as
`shared.buildMode`. A request that names none runs in the administrator's
`defaultBuildMode` in effect (`resolveBuildMode`).

| Mode | Builds, for each job | Model calls per resume | Prompts (Admin -> Prompts) |
|---|---|---|---|
| `suitable`, Choose Suitable Resume | the matcher's pick, AS WRITTEN | the cover letter alone | Generate Cover Letter |
| `partial`, Partial Tailor | the matcher's pick, tailored for the posting | the tailoring, then the revise pass when it is due; its answer carries the letter, and the letter call is the fallback | the resume's Building prompt (Tailor Resume, or a variant of it), Revise Resume Coverage, Generate Cover Letter |
| `full`, Fully Tailor | the profile's EFFECTIVE default resume, written for the posting | as Partial | Tailor Resume (Fully), Revise Resume Coverage, Generate Cover Letter |

Every run writes a cover letter (the PDF always, the DOCX when
`includeCoverLetterDocx`), so Choose Suitable Resume costs one letter call per
resume and no more: `runResumeTask` never calls `tailorResume` for it, the
resume prints as written (`result.tailored` is `Boolean(tailoredContent)`, so
false) and the letter is written from the resume's own text. A posting never
analysed is analysed once, as for every run - through the gate, on the analysis
model, and nothing is charged for it - and that analysis names the role the
letter and the folder path use when the job gave none. Content a task carries
from a preview is finished against the resume as it is now
(`finaliseHeldContent`) and not tailored again.

**The run request.** `POST /api/generation/batches` and `/quote` read it with
`readRunRequest` (services/resumeChoice.ts): `{ profileId, buildMode?,
previewedResumeId?, tailoredContentByResumeId?, previewTokenByResumeId?, model?,
jobs, format?, includeCoverLetterDocx?, label?, templateId?, sheet?, mode?,
tabId? }`. A run names exactly ONE profile (a person of the caller) on every
subscription, administrators included, so there is no scope gate, no Premium
lock on a run and no `/resume/preview-all`: a Default account builds a profile
of any number of resumes in every mode, and the tiers differ only in how many
profiles an account keeps. `tailoredContentByResumeId` (entries that are
objects) and `previewTokenByResumeId` (entries that are text) are keyed by
resume id and hold what a preview produced, and `previewedResumeId` is the
resume it showed. `/batches` answers 202 `{ batchId, kind, total, jobCount,
buildMode, orderId?, orderNumber?, queues? }` - `total` is the resumes queued,
one per job, and `queues` an administrator's - and names the run `{N} job(s) for
{profile name}, {mode label}` unless the caller gave a label. Every refusal is
a `PublicError` written for anybody, comes before anything is charged or asked
of a model, and is sent as `{ error, code, ...extra }`:

| Status and code | When | Sentence |
|---|---|---|
| 400 `one-profile-per-run` | no `profileId`, one that is not text, or a `profileIds` or `resumeIds` of any shape (an empty list too) | *Choose one profile to build for.* |
| 400 `bad-build-mode` | a `buildMode` that is not one of the three | *buildMode must be "suitable", "partial" or "full".* |
| 400 `suitable-takes-no-content` | Choose Suitable Resume - named, or the default in effect - with previewed content or a token | *Choose Suitable Resume builds each resume as written, so it takes no previewed content.* |
| 400 `bad-previewed-resume` | a `previewedResumeId` that is not text | *previewedResumeId must be the id of the resume the preview showed.* |
| 404 `profile-not-found` | no such profile, or another account's (an administrator's too) | *That profile was not found. It may have been deleted; reload the page.* |
| 400 `no-profiles-to-build` | the profile has no ENABLED resume | *That profile has no enabled resume to build. Add or enable a resume on its page.* (`NO_PROFILES_TO_BUILD`) |
| 409 `preview-changed` + `profileId`, `resumeId` | the run would build a resume the preview did not show (below) | *Jane Doe's resumes have changed since the preview: this run would now build Backend Engineer. Preview again.* |
| 402 `insufficient-credits` + `neededMilli`, `balanceMilli` | the balance cannot cover the whole sum | *This needs {$X} of credit and the account has {$Y}. Generate fewer at once, or add more credit.* |

In `/batches` the steps run in this order: `readRunRequest` (before the jobs, as
`/quote` asks it, so the wrong people are told so and not that there are no
jobs), `normalizeJobs`, the mode in effect, `resolveRunTarget` (for its refusals,
ahead of the Google read), the sheet and the analyses
(`resolveAnalysesAtSubmit`, which asks no model), `resolveRunTarget` AGAIN (the
profile and its enabled resumes as they are after those awaits, which can take
seconds on a big sheet run, so a resume disabled meanwhile is not chosen),
`planRun`, `checkPreview`, the
prices (`getBuildModePrices`), `buildTasks`, `chargeFor`, `reserveCredits`,
`createOrder` and `queue.submit`. `/quote` mirrors them as far as the model
check: it is lenient where the form is still being filled in (jobs are counted,
not validated, and no jobs is a quote of nothing) and answers `{ resumes,
costMilli, pricePerResumeMilli, balanceMilli, exempt, buildMode }`,
`pricePerResumeMilli` being the one price (a quote stands one resume in for every
job, so they all cost the same, and one priced stand-in is multiplied rather than
a plan built per job), null when there is nothing to price. It makes no choice, so it cannot say 409 `preview-changed`. The log line of
a submission reads `(N job(s) for {profile name}, {mode label}; chosen among C
resume(s) in T ms)`.

**Keywords** (D24; services/resumeKeywords.ts). A resume's keywords are COMPUTED,
never stored. `keywordsOf(resume)` is pure and takes about a millisecond;
`matchKeywordsOf(resume)` memoises it in 512 entries
(`MATCH_KEYWORDS_CACHE_SIZE`) keyed by the resume's id, its `updatedAt` and
`KEYWORDS_VERSION` (a save moves `updatedAt`, so an edited resume is computed
afresh; the version is bumped by hand whenever the extraction changes what it
answers for the same resume), freezes the answer and writes NOTHING back: a read
that saved would upsert the whole document and could overwrite a concurrent
edit with an older copy. A draft with no id or no time is answered and not
memoised. `ResumeKeywords` is `{ version, vocabulary, basedOn, headline,
roleTitles, terms }`: `vocabulary` a hash of the vocabulary and its synonym
groups, `basedOn` a hash of exactly the fields read, `headline` and `roleTitles`
the KIND of role the headline (up to four, for "A | B") and each held title
(twelve, in resume order, repeats dropped) name - `roleKind`, the level words
taken off the edges, and the normaliser's placeholder headline 'Professional'
counts as none - and `terms` the technologies, tools and concepts the resume
claims, from three sources in this order, at most 80 (`MAX_KEYWORD_TERMS`) of at
most 60 characters (`MAX_KEYWORD_LENGTH`), the earlier never displaced by the
later:

- CURATED - what the person typed: the resume's `skills` and each role's `skills`,
  in their order, spelled as the shipped list spells them (`go` is `Go`).
- SCANNED - the technologies the prose names, in first-appearance order. The prose
  is the fields the revise pass reads as evidence (headline, summary, skills and
  their headings, strengths, each role's title, description, achievements and
  skills, certifications, projects, volunteering, courses, awards and
  publications) less the soft skills; never the name, the contact, a company
  field, education, languages, interests, references or custom sections. A
  sentence about the COMPANY ("Acme is a fintech platform built on Kafka.") is
  left out, by the test the tailoring prompt's `companyContext` uses
  (`isCompanyDescriptionLike`).
- TITLES - `headline` and `roleTitles`.

The vocabulary the prose is scanned against is the SHIPPED one -
`backend/static/skills/skills.json`'s hard skills (about 1,500) with
config/conceptTools.ts's tools and aliases - and never the live skill library:
any builder can add to that one (POST /resume/skills/confirm), which would make
one account's keywords depend on another's actions (the tailoring cache's key
follows the same rule and carries no library). A shipped list that cannot be
read falls back to the concept table with one warning, and never fails a GET or
a save; tests swap the list or the file it is read from
(`setMatchVocabularyForTests`, `setMatchVocabularyFileForTests`). Everyday
English words sit in that list (Kind, Less, Express, Spring, Swift, Echo), so a
name is found in prose only by a rule for its shape: one character (C, R) never, curated
only; two letters (Go, Nx; the alias CI) in their own case, not where a
sentence or bullet starts (unless it reads as a list item or a requirement,
below) and not before a hyphen ("Go-live"); two characters
with a digit or symbol (C#, S3) in their own case; one Title-case word
(Express) in its own case, and at a sentence start only if it is not an
everyday word (see below); one lower- or UPPER-case
word (curl, REST) in its own case; anything else (Node.js, CI/CD, "unit
testing", an alias of three characters or more that is not ALL-CAPS) in any
case, as a whole word. A sentence starts at the text's start, after a line
break (and a bullet), after a numbered item or after `.`, `!` or `?` and a
space (so after "e.g.", "i.e." and "etc." too); `:` and `,` do not
end one, so "Nice to have: Terraform" counts. A requirement list names one
technology per line or bullet, so a Title-case name at such a start IS taken
("- Python", "Kubernetes" on a line of its own, "1. Terraform", "(e.g. Docker)")
unless it is in `SENTENCE_START_AMBIGUOUS`, a hand-curated, exported and
test-pinned set (126 lower-case words) of the title-class names that are also
everyday words, names or plain-noun practices: Express, Spring, Swift, Kind,
Less, Echo, Hack, Node, Testing, Analysis, Infrastructure, Automation,
Statistics, Migrations, Transactions, Streams, Vector, Render, Relay, Vault,
Phoenix, Chef, Puppet, Hive, Nomad... ("Kind regards", "Express yourself",
"Spring is here", "Swift Developer wanted", "Testing is hard" stay out; "Built
Express APIs" and "Stack: Spring" still count). It was made by reading all the
title-class entries: 359 in the shipped list, 384 distinct ones with the
concept table's tools and the synonym spellings (counted with the code's own
classifier). DEVIATION FROM DESIGN G2, which refused the whole title class at a
sentence start and so missed most bullet-start technologies (the owner's
"choose by similarity of keywords" needs them): a name that is no everyday word
is accepted there. A name the sentence-start rule would refuse - the
two-letter class (Go, Nx, jq, TS) and every word of `SENTENCE_START_AMBIGUOUS`
- is still taken there when it READS AS A LIST ITEM OR A REQUIREMENT
(`readsAsListItemOrRequirement`, `KEYWORDS_VERSION` 4): (a) it is the whole
line after an optional bullet or number ("Go", "- TS", "1. Swift", "- Node",
"Swift (iOS)"); (b) a list separator and another technology follow it, in that
technology's own case ("Go, Docker", "Go/Docker", "Swift and Objective-C", "TS
or JS", "Go & Rust", "(e.g. Go or Rust)", a skills line "Go: 3 years"); or (c)
a requirement cue follows, optionally after "is" or "are" and "a" ("Swift
required.", "Go experience", "Node is a plus", "TS preferred"; the cues are
required, requirement(s), experience(d), preferred, proficiency, proficient,
knowledge, expertise, skill(s), plus, desired, background, fluency, fluent,
familiarity). "developer(s)" and "development" are NOT cues, so "Swift
Developer wanted" and "Go developer" stay prose; neither are "Kind regards",
"Swift reply", "Go to market", "Go ahead", "Express yourself", "Spring and
summer" or "Kind, caring people" (the word after a separator must itself be a
vocabulary name). Mid-sentence behaviour is unchanged. Lower-case
"go", "node" and "spring" prose is never a technology. The same name in the
resume's `skills` list or a role's always counts, being curated. Three
refinements (`KEYWORDS_VERSION` 3 added them, with the title-class rule and the
synonym scan; 4 is current): a short closed list of names
that are no English word (`SAFE_ANY_CASE`: Docker, Kubernetes, Python, Postgres,
Kafka, Terraform...) is found in ANY case, for the casual or all-capitals
posting - lower-case "react", "express", "rust", "spring" and "kind" are
everyday words and stay out of it; a name inside a LONGER name found in the same
text is not a hit of its own ("CI" in "CI/CD", "GitHub" in "GitHub Actions";
a standalone mention elsewhere still is); and a name inside a company's
("American Express", "Express Scripts") or the clearance "TS/SCI" is not a hit.
`TERM_SYNONYMS` is a closed list of spellings of one thing (Go and Golang,
Kubernetes and K8s, TypeScript and TS, HTML and HTML5, CSS and CSS3, Python and
Python3, JavaScript and JS and ES6...): one term for the dedupe and the matcher,
AND (`KEYWORDS_VERSION` 3, DEVIATION FROM DESIGN G2, whose scan found only the
shipped list's and the concept table's own spellings) every spelling in it is
also scanned for in a text, as a library entry with the class its shape earns
and the same synonym key as its canonical one - "Golang services on K8s" names
Go and Kubernetes, "Node" mid-sentence Node.js, "Amazon Web Services" AWS -
while lower-case "go" and "node" prose still names nothing. `isVocabularyTerm`
says whether a whole string is an entry of that vocabulary.

They are served on GET /api/resumes and GET /api/resumes/:id as a derived
`matchKeywords` (`withMatchKeywords`: a resume stored before keywords existed, or
under an older vocabulary, is answered current; a failure leaves the field off
and never fails the read) and on no other answer. Nothing reads one back: the
document builders carry none, a `matchKeywords` in a POST, PUT or import body is
ignored and an import stores none, it is not on the `Resume` type, and it is
left out of `resumeFingerprint` (the tailoring cache's key), of
`prepareResumeRenderData` (which spreads the document), of the prompt JSON
(`buildPromptResume` names its fields) and of the revise pass's evidence.

**The matcher** (D25; services/resumeMatch.ts, pure: no database, no model, no
I/O). `chooseForJob(job, candidates, mode)` picks among a profile's ENABLED
resumes (`MatchCandidate { resume, isDefault }`; `MatchJob { analysis?, text?,
title? }`) and `scoreResumeForJob` scores one. The score is S = 0.45 T + 0.55 R.

- T is TITLE affinity: the kinds of role the posting names (its analysis' title and
  the role the caller gave, each through `roleKind`) against the resume's
  headline (70%) and its best held title (30%; a part the resume lacks is left
  out). A kind's last word, its head, counts 1 and every qualifier before it
  counts 2 ("Software" counts 1: every second engineer's title has it),
  `developer`, `programmer`, `dev` and `swe` read as `engineer`, and
  "front end", "machine learning" and their kin fold to one word, so "Data
  Engineer" is a third of the way to "Backend Engineer" and "Backend Developer"
  all of it; DevOps, SRE and "site reliability" fold to one word, and a Platform
  Engineer posting counts a DevOps resume (and the other way round) half a
  qualifier. The words of the title's TAIL - what `roleKind` cuts off after
  a comma, " - ", " | ", a colon or a bracket (`roleTail`), as in "Software
  Engineer, Backend", "Software Engineer (Backend)", "Software Engineer -
  Backend Platform" and "Engineer II, Backend Platform" - are further
  qualifiers of weight 2 (DEVIATION FROM DESIGN G2, which used `roleKind` alone
  and so read every one of those as the generic "Software Engineer", a Full Stack
  Software Engineer's whole title); level numerals, the closed
  `TAIL_NOISE` words (Remote, Hybrid, Contract, Full-time...), the kind's own
  words and a tail word that is a single-word TERM of the posting (the "(Go,
  Kubernetes)" of a title, scored as the terms they are) are not counted.
  `titleMatched` says a whole KIND was said, the tail aside. A posting with no terms
  and no role given may take its text's opening line for the title - at most
  eight words, not ending like a sentence - and ONLY then (a posting with terms
  is scored on them as before).
- R = 0.7 core + 0.3 rest is RECALL over the posting's own terms, each tier the
  weighted share of its terms the resume has. What the resume has beyond what
  the posting names counts for nothing, so a long list cannot win on size.
  With an analysis - read through `postingTermLists` and `pickTopSkills`, never
  `buildTailorLists`, whose concept tools compile thousands of patterns per call
  (about 8 ms a job) - core is the five terms it leans on and its must-include
  terms, weight 3; rest is its other skills, weight 2, and its concepts and
  domain knowledge, weight 1; soft skills, verbs and responsibilities are never
  scored. From text alone - a job with no analysis yet, or one that names
  nothing - the terms are what the vocabulary scan finds in the analysis' own
  text, else the job's, plus every candidate's own term the text names
  ("payments" is in nobody's vocabulary but may be on a resume): a term in the
  role or the posting's first line weighs 3, one in a requirements block 2 (core
  is weight 2 and up), one anywhere else 1, and a one-letter term is never
  looked for.
- A posting term's FACTOR is the best the resume reaches: 1.0 the same thing
  (synonym), or the posting's term a whole word inside the resume's ("AWS" in
  "AWS Lambda"); 0.6 the resume's term a whole word inside the posting's; 0.8 the
  resume's term an alias of a concept the posting's term names ("continuous
  integration" for "CI/CD"); 0.5 a tool of that concept (Jenkins). A one- or
  two-character term matches exactly only ("C" is not "C++", "Go" is not
  "Gopher"). An ANALYSIS term that spells alternatives - "Go (Golang)",
  "Golang (Go)", "Go/Golang", "Airflow or Dagster", "Kubernetes (K8s)" - is
  expanded before scoring (DEVIATION FROM DESIGN G2): split at a bracket, " or "
  and "/" unless the whole term is a vocabulary entry ("CI/CD", "TCP/IP", "A/B
  testing"), the term itself kept as one of the readings (so "CI/CD pipelines"
  still names its concept), at most six; each reading is scored and the best
  factor counts, while the term keeps its own spelling in `matched` and counts
  once in `postingTermCount`. With terms and no titles, or titles and no terms, that part alone
  is the score; with neither every score is 0.
- Ties: scores are compared to six decimals, and a shared best score goes to the
  profile's effective default, then the more PRECISE resume (the share of its
  terms the posting names), then STRICT title affinity (a missing headline
  counted as nothing, so a specialist whose headline and roles both match beats
  a headline-less resume that merely lists one matching role), then the newer
  `updatedAt`, then the lower id - a total order, so the answer never depends on the order the candidates came in.
  Nothing matching at all is such a tie: the default is built.

`TaskMatch` is the explanation, `{ v: 1, mode, reason, candidates, basis?,
score?, titleMatched?, matched?, matchedCount?, postingTermCount? }`. `reason` is
`matched` (the resume won on its score), `tie` (the best score was shared, or
nothing matched, and the tie-break decided), `only` (the profile has one enabled
resume) or `default` (Fully Tailor, which builds the effective default by rule);
`candidates` is the number of enabled resumes at submit; `basis`, for `matched`
and `tie`, says what the score was worked out from - `analysis`, `text`, `title`
or `none`; `score` is rounded to four decimals; `matched` is the posting's terms
the chosen resume carries, best first (weight x factor, then the posting's
order), at most 8, in the posting's spelling, and `matchedCount` and
`postingTermCount` count them all. An unexpected pick is read off the order
item's `match`. The worked
example the owner's question came from - a bare "Backend Engineer" resume beats
the profile's default "Data Engineer" resume (a stack of Python, Spark, Airflow,
AWS, Kubernetes, PostgreSQL and Docker) for a Senior Backend Engineer posting
that asks for Go and Kubernetes, and the data engineer wins once it also lists
Go and gRPC - is pinned on the analysis path and on the text path
(test/resumeMatch.test.js), as are 500 jobs among 25 resumes in well under three
seconds; `planRun` yields to the event loop every 25 jobs, so a long sheet run
does not hold the server's other requests.

**The choice is fixed at submit** (D20). `resolveRunTarget` files the caller's
unfiled resumes first (an account that has not opened its dashboard since the
upgrade still has its people), finds the profile (the caller's own, else 404
`profile-not-found`) and returns its ENABLED resumes, newest first, with the
effective default among them: a disabled resume is never a candidate. `planRun`
then gives every job one resume and its `TaskMatch`: Fully Tailor the effective
default (reason `default`), a profile with one enabled resume that one (`only`),
otherwise `chooseForJob` on the job's analysis - the stored one its `analysisId`
names, which `resolveAnalysesAtSubmit` has put on the job by then (the sheet
row's, the page's or the store's; no model is asked) - else, for a job with none
yet, on its posting text and role. The model is resolved once per DISTINCT
resume (the request's `model` wins, then the resume's own, then the app
default) and changes where a resume runs, never what it costs. The answer is
written onto each task's label (`resumeId`, `resumeName`, `companyName`, `role`,
`sourceRowNumber?`, plus `resumeLabel`, the chosen resume's headline label
(`resumeLabelOf`), `profileLabel`, the profile's name at submit, and `match`),
which reaches the queue's snapshots through `...task.label`, and onto the order
item (`order_items.resume_label`, `profile_label` and `match_json`, in SCHEMA and
ADDED_COLUMNS, NULL on an item an older build wrote), which `GET
/api/orders/:id` serves as `resumeLabel`, `profileLabel` and `match` long after
the batch is evicted. `toItem` reads them leniently: junk is null, and only the
known keys of `match` survive (at most 50 matched terms of 200 characters).
`resumeName` stays the resume's own name, the person's; `resumeLabel` is what
tells two resumes of one person apart. A restored task builds `payload.resumeId`
in `payload.buildMode` and never chooses again; one queued before v4.2 has
neither a mode (it builds Partial, as every resume without a stored choice did)
nor a `match`.

**The preview check** (`checkPreview`, `/batches` only). When a request sends a
`previewedResumeId` or any previewed content, every planned resume must be the
previewed one or a key of the content; otherwise the profile's resumes (or the
posting's analysis) changed since the page previewed, and building something
else at the price of what was shown is refused: 409 `preview-changed`, with the
profile's name and the resume's label in the sentence and `profileId` and
`resumeId` beside it, BEFORE anything is reserved or charged. A request with
neither is never checked. **A deleted pick is refunded, not replaced:** a chosen
resume deleted before its turn fails its task with `ResumeGoneError` (410, not
retried) and the queue's `taskFinished` hook gives back that task's own
snapshotted price (test/buildModes.test.js and test/modePricing.test.js run
it); another resume is not built in its place, since the choice was made, priced
and recorded at submit.

**Fully Tailor builds the profile's EFFECTIVE default** (D13): the chosen default
while it is an ENABLED resume of the profile, else the oldest enabled
(`effectiveDefaultResumeId`; a profile with no enabled resume is refused before
it is asked), whatever would match the posting better and without asking the
matcher. A disabled chosen default is skipped, not replaced: the choice is kept,
and enabling the resume brings it back (test/buildModes.test.js).

**Previews** (`POST /api/resume/preview`, routes/resume.ts). The body names
exactly one of `profileId` and `resumeId` (both: 400 `profile-or-resume`, *Name
the profile to preview, or the resume to show again, not both.*; neither: 400
`profile-required`, *Choose a profile to preview.*).

- `{ profileId, buildMode?, analysisId?, jobDescription?, jobLink?, companyName?,
  role?, templateId?, model? }` CHOOSES, then previews: the resume is picked as a run
  would pick it for this posting (`planRun` with one job). The refusals that cost
  nothing come first - an unknown or another account's profile 404, a profile
  with no enabled resume 400 `no-profiles-to-build` in its own words (*Jane Doe
  has no enabled resume to preview. Add or enable one on the profile's page.*), a
  `model` the request may not use 400 `model-unavailable`, asked of Partial and
  Fully only - and then the posting is analysed through the gate, once, as ever.
  Choose Suitable Resume draws the resume as written: no tailoring call,
  `tailored: false`, no token. Partial and Fully tailor it, through the chosen
  resume's template, and answer a `previewToken` for this account, that resume
  and that mode. A posting too short to analyse is drawn as written, untailored,
  in every mode.
- `{ resumeId, tailoredContent, ... }` DRAWS HELD CONTENT AGAIN, as the manual path
  always did: re-read against the resume as it is now when an analysis is known,
  no tailoring call and no token; without content, 400 `content-required`, *Send
  the previewed content to show it again, or name the profile to preview.*

The answer is `{ html, tailored, tailoredContent?, previewToken?, analysisId?,
profileId, profileName, resumeId, resumeLabel, buildMode, match }`, `match` being
null when held content is drawn again; `resumeId` is what the page sends back as
`previewedResumeId`. A preview charges nothing, and there is no `/resume/choose`.

**Prompts per mode, and the Building prompt.** No prompt text, variable or
contract changed for the modes: each mode's prompts already existed and are
edited under Admin -> Prompts. Partial runs `tailor-resume`, or the variant the
resume chose as its Building prompt (`resumeSettings.resumePromptId`; a choice
naming a record that is gone, or one that is not a Tailor Resume prompt, runs
the built-in with one warning). Fully runs `tailor-resume-full`, a single-prompt
feature, whatever Building prompt the resume chose. Choose Suitable Resume
ignores the Building prompt: it tailors nothing, and only the cover letter
prompt, which the other two use too when their tailoring brought no letter, runs
for it. Revise Resume Coverage follows either tailoring. Only descriptions and
sentences changed (promptService.ts): Tailor Resume's usage says it runs "for
every resume built with Partial Tailor", Tailor Resume (Fully)'s "for every
resume built with Fully Tailor - the profile's default resume", Generate Cover
Letter's names "every Choose Suitable Resume build, which tailors nothing", and
the refusal of a second Fully prompt reads *Fully tailoring has one prompt, the
built-in Tailor Resume (Fully), which every Fully Tailor run uses. Edit that
prompt instead of adding another.*

**Prices per mode** (D21; config/buildModes.ts). What a resume costs is the price
of the mode it is built in; the model that runs it never changes it, and a model
record carries no price. The settings are `suitablePriceMilli`,
`partialPriceMilli` and `fullPriceMilli` (`BUILD_MODE_PRICE_FIELDS` names each
one's setting, its request field `suitablePriceUsd`... and its `.env` variable
`RESUME_SUITABLE_PRICE_USD`, `RESUME_PARTIAL_PRICE_USD`,
`RESUME_FULL_PRICE_USD`): per mode, stored > `.env` > $0 (owner decisions S1-S3,
in the config/ entry above). $0 is free, and there is no default price on
purpose: a mode nobody priced builds for nothing. The range is $0 to $1,000 in
steps of $0.001. A save (PUT /api/admin/settings) sends dollars: `null` resets,
'' is refused, anything else goes through `parseBuildModePriceInput` and is
stored exactly. A refusal is a `BuildModePriceError` whose `field` (the `...Usd`
name) and `code` the route passes on: 400 `bad-price`, *The Partial Tailor price
is required: an amount in dollars, like 0.023. It is from $0 to $1000 in steps
of $0.001, like 0.023; 0 makes it free.* for '' (junk and a fraction of a
thousandth say their own first sentence), *The Partial Tailor price must be from
$0 to $1000 in steps of $0.001, like 0.023; 0 makes it free.* above the ceiling;
400 `bad-price-field`, *Send the Partial Tailor price in dollars, as
partialPriceUsd.* for a `partialPriceMilli` key. `.env`'s value above $1,000
clamps with one warning; junk (not an amount, negative, finer than a thousandth)
warns once and reads $0, and while nothing is stored over it the admin payload
lists the mode in `unreadableModePrices`, for the page to show it red and name
the variable; a stored price this app never writes is dropped with one warning
and is not flagged. The admin payload carries each price's `settingSources` and
`settingDefaults`; `GET /api/resume/models` carries `defaultBuildMode` and the
three prices, for the builder's mode cards - the same figures a quote reveals.
`getBuildModePrices()` is the services' read, and THROWS when the settings cannot
be read: a run is never priced at a guess.

A run costs EXACTLY its jobs times the mode's price. `priceRun` gives every
planned resume `prices[mode]` and sums the integers (`chargeFor`), so seven
Partial resumes at $0.023 are $0.161; there is no "up to", and `/quote` is the
same arithmetic (`quoteRun`), so the figure quoted is the figure charged. The
price is taken when the run is submitted and snapshotted on each task
(`payload.costMilli`); a resume that does not deliver gives back its own. A free
mode takes nothing and writes no row, an account with no credit can run it, and
too little credit for the whole sum is 402 with nothing queued. Administrators
are quoted the full amount (`exempt: true`) and charged nothing; they are not
exempt from the one-profile rule. Previewed content is the exception:
`previewTokenByResumeId` holds a signed token per resume
(`issuePreviewToken({ userId, resumeId, buildMode })`, claims `{ u, r, b, t }`,
valid for a day, HMAC with a secret kept in `app_settings`) and content is
priced at the run's mode only when its token is
valid for this account, this resume AND this mode (`readPreviewToken`: forged,
expired, another account's or resume's, an old-format token and none at all read
as null). Content without one costs the FLOOR, `max(prices[mode], prices.partial,
prices.full)`: a request cannot name the cheapest mode while supplying the
dearest one's work, and a Partial token does not pay for Fully work. A token is
not bound to the content, since the page lets the person edit the JSON, which is
still that mode's work; administrators are never held to the floor. KNOWN GAP
(the owner's to decide): previews are free, so an account can preview a resume
in Fully (keeping the content) and in Partial (keeping that token) and finalise
Partial with the Fully content, paying Partial's price for Fully's work. Closing
it means binding the token to a hash of the content, which would make every hand
edit the floor's price (services/credits/previewToken.ts says so too).

**The pages.** Build Resumes and Find Jobs' Order Immediately choose ONE profile
(`ProfileSelector`) and ONE mode (components/builder/BuildModeChoice.tsx: three
cards, never locked, each saying what the mode does and what a resume costs in
it) and send `{ profileId, buildMode }` - see app/page.tsx in the layout above
and Find Jobs in "The Job Data Lake" for the previews, the receipt and the
order's page. The administrator's side is Settings -> General. Its Builder
Defaults choose the **Default profile** (`#default-profile`: "Choose
automatically" - stored as '' - then the administrator's own profiles, each
"{name} (N resumes)"; with none, "You have no profiles yet. Add one under
Profiles before choosing a default."; no source line, because it has no `.env`
default) and the **Default builder mode** (`#default-build-mode`, a select with
the three modes, its source line and Reset to default); the old build-target
setting is gone from the page as from the server. Its **Price per resume**
section has the three prices (see "Money"). Admin -> Models has no price (see
"The AI layer").

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
never by slicing `formatMoney`'s text - and test/frontendMoney.test.js runs each
pair over the same inputs (and the build modes' price boxes,
app/admin/settings/modePriceDraft.ts, against the server's
`parseBuildModePriceInput`, every refusal word for word) and fails on any
difference - and on a `Math.floor`, `parseInt`, `parseFloat`,
`Number.isInteger` or `toFixed` in the frontend money files it lists
(modePriceDraft.ts and the mode cards, components/builder/BuildModeChoice.tsx,
among them). A page shows every amount with `formatMoney`, never `Intl`
currency formatting, and SENDS an amount as the text that was typed
(`amountUsd`, `balanceUsd`, `partialPriceUsd`), never a number it parsed.
History from before dollars is shown in its own unit and never converted: a
ledger row with `legacyCredits` reads `-12 credits` (lib/ledger.ts), and a
payment that bought credits keeps its "195 Credits at $0.50 each" invoice line
(lib/paymentDisplay.ts `isLegacyPurchase` - not just "has `legacyCredits`": a
checkout opened before the switch and paid after was credited in dollars).

**The API contract.** Every amount in every response is an integer in a field
ending `Milli` (`balanceMilli`, `heldMilli`, `deltaMilli`, `balanceAfterMilli`,
`costMilli`, `pricePerResumeMilli` - the generation quote's one price -,
`partialPriceMilli`, `neededMilli`, `amountMilli`, `creditMilli`...). Every
amount in a request is dollars, as text or a JSON number, in a field ending
`Usd` (`partialPriceUsd`, `balanceUsd`, `amountUsd`, `minUsd`...). A field in the
old unit (`credits`, `amount`, `creditsPerResume`, `minCents`) is never read,
as dollars or anything else: where the `Usd` field is required its absence is
refused (a checkout or quote: *Choose an amount in dollars and cents, like 25
or 12.50.*; a build-mode price sent empty, where `null` is Reset; a payment
limit without `minUsd`), and elsewhere the old field is ignored - a model's
`pricePerResumeUsd` among them, since models carry no price. The old
integer-credit fields are gone from responses, not aliased.

**Storage is NEW columns, never the old ones reinterpreted** - the old ones
hold history, in its own unit: `users.balance_milli`, `credit_ledger.delta_milli`
/ `balance_after_milli`, `credit_reservations.units_milli` / `refunded_milli`,
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

**The switch to dollars** was build ac3df79's `dollarSwitch.ts`, gone with
the rest of the upgrade code - the startup guard requires its marker,
`schema_meta.credit_unit = 'usd-milli'`. The owner chose a RESET (M1), and what
it left is history this build still reads: a `reset` ledger row per account
that held old credits (reason `reset`, in the old unit, served as
`legacyCredits`; one at delta 0 for an account whose credits were all held by
a run), `users.credits` zeroed, and a snapshot in
`app_settings["migration-log.credits-to-dollars"]` that nothing reads. Model
prices no longer exist: what a resume costs is the price of its build mode (see
below), and a `pricePerResumeMilli` an older build stored on a model record is
read past and dropped by the next settings write.

**What a resume costs** is its build mode's price - `suitablePriceMilli`,
`partialPriceMilli` or `fullPriceMilli`, whichever model runs it - taken when
the run is submitted as the SUM of the integer prices of its resumes (jobs times
the mode's price, exactly) and given back per task. The settings, the exact
charge, the previews' tokens and the floor are "Builder modes and the suitable
resume" above; the reservation, the per-task refund and the ledger line are "The
AI layer"'s Price per resume. The pages say it wherever a figure appears.
Settings -> General's **Price per resume** has a box for each mode
(`#mode-price-suitablePriceMilli`, `#mode-price-partialPriceMilli`,
`#mode-price-fullPriceMilli`: text, `inputMode="decimal"`, dollars as typed).
app/admin/settings/modePriceDraft.ts, subscriptionPriceDraft.ts's twin, judges
each box in the server's own sentences before anything is sent - an empty box
is refused, since a price is required, and `0` is how a mode is made free - and
sends only the boxes that changed, as typed, under their `...Usd` names; each
box has its source line (Set here, From .env (NAME), Default) and Reset to
default, which sends `null` through `appSettingResetBody`; a refusal's `field`
puts the server's sentence under its own box; a mode priced $0 is flagged in
red (*Free: nobody is charged for Partial Tailor.*), and so is a mode in
`unreadableModePrices`, naming its `.env` variable; Save Prices. The build-mode
cards on Build Resumes and Find Jobs say what a resume costs in each mode
(*Free.* or *$0.02 a resume.*), the cost line and the spend confirm quote the
run exactly - `describeRunSpend` writes "3 resumes at $0.02 each (Partial
Tailor)" - and the Credits copy (components/credits AmountStep and
PolicyPanels) says a resume costs the price of the build mode it is built in.
No page says a model has a price (test/frontendSettings.test.js and
frontendRefunds.test.js hold that).

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
/api/payments is `requireUser` - a purchase refund gives back the UNSPENT
balance, which for a reporter is earnings.

**Subscriptions are paid from the balance** (owner decisions, 2026-10-19;
services/subscriptions, database/subscriptionRepository.ts, routes/subscription.ts).
A paid tier lasts 30 days from its purchase and is renewed by the SWEEP
(renewal.ts, every SUBSCRIPTION_RENEWAL_SWEEP_MS, 10 minutes, and at startup
once `reconcileCredits` has run - `startSubscriptionRenewalAfter`) at the price
in effect that day; the next period starts at the old end, or at now when a
whole period was missed. Moving UP is at once: `max(0, new price -
unused credit)`, the credit `(price x daysLeft - (price x daysLeft) % 30) / 30`
of the period's own price (`subscription_period_price_milli`), `daysLeft`
counting a started day (0..30, so it changes once a day); the base - the tier
held at the FIRST purchase, Default or an administrator's - is kept through
every upgrade and is where a paid tier returns when it ends. Moving DOWN
(`next`, a paid tier above the base) and Cancel (`renews = 0`) take effect at
renewal; Resume undoes either. A purchase carries `chargeUsd`, what the page
showed; `decide` works the charge out again inside the transaction and a
difference is 409 `charge-changed` with `chargeMilli` - nobody is charged an
amount they did not see. Every charge is creditRepository's
`debitSubscriptionCharge`: ONE conditional UPDATE, `role = 'user' AND disabled
= 0 AND balance_milli >= amount`, refused never clamped (a reporter's earnings
are never spent on a tier), its second read naming `not-a-user`, `disabled` or
`insufficient` in that order, reasons `subscription-purchase` (keyed
`subscription:<account>:<tier>:<period start>`) and `subscription-renewal`
(`subscription-renewal:<account>:<the paid_through it renews>`), refKind
`subscription`; a $0 charge (the credit covers it) writes no row. A purchase the
balance cannot cover is 402 `insufficient-credits` with nothing moved; a renewal
it cannot cover ENDS the tier (`lapseWhenShort`), as do a role that is not
`user` (`promoteIfConfiguredAdmin` changes roles past Accounts), a cancel, a
DISABLED account (it cannot sign in to use or cancel another period, so it is
not charged for one; `BillingState.disabled`) and a tier no longer priced -
each with a notice after the commit (notices.ts; an administrator gets none, a
reporter's has no link). A change a disabled account's request was already
making is 403 `account-disabled`. A pass whose price read throws touches
NOBODY: a settings failure must never read as "not offered". Nor does a price
that is SET and unreadable (`getSubscriptionPriceReading().unreadable`, above):
`renewalDecision` HOLDS what renews as that tier - neither renewed nor ended,
`held` in the report, one warning per pass naming the price - while the rest
renew. Administrators are exempt (409 `admin-exempt`, the page read-only). An
administrator SETTING the tier (a different one) or moving the role away from
user ends paid billing at once and refunds NOTHING (a credit could become a
reporter's earnings): Accounts' answer carries a `note` with the unused amount
to give back with +/-, and the account a notice (`reportEndedByAdministrator`);
DISABLING a paying account ends nothing, and its note says the tier ends at
its paid_through unless enabled by then (`describeDisabledPaidTier`). Both are
worked out from reads made in the change's own IMMEDIATE transaction
(`applyAdministratorChange`), so another server's renewal or purchase cannot
land between them unmentioned. Rows carry `subscriptionBilling: { paidThrough,
renews, next } | null` (one `listPaidSubscriptions()` query). The prices are
admin settings with .env defaults (see config/ above); an unpriced tier is not
offered. `GET /api/auth/subscriptions` is gone (404): the catalogue is GET
/api/subscription's `tiers` (frontend lib/subscriptionBilling.ts).
test/subscriptionBilling, subscriptionRoutes and subscriptionRenewal.test.js
hold it, the last with the due query's plan (`DUE_SUBSCRIPTIONS_SQL` through
`idx_users_subscription_due`). The pages: Settings -> Subscription (the cards,
see components/subscription/ above), Settings -> General's **Subscriptions**
price boxes (app/admin/settings/subscriptionPriceDraft.ts: dollars as typed,
only the boxes that changed, '' = not offered, refused in the server's words
before anything is sent, Reset through `appSettingResetBody`), and Admin ->
Accounts' *Paid · renews ...* line under a paid tier and a kit Dialog confirm
before a tier or role change that ends it.

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
`toRequest` derives the kind from the ITEM KEY (`kindOfItemType`) and marks an
item type this build does not know - an older build's `task:`, or a row edited
by hand - `unrecognised` (on the RefundRequest, NOT in any response): served
as itemType `payment`, and in the admin view with `refundableNowMilli` 0 and
UNRECOGNISED_REASON (*This request names something this version of the app
cannot measure, so it cannot be refunded here. Decline it, and refund by hand
from Accounts if it is owed.*) as `refundableNowReason`; refundable never (409
`unrecognised`), declinable. `GET /api/refund-requests?kind=` filters by kind. Asking for a
purchase or resume refund is CLOSED (R1), and there is no route for it at all
(`POST /` and `GET /options` are gone - a 404) and no service function either:
tests and the e2e scripts seed such a request with test/refundSeed.js's
`seedRefundRequest({ refunds, refundDb, sqlite }, account, { itemType, itemId,
reason })`, which makes the checks the asking route made and throws
`RefundRequestError`. Every request made before is decided as below.

**Refund requests** (owner decision M3; `services/refunds`,
`database/refundRequestRepository.ts`, `routes/refundRequests.ts`). Somebody
asked about their OWN purchase or resume, with a reason (before R1 closed
asking; such requests are still in the queue); an administrator moves it
Requested -> Approved (no money), Requested|Approved -> Declined (reason
required, final) or -> Refunded (the money moves in the same step, final). The
state machine is in the WHERE clauses; a repeat of the same action answers 200
`changed: false` and moves nothing. ONE OPEN REQUEST PER ITEM is a partial
UNIQUE index on `refund_requests(item_key) WHERE state IN ('requested',
'approved')`, not a route check. An item is one of four names
(`REFUND_ITEM_TYPES`): `payout:<account>` above, `payment:<id>`,
`order-item:<id>` (durable - `order_items.cost_milli` is copied from the
task's `costMilli` at `createOrder`, because the task is evicted) and
`charge:<reservation id>` for a build of the synchronous `/resume/generate`
(removed since; a `kind: 'request'` reservation is that one resume, and its
requests still read and decide). Every queued run has an order row - a
Generate Immediately run's is `orders.kind = 'immediate'` - so a queued resume
is always its order item (an older build's `task:` reads as unrecognised,
above). A resume's refund is
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
the lake's `job-report-reward` and `job-report-reward-revoked` (see "The Job
Data Lake" below) and the subscriptions' `subscription-purchase` and
`subscription-renewal` (drift-checked by test/frontendMoney.test.js, which also
lists the lake's and the subscriptions' money modules among those that may not
floor or float-parse; test/money.test.js lists the backend's).

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
With NO row - nothing saved, or `PUT /api/admin/contact { channels: null }`
(Reset to default, `deleteSetting`) - the channels are `.env`'s
`CONTACT_CHANNELS` (`contactChannelsFromEnv`: `type:value[|label]` entries,
each through the same validator, a failing one dropped with ONE warning naming
positions, never values); a row holding `[]` is the admin's "none" and beats
it. The editor's payload carries `settingSources.channels` and
`settingDefaults.channels`.

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
prompt's model override still decides it; so does Write Entry Bullets
(services/entryBullets.ts, the resume editor's Write with AI: free, one call
per account at a time, `runChoiceWins` on the default model). It does NOT decide a resume:
tailoring, its revise pass and the cover letter pass `runChoiceWins`, so they
run on the model resolved for that resume (the request's, else the resume's own,
else the app default), whatever the prompt record says. A JOB ANALYSIS runs on the
administrator's analysis model (`analysisModelId`, see "Job analysis runs once"
below), also with `runChoiceWins`, and the Job Filter makes no model call of its
own at all - it judges that analysis.

Models are admin-curated records: a display name, a seat, a model name and a
description - and no price: what a resume costs is the price of its build mode.
The model name is chosen from `config/providerModels.ts`'s
`listProviderModelOptions(provider)`, each seat's list overridable in `.env`
(`AI_CLI_MODEL_OPTIONS`, `AI_CODEX_MODEL_OPTIONS`, `AI_GEMINI_MODEL_OPTIONS`,
read per call, all-or-nothing). It is checked when a model is created or its
provider or model name changes, and when a prompt override is saved -
`normalizeAIModelRecords` stays list-agnostic, so a `.env` edit can never brick
a settings read. An ordinary account sees models as `{ id, name }` only
(`getUserAppSettings`, `GET /api/resume/models`); the admin payload carries
everything plus `providerModelOptions`. A REQUEST naming a model that cannot run
is refused (`ModelUnavailableError`, 400) rather than swapped, because the
person chose it for this request and a run on another model, with no word of
it, is not the run they asked for (it would not change the price, which is the
build mode's), while a STORED resume preference that went stale falls back to
the default with a warning once. The bare-provider and
`provider:modelName` request forms are admin-only.

**Admin -> Models** (owner decisions M1, M2) opens with its heading and
**Create New Model** at the top right; create and edit are one kit Dialog,
app/admin/models/ModelDialog.tsx (ProvidersSection's pattern), its decisions
in modelForm.ts - the draft, the local checks in the server's own sentences,
an edit's body of only what changed (an untouched one closes with no
request), and `modelRefusalField`. The model routes answer a refusal about
one box with `field` (config/aiModelConfig.ts `AIModelInputError`,
`AI_MODEL_FIELDS`: name, provider, modelName, description, enabled), so a name
another administrator took meanwhile lands under the name box;
test/frontendSettings.test.js drives the dialog's helpers through the real
routes. A model carries no price: a create without one is 201, a
`pricePerResumeUsd` in a body is not read, refused or stored, and one an older
build stored on a record is read past and dropped by the next write. The page
draws none - no Price column, no price box, no red notice for a free model - and
says under its heading *What a resume costs is set per builder mode under
Settings > General > Price per resume.*; modelForm.ts's `MODEL_FIELDS` is the
server's `AI_MODEL_FIELDS`, and no price is among them. The table's badges and
the default and analysis choices are under "Job analysis runs once" below.

**Price per resume** is the build mode's, never the model's. The three prices
(`suitablePriceMilli`, `partialPriceMilli`, `fullPriceMilli`) are thousandths of
a dollar, 0..1,000,000 ($0-$1,000), 0 = free (config/buildModes.ts; "Builder
modes and the suitable resume" has their `.env` names, sources and refusals).
There is NO default price: a mode nobody priced is free, and the admin payload
lists a mode priced $0 only because its `.env` line was junk
(`unreadableModePrices`). A run's resumes are priced at submit by
services/resumeChoice.ts `priceRun` - the mode's price for each planned resume,
or the floor below - and the price is snapshotted on the task as
`payload.costMilli`, OUTSIDE `payload.choice`, so a restore that re-resolves a
retired choice never re-prices it; `chargeFor` sums `taskCostMilli(payload)` and
the queue hook refunds it, 0 when absent (a task from before dollars, whose
`creditCost` is never read as money). `reserveCredits` and `refundTaskUnit` take
AMOUNTS in thousandths, a batch reserves the sum (a free run reserves nothing and
writes no ledger row), and the ledger line is `describeCharge`'s, by mode: *3
resumes: 3 x Partial Tailor @ $0.02 = $0.06* (the "N resume(s):" prefix stays,
because the refund parser reads it; a mixed charge is one group per mode label
and price). `POST /api/generation/quote` prices a batch body through the same
arithmetic without reserving anything (`costMilli`, and `pricePerResumeMilli`
when every resume costs the same, else null). Administrators stay exempt.
Tailored content a preview already wrote is priced as the mode that WROTE it, not
the one the finalising request names: `/resume/preview` hands back a signed
`previewToken` for Partial and Fully (`services/credits/previewToken.ts`, HMAC
with a secret kept in `app_settings`; claims `{ u, r, b, t }` - account, resume,
build mode, time), and `/generation/batches` and the quote
(`tailoredContentByResumeId` with its `previewTokenByResumeId`) charge the run's
mode for content whose token is valid for that account, resume AND mode;
content without one is charged the floor,
`max(prices[mode], prices.partial, prices.full)`.

**Prompt variables are the code's, strictly.** A feature-linked prompt may use
exactly the variables `PROMPT_FEATURES` declares for it (`promptService.ts`), and
that list must equal the keys of the feature's value builder -
`buildTailorResumePromptValues`, `buildAnalyzeJobDescriptionPromptValues`,
`buildJobFactsPromptValues` and their siblings in `resumeService.ts`, and
`buildWriteEntryBulletsPromptValues` in `services/entryBullets.ts`;
test/promptVariables.test.js fails when they drift, so a new variable goes in
both. The features, in this order everywhere (`listPromptFeatureKeys`):
analysis, Job Facts (Filter) (id `filter-google-sheet-job`, the analysis's
second call, Extracting), tailoring, Tailor Resume (Fully) (id
`tailor-resume-full`, Building - see "Partial and Fully tailor" below),
Revise Resume Coverage (id
`revise-resume-coverage`, the tailoring's second call, Building), cover
letter, Write Entry Bullets (id `write-entry-bullets`, Building; variables
`entryJson` - required - `profileJson`, `task`, `instructions`), the two
extractors. The
built-in texts are the owner's, shipped verbatim in `backend/static/prompts`
(the bullets text is this build's, not the owner's, and is not dated by
`OWNER_PROMPTS_CONTRACT`).
A variable whose value the CODE fixes and is the same on every call would be
listed in `STABLE_PROMPT_VARIABLES` (promptService.ts), which promptAssembly
keeps in the cacheable stable part instead of starting the call's data at it -
EMPTY today: the analysis's job field and industry lists were the two, and
neither is a variable now (the job field list is code-owned text on the facts
call, below; the industry is derived). Create, update, `/prompts/validate` and
`/preview` refuse or report any other name (`Unknown prompt variables: x`; an
unsaved draft names its `featureKey`). Some are REQUIRED - contract markers, a
record without which cannot produce what the code parses
(`PromptFeatureDefinition.requiredVariables`,
`listRequiredPromptVariables(featureKey)`): `jobDescription` for
analyze-job-description and for filter-google-sheet-job, `profileJson` for
generate-cover-letter, `profileJson`, `jobAnalysisJson` and
`softSkillGroupHeading` for tailor-resume and tailor-resume-full (the parse
finds the soft-skill group by that heading), and `draftJson` and `missingTermsJson` for
revise-resume-coverage. Create and update refuse a text
without them (400 `Missing required prompt variables: a, b. Every <Label>
prompt must use [[a]] and [[b]].`); validate and preview report them
(`validation.missingVariables: string[]`; `allowedVariables[].required: true`).
A STORED FEATURE record without them, OR naming a variable the code no longer
supplies (`validation.unknownVariables` - an analysis edit asking for the old
`[[jobFieldList]]`, a filter edit from before its retirement reading
`[[jobContent]]`, a tailoring edit or per-resume variant naming the old
`[[includeStrengths]]`/`[[includeSoftSkills]]`/`[[technicalSkillsLayout]]`
switches or `[[hardSkillsJson]]`) - edited before the rule, or by hand - is listed
`needsUpdate: true` and never run: at runtime (resolvePromptByExactId /
ByRuntimeId, renderPrompt*, renderPromptSegmentsByExactId) promptService's
`usableAtRuntime` puts the feature's built-in in its place - the admin's edit
of it when usable, else the shipped file - and logs `[prompts] The prompt
"<name>" (<id>) does not use [[...]], which every <Label> prompt must; the
built-in <Label> prompt runs instead until it is updated under Admin ->
Prompts.` (or `uses [[x]], which this version does not supply`, or `dates
from an older version of the <Label> prompt`, several joined by `, and`) once
per record id and updatedAt. Variables alone cannot catch every older edit:
an analysis edit from before the job field lists, or a Job Filter edit from
before its retirement, names only `[[jobDescription]]`, as the owner's new
texts do. So a feature whose contract changed carries `contractSince`
(`OWNER_PROMPTS_CONTRACT`, 2026-10-19, the shipped analysis and job facts
files' `updatedAt`; `TAILORING_PROMPTS_CONTRACT`, 2026-10-20, the two
tailoring files', the revise pass's and the cover letter's -
promptVariables.test.js holds each file to its feature's), and a STORED
record of it saved before then - the admin's edit of the built-in or a
variant, never the shipped file, and an `updatedAt` that is no time counts as
before - is `needsUpdate` and `savedForOlderVersion` whatever its variables;
any save clears it. The 2026-10-19 contract is GROUNDING: every one of the
five texts was rewritten so a resume or letter claims only what the source
resume says (the tailoring's "THE PROFILE IS THE ONLY SOURCE OF FACT", a posting
technology only where the source names it, a figure only where it states
one, the skills block the candidate's real stack - no fill to thirty, no
"tools their companies run on" - and a self-check; the analysis extracts
only what a posting states, with no implied skills and no target counts;
the revise prompt leaves a term it cannot place honestly missing and adds no
figure but the source's) - so an older edit, which may still ask for a
figure the work "implies", gives way. The 2026-10-20 tailoring contract
(owner's request) opened two holes in it on purpose, because a resume of
titles and dates came out with an EMPTY Experience and an EMPTY Technical
Skills: Partial's skills block leads with every hard skill the posting names,
whether or not the resume lists it (abilities, practices and concepts stay
in the prose; 15 to 30 entries; in no sentence about a described role), and
a role the resume leaves EMPTY - no `companyContext`, no `achievements` - is
written from the posting (3 to 6 bullets, believable for its title, company
and years, modest figures allowed there only; the summary may draw on that
work too) - the owner, asked whether Partial should invent at all, kept this
(2026-10-20); and Fully tailor exists. An edit of the tailoring saved before
it leaves an empty role empty, so it gives way, and so do edits of the
revise pass (its draft now carries each role's dates, for a years rule, and
after a Fully draft its terms are not the source's) and of the cover letter
(told the tailored resume when there is one). promptVariables.test.js's "the shipped
prompts keep a resume to what its source says" holds each rule in the
shipped files and the absence of the ones they replaced. Write Entry Bullets
is not dated (its text never changed). That is how every edit written for an
older prompt contract gives way to the shipped texts, with no migration. An UNATTACHED record is never flagged (it has no built-in to give
way to): one naming a variable it does not declare still fails at render with
`contains unknown variables`. So no turn carries an override for a prompt
that predates a variable. SIX features have one prompt each
(`SINGLE_PROMPT_FEATURES`, `listSinglePromptFeatures`): the analysis, the job
facts, Tailor Resume (Fully), the revise pass, the cover letter and Write
Entry Bullets, each run by
its exact id on a model the code chooses (`runChoiceWins`) - so `createPrompt` refuses a variant (and moving a
prompt into one) and `activatePrompt` an old variant, each in its feature's
own sentence, a stale `activePrompts` entry for one is ignored (and dropped on
the next write), and a variant an older build saved is listed, never active.
`resumeSettings.coverLetterPromptId` is gone (no page ever set it; a save
drops a stored one): `generateCoverLetter` runs the built-in. A resume's
`resumePromptId` naming a record that is gone (a deleted custom prompt) or one
that is not a Tailor Resume prompt runs the built-in `tailor-resume`, warned
once per resume and id (resumeService `resolveResumePromptId`), rather
than failing every build with `Prompt "<id>" not found`. Only Partial Tailor
reads a resume's `resumePromptId` (its Building prompt); Fully Tailor and
Choose Suitable Resume ignore it.

The tailoring's values (`buildTailorResumePromptValues`) are the posting's
analysis in its own spelling and nothing else - no skill library, no resume
setting - built by services/tailorContract.ts `buildTailorLists`, which reads an
analysis of either shape (a posting is analysed once, ever, so most are older):
`jobAnalysisJson` the analysis prompt's own schema (no posting text, facts or
duplicate lists), `targetRoleTitle` = `jobTitle` = `jobMeta.title`,
`skillsJSON` its abilities, tools, technologies and protocols,
`topSkillsJson` the five it leans on (`pickTopSkills`: +6 must-include, +3 a
mention in a requirements block, +1 a mention, capped at 6, up to +3 for
coming early; a one- or two-character name like Go matched as spelled),
`keywordsJson` its soft skills, must-include terms and past-tense action verbs
not banned, `conceptKeywordsJson` its architecture patterns, methodologies and
buzzwords, `conceptToolsJson` config/conceptTools.ts's rows its terms name
(the posting's spelling of the concept, the tools shuffled), the
responsibilities, the domain knowledge alone, and `softSkillGroupHeading` one
of services/skillGroups.ts's six. The three per-resume draws - the heading,
the tools' order, the title's shape - are SEEDED (`tailorSeed` =
sha256(resume id + posting hash), `mulberry32`, one sequence per draw), never
`Math.random()`: the same resume asked again is the same question and a cache
hit, and the parse can redo them. The section switches and layout are not
values: they decide how the answer is DRAWN. The Strengths switch reaches the
model only as `profileJson`'s `strengths` (sent while on), and `softSkills`
is never sent. Nothing is appended to a tailor-resume turn.

**Partial and Fully tailor** (owner's request, 2026-10-20; since v4.2 the mode
is the RUN's, see "Builder modes and the suitable resume"). `TailorMode` is
`'partial' | 'full'` (types/resume.ts) and comes from the task's
`payload.buildMode`, passed down explicitly: `tailorResume(resume, analysis,
choice, mode, signal?, cache?)` takes it as a REQUIRED fourth argument, so the
compiler finds every caller, and `buildTailorResumePromptValues(resume,
analysis, mode = 'partial')`, `buildCoverLetterPromptValues(..., tailored?, mode
= 'partial')` and `generateCoverLetter(..., tailored?, mode = 'partial')` take
it too. Choose Suitable Resume never reaches them (it tailors nothing). No
resume carries a mode: `ResumeSettings.tailorMode`, resumeDocument's
`getResumeTailorMode`, settingDefaults.ts's `envDefaultTailorMode` and the
`defaultTailorMode` of GET /api/resume/models are gone, and a resume stored with
a `tailorMode` is read past and loses it at its next save.
`DEFAULT_TAILOR_MODE` is the BUILDER's starting mode now (`defaultBuildMode`,
taking `suitable`, `partial` or `full`; an install that had
DEFAULT_TAILOR_MODE=full keeps meaning Fully Tailor). `tailorResume` runs
`tailor-resume-full` (`FULL_TAILOR_PROMPT_ID`, a single-prompt feature declared
from tailor-resume's own variables by promptService's `withFullyTailoring`) for
`full`, whatever `resumePromptId` says, and the resume's choice for `partial`;
`buildTailorResumePromptValues` is the one builder,
and only `profileJson` differs (`buildPromptResume(resume, mode)`: in Fully
each role is `{ title, company, startDate, endDate }` and there is no
`summary` - no description, achievements, role skills or location). In both,
`totalYearsExperience` is the resume's own, else the whole years from its
earliest role start to its latest end, "Present" being today
(`yearsOfExperience`: a model adding dates up does not know today's date,
and wrote 6 for 7). The parse
is the same (the facts, location included, come back from the source resume). The
revise pass after a Fully draft is asked for the whole checklist
(no `supportedTerms` filter) and given no figures note; its `draftJson` has
each role's dates in both modes, for the revise prompt's years rule. The
cover letter the tailoring answer brings is written by the same prompt; the
fallback (`generateCoverLetter`, when the answer brought none) is given, with
tailored content (`runResumeTask` passes it), the mode's projection with the
tailored resume's own summary and bullets in place of the source's
(`sourceAsTailored`, a role matched by company, title and dates, so
two stints keep their own), and without it the PARTIAL projection whatever
the mode - the untailored resume prints the source's own text. The posting's
action verbs reach `jobAnalysisJson` without the banned openers
(`analysisForPrompt`; a live Partial run opened a bullet with the posting's
"Architected"). The mode is in no cache-key field of its own: the
prompt id and `profileJson` differ. test/tailorModes.test.js holds all of it,
Choose Suitable Resume's tailoring-free path included.

`parseTailoredResumeContent` reads an answer - fresh, cached, or held by a page
- against the source resume as it is NOW, idempotently: the title is the source's
headline (else the model's, else the latest role's title - never the kind
alone; with none of them it is '' and the render prints getResumeTitle's
fallback) with the posting's role KIND (`roleKind`: any " - "/","/":"/"("
tail cut, then level words taken off its EDGES only - a leading Senior/Staff/
Lead..., a trailing II/3 - so "Tech Lead" keeps its Lead) composed on in one
of six seeded shapes unless the headline already says it
(`composeTailoredTitle`); roles keep
the model's order with their five facts restored from the source, a role the
source lacks dropped, one the answer left out put back with its own bullets
(`restoreRoles`; of two stints with one company and title, the one whose
dates agree with the answer's - `closestStint`: start before end, the same
text before the same years, else the source's order - so a resume typed oldest
first never swaps them), `description` '' always, and bullets sanitised and capped at
8 - the eight with the most distinct checklist terms (`capBullets`); an empty
role gets the source's own bullets. The summary is only made safe (spelled-out
years, one to twenty and both ends of a range, become numerals; a compound
like "Twenty-five" or "twenty one" is left as written); no sentence is added. `skillGroups` are kept as the
model wrote them (shape only), the soft group marked `soft: true` and
`softSkillGroupHeading` stored; `hardSkills` = `skills` the technical groups,
`softSkills` the soft group's while Soft Skills is on for the template, else
[]; strengths the source's own while on (and no list of skills to confirm:
nothing printed is checked against the library). With no `skillGroups` in the
answer, the source's own grouping or skills.
`dashBackstop` takes em/en dashes and a spaced `--` out of the summary,
bullets and cover letter (a range becomes a hyphen - a dash whose words on
both sides carry a digit, so `$5M–$10M`, `50%–80%` and `Q1–Q3` stay ranges,
never lists), and
`generateCoverLetter`'s result. `runResumeTask` runs client-held preview content
through the same parse (`finaliseHeldContent`), as `/resume/preview` does.

**The revise pass** (owner's `revise-resume-coverage`; services/reviseCoverage.ts,
called inside `tailorResume`, so /resume/preview (Partial and Fully) and the
queue task get it) runs after a FRESH
tailoring only - never on a cache hit or on content a page sent back - when
TAILOR_REVISE_PASS is on and the draft is missing a checklist term THE
SOURCE RESUME'S OWN WORDS CARRY, or has dropped a figure the source states. The
checklist (`TailorLists.checklist`): the top five, the must-include terms, the
concepts, the soft skills, the skills, the verbs - not responsibilities or
domain knowledge - filtered to `supportedTerms(checklist,
resumeEvidence(sourceAsShown(resume)))`: the same whole-word `containsTerm` over the
resume's headline, summary, skills and their headings, soft skills,
strengths, each role's title, description, bullets and skills, and its
certifications, projects, volunteering, courses, awards and publications -
never a company name, and each description as the tailoring saw it
(resumeService `sourceAsShown`: its sentences about the company dropped, as
for `companyContext`; `droppedResumeFigures` reads the same resume). The revise call reads the draft and not the source,
and the tailoring is told to leave out a term the source never names, so
asking for one would undo that on the one call that cannot check.
`missingTermsJson` is the supported ones the summary and bullets lack,
in that order, never one with a banned word or opener
(`RESUME_BANNED_WORDS`/`RESUME_BANNED_OPENERS`, which the revise prompt bans
outright), at most TAILOR_REVISE_MAX_TERMS. `figuresNote` is
`figuresNote(droppedResumeFigures(resume, draft))`: each role's bullets,
then its description's sentences, in the source's order, that carry a figure
(`figureTokens`: a number not glued to a letter, so S3, EC2, p99 are names;
separators dropped, a 19xx/20xx year left out) the draft's summary and
bullets no longer carry anywhere, at most `MAX_DROPPED_FIGURE_LINES` (12),
each under its company and title, with the one instruction to put the figure
back where a bullet of that role describes the same work - or '' (its
wording, `FIGURES_NOTE_WORDING`, is in the cache key). Nothing asks for a
figure the source does not state: the old "fewer than five figures" rule,
whose sentence asked for "modest" figures the work "implies", is gone. The call
(`callSite: 'revise-resume-coverage'`, the seat's TAILOR timeout) runs on the
resume's choice with `runChoiceWins` and the same signal, inside the queue's
provider pin. `mergeRevision` reads only a non-empty `summary` (not the
prompt's placeholder) and whole roles' bullets, the n-th returned (company,
title) to the n-th draft role with that pair when the answer returned all of
them - else, since the prompt lists only the roles it changed and the draft
it reads has no dates, the stint whose bullets it repeats most
(`stintSharingMost`; none shared, or a tie, and it is ignored) - and takes a line only when the
finishing would print all of it (resumeService's `printsWhole`; the revise
prompt has no pronoun rule, and the sanitiser drops a sentence with "we" or
"our"): such a summary keeps the draft's, such a bullet - or a repeat - the
draft's bullet at its place when the role came back with as many, else the
role keeps its draft bullets; a part returned as the draft has it is no
change. The result is finished by the same parse. An unparsable or empty answer changes nothing; a seat failure
leaves the draft as the resume (`[tailor] The revise pass failed ...`, once
per model and reason, and nothing cached); an abort is passed on. Nothing
about a resume is in a posting's analysis, on purpose: the analysis reads the
posting, not the resume, and one analysis serves every resume, for ever
(below).

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

Older builds had more providers: `openrouter`, the browser-chat pair
`claude-web` / `chatgpt-web` and the metered APIs `claude` (Anthropic),
`openai` and `deepseek`. Nothing of them is left - no alias map, no retired-id
maps, no in-memory repair, no migration-log readers (ac3df79's migrations
removed them from every database the guard admits; their logs and settings
snapshots stay in app_settings, unread). An id outside the catalog is simply
unknown: `coerceProviderId` answers null, a settings READ drops a model record
naming one (an admin save refuses it), a REQUEST naming one of their models is
400 `model-unavailable` like any other unknown model, a resume save naming one
is refused, a STORED resume choice naming one falls back to the default with
a warning once, and a prompt override naming a provider this build lacks is no
override (aiModelCatalog's `readStoredPromptModelSelection`: warned once, never
a throw, so Admin -> Prompts still lists; saving one is refused). The flat
`claudeCliEnabled` / `openrouterEnabled` flags are neither read nor served:
`providersEnabled` is the only shape, on both halves.

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
`TAILOR_STATIC_DIR` at temp dirs, and no test reads a real Google credential
(`TAILOR_GOOGLE_CREDENTIAL_SEARCH=off`, set by the runner and helpers.js). No real Google account has answered through
the Gemini seat: its successful fixtures are the real 0.62.0 CLI's envelopes
around fake answers, and the file names say so.

## Providers of one type

Owner decisions P1-P4. A PROVIDER is one place a type runs:
`config/aiProviders.ts`, stored as `aiProviders` in the app-settings row next to
`aiModels` (`{ id, type, label, homeDir, binaryPath, concurrency_max_requests,
enabled, createdAt, updatedAt }`, only what an administrator set -
`storableProviders`; an untouched built-in is not stored). The FIRST of each
type is the BUILT-IN one, id = the type id, so every stored model, prompt
override, resume and queued task (which all name a type) keeps working; its
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
`markItemRunning(batch, seq, provider)` puts it on `order_items.provider_id`,
served on GET /api/orders/:id to an administrator only as
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
analysis passes one (the queue task and /resume/preview).
`tailorCacheKey` is SHA-256 of `TAILOR_CACHE_VERSION` (2:
the model writes the skills block, roles are restored and capped, and a
resume's answer may be its revised one), the kind, the resume as the call
sees it (after `resumeForTemplate`) minus `createdAt`/`updatedAt`,
`resumeSettings`, `sectionOrder`, `profileId` AND the derived `matchKeywords`
(`resumeFingerprint`, hashed
under the
literal key `profile:` - build 4.1's spelling, which stays, or every cached
tailoring would miss: the layout, the
Soft Skills switch and the section order only decide how the answer is drawn,
so flipping or dragging them is a hit; which profile a resume is filed under
is the server's bookkeeping and no word of what the model is told, and it is
written when old resumes are filed and when one is moved, so a key that
carried it would miss every cached tailoring once; the keywords GET
/api/resumes serves with a resume are made FROM it and say nothing it does not,
so a resume read there and passed on is the same question as the stored one; the Strengths switch reaches the key
through `profileJson`, the chosen prompt and model through their own fields;
the nine new section lists are content and change the key, though none is
in `profileJson` yet), canonical JSON, the template id, the analysis id,
the provider type, model record id and model name, the prompt record's id and
the SHA-256 of its text, the SHA-256 of the rendered `promptValues` plus any
`appendToUserBody` text (built BEFORE the lookup, from the analysis alone - no
skill library, so a library add or confirm changes no key - and any change to
the code that builds them is a miss with no TAILOR_CACHE_VERSION bump), and
`extra`: for a resume, the revise prompt's id and the SHA-256 of its text, the
figures sentence's wording (`FIGURES_NOTE_WORDING`) and the
TAILOR_REVISE_PASS / TAILOR_REVISE_MAX_TERMS values; for a cover letter, the
company and role. No tailoring is cached without an analysis id. What is stored
for a resume is the resume as the model ended it - the tailoring call's RAW
answer, or, when the revise pass changed it, the parsed draft with the
revision folded in - so a hit makes no tailoring call AND no revise call. It
is kept only once it parsed, only when the asked-for model wrote it - the
tailoring and the revision alike: `CompletionResult.fellBack` (types.ts; set by
the Claude seat when `--fallback-model` answered - `answeredByFallback`, by
model FAMILY, never a string compare, since an alias comes back as a full id -
and by Gemini when another family answered, `geminiAnsweredByFallback`, `auto`
never) makes `tailorResume` / `generateCoverLetter` use the answer and skip the
write (`[tailor-cache] Not keeping this ...`) - and never when the revise call
failed (the next build asks for the revision again). They call
`createPromptCompletionResult`, the variant of `createPromptCompletion` that
answers the whole result. A hit runs `parseTailoredResumeContent` against the
resume again (idempotent on its own output), and an answer that no longer
parses is a miss. The charge never depends on it: a resume is priced at
submission. Read and write failures are a miss, warned once. Every caller and
both rules are pinned by test/tailorCache.test.js through the real routes. `TAILOR_CACHE_DAYS` (operational.ts, default 30, 1-3650)
prunes on `created_at` at boot and daily (`startTailorCachePrune` from
index.ts, unref'd).

## Job analysis runs once

**A posting is analysed exactly once, ever** (owner decisions J0, J1, J3, J5,
J8, O1, P5, P7; PLAN check 1). `services/jobAnalysis/gate.ts`'s
`getOrCreateAnalysis({ jd, link, sheetRow?, requestedBy?, storedOnly?, signal? })`
is the only function that runs the analysis's two prompts -
test/analysisGate.test.js reads every source file and fails on any other that
names `analyze-job-description` or `filter-google-sheet-job`, builds or parses
their completions (`build*PromptValues`, `parseJobAnalysisKeywords`,
`parseJobFacts`, `composeJobAnalysis`), sends the job field line, or keeps an
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
leaves); (3) ONE analysis on the analysis model: TWO calls in parallel (O1) -
the analysis prompt (`callSite` `analyze-job-description`, the keywords) and
the Job Facts (Filter) prompt (`callSite` `filter-google-sheet-job`, the
facts, `temperature 0`, `maxTokens` 1000), both `runChoiceWins`,
`useExactPromptId`, JSON - composed into one row, stored with
`INSERT ... ON CONFLICT DO NOTHING` and read back. Either failing (a seat, an
answer that does not parse) aborts the other (a controller of their own under
the shared one, which the last waiter leaving still aborts) and stores
nothing - the only way a posting reaches a model twice, bar a facts answer
that names no job field at all (the key left out, null or blank - not
`unclassified`, which is an answer): the facts call is asked ONCE more, then
the posting is stored `unclassified` with an `[analysis] ... named no job
field, asked twice` warning naming its content hash; and bar a stored row
whose `analysis_json` cannot be read as an object (damaged outside the
program): it reads as absent, so its posting is analysed once more (both
calls) and the answer written into THAT row (`repairUnreadableRow`, under an
IMMEDIATE transaction), never once per request. The job field is the CODE's
question, never a variable (services/jobAnalysis/jobFieldLine.ts):
`JOB_FIELD_PREAMBLE` - "ONE MORE FIELD ... "job_field": exactly ONE id from
the JOB FIELDS list" and `renderJobFieldListForPrompt()` - goes BEFORE the
facts record's stable part through `CreatePromptCompletionInput.systemPreamble`
(promptExecution.ts `runAssembled`, the same order in the fold for a seat
without system blocks), so it is cached and no edit can drop it, and the
one-line `JOB_FIELD_REMINDER` after the posting through `appendToUserBody`.
`prompt_hash` is SHA-256 over both records' texts and those two constants.
Nothing about a model, a prompt, a resume or an account is part of a
posting's identity, so an edit of either prompt or a new analysis model
reaches only postings never analysed before - a posting analysed by an older
build keeps that analysis, and every reader takes both shapes - and there is
no re-analyse anywhere (the admin Prompt Test page's
`/resume/analyze-prompt-test` goes through the gate too, makes both calls, and
ignores the `promptId` and `model` it is sent).

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
('' on older rows) is the company a caller knew the posting by -
the gate takes an optional `company` and records it on insert or, when the row
has none, afterwards (`attachCompanyName`, '' only; the builder routes, the
queue task, the submission step, the Job Filter and the reporter run all pass
it) - because the analysis leaves company names out and the lake's merge hashes
on it. Never part of a posting's identity.

**Callers pass `analysisId`**, never an analysis: `/resume/analyze` answers the
analysis plus `analysisId` and `jobFieldLabel`; `/resume/preview` and every job
of `/generation/batches` take `analysisId` (must exist: 400 otherwise) or
`jobDescription` + `jobLink`, and the preview answers `analysisId`. A
`jobAnalysis` object in any body is NOT read - it was a
way to forge a job field. `/generation/batches` resolves ONE analysis per job
at submission, before the resume is chosen for the job (`submit.ts`'s
`resolveAnalysesAtSubmit`, no model call, `storedOnly`; the matcher reads that
same analysis), and puts it on the job's task as `payload.analysisId`; a job
with none is analysed by its task through the gate (a posting repeated in the
batch waits for that call), which then stamps the job's task
(`AnalysisHooks.recorded` -> queue/index.ts `recordJobAnalysis`), so a retry and
a restored task skip the analysis step. Per-resume
analysis prompts are gone (`resumeSettings.analyzeJobPromptId` is dropped on
save, a variant cannot be created or activated, an old one is listed but never
active).

**The analysis** (`JobAnalysis`, types/template.ts) is the keyword half -
`parseJobAnalysisKeywords` / `normalizeJobAnalysisKeywords` (resumeService):
lists cleaned, soft skills in the posting's own order (never re-sorted),
responsibilities as the noun phrases the prompt wrote (never reworded around a
leading verb; a trailing full stop dropped), an employer-voiced or meta phrase
dropped - `RESUME_META_TAILORING_PATTERN` is "maps to", "target role",
"keyword coverage", "for this role", "aligned with the job" and their kin,
never the bare "ATS" or "job posting" - and `jobMeta.seniority` as answered
(`unknown` included); a `jobField`, `industry`, `salary` or `filter` key in
that answer is IGNORED - plus the facts half, `parseJobFacts` /
facts.ts's `normalizeJobFacts` over the facts call's TOP-LEVEL snake_case
answer (`_confidence` companions ignored), composed by `composeJobAnalysis`:
`jobField` (one id from `config/jobFields.ts` - the owner's list at bullet
level, areas 1-8, 10 and 11; area 9 is not offered - else `unclassified`,
checked in code by `normalizeJobFieldId`), `salary` `{ min, max, currency,
period, raw }` (only what the posting states; the facts prompt asks for no
currency, so a new analysis's is null and never inferred - `formatSalary`
then prints the bounds without one), and `filter` (the Job Filter's facts,
with `seniority` - the facts call's word, one of `SENIORITY_VALUES` else
`not_specified`; OPTIONAL on `JobFilterFacts` and never defaulted, so an
analysis stored before has none). An off-list filter word becomes
`not_specified` - except a clearance, which fails CLOSED (`normalizeClearance`:
an unknown word is kept, and fails the filter; only an absent or empty one is
`none`), and words are folded across spaces, `-` and `/` (`TS/SCI` is
`ts_sci`). An analysis stored in v6 may carry `industry` (one id from
`config/industries.ts`, or `not_specified`; `normalizeIndustry`: an id, a
label, a known short form or a keyword, else `other`); a new one NEVER does -
its industry is the facts call's company category, derived when read. Its industry,
job type and clearance are derived when READ, by facts.ts's pure
`industryOf` (its own `industry` whenever the key is there; else its filter's
company category, `COMPANY_CATEGORY_INDUSTRY`; else keywords in its free-text
`jobMeta.industry`; else `not_specified`), `jobTypeOf` ('remote' | 'hybrid' |
'on_site' | '') and `clearanceRequiredOf` (false only for `none` and
`not_specified`, so an unknown clearance word is required, failing closed) -
`analysisFactsOf` is all three, and every place that shows them uses it.
NOTHING re-asks a model for an older analysis's industry, and nothing is
written back into one. The tailoring prompt is given none of the four
(`jobField`, `industry`, `salary`, `filter` are left out of
`jobAnalysisJson` by `buildTailorResumePromptValues`' projection,
tailorContract.ts `analysisForPrompt`, so none of them changes its values or
any tailor-cache key - pinned by test/tokenBudget.test.js; `jobMeta.industry`,
the posting's own word, is in it as it always was, and `filter.seniority` goes
with `filter` - the tailoring prompt sees only `jobMeta.seniority`). Both prompts' variables are `jobDescription` (REQUIRED) and
`jobLink` (offered; the owner's texts use the posting alone, at the end, so
each call's cached system part is byte-identical across postings - test
pins it). An administrator's record without the posting, or naming the old
`[[jobFieldList]]` / `[[industryList]]` / `[[jobContent]]`, is refused on save
and, stored, is `needsUpdate` and never run - so is any stored edit of either
saved before the owner's texts (`contractSince`), however few variables it
names - the shipped prompt runs in its place (see "Prompt variables are the
code's, strictly" above); the analysis
turn carries no addendum. The analysis model is
`analysisModelId` in the admin settings ('' = the app default model; a stale
one falls back with a warning; a save CHANGING it to a model that cannot run
is refused by name) - never in an ordinary account's payload. With none
stored it is `.env`'s `ANALYSIS_MODEL` (a runnable record's id or display
name, else warned once and ''), and `settingSources.analysisModelId` says
which; a deleted model's stored choice is removed, not blanked.

**The Job Filter** (routes/jobs.ts) makes no model call of its own (J8): a row
whose link is stored is judged on that analysis with no page fetch; otherwise
the page is fetched and handed to the gate - whose facts call is the owner's
filter prompt. The verdict is
`evaluateJobFilterAnalysis(jobFilterAnalysisOf(analysis))`, seniority read as
`filter.seniority ?? jobMeta.seniority` (only the facts call's list has intern,
director and VP, which the filter fails; an older analysis's `jobMeta.seniority`
was asked in those same words). It runs on the
caller's own sheet only (the tab named, else All, a job tab only - 409
`not-job-tab` otherwise), reads C:E once, judges EVERY row with a link and
answers each to the page (`rows: [{ row, company, title, link, result:
'Pass'|'Fail'|null, reason, reused, error? }]`), and writes NOTHING into the
sheet - no verdict, no analysis cell (owner's default). The
`filter-google-sheet-job` prompt is back as the analysis's facts call, labelled
"Job Facts (Filter)" (an edit an older build stored of it is listed as its
built-in edit, flagged `needsUpdate` - it reads `[[jobContent]]` or was saved
before the owner's texts); the
`AI_*_TIMEOUT_MS_FILTER` budgets stay retired - the facts call takes the
seat's default budget.

**The account's own sheet** (owner decisions S1-S3;
`services/sheets/accountSheet.ts`). Every job route - Build Resumes' sheet
mode, the Job Filter, the reporter run, the push, Admin -> Google Sheets, and
jobExport.ts's writer - reads and writes the caller's OWN spreadsheet and no
other (`resolveAddressableSheet`: any other id is 404 before Google is asked,
an administrator's included). `googleSheetsSources`, an older build's saved
"shared" sheets, is gone from the types, the defaults and the normaliser, so
the next settings save drops it from a stored row. A sheet has two tabs of
the app's: **All** (first, the default of every route) and **Temp For AI**
(second, what the push replaces). A new sheet is created with All and gets
Temp For AI at index 1; an ensure that finds one missing - a sheet not yet at
layout 2, or a tab deleted since - adds All at 0 and Temp at 1 (at 0 while
All's name clashes, so the All added once it is free lands it second); any
other tab is never read, written, re-headed, protected or cleared - it is not
a job tab. A tab already called All
or Temp For AI that is not a job tab is left alone and reported (`conflict: {
tabs, message }` on the state, logged once when found). Only the Job Sheet
page looks at the two tabs again - `GET /api/sheet?recheck=1`
(`describeAccountSheet`'s `recheck`, a verifying ensure on EVERY such load, not
only while a clash is recorded), so a clashing tab renamed since is replaced,
and an All or Temp For AI deleted or renamed under a recorded layout is put
back, at its next load - the one way a REPORTER gets a deleted All back; every
other read, the shell's on every page load included, answers from the row (a deleted tab's link included), and a look Google
refuses falls back to it. It is
recorded in `users.sheet_layout` (2) with `sheet_all_gid` / `sheet_temp_gid`
(NULL at layout 2 = that name clashes). Once layout 2 is recorded a sign-in
makes NO Google call; a verifying ensure (the push, the Job Sheet page's look)
lists the tabs once and puts back a deleted All or Temp For AI; the boot
backfill allocates a sheet only for an account that has none
(`listAccountsWithoutSheet`). The state is `{ configured,
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
push, the export writer) goes through it. Every row of a job tab is 21 px high
with its data cells CLIPPED and the Date column formatted as a date (`jobRowLayoutRequests`,
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

**The export writer** (`services/sheets/jobExport.ts`, owner decision F4: the
Apify job search, its routes and `backend/scrapers/` are gone, and only its
sheet writer was kept - for Find Jobs' Export into Sheet, its one caller).
`appendJobRows(account, tabName, rows)`: own sheet (404 otherwise), the tab
named or All; a tab the account sheet reports as a name CLASH (`state.conflict`
from `resolveJobSheetTarget`, which now answers the ensured state too) is 409
`tab-name-clash` in the Job Sheet page's sentence ending "then export again.",
before anything is read; a job tab only (409 `not-job-tab` before anything is
read; an empty tab is laid out) - and the app's own All or Temp For AI, its row
1 edited, refused in `ownTabNotJobTabSentence`'s words (rename or delete it,
and the next verifying ensure adds a new one), never the "choose All or Temp
For AI" of `notJobTabSentence`. ONE read of A:E gives the duplicate check
(`jobDuplicateKeys`: the row's link as the store keys it - `linkKey`,
tracking parameters, scheme and a trailing slash aside - else, with no usable
link, the company as the lake compares it, `normaliseCompany`, and the title
folded; a row sharing a key with one there, or with one written earlier in the
call, is skipped), the first row after the last used one and NO(DATE) - 1 +
the highest number on rows dated today (in any form `sheetDateOfCell` reads).
It writes RAW in chunks of at most 50 rows and about 1.5 MB of JSON
(`EXPORT_WRITE_MAX_ROWS`/`_BYTES`, googleSheets.ts `boundedWriteChunks`, which
the push's chunks use too) - Date as a serial number (a real date), NO(DATE),
Company, Job Title, Job Link, Job Description (`descriptionCell`) - and, for a
`JobExportRow` carrying `analysis`, the six G-L cells in the same write (A:L);
never a column the caller names. Before each chunk its rows are read again
(A:F) and a row holding anything moves the rest below the last used row (409
`sheet-changed` after five tries), and one `:batchUpdate` grows the grid when
the chunk runs past it and lays the rows out. Writes to one tab are serialised
in-process. Its Google calls are a seam (`setJobExportSheetsClientForTests`,
the e2e stub's `export-*` events) whose real client looks the integration's
functions up at each call, so a test swapping one of googleSheets.ts's exports
is answered by its swap. It answers `JobExportResult` (`spreadsheetId,
spreadsheetTitle, tabName, tabUrl, date, updatedRanges, rowsWritten, startRow,
endRow, firstNo, lastNo, unresolvedJobLinks, skippedDuplicates`);
`exportPlaceOf` is its pure placement. test/jobSheetRoutes.test.js drives it.

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
sends its `analysisId` to preview and every batch; a change of
company, role, resume or model never asks again (the held analysis is NOT
reset with the other outputs), an edited description is another posting, and
a 400 from a request that named it lets it go (`dropsHeldAnalysis`).
components/AnalysisFacts shows its title, job field label, job type,
seniority, clearance and salary - each only when the analysis says it
(lib/jobAnalysis.ts `analysisFacts`: `formatSalary`, `JOB_TYPE_LABELS`,
`clearanceRequiredOf` and `seniorityOf` - the facts call's
`filter.seniority`, else an older analysis's `jobMeta.seniority`, what the
Job Filter judges - each a copy of the server's, run against it by
test/frontendAnalysis.test.js) under the description, in the preview
dialog and on Prompt Test, which has no prompt or model select any more,
names both prompts, and marks in the posting only the keyword half
(lib/analysisHighlights.ts `collectHighlightTerms`: never `jobField`,
`industry`, `salary` or `filter`, which once marked every "us" in "join us"). The sheet panel sends `sheet: { tabName }` (the account's own sheet,
the server's default - there is no other) and each row's `jobLink`, never a
cell; it reads the rows' C:F, then G:L in a SECOND, best-effort range read (a
job tab narrower than twelve columns refuses a range past its grid - the rows
then say *When built*) to show which rows skip analysis. It has no sheet
select and no column mapping. Every page that picks a tab - the panel, the
Job Filter, Report Jobs - draws the server's listing through
lib/sheetTabs.ts: `sheetTabOptions` lists a `layout: 'other'` tab DISABLED as
*(not a job tab)*, whatever its name, and `chosenTab` starts on the server's
`defaultTab` (All) and never yields an `other` tab, however the select was
driven; test/frontendJobSheet.test.js runs both against
`listAddressableSheetTabs`. The note under the select is
`unreadTabsNoteFor(tabs)`: `UNREAD_TABS_NOTE` (copy a job from a tab that is
not read into C to F of All), or, while the tab named All is an `other` one
(the name clash), `UNREAD_TABS_NOTE_ALL_CLASH`, which says to rename or delete
it and open Settings > Job Sheet first - never to paste into a tab no route
reads. Both spell the tab name out on purpose: Next 16.1's
Turbopack folded an EXPORTED constant built from template literals joined
with `+` at build time and dropped the middle literal of three (not tried
again on 16.3.8), so write such a constant as plain string literals. The Job Filter page shows each row's
verdict (lib/jobFilterDisplay.ts - its reason words are drift-checked against
services/jobFilter.ts's reasons by the same test) and sends only `{ tabName,
startRow, endRow? }`. The analysis model is chosen on Admin -> Models (owner
decision M2; General has no select for it any more): a *Default* and an
*Analysis* badge in the Model Library - Analysis on the model postings are
analysed on, the default model's while none is chosen - and each row's **Set
default** and **Use for analysis**, which on the chosen model is **Use the
default model** (`analysisModelId: ''`); above the table the two choices
with their sources ("Default (the default model)" for an analysis model
nobody set) and Reset to default, and a chosen model that stopped running
named as one that cannot run, postings meanwhile on the default; Admin -> Prompts lists
the features in the server's order (`FEATURE_ORDER`, held to
`listPromptFeatureKeys`) and offers no New Variant, Duplicate, Save Active or
model override for the four single-prompt features, saying why in each one's
own sentences (`SINGLE_PROMPT_NOTES`: `about`, and `model` in the override's
place); it marks a record the server sends `needsUpdate` (a *Needs update*
pill and `notRunLine` - *Not run: it does not use [[...]]*, *... uses [[x]],
which this version does not supply*, *... dates from an older version of this
prompt* from the server's `savedForOlderVersion`, or several), pills each required variable
*Required*, and in the editor says what runs in a flagged record's place and
what the text as typed lacks or names that it is not given - refusing Save,
with no request sent, in the server's own sentence and order (`saveRefusal`:
an unknown variable first, then a missing one; a feature's prompt only - an
unattached one's variables are its own rows, which the server tidies first).
Those decisions are lib/promptRequirements.ts (`SINGLE_PROMPT_FEATURES` /
`isSinglePromptFeature`, a copy of the server's `listSinglePromptFeatures`;
`requiredVariables` read from `allowedVariables[].required`,
`missingRequiredVariables`, `unknownVariables`, `missingVariablesSentence`,
`unknownVariablesSentence`, `needsUpdateNote` - which names what is missing,
what the server no longer supplies and an older version's edit, which "saved
again" clears; no runtime import), which
test/frontendAnalysis.test.js holds to `listSinglePromptFeatures`,
`listRequiredPromptVariables`, `validatePromptContent` and `updatePrompt`'s
refusal. The page loads its model options with `adminApi.getSettings` (there
is no `/api/admin/ai-models` any more). The resume
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
NULL` (the outbox) - plus `job_lake_history(lake_id)` and `job_reports`' two
(below), all in `INDEXES_AFTER_COLUMNS`. test/jobLakeStore.test.js pins them
and their plans (`FIND_BY_HASH_SQL`, `LIST_DEFAULT_SQL`, `UNSYNCED_SQL`,
`HISTORY_SQL`, `FIND_JOB_REPORT_SQL`, `findJobReportsSql` and
`DELETE_LAKE_REPORTS_SQL`).

**Facts** (v6): `job_lake` and `job_lake_history` carry `job_type` ('remote' |
'hybrid' | 'on_site' | ''), `clearance` (0/1) and `industry` (a
config/industries.ts id or `not_specified`) - the analysis's, through
`lakeJobFromAnalysis` -> facts.ts `analysisFactsOf`, never the caller's;
written on insert, replace and the history copy. Never NULL in a lake the
guard admits (a NULL `job_type` refuses the database: ac3df79 filled every row
an older build wrote, from its stored analysis), and read with defaults
anyway: `toEntry` / `toHistory` serve `jobType` ('' when not stated),
`jobTypeLabel` (Remote, Hybrid, Onsite, ''), `clearance` (a boolean),
`industry` (`not_specified` by default) and `industryLabel` ('' for
`not_specified`) - never null.
`LakeFilters` (and GET /api/admin/job-lake, and Find Jobs) filters on `jobTypes`
(`not_specified` = ''), `clearance` (`true`/`false`) and `industries`, with no
index of their own: the page still reads `idx_job_lake_updated` in order, no
sort (pinned); the GET answers `options: { jobTypes, industries }` for the
page's list boxes.

**The lake's search** (database/jobLakeRepository.ts `lakeReadSql`, read by
services/jobLake/filters.ts `readLakeFilters(source, { requestedBy })` - the
ONE reader of Admin -> Job Lake's GET /, its POST /push and Find Jobs' GET
/api/jobs/lake). `LakeFilters` holds six LISTS - `keywords` (`q`),
`companies`, `jobFieldIds` (`field`), `requestedBy`, `jobTypes`, `industries`
- any value of which matches, and the dates, salary range and clearance; a
list filter is a string, the key repeated, `key[]=` or a JSON array (each
trimmed, empty and repeated values dropped, a comma never split); a single
filter refuses a list (*<Label> takes one value.*); a non-text value or
`key[x]=` is *A filter value must be text.*; at most 10 keywords, 25
companies, 25 requesters (`LAKE_FILTER_MAX_VALUES`), and the keywords at most
25 words in all (`LAKE_KEYWORD_MAX_WORDS`, counted by `keywordWords`, the
index's own split - not a letter or digit, OR one of the 21 code points JS
calls letters that `unicode61` still calls marks, U+19B0-U+19C0,
U+19C8-U+19C9, U+1CF2-U+1CF3 (`KEYWORD_SEPARATORS`; jobLakeStore.test.js
sweeps every NFKC-stable letter and digit through the real tokenizer, so a
Unicode or SQLite drift fails the build): *Search for at most 25 words in
all, across the keywords.*), each keyword at most `LAKE_KEYWORD_MAX_LENGTH`
(100) code points (*A keyword can be at most 100 characters.*, the backstop
for such a drift); and `requestedBy` from anybody the route does not let name it
(Find Jobs, for a non-admin) is 403 `not-an-admin`, *Only an administrator can
filter jobs by who requested them.*, before its count. Checked in that read
order (q - its count, then each one's length, then its words - company, requestedBy, field, salary,
dates, jobType, clearance, industry), which lib/jobLakeDisplay.ts
`lakeFilterProblem` copies. A list is read in ONE pass (`filterValues`: a Set,
each value judged as it comes - past the cap or off the closed list refused
right there), as Find Jobs' export ids are (`readLakeIds`): a body of a million
values once took minutes comparing every pair. `ftsQuery(keywords)`: each
keyword's words ANDed - `"w"*`, but a word of one or two characters `"w"`,
matched whole (*Go* is not *Google*, and a short prefix was the costly term) -
keywords ORed in parentheses, never more than 25 words asked whoever calls; a
search's word budget, not a keyword's, bounds its FTS5 work (ten keywords of
twelve one-letter prefixes took seconds on 20,000 jobs). `lakeReadSql` never
sorts the lake: no filter is exactly
`LIST_DEFAULT_SQL`/`PUSH_DEFAULT_SQL`; the companies (normalised; none left =
null, matches nothing), else 1 to `LAKE_MERGE_MAX_ARMS` (25) fields, DRIVE - one
value a seek on its `(col, updated_at)` index, several one SELECT per value
joined by UNION ALL and ordered as a whole (`MERGE (UNION ALL)`, no TEMP
B-TREE), the other indexed filters inside each arm as `+job_field_id` /
`+requested_by`; no driver walks `idx_job_lake_updated` (requested_by plain,
so Requested by alone seeks its index and sorts those rows only); keywords are
`WITH lake_hits(id) AS MATERIALIZED (... MATCH ?)` tested as `+id IN`; the
count is a separate plain statement. test/jobLakeStore.test.js pins each plan,
and that no plan pairs a plain `SCAN job_lake` with a TEMP B-TREE.
`getLakeEntriesByIds` (`lakeEntriesByIdsSql`, a rowid seek each) and
`suggestLakeCompanies` (`LAKE_COMPANY_PREFIX_SQL`, a `company_key` range from
the normalised prefix to `prefixUpperBound`, grouped in index order, the newest
spelling) serve Find Jobs. `requesterLookup` is services/jobLake/requesters.ts.

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
analysis is final - it would be unclassified again). `findJobReportsSql` is a
plain seek: a record always names a lake row that exists, because this build
deletes the two together, and the guard's first stamp deleted, once, every
record an older build (which knew nothing of the records) left naming a row
it had deleted.

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
`already`, never recorded. A report's sheet row (`LakeJob.reportedFrom`) goes
on its `job_reports` record; `job_lake.report_ref`, which an older build
decided its own `already` on, is neither in SCHEMA nor written (an upgraded
database keeps the column, unread). The analysis is marked merged in the same
transaction. The decision reads the database ONLY
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
`reportRateMilli` (global; unset = `JOB_LAKE_REPORT_RATE_USD`, else $0 -
nobody paid until set), `duplicateWindowDays` (unset =
`JOB_LAKE_DUPLICATE_WINDOW_DAYS`, an operational setting, default 60, 1-3650;
`resolveDuplicateWindow` says `admin | env | default`), `dailyCapMilli` (unset =
`JOB_LAKE_DAILY_CAP_USD`, else no cap) - the value stored here WINS over .env
for all three, and `readLakeSettings` serves `settingSources` and
`settingDefaults` for them (`reportRateSet` is still "an administrator stored
one"). PUT takes `reportRateUsd`, `duplicateWindowDays`, `dailyCapUsd`
(null/'' clears: Reset to default; `dailyCapUsd: 'none'` stores
`noDailyCap`, an administrator's "no cap" that beats `.env`'s) and refuses
`*Milli`. Admin -> Accounts'
list carries `globalReportRateMilli`.

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
names - a list filter's values a JSON array - read by the one `readLakeFilters`
(services/jobLake/filters.ts) that reads GET /'s query string, so a
push holds exactly what Search shows and a bad filter is refused in Search's
words, 400, before Google is asked anything). The CALLER's own sheet and its
Temp For AI tab only - no spreadsheet or tab is read from the request: one
push per administrator at a time (in memory, 409 `push-in-progress`);
`ensureAccountSheet(admin, { verifyTab: true })` (a Temp For AI deleted or
renamed since is put back; the name held by a tab of the person's own is 409
`tab-name-clash`, the Job Sheet page's clash sentence ending "then push
again."); Temp For AI inspected once and refused unless a job tab (409
`not-job-tab`, `tempTabNotJobTabSentence`), then verified on that read; the
rows (`listLakeForPush(filters, JOB_LAKE_PUSH_MAX_ROWS)`: `lakeReadSql`, newest
first by `updated_at DESC, id DESC`, read as cap + 1 with the COUNT in the
same read transaction; `PUSH_DEFAULT_SQL` walks idx_job_lake_updated, pinned
by test/jobLakePush.test.js); ONE `:batchUpdate` - `appendDimension` ROWS when
the grid is short, `clearDataRowsRequest` (an `updateCells` of A:L from row 2
to the end, fields `userEnteredValue,userEnteredFormat.backgroundColor`, so a
duplicate's red paint goes too - never the header, never a column past L),
`jobRowLayoutRequests`; then RAW writes of A:L in chunks of at most
`PUSH_WRITE_MAX_ROWS` (200) rows and `PUSH_WRITE_MAX_BYTES` (1.5 MB of JSON;
one bigger row goes alone - googleSheets.ts `boundedWriteChunks`). A row is Date (`sheetDateText` of `updated_at` in
SHEET_TIMEZONE, sent as `sheetDateSerial`), NO(DATE) (1, 2, ... down each
day's rows), Company, Job Title, Job Link, Job Description (analysisColumns.ts's
`descriptionCell`: cut at 50,000 with `ANALYSIS_TRUNCATED_MARKER`, never
through a surrogate pair) and `analysisColumnValues` of
the row's stored analysis (services/jobLake/index.ts `lakeAnalysisCells`, which
the export uses too) - six blanks when it has none - so a build from the
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
test/routeAccess.test.js, and Find Jobs' four on the builders' `/api/jobs`
router (`requireUser`, so no row of their own: GET /lake, /lake/companies,
POST /lake/export, GET /lake/:id - see "Find Jobs" below). The run's summary
is `{ added (added + replaced), total, duplicates, unclassified, replaced,
skipped, failed, alreadyReported, earnedMilli, balanceMilli, sheetUpdated }`.

**The pages.** lib/jobLake.ts is the API's shapes; lib/jobLakeDisplay.ts
everything the three pages decide, with no React and no runtime import but
lib/format.ts, lib/reporterPay.ts and lib/settingSources.ts, so
test/frontendJobLake.test.js runs it against the server: `readReportRange` is
`readRunRange`'s refusal word for word, `lakeSettingsProblems` /
`lakeSettingsChanges` are `updateLakeSettings`'s (only what changed is sent,
AS TYPED, '' to clear), `lakeFilterProblem` the lake routes' 400s in their read
order (the counts against `LAKE_FILTER_MAX_VALUES` and the words against
`LAKE_KEYWORD_MAX_WORDS` by `keywordWords`, each keyword's length against
`LAKE_KEYWORD_MAX_LENGTH`, copies, said in
`LAKE_FILTER_CAP_SENTENCES` - the server's words, which the form's full boxes
say too; each job type and
industry against the route's own `options` lists, never a copied one),
`draftFilters` what Search takes of the draft (`LakeFilterDraft`: the chips,
and what is typed in Company - one company - and Full text - split on
`LAKE_KEYWORD_SPLIT`), `lakeFilterBody` the one spelling of the filters sent -
the query string's parameters (`lakeQueryString`: a list's values each under
its own key) and Push to Google Sheet's body (a JSON array) alike, in
`LAKE_FILTER_ORDER`; `sameLakeFilters` ignores a list's order - with `describePushConfirm` /
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
Payments keeps them; the lake's filter form is components/jobLake/
LakeFilterForm.tsx - the ONE form, Find Jobs' too - its boxes drawn FROM
`lakeFilterOrderFor(requesters !== null)` (`LAKE_FILTER_ORDER`, without
Requested by when the page hands it no people) and `LAKE_FILTER_LABELS` - the
owner's order: Updated from, Updated to, Requested by, Job field, Job type,
Clearance, Industry, Company, Salary from, Salary to, Full text
(frontendJobLake.test.js pins it, the form's `FILTER_INPUT_IDS`, and that both
pages draw `<LakeFilterForm`) - the six list filters as components/ui/
MultiSelect.tsx boxes: Job field grouped by area, Job type offering
`LAKE_JOB_TYPE_CHOICES` (a copy of `listJobTypesForClient` less
`not_specified`, drift-tested), Industry the route's own
`options.industries`, Requested by `email (role)`, Company creatable with
suggestions from GET /api/jobs/lake/companies (asked 200 ms after the typing
stops, the request before aborted), Full text creatable and split on commas;
Clearance a select, Required / Not required; the dates and salary plain
boxes. The filters apply on Search (a bumped epoch on usePagedList), which
turns what was typed into chips. What is typed into the four lists that take
no value of their own (Job field, Job type, Industry, Requested by) only
narrows them; it is the form's own (`filterText`), and Search and Clear both
empty it - Clear is pressable for it alone, and then asks the page nothing. The table's cells are components/jobLake/
LakeCells.tsx (`Cell`, `WebLink`). **Push to Google
Sheet**, beside Search, pushes `applied` - the search on the page, never boxes
changed since, which its kit Dialog confirm says - after naming the count THAT
search's latest answer gave (`searched`, guarded against an older answer
landing late; `pushBlocker` waits for it) and that it replaces Temp For AI of
your own sheet; the result is a Notice (warn when capped) linking to the tab
through `safeWebLink`, a refusal an ErrorNotice. The table and Details show
each job's Job type, Clearance and
Industry in the server's words (`jobTypeLabel`, `industryLabel`;
`lakeFactCells`, and `describeLakeFacts`, which says *Not stated* for a blank
one); Details is a kit Dialog with
Revoke reward and Delete + "Also revoke the reward"; the money boxes are text, never `type="number"`,
and the page is in frontendMoney.test.js's FRONTEND_MONEY_SOURCES.
test/e2e/report-run.js drives both against stub-report-sheets.js and
stub-seat.js, recording the reporter's earlier reports in the database first
(report-sheet-rows.js, which both share) - a Lake Status cell decides nothing;
test/e2e/lake-push.js drives the filter form and the push against
stub-lake-push-sheets.js (every account its own spreadsheet, the cells written
to a JSON file in DB_DIR for the script to read), then builds from the pushed
rows: their cells are read and nothing is written back.

**Find Jobs** (`/jobs`, owner's request; app/jobs/page.tsx,
OrderJobsDialog.tsx, FindJobDialog.tsx; routes/jobs.ts, services/jobLake/
findJobs.ts) is the lake for every builder - the rail's Find Jobs, a page now,
not the external link to the sheet it was (`NavItem.external` is gone). GET
/api/jobs/lake reads `readLakeFilters(req.query, { requestedBy: isAdmin })` and
answers `{ rows, total, limit, offset, options, exportMaxRows }`; a row is
`findJobsRow`'s explicit ALLOWLIST - `id, company, title, url, jobFieldId,
jobFieldLabel, salary, jobType(Label), clearance, industry(Label), updatedAt,
analysisId`, an administrator's adding `requestedBy, requester, source` -
never a spread of `LakeEntry` (no reward, seen count, hash, key or sync, for
anybody: test/findJobs.test.js holds the key sets). GET /lake/companies
(`?prefix=`, a string, cut at 100; `limit` 1-25, default 10) is
`suggestLakeCompanies`; GET /lake/:id the row plus `jobDescription`, no
history (`readLakeId`: 404 for junk). POST /lake/export `{ ids }` is
`exportLakeJobs`: `readLakeIds` (400 *Choose the jobs to export.* / *Each job
is named by its number in the lake.* / `too-many-jobs` past
`JOB_LAKE_EXPORT_MAX_ROWS`, an operational setting, 200, 1-1000, with
`maxRows`), `getLakeEntriesByIds` (none: 404 `jobs-not-found`), then
`appendJobRows(account, All, ...)` with each job's `lakeAnalysisCells` -
answered `{ exported, skippedDuplicates, missing, tabName, tabUrl, startRow,
endRow, maxRows }`; a sheet or tab in the body is never read. The app's own
All (or Temp For AI) whose row 1 was edited keeps its recorded id, so no clash
is on record: the writer refuses it in `ownTabNotJobTabSentence`'s words (409
`not-job-tab`, *... so nothing was exported into it. Rename or delete that tab
in Google Sheets, then export again: a new All tab is added.* - the push's
`tempTabNotJobTabSentence` is the same function), never "choose another tab",
which Find Jobs has none of. The page:
PageHeader with **Go to my sheet** (the sheet's `defaultTabUrl` through
`safeWebLink`, else the session's `sheetUrl` through `sheetLinkFor`; off, with
a warn Notice of the server's sentence, when Sheets is not set up), the form
(Requested by for an administrator alone, with `accountsApi.list`), a toolbar
(`describeLakeTotal`, `describeSelection` and Clear selection, **Export into
Sheet** and **Order Immediately**, each off with its `exportBlocker` /
`orderBlocker` sentence as its title - every reason those reach is also said
on the page), the pager, and the table with a box per
row and the page's select-all (`pageSelectionState`, indeterminate by a ref),
`tr[data-selected]` tinted (globals.css; find-jobs.js compares the cells' computed colours, light and dark - the attribute alone passed with the rule lost). The table is `data-density="compact"` (8px side padding; a `hyphens-auto` cell hyphenates only a word of 12 letters or more), Updated the date with the full time as its title, Requested by cut to the column with the whole of it as its title, and Details `data-sticky-end` (held at the box's right edge while it scrolls). NO column can be widened by its rows: Company, Job field, Title (WebLink's `wrap-anywhere`), Salary and Industry each have a `min-w-*` floor and break inside a word wider than it - a catalogue label such as *Telecommunications* or *Localization and internationalization* (Job field and Industry also `hyphens-auto`; Chrome never hyphenates a capitalised word, so *Telecommunications*, the one industry word wider than 96px of text, breaks without a hyphen), a long title, a raw salary - and the rest are fixed (`whitespace-nowrap`, the box, Details) or capped (Requested by), so no row can widen the table past its floors: at most 1073px for an administrator in Geist (narrower with short Requested by addresses), inside the box at 1440px - 1118px, or 1103px beside Windows Chrome's 15px scrollbar. A user's is at most 945px, which fits the 958px box at 1280 only where scrollbars take no room (overlay ones, or puppeteer's hidden ones); beside a classic desktop scrollbar (15-17px, the box 941-943px) it scrolls 2-4px sideways, Details held in view. A wider floor, or a column that can grow with its text, brings back the sideways scroll an administrator had with real labels. Opaque, Details would hide a control the Tab key reaches under it, so the box's `onFocus` is lib/stickyColumn.ts's `keepFocusClearOfStickyEnd` (`stickyEndShift`: scrolled clear of the column, or back to the left edge; Details itself never moves the box; frontendFindJobs.test.js runs the sum and the handler) - for a KEYBOARD focus only (`:focus-visible`): a mouse press or a tap focuses a checkbox or a link on its way down, and a box moved then took a half-hidden one out from under the pointer, so the click landed on the cell - the box unticked, the link unopened. find-jobs.js checks 1440 for both roles with the catalogues' widest words, long titles and salaries on top, every row's Details at 1280 for an administrator, and at 390 a press on a checkbox half cut off at the left edge (ticked) and on each line of a Title link half under Details (reached), the box unmoved, then Shift+Tab to that link (scrolled clear). The selection is a Map kept across
pages (`toggleSelected` / `togglePageSelected`, at most `exportMaxRows` -
*You can select at most N jobs at a time.*), let go by Search, Clear and an
order, kept after an export. Details' footer picks the job with a box, *Select
this job* (a box, as the row's; `pick` answers the cap's sentence, which the
dialog says itself, over the page's). Focus is never dropped: Clear selection
hands it to the select-all box, the form's Clear (off once nothing is left) to Search, Export into Sheet stays focusable while it exports (`aria-disabled`, presses ignored), Order Immediately stays pressable while its
modal dialog is open (only an export blocks it) so Cancel gives it back there,
and a placed order's receipt (`[data-order-result]`, `tabIndex=-1`; the
receipt itself `role=status`) takes it. **Order Immediately** (OrderJobsDialog) is an
ORDER for ONE profile in ONE build mode, on every subscription, so nothing in
it is locked: `ProfileSelector` (`#order-profile`: the profiles that have an
enabled resume, newest edit first, "{name} (N resumes)", loaded on every tier;
"You have no profile with an enabled resume. Add one under Profiles first."
when there is none) and components/builder/BuildModeChoice.tsx (radios
`orderBuildMode`: the three mode cards, each saying what the mode does and,
once GET /resume/models has answered, what a resume costs in it), starting
where Build Resumes starts (`startingProfileId`, `startingBuildMode`), with
`buildModeNote` under the cards (`[data-build-mode-note]`), `AiPreferenceFields`
(`order-ai`; the model is this order's only - Fully Tailor builds the
profile's default resume, so it says "Defaults come from {label}, the profile's
default resume. A model chosen here applies to this order only." and the other
modes "Each resume uses its own model; one chosen here applies to this order
only."), `CostLine` from a quote of exactly the order - keyed by the profile,
the job count, the model and the mode, so a 402 shortfall belongs to the order
that was refused - or, in its place while who it is for cannot be built for,
`profileBlocker`'s sentence (`[data-order-blocker]`, aria-live) - and Place order
through `useSpendConfirm().ask({ kind: 'order', ... estimateRun(body) })`
before `generationApi.submit({ label: lakeOrderLabel(n), mode: 'order',
buildMode, profileId, jobs: lakeOrderJobs(rows).jobs, ...defaultRunFormat })` -
each job `{ companyName, role, jobLink, analysisId }`, a row with no analysis
left out and said (`describeOrderSkipped`); a 402 is the cost line's
shortfall; placed, the page shows `OrderReceipt`, lets the selection go and
re-reads the account (the top bar's balance). The receipt says what is being
built, "3 resumes for 3 jobs are being built: Partial Tailor for Jane Doe."
(`placedOrderFrom(submitted, skippedNote, profileName)`; the mode and the
profile are left out of the sentence when the page does not know them), and the
order's page prints each item as the profile's name (else the resume's name),
" · " and the resume's label, " - " and the role, " - sheet row N" for a sheet
row, with, muted under it (`[data-order-choice]`), how the run came to build
that resume, `describeChoice(match)` (lib/orders.ts):
"Suitable resume: matched Go, Kafka" (the first eight terms, then " and N
more"), "... its title matches the posting's", "... no other resume matched
better, so the profile's default", "... the profile's only enabled resume" and
"Fully Tailor: the profile's default resume"; an item placed before v4.2 has no
`match` and prints as it always did. Closed while its price is worked
out (Cancel, Escape, the backdrop), the dialog unmounts and `useSpendConfirm`
starts nothing for a hook that has gone - a free or exempt order was once
placed behind the person's back. test/frontendFindJobs.test.js
holds the MultiSelect's decisions, serves a real Default account through the
real /generation/quote - the request the dialog builds is a 200 at each of the
three modes' prices, and a `profileIds` or `resumeIds` list is 400
`one-profile-per-run` - and the order's wiring; test/e2e/find-jobs.js
drives the page, the export and the order (in Partial Tailor and in Choose
Suitable Resume, the items naming the resume chosen and why) against
stub-lake-push-sheets.js (its export seam) and stub-seat.js.

## Conventions from the history

Some 200 commits, no tags; releases are merge PRs named for their branch (v2.0,
v3.0, v4.0, and v4.1, built one commit per phase plus a review-fix commit where
one was needed - Phase 9's 4b43c01). The README's
"What changed in this release" is rewritten for each release from the commits
since the last one, and the short **Upgrading** list under Quick Start (stop,
back up, pull, `npm run install:all`, build, start) says what an operator does. There is no
rollback procedure and no per-release upgrade history any more (owner decision
L1: every install ran ac3df79, and nobody goes back): a release that needs
data changed carries the code that changes it, and a database too old for it
is refused by the startup guard, which names the build to start once first.
The pattern in nearly every feature arc is a feature commit
followed by one or more "fix what the adversarial review found" commits, so
expect review passes to be part of the work rather than an afterthought.

**The v4.2 vocabulary.** v4.1 called one resume document a "profile" and a list
of resumes a "group"; v4.2 calls them a **resume** and a **profile** (the
person), and the signed-in user's own settings page **Account** (Settings ->
Account; it was the "Profile" tab). The code, the tables, the API paths, the
tests and these notes say so together, and the names a database stored are
renamed in place by database/glossaryRename.ts (see database/ above). A resume
is `Resume`, `ResumeSettings` / `resumeSettings`, the `resumes` table,
`/api/resumes` and `routes/resumes.ts`; a profile is `Profile`, the `profiles`
table, `/api/profiles`, `routes/profiles.ts` and `profilesApi`. A profile is a
person on the server and on the pages (see "Profiles and their resumes"): what
the pages of v4.1 said "group" for went with the several-profile builder - the
Groups page that edited a member list, its rail row and lock, the builder's
"Specific group" target and the administrator's default build target - and no
page says "group" in that sense now. Do not rename a "group" or a "profile"
without knowing which sense it is: skill groups, the Grouped layout and
`role="group"` / `role="radiogroup"` are other senses entirely, and
test/glossaryRename.test.js fails on a retired name.

**Names that keep the old word.** Some say "profile" and are not the rename's to
change: what a model reads or a cache key hashes (`[[profileJson]]`, the
literal key `profile:` of the tailoring cache, "FIGURES THE PROFILE STATES" in
the revise pass, the prompt id `extract-profile-from-resume` and the shipped
prompt texts), what is stored or printed (the output token `{{profile_name}}`
with its aliases `profile` and `profile name`, the blank name 'Untitled
Profile', the sample "Sample Profile", `answers.profile_id`) and the cap and
the run, whose names kept the word because their final meaning is a person:
the cap's (`profileLimit`, `profilesUsed`, `ProfileLimitError` and
`profile-limit`, `orphanedProfiles`) count people now, and the run's names are
gone, backend and frontend alike: a run names ONE profile (`profileId`, where
the body said `profileIds`) and a build mode, and `assertProfileScopeAllowed`,
`MULTI_PROFILE_SUBSCRIPTION`, `NO_MATCHING_PROFILES`, the 202's
`profileCount`, the frontend's `profileIds` lists, its several-profile
targets (the v4.1 `ProfileTargets`, `canBuildForManyProfiles`, the group
target) and its preview-all client were deleted with the builder's
several-profile flow. What is left is right as it stands: `ProfileSelector`
lists people, and the list at `/admin/profiles` (rail label "Profiles",
heading "My Profiles") is the dashboard of people now.
Renaming the first kind would orphan stored prompt edits or miss every
cached tailoring (the golden literals in test/glossaryRename.test.js pin it).
The Bid Assistant keeps its own words altogether (see bidAssistant/ above).

**The one alias.** For the renamed words, nothing reads a retired spelling and
there is no alias map, with ONE exception, an input one (owner decision D9):
services/resumeImport.ts still reads a v4.1 resume file - the list wrapper
`{ "profiles": [ ... ] }` (beside `resumes`, `items` and `data`) and, on each
record, the field `profileSettings`, which it moves to `resumeSettings` before
the record is built - so that a file v4.1 wrote can be imported. It reads them
and never writes one; the drift test allows the spelling in that file and in
glossaryRename.ts alone; and nothing else reads it, so a record pasted into the
Bid Assistant's editor with `profileSettings` keeps no settings. Two other
readers of an old spelling are not aliases of the rename:
database/glossaryRename.ts reads the old table, column and key names once, to
move them, and the file-name token map (`FILE_NAME_TOKEN_ALIASES` in
utils/outputStorage.ts) reads `{{profile}}` and `{{profile name}}` beside
`{{profile_name}}`, the spellings resumes stored their file name templates in
(see "Where resumes are filed").

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
