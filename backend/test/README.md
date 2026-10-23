# Backend Tests

Run from the repository root:

```sh
npm test
```

Or run only the backend test suite:

```sh
npm run test --prefix backend
```

The backend tests use Node's built-in `node:test` runner and require no extra test dependencies. The test script builds TypeScript first, then runs the compiled JavaScript from `backend/dist` through `backend/scripts/runTests.js`.

**What a full run reports.** With v4.2 complete (see *The v4.2 vocabulary* below) the suite is 158 files and 2178 tests: 2158 pass, 4 are skipped and 16 fail. The 4 skipped say why - two tests of the frontend's launcher in `devServer.test.js` need POSIX signals (skipped on Windows), and two in `installCheck.test.js` need npm to have started the run (skipped when it is started as `node scripts/runTests.js`, as these counts were measured; `npm test` runs them). The 16 failures are the Windows 11 machine this was built on, not the code, and are the same 16 throughout v4.2, from the rename stages to the last count: `aiOperationalWiring` x2, `aiProviders` x2, `claudeCli`, `codexCli` x3, `geminiCli` x4, `jobLakeReport`, `orderFileAccess`, `providerSeats` and `sheetsDoctor` - Windows semantics (no executable bit, a symlink that needs a privilege, a drive letter in a path, CRLF checkouts), Windows' resolution of the `claude`, `codex` and `gemini` commands (`resolveBinary.ts`: the `.cmd` shims of the real CLIs installed on that machine are rewritten into `node <script>` arguments, and a stand-in path that does not exist reads as not installed), and the repository's root `.env` reaching the test process. Read a red run against them: a failure in any other file, or more in one of these than counted, is a regression.

**Build from a clean `backend/dist`.** `tsc` writes compiled files and never deletes the ones whose source is gone, so after a pull or a change that moves, renames or deletes a `.ts` file, `dist` still holds the old module, and a test that still requires the old path passes against code the source no longer has. v4.2 retired `services/profileService`, `services/profileImport`, `services/sampleProfile`, `config/profileSections`, `types/group`, `database/groupRepository` and `routes/groups`; `glossaryRename.test.js` fails with *no compiled module of a retired path is left in backend/dist* while any of them is there. So `rm -rf backend/dist` (PowerShell: `Remove-Item -Recurse -Force backend/dist`) and `npm run build --prefix backend` before the run - `npm test` builds, but does not clean.

The suite needs only the backend installed. Two tests in `installCheck.test.js` check this checkout's own install - every package the root, backend and frontend `package.json` files name is installed, and `scripts/checkInstall.mjs` prints nothing - and are skipped, saying why, where the root's or the frontend's `node_modules` was never made (a backend-only install such as `npm ci --prefix backend`). A `node_modules` that is there but short of a package still fails them; `npm run install:all` from the repository root puts it right.

Storage tests point `DB_DIR` (SQLite database) and `TAILOR_STATIC_DIR` (default prompts, skill seed, built-in templates) at temporary folders under `os.tmpdir()`, so they never touch the real database or shipped assets.

**The run cleans up after itself.** The suite makes a fresh temporary directory for nearly every test (several hundred per run) and nothing deletes them one by one, so `scripts/runTests.js` gives the whole run a temporary root of its own - it sets `TMPDIR`, `TEMP` and `TMP` (what `os.tmpdir()` reads on each platform, inherited by any child a test spawns) to a new `tailor-test-run-*` directory - and `DB_DIR` to a `db` directory inside it, whatever the environment says, so a test that opens the database before it sets up its own storage (the PDF generator reads the skill library as it loads) never reaches the real one - runs `node --test "test/*.test.js"`, deletes the directory and exits with the suite's own code (`testRunner.test.js` holds it to that). The system temp directory gains nothing from a run. To look at what a failing test left behind, keep it:

```sh
TAILOR_KEEP_TEST_TMP=1 npm run test --prefix backend
```

**No test uses a real Google credential.** The backend looks for one beside its own compiled code too, so on a checkout holding a real one (`backend/google-oauth-credentials.json` after `npm run sheets:login`, or `backend/service-account-key.json`) every test that signed an account in used to allocate a REAL spreadsheet in that Google account - one owner's Drive collected 440 named "Free Tailor - admin@example.com" and the like. `scripts/runTests.js` therefore sets `TAILOR_GOOGLE_CREDENTIAL_SEARCH=off` (only a file a variable names is read) and `GOOGLE_CREDENTIALS_PATH` / `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` to empty for the whole run, whatever the environment or `.env` says, and `test/helpers.js` sets the same three as it loads. A test of the search itself writes its own fake credential and turns the search on for its own scope with `withCredentialSearch`. The e2e backends get the same from `test/e2e/no-google.js`, which every e2e preload requires first. `testRunner.test.js` holds all of it, holds every `dist/index.js` command in the e2e README and in each e2e script's own comments to loading a preload, and fails on any line there that starts a backend another way - the root `npm run dev` and its kin, the backend's `npm start`, ts-node-dev - none of which loads one (shell.js said "`npm run dev`" until this release). Run test files through `scripts/runTests.js` only.

To run one file the same way (after `npm run build --prefix backend` - from a clean `dist`, as above - since the tests load `dist/`):

```sh
cd backend && node scripts/runTests.js test/orderRoutes.test.js
```

A test that writes somewhere other than `os.tmpdir()` escapes this, so new tests take their directories from `os.tmpdir()` (`helpers.js`'s `useTempStorage`, or `fs.mkdtempSync(path.join(os.tmpdir(), ...))`) like the rest.

Coverage currently focuses on:

- SQLite-backed skills CRUD and seeding from the static skill library
- prompt CRUD, rendering, activation, and validation
- the startup guard (`upgradeGuard.test.js`): a database this build creates
  stamped with every mark and opening again; one build ac3df79 finished
  upgrading opening, stamped once, so later starts read only the stamp, and
  that first stamp dropping only the report records whose lake row is gone;
  each upgrade it never finished refused by name - its migrations stopped at
  version 5 or 7 or never recorded, waiting for an administrator, credits never
  switched to dollars, saved templates never moved or moved incompletely,
  `users.plan` never renamed, a column ac3df79 adds missing (a database
  last opened by 1df7275, by a build whose lake had no fact columns, or by a
  build from before the lake), lake rows without their facts - with nothing
  created and no stamp, every one of them in a single refusal; a template-move
  record nobody can parse read as complete; every column it asks for one this
  build makes; and the real server spawned on such a database printing that
  one line and exiting 1, no stack trace, never listening; the guard's list of
  added columns held to the names build ac3df79 gave the tables (`profiles`,
  `profile_groups`), which it reads a database by before the v4.2 rename
  (`glossaryRename.test.js` reads an unstamped database through them too);
  and the README's quotes of that line held to the guard's own words
- the data-migration runner (`migrationRunner.test.js`), given steps of the
  test's own so it does not depend on what the shipped ones do: each step's
  version written as it finishes and nothing run twice, a step at or below the
  database's version never run, a deferred step writing nothing and stopping
  the ones after it until it runs, a step that throws logged - never thrown -
  with the steps before it kept, and a database whose version cannot be read
  left alone; and the shipped steps, from 9, finding nothing to do on an empty
  database (step 10 is `outputPath.test.js`'s)
- profiles (people) and the resumes filed under them (`profileTree.test.js`):
  the tree and its invariant (no resume under a missing profile or another
  account's, every default a member), placement by the person key (a name over
  100 characters included), the limit counting people - raced from separate
  threads on separate connections, since requests in one process only run one
  after the other - move, delete and the default resume, the query plans
  pinned off the exported statements, and the lazy filing of a database as
  v4.1 left it (dangling and foreign pointers, edits, the Bid Assistant's PUT,
  rows that are not documents, the session's count)
- the Profiles pages' half (`frontendProfiles.test.js`), written from the
  specification: the dashboard's decisions (`lib/profileDashboard.ts`, which
  imports nothing at runtime) - its two tabs and their addresses (only
  `resumes` opens All resumes), Grid / List kept under
  `freeTailor.profiles.view` and Grid for a storage that is missing, throws or
  holds junk, the route test that puts the profiles list, one profile and the
  editor on the resume desk and nothing else, a profile's and a new resume's
  encoded addresses (`?profile=`), a resume's label equal to the server's
  `resumeLabelOf` over a table of headlines and names, profiles newest edit
  first, the two searches (a profile by its name or the words of any of its
  resumes, a resume by label, name or profile), the holdings line, the
  search's count line, the delete warning in the owner's words (a profile
  with no resume a plain delete, a blank name *Untitled Profile*) and the
  keywords preview; the chooser's links, Duplicate keeping the template and
  Download as a file Import JSON takes back; `describeChoice`, the one
  wording of why a resume was chosen, for the order page, the receipt and the
  preview; the build modes, their labels and price settings equal to the
  server's, and the three mode cards read in the owner's words and never name
  a subscription; the clients `profilesApi` and `resumesApi` against the real
  routes - making, reading, renaming and re-defaulting a profile, a resume
  filed where `?profileId=` says, Move all or nothing, Delete taking every
  resume and answering how many, every refusal as the server made it, a
  Default account keeping one profile while its resumes are never counted, an
  import and an upload filed under the profile asked for and an upload for
  another account's profile refused before the model is asked; and text pins
  on the pages - the four pages of the desk exist,
  the dashboard's tablist, `aria-pressed`, search and status line and the
  `data-*` hooks the browser scripts use, the one lock (`more-profiles`), a
  Suspense boundary around everything that reads the address, the editor
  going back to the resume's profile and never to the bare list, a profile's
  page handing an old resume bookmark to the editor, no template rule left in
  the sources, no price file flooring or float-parsing, and the admin layout
  asking `isProfilesDeskRoute` instead of keeping a pattern of its own
- the v4.2 vocabulary (`glossaryRename.test.js`, in its own section below): a
  database as v4.1 left it, stamped or not, opening with its tables, columns
  and stored keys moved to the new words and then left alone, a stray table
  dropped or two tables with rows refused by name, golden values holding what a
  model reads and every tailoring cache key to v4.1's, the Bid Assistant still
  reaching resumes, and scans of the whole source for any leftover of the old
  words
- the settings with a `.env` default (`settingDefaults.test.js`): for every
  one, the code default with nothing set, `.env`'s over it, an
  administrator's over `.env`, and `null` putting `.env`'s back - each with
  its `settingSources` and `settingDefaults`, and the stored row holding only
  what was set; a save, a model edit, create or delete storing nothing they
  were not about; a deleted model's stored default or analysis choice removed;
  a `DEFAULT_MODEL` / `ANALYSIS_MODEL` that names nothing runnable warned once
  and not used; an empty analysis model kept as the administrator's "default
  model"; neither map in an ordinary account's payload; PUT /api/admin/settings
  resetting by `null` and refusing a wrong shape by name; the payment limits
  from `.env` reaching the buy page (and a method a saved list leaves out),
  a fraction of a cent or an inverted band warned and not used; a relative
  `OUTPUT_BASE_DIR` refused; `CONTACT_CHANNELS` used while nothing is saved,
  a failing entry dropped with one warning naming its position and never its
  text, `[]` saved beating it and `{ channels: null }` resetting; the lake's
  rate and cap under the administrator's; the output prefix's `.env` default
  read in its canonical spelling; the subscription prices - `''` or `$0`
  saved as the administrator's *not offered*, which beats `.env`, Reset
  bringing `.env`'s back, a price above $10,000, a fraction of a thousandth,
  junk and a `...Milli` field refused under the box they name (over PUT
  /api/admin/settings too), `.env`'s clamped above $10,000 or not offered when
  it is `0` or junk, each warned once - junk, and a price hand-edited into the
  row with nothing under it, listed as unreadable for the renewal sweep, never
  unset or `0` - and a price hand-edited into the row ignored with one
  warning; and migration 9 - a field still at
  its old default taken out, a changed one kept, idempotent, a missing or
  unparsable row left alone, and an upgraded install's row rewritten as it
  opens
- app settings persistence, and an id outside the provider catalog - an older
  build's OpenRouter, browser-chat or metered provider - read as unknown, never
  as a seat (`claudeCli.test.js`, `aiFacade.test.js`, `userModelAccess.test.js`)
- the Gemini seat wired in - catalog, registry, health card (which asks every
  seat for a fresh check, the one that can lift a hold), operational
  settings, fresh-install seeds (`geminiSeat.test.js`)
- model administration: the per-seat model-name lists and their `.env`
  overrides, the admin payload that serves them, create and edit validation,
  Set Default refusing a model that cannot run, and prompt overrides checked
  against the same lists (`modelAdministration.test.js`)
- the price per resume, which is the build mode's (`modePricing.test.js`): the
  three prices in thousandths of a dollar (every mode free until somebody
  prices it; `.env` pricing each mode on its own, an administrator's price
  beating it - $0 included - and `null` putting `.env` back; a price saved in
  dollars and refused by its box and code when missing, bad or sent in
  thousandths; a junk `.env` price read as $0, flagged unreadable and said
  once; a stored price nobody could have written read past;
  `getBuildModePrices` throwing rather than reading $0), a model carrying no
  price (one an older build stored read past and dropped by the next write, a
  create without one 201, a body's `pricePerResumeUsd` ignored), the credit
  primitives taking an amount, the queue refunding each task's snapshotted
  `costMilli` - restored tasks and a deleted pick included - and, through the
  routes, the quote equal to the charge, the 402 naming the sum, free modes,
  the exempt administrator, previews' tokens binding the mode and the floor
  for content nobody vouches for; and the quote, a batch charged jobs x the
  mode's price and broken down by mode, and a preview's token end to end
  (`generationPricing.test.js`)
- what an ordinary account may know of models: the slim `GET
  /api/resume/models`, a stored choice falling back while a requested one is
  refused with one generic sentence, the provider request forms kept for
  administrators, the resume-save check, the job filter naming the analysis
  model and the Bid Assistant on the app default model
  (`userModelAccess.test.js`)
- job analysis runs once (PLAN check 1): the ten cases that used to re-run it,
  each through the real routes and queue against a COUNTING stub seat that
  must see exactly one analysis call and one facts call per posting, and a
  damaged stored row analysed once more and repaired in place
  (`analysisOnce.test.js`); the store with no window, cap or overwrite, an
  edit of either prompt, the analysis model deciding both calls, the audit
  hash over both prompts and the code's job field text, and the facts
  answer's closed lists (`analysisCacheEndToEnd.test.js`); the in-flight
  join, a caller's abort, a failed call storing nothing, across both calls
  (`analysisInFlight.test.js`); the facts call itself - its snake_case answer,
  seniority, a salary with no currency, the job field asked once more when
  missing, the industry derived, the two calls side by side with either
  failing stopping the other, the last caller leaving stopping both, and the
  job field list before the prompt in a folded turn too (`jobFacts.test.js`);
  the gate as the only caller of the two prompts, each one's byte-identical
  cached part, the job field list the code's own text on the facts call, an
  administrator's analysis edit run as written and an outdated one (the old
  lists, `[[jobContent]]`, or saved before the owner's texts though it names
  only `[[jobDescription]]`) not, with no edit able to drop the job field - and
  a sheet row's cell worth only the stored
  analysis its id names for that posting - an unknown id never stored, and
  nothing in the code writing `source = 'sheet'` (`analysisGate.test.js`); the
  table, its UNIQUE
  indexes, the link and text identities, EXPLAIN QUERY PLAN on every lookup
  (and on the lake's two reads) and the repair of an unreadable row, the
  closed industry list with stable ids (an unknown word Other), no industry
  on a new analysis - derived from its company category, else its free-text
  industry, else not specified - and one stored with an industry keeping it,
  and job type (Remote,
  Hybrid, Onsite or blank) and clearance (required unless the analysis says
  none or does not say) (`jobAnalysisStore.test.js`); the industry, like the
  job field, salary and filter (the facts call's seniority included), never
  reaching the tailoring prompt nor changing a tailoring cache key
  (`tokenBudget.test.js`); and the app sheet's
  six
  analysis columns - sheet-first builds with one batched read, write-back once
  and RAW, the trust rule, row identity, a cell used only when it names its
  posting's stored analysis (a replaced posting, a sort under the protected
  columns, a program-shaped cell naming an analysis the store never held -
  never registered, analysed once and replaced; one with no id left alone), a
  person's own tab left alone, a moved row not settled, the protection's
  request shape and repair with the Analysis column cleared (a cell forged
  while unprotected never trusted), the grid grown past twelve columns and the
  429 backoff (`analysisSheets.test.js`). The Job Filter's verdict through the
  analysis path, an unknown clearance failing closed, seniority from the
  facts call and an older analysis's `jobMeta.seniority` (`jobFilter.test.js`).
  `analysisHarness.js` is their shared install, stub seats and output stubs:
  its seats answer each prompt by its call site (a one-object analysis split
  into the keywords and the snake_case facts, the revise pass `{}`) and fail
  loudly on a call site they do not know.
  The pages' half (`frontendAnalysis.test.js`): the builder holding one
  analysis per posting (re-spaced text the same posting, edited text or
  another link not, a 400 letting it go), the salary line, the job type,
  seniority (the facts call's, else an older analysis's own) and clearance a
  page shows, Prompt Test marking only the keyword half and never a fact, the
  posting normalisation, the Analysis cell's states and the sheet panel's
  column letters, and the prompt editor - the features in the server's order,
  the required variables, what a text lacks or names that is not supplied,
  the *Needs update* note and the list's *Not run* line (an edit the server
  dates from an older version included), the single-prompt
  features and each one's sentences (each still opening as it did; Fully
  tailoring's names the profile's default resume, the cover letter's the
  Choose Suitable Resume builds, and none says a model has a price) and the
  refusal of a save (an unknown variable first, as the server does) in the
  server's sentence - each run against the server's own code
- the Job Data Lake: the company normalisation and the versioned hash
  (`jobLakeIdentity.test.js`); the tables and exactly the planned indexes -
  `job_reports`' two among them - with EXPLAIN QUERY PLAN on the duplicate
  check, the admin page's default view (filtered on the three facts too,
  never a sort) and the "reported before" reads, the duplicate
  window on a fake clock (59 days a duplicate, 61 a replacement with its
  history), the administrator's window over `.env` over 60, rewards at the
  reporter's own rate else the global one, snapshotted, once per version,
  under the daily cap (which a revoke does not free), never a $0 ledger row;
  job type, clearance and industry stored from the analysis, moved by a
  replacement and kept in the history, and filtered on by the admin query;
  `already` from `job_reports` for the same account and posting on any row
  or tab, or none, even after the window, with nothing moved or paid, and
  another account's report of it a duplicate recorded as theirs; an
  unclassified report recorded, one with no company not; a delete forgetting
  the reports that reached the row, so each can report it again; revoke and
  delete; the search - several values of a filter, any matching, a keyword's
  words all needed and keywords ORed, a word of one or two characters matched
  whole, never more than 25 words asked - and every plan it runs (`lakeReadSql`:
  one value a seek, several companies or up to 25 fields merged arms, more
  fields, the facts and keywords alone the walk of `updated_at`, keywords
  matched once in a materialized CTE, never a plain scan sorted); the read by
  ids and the company suggestions with theirs; and four threads adding the
  same job at once (`jobLakeStore.test.js`); the admin sheet's outbox - created once (a failed
  header write finishes the same spreadsheet), shared with enabled
  administrators at every sync, an idle one included, a failed append kept
  and sent exactly once on retry with Google's reason on the page, a
  replacement a new line, a duplicate none, a recreate mid-sync sending the
  whole lake to the new sheet and marking nothing for the old, a sheet from
  before Job Type, Clearance and Industry given its new header once (version
  1 to 2) before its next line - and the duplicate decision made with every
  Google seam set to throw (`jobLakeSync.test.js`); and over HTTP, a
  reporter's run against a sheet in memory and counting seats (what is
  analysed, added, replaced, a duplicate, unclassified or skipped, what is
  paid, written and painted red, a re-run that analyses and pays nothing, the
  same posting moved, on another row or on another tab *Reported before* and
  unpaid, the same posting twice in one run a red duplicate the second time,
  a row whose first outcome was a duplicate painted red again, a posting
  pasted over another reported like any other and its row's analysis cells put
  right, a Skipped
  row's analysis cells written once it is reported, one row's seat or merge
  failure failing only that row, duplicates painted only in rows that still
  hold their posting and nothing written into a cell), the admin merge, the
  company a build or the Job Filter names on an analysis, and the admin lake API
  (`jobLakeReport.test.js`); Push to Google Sheet over HTTP against every
  account's spreadsheet in memory - Temp For AI's A:L below the header
  replaced, values and red paint, the header and the person's columns past L
  kept, newest first, Date in SHEET_TIMEZONE and NO(DATE) per day, the six
  analysis cells as a build writes them (blank with no analysis), the list's
  own filters and refusals - lists as JSON arrays matching Search's repeated
  keys, a single filter refusing a list, the counts' caps - the cap, writes
  of at most 200 rows and about
  1.5 MB with the grid grown first and a long description cut with the
  marker (never through a surrogate pair), a build from the pushed rows
  asking no model - a link-less job whose description was cut among them,
  matched by its cut copy until that is edited - one push per
  administrator, a Temp For AI that is not a job tab or whose name is the
  person's own refused before any write, admins only, and the read's plan
  (`jobLakePush.test.js`). The pages' half (`frontendJobLake.test.js`): the
  rows a run is asked for, the settings boxes and what a save sends, and the
  lake's filters - lists and their counts too, the keywords' words in all
  split as the server splits them, against the admin route and, as a user,
  Find Jobs' - each refused by the page exactly when and in the words the
  server refuses them (the caps' sentences the form's full boxes say too, in
  one copy), and Requested by a user's 403; Search and Clear emptying what was
  typed into a list only to narrow it; the filter
  boxes in the owner's order (pinned, drawn from it by the one
  LakeFilterForm both pages render, Requested by only an administrator's),
  the job type and clearance choices against the server's, what Search takes
  of typed text, and the query string in that order as repeated keys; Push to Google Sheet's
  body - the search's own filters - pushing exactly the jobs Search lists, in
  its order, and refused in its words, its confirm and its result (the cap
  sentence included) read from real pushes; every row and merge status given its
  words, *Reported
  before (Added)* and the rest in the server's, and red exactly for a
  duplicate and a row reported before whose first outcome was one - the rows
  a run paints; a lake job's type, clearance and industry in the server's
  words; when Add to job lake may be
  pressed; a sheet's `javascript:` link never an href; and the owner's line
  drawn from a real run's summary, with a tab of the reporter's own refused
  in the run's words; and Find Jobs: an export's sentence drawn from real
  exports, the export and order blockers, and an order's jobs accepted by the
  server's own `normalizeJobs`
- Find Jobs' routes over HTTP (`findJobs.test.js`): a user's row and an
  administrator's exact key sets - never a reward, a seen count, a hash or
  who reported it, for a user - and a job's details; the list filters as
  repeated keys or `key[]=`, never an object, each matching any, the caps -
  the keywords' 25 words in all among them - and a single filter refusing a
  list; an export's ids and a list's values read in one pass and refused at
  the first that cannot be taken, a million of them never compared pair by
  pair; Requested by a 403 for anybody but an
  administrator; the company suggestions; the export's cap read at every
  request; a reporter refused every route; and an export on an install with
  no Google Sheets, the jobs looked up before the sheet's sentence
- Find Jobs' page (`frontendFindJobs.test.js`): the MultiSelect's decisions
  (filtering, choosing past a cap, typed text split, the active option -
  still the one chosen once a filtered list is whole, and scrolled into the
  list's own view - what is announced) and its combobox markup; who an order
  builds for - ONE profile in one of the three build modes, all open to a
  Default account: the request the dialog sends (the first profile offered,
  the jobs that have a stored analysis, a mode) quoted by the real generation
  route in each mode at that mode's price, a list of profiles or of resumes
  refused (400 `one-profile-per-run`) and another account's profile a 404;
  and the pieces Build Resumes and Find Jobs share, the cost line, the
  receipt, `ProfileSelector` and `BuildModeChoice` - with no several-profile
  target, no lock and no list of profile ids on either page - the order
  dialog's ids (`order-profile`, `orderBuildMode`) and copy, its saying why
  it cannot be placed where the cost line stands, and its sending an Order
  only after the spend confirm, which starts nothing for a dialog closed
  meanwhile
- providers of one type and their queues (`providerQueues.test.js`): two
  Claude providers with limits 1 and 2 running six tasks at most three at once,
  each at its own limit, placed two and four; a held provider's waiting work,
  a retry included, moving to the other; a switched-off provider taking nothing
  and its waiting work moving; a type with no provider serving waiting rather
  than failing, then running; no slot running another type's work; an idle
  provider taking a busier one's head; urgent work per lane; the real queue's
  reading of the providers resized live; a restored task naming a removed
  provider landing in its type's pool; and the provider recorded on the order
  item and shown to an administrator alone. Through the REAL queue and real
  provider state, too: an adapter's seat-wide hold moving the waiting work
  (and the stored rows with it), a signed-out provider asked again by the
  queue's reading and serving once it answers, a type switched off stopping
  every lane of it, a queued resume's model calls pinned to the provider whose
  lane it holds, the blocked re-check on fake timers, an urgent task stolen
  before a busier lane's ordinary one, a restored finished task keeping its
  `ranOn`, and a started task writing it to its row and its order item. Each
  provider's own seat
  (`providerSeats.test.js`): its child's folder and binary with every key still
  stripped or pinned, for the three types; holds and health per provider; a
  semaphore resized live; the registry's adapter per provider and a type's stub
  standing in for its others; the pool's pick, the queue's pin, and the
  analysis model pooled the same way; two providers of one type keeping two
  semaphores, an added one's own working directory, Codex's and Gemini's
  readiness, a new binary rebuilding the adapter, a removed provider's type
  remembered, every enabled provider in the startup check, and a signed-out
  added provider's advice naming its own folder. The providers' settings
  (`aiProviders.test.js`): the built-ins first, `.env`'s values and an
  administrator's override with where each came from, every path check - on
  an add and on an edit, against the app's REAL directories - a folder shared
  within a type refused, the settings row (kept, and never written, by a
  General settings save) and the routes over HTTP, a busy provider refused
  removal. The pages' half
  (`frontendProviders.test.js`): the type list, sign-in variables, `.env`
  names, limit range and hold kinds copied from the server and checked
  against it; every problem the Add and Edit forms find being the server's
  own refusal, in its words and on its field; an edit sending only what
  changed, so a built-in's `.env` value stays `.env`'s; a refusal pinned to
  its box; where each value came from and how a provider's state reads; the
  type offered exactly when the server would run it, by lib/api.ts's own
  `isProviderOffered`; every field the routes
  send read back whole; and no page outside the admin ones reaching the
  routes
- the tailoring cache (`tailorCache.test.js`): a second identical build making
  no tailoring or revise call and charged again, a one-character resume
  change, another model, an edited prompt and another template each a miss, a
  skill added to the library not one, the key's parts (the revise prompt and
  settings in, the resume's settings out) and the key still built by hand with
  the resume under the field name `profile`, as v4.1 hashed it, so every
  stored tailoring stays a hit, a cover letter's own key, every caller
  passing its context (/resume/preview and the queue's tailoring and cover
  letter; /resume/preview-all is gone), nothing cached without an analysis id, an
  answer that does not parse or that a fallback model wrote never stored, an
  unreadable stored answer a miss, the one-seek lookup and the prune; the
  seats' `fellBack` is in `claudeCli.test.js` and `geminiCli.test.js`
- what anybody but an administrator is told when something fails
  (`publicErrors.test.js`): public refusals in their own words, everything
  else as a generic sentence and a ref with the cause logged under it, and the
  cause as `detail` for an administrator only - per class (public errors, AI
  failures, body-parser, anything else), through the last-resort handler and
  a route's AI failure over HTTP, for stored task and order-item errors read
  back by their owner, and for the routes and projections that were leaking
  the installation's workings (AI health, the queues, prompt bodies, the
  sign-in options, the skill library's writes, the Bid Assistant template and
  job deletion); an administrator's settings read that fails carrying its
  cause and a ref; the payment method reasons are pinned beside their routes
  (`paymentRoutes.test.js`)
- whose Bid Assistant data is whose (`bidAssistantScoping.test.js`): a saved
  sheet source is its owner's, and a legacy owner-less one or a deleted
  account's an administrator's to change; answers are read and deleted
  through the reader's own resumes, go with the resume - so an account that
  later takes its id reads none - and are all a job's "Answered" flag counts;
  and the shared job board's deletions are an administrator's. The Bid
  Assistant still calls a resume a profile, in its routes and its fields
  (`/api/bid-assistant/profiles`, `profileId`, `focusProfileId`,
  `targetProfileIds`, *Profile not found.*), and this test speaks its words
- the batch progress stream's bare-newline heartbeat, which keeps a proxy's
  idle timeout from cutting a long batch (`batchStream.test.js`)
- the account tier called a subscription everywhere
  (`subscriptionRename.test.js`): a database this build creates with
  `users.subscription` and no `plan` (an older one still on `plan` is the
  startup guard's to refuse); Settings > Subscription as a tab, with no page
  at `/settings/plan`; and no frontend code or copy still calling the tier a
  plan. The tier gate itself, `requireSubscription`,
  is in `sectionPermissions.test.js`, the admin payloads in
  `accountRoutes.test.js`, and the frontend's copy of the tier order is held
  to the backend's in `frontendHelpers.test.js`
- money in thousandths of a dollar: the one parser and formatter (`"0.023"`
  is 23, `"0.0235"` refused, shown with no trailing zeros - `$1`, `$4.1`,
  `$0.023`, `$0` - never rounded, whole cents only where a card is charged or
  refunded) and a guard that no money module floors,
  truncates or float-parses an amount (`money.test.js`); a
  purchase crediting exactly what it charges, with no fee, and the payment
  limits in dollars (`paymentFees.test.js`); and the frontend's copies of all
  of it run against the server's (`frontendMoney.test.js`), the price of each
  build mode included: Admin -> Settings' three price boxes
  (`modePriceDraft.ts`) refusing every input of a long list in
  `parseBuildModePriceInput`'s own words and naming the box the server names,
  filled with what is in effect and sending only what changed, as typed; the
  spend confirm's line naming the build mode a run is priced in; no page that
  shows or sends money flooring, truncating or float-parsing it; and no box
  an amount is typed into a number box (the price boxes are text with
  `inputMode="decimal"`, and a model has no price box at all)
- subscriptions bought from the credit balance: the rules as tables - the
  days left and what they are worth, what moving up costs ($19.99 less 29
  unused days of $9.99 is $10.333), the period a renewal buys, every card's
  offer in every state, and why a due one renews, ends (a disabled account's
  included) or holds while its price cannot be read
  (`subscriptionBilling.test.js`); over HTTP on a fake clock, the view, a
  purchase charged exactly once in one ledger row with its key and note and
  the base captured, a move up prorated, a short balance or a changed price
  refused with nothing moved, two purchases at once charged once, every
  refusal, the switch at renewal, cancel and keep with their repeats, an
  administrator's tier or role change on Admin -> Accounts ending a paid one
  with its note and notice and no refund, read in the change's own
  transaction with no other writer let in, disabling a paying account ending
  nothing but saying when it ends, and `GET /api/auth/subscriptions` gone
  (`subscriptionRoutes.test.js`); and the renewal sweep - charged once
  however often it runs and across a restart, a late renewal from the old
  end and a missed period from now, the switch, every way a paid tier ends
  with its notice, a disabled account never charged and the charge itself
  refusing one, a pass that cannot read the prices touching nobody, a price
  set and unreadable holding what renews as it while the rest go on, held
  rows never hiding the ones due after them, a renewal decided on a period
  that moved on doing nothing, the due query's pages through its partial
  index, the six columns reaching an older database, and the timer: a pass
  at once, unref'd, never two at once, the first only once the credit books
  are straight (`subscriptionRenewal.test.js`); and the Subscription page's
  half, through the frontend's own client against the real routes - the
  amount it sends back accepted to the thousandth and in whole cents, every
  card's action and the "Current subscription" summary drawn from real
  answers as Default, paid, switching, cancelled, kept, set by an
  administrator and an administrator's own, a changed price and a short
  balance read as the page reads them (a short balance is only ever a 402
  `insufficient-credits`: the client has no reader of a tier refusal any
  more), a short renewal warned of, an *Upgrade
  · $0* the unused days cover still asked about (nothing now, the price at its
  first renewal), the cards four, two or one across and never three, and Admin
  -> Accounts' *Paid · renews* line and confirm (`frontendSubscription.test.js`)
- the one lock drawn where a subscription falls short - adding a PROFILE past
  the tier's limit (a run builds one profile on every subscription, so
  nothing on a run is locked): `LockedFeatureId` has exactly one member,
  `more-profiles`; its words from `describeLock` per tier, never a "plan"; a
  refusal's lock worded from the 402 `profile-limit` and never from a session
  behind it (there is no tier refusal left to read); the frontend's copies of
  the tier names and profile limits and its entitlement helpers equal to the
  backend's; and the multi-profile lock, the build target it capped and the
  refusal that worded it present on neither side (`frontendHelpers.test.js`).
  The same file holds the shared run choices - where a page starts (the
  administrator's default profile while it is offered, else the first), what
  blocks a run (three sentences, and *No profile has an enabled resume to
  build.*), the mode it starts on (Partial Tailor for anything unknown), the
  line under the mode cards in all four forms and the files, from a module
  whose only runtime import is the build modes - the frontend's build modes
  (their labels, the setting each price is served under, one card each, none
  naming a tier) equal to the server's, and the Multiple flow's previews gone;
  the builders' rail, with one Profiles entry that no tier locks, lit for the
  dashboard, a profile's page and the
  chooser and editor under `/admin/resumes` (`isNavLocked` and `activeHref`,
  `frontendRoles.test.js`); and the alert before anything spends credit
  (`frontendSpendConfirm.test.js`): *Do not show again* per kind of action
  under keys of its own (the old Generate Immediately key not read), unreadable
  storage asking, Generate Immediately asked always and an order or a
  subscription only when it takes credit, the amount, the balance after and a
  short balance blocking Proceed, and every Build Resumes run and Order and
  every subscription change going through it - a finalise quoted with its
  content as well as its tokens, the run buttons waiting while it prices, its
  "could not be worked out" sentence naming the build mode and no model, and
  the page read the same on a CRLF checkout
- the admin pages' half of the settings with a `.env` default, the Models
  dialog and where resumes are filed (`frontendSettings.test.js`): the frontend's
  copies of the server's variable tables, dialog fields and token lists held
  to the server's; the words beside a box (*Set here*, *From .env (NAME)*,
  *Default* - the Providers table's own) and Reset offered only while set
  here; through the real client and routes, an untouched General or Payments
  form sending nothing, one changed box sent alone and turning *Set here*,
  Reset (`null`) putting `.env`'s back, the contact list's Reset against a
  saved empty list, the lake's boxes holding only what is set here, the
  subscription prices saved in dollars as typed, read in thousandths with
  their source and Reset under their dollar name (`appSettingResetBody`), and
  General's price boxes sending only the box changed and refusing in the
  server's words before anything is sent (`subscriptionPriceDraft.ts`); the
  price of each build mode the same way (`modePriceDraft.ts`) - three boxes
  sent as typed under the mode's dollar name, $0 a price that beats `.env`,
  the server's exact sentence and its `bad-price` code for what it refuses
  (the empty box included), the refusal's `field` landing under the box it
  names, a served `...Milli` name refused as `bad-price-field`, Reset sending
  `null` under the dollar name, junk in `.env` read as $0 and listed as
  unreadable - beside the builder's starting mode (`defaultBuildMode`, with
  `DEFAULT_TAILOR_MODE` behind it) as a box of its own, and no build target,
  free-model list or model price served or read any more; the
  dialog refusing what the server refuses in its words and pinning a refusal
  only the server can make (a name taken meanwhile, a pair another record
  holds) under the box it names, an edit sending only what changed, and a
  model carrying no price - no field in the draft, none in a create or an
  edit, and one sentence on the page saying a resume's price is set per
  builder mode; Set
  default, Use for analysis and "Use the default model"; the token chips
  inserting at the caret and a slow preview answer dropped; and Resume files'
  preview, save and Reset against the account routes, a reporter refused and
  the section not drawn for one
- refund requests and Contact admin: every allowed and refused state change,
  a double-pressed *Refunded* moving money once, a card's partial refund with
  its credit held while Stripe answers, crypto at the amount sent by hand, one
  open request per item in SQL, the older kinds of request seeded through
  `refundSeed.js` (`seedRefundRequest`, the checks the removed asking route
  made) now that nothing can ask, the service offering no way to, and a row of
  an item type this build does not know - an older build's `task:` - never
  refunded, only declined (`refundRequests.test.js`); a reporter's payout
  request -
  asked once at a time, never at $0, by a reporter only; Record payout writing
  one row keyed by the request, refused above the balance or for an account
  no longer a reporter with nothing moved, and Admin -> Accounts' payout
  closing the open request, the ledger adding up throughout
  (`payoutRequests.test.js`); a notice reaching
  only the account it is for, in its feed and its unread count, by an index
  seek (`notificationRecipients.test.js`); the contact channels' rules and
  the links the server builds (`contact.test.js`); and the pages' refund and
  payout decisions against the server's - nothing in the browser asking for a
  refund any more, a decline's reason and a payout's note refused in the
  server's words, Ask for Refund off exactly when and why the real payout
  route says, Record payout in the queue refusing what the real route refuses
  and a recorded payout reading *Paid out* - plus every sentence that asks for
  an administrator followed by a Contact admin link, and the credits copy
  saying a resume costs the price of the build mode it is built in and never
  that a model has a price (`frontendRefunds.test.js`)
- Generate Immediately and Order: the two kinds (`mode` alone decides; an old
  script's `asOrder: true` is not read), the tab lease through the
  stream, the release, the owner-checked per-file download and the deletion
  after the run (`immediateRuns.test.js`); the grace on a mock clock
  (`tabLease.test.js`); immediate work before orders on one lane
  (`queuePriority.test.js`); one profile per run on every subscription - a
  Default account building a profile of three resumes in every mode, as
  Generate Immediately, as an Order, quoted and previewed, a body naming two
  profiles, a `profileIds` list, resume ids or no profile refused 400
  `one-profile-per-run` for every tier, administrators included, a profile
  that is not the caller's a 404, one with no enabled resume 400
  `no-profiles-to-build`, administrators exempt from charges and not from that
  rule, and no scope gate left in the code (`subscriptionGates.test.js`); the Tab
  select's listing (`sheetTabs.test.js`); the builder's reattach seeing only
  the caller's own runs (`builderRunListing.test.js`); a restored run keeping
  its reservation (`restoreReconcile.test.js`); an untitled row built for its
  analysis's title (`queuedRole.test.js`); and the page's own decisions - a
  tab's id, the downloads (a finished resume naming which of the person's
  resumes the run chose, only when the snapshot says so), the release
  request, how a run ended, the sheet rows (`immediateRunHelpers.test.js`;
  the question asked before a run is `frontendSpendConfirm.test.js`'s)
- saved templates as files (`templateFiles.test.js`): import, extraction and
  the manual builder each writing `<id>.json` with its source (the import
  answering the list and its counts, nothing spread beside them), an edit
  rewriting it and a delete removing it while a built-in stays as shipped, ids
  checked before any path is built, a lookup taking an id exactly as its file
  carries it (no folding of case or underscores), a directory that cannot be
  written giving the generic error and leaving no `.tmp`, the startup line
  saying whether saved templates can be written, and a stale scratch file
  swept
- the resume preview's sample person (`sampleDefaults.test.js`): an empty
  draft filled field by field and section by section, typed values winning,
  and the sample reaching nothing but the preview route - never a save, a PDF
  or a prompt; and the editor's helpers - the pane width that stops the
  preview shaking, the "N kept" line, the sample-text notice and placeholders,
  the chooser's links reading back as the same choice (the template, the
  layout, then `&profile=<id>`, encoded and no part of the choice), any resume
  offered any template (no picker or helper limits one to the templates the
  other resumes have not used), and a card's Duplicate and Download -
  Duplicate sends a resume's whole content as a new one on the same template,
  without its id, times, switch, profile or keywords, and Download is a file
  Import JSON takes back, without the keywords or the profile it was filed
  under (`frontendEditorHelpers.test.js`)
- what the pages send back of a tailoring (`frontendTailoring.test.js`): the
  builder's *Manual Edits (JSON)* box offering only what an edit can change,
  plus each role's company, title and dates to say which role its bullets are -
  no role description or place, no derived skill list - and its edit finishing
  through the server's own parse exactly as the whole content does, for every
  switch and layout and for two stints under one company and title listed in
  the other order; an edited bullet, summary, group or soft group surviving, a
  role's place and dates the resume's whatever the edit says, an edited title
  kept only without a headline, and the note under the box saying so; anything but
  one JSON object refused before it is sent; and the resume editor saving and
  previewing only settings the server reads (no skill ordering, no cover
  letter prompt and, the mode being the run's, no tailoring mode: not in a
  draft, a save or the defaults, and a stored one read past by the draft and
  by the server alike), its Experience section saying a tailored resume
  prints no role description
- importing a resume from a JSON file (`resumeImport.test.js`): the gate more
  than the happy path, since `resumeDocument` normalises anything it is handed
  and never throws - the three shapes a file comes in (one record, a list, the
  wrapper `resumes`), a file that is not a resume refused naming the entry, and
  nothing imported when one entry in the middle is bad, a free id kept and a
  taken one replaced rather than overwritten, one id twice in a file not
  collapsing into one resume, a nonsense `createdAt` ignored, an oversized file
  refused before anything is built, the error type the route maps to a 400, and
  an import landing in the database whole or not at all; and v4.1's export
  files still read - a record, a list or the wrappers `profiles`, `items` and
  `data`, a record's `profileSettings` arriving as `resumeSettings` with the
  values it held, either settings key enough to make a record a resume, and
  this build's wrapper read first when a file carries both. That alias is the
  one place the old spelling is still read; `glossaryRename.test.js` holds it
  to the import and the rename step
- the section catalogue and the order of sections (`sectionCatalogue.test.js`):
  fifteen kinds in canonical order with the classic six first in the DOCX's, a
  section ref only a kind id or `custom:<key>` and nothing trimmed or folded,
  `presenceOf`, `cleanSectionOrder` and `sectionSortKey`, and
  `effectiveSectionOrder` with nothing stored (the template's own order,
  filtered to the default kinds and the kinds with content) and with an order
  stored (that order, then the unlisted default kinds in the template's order,
  then the unlisted kinds with content, then the custom sections); the nine
  new kinds and the custom sections stored trimmed with blank entries dropped
  and capped at fifty entries and ten custom sections, omitted keeping what is
  stored and `[]` clearing; a stored order exactly what the person arranged -
  never filled in, cleared by `[]`, re-cleaned when a custom section goes, an
  absent one staying absent; the preview builder passing every list and the
  order through; the tailoring cache ignoring the order and missing on a new
  entry; and a file with a name and only projects being a resume. The
  frontend's copy of the catalogue is held to it by
  `frontendEditorHelpers.test.js`
- a resume's two section switches and its own soft skills
  (`resumeSections.test.js`): off unless stored `true`, kept by a save that
  omits them; the soft-skill list cleaned, bounded and kept; the preview's
  resume builder never throwing and taking only the settings that change the
  render; the render gate - a switched-off section empty whatever the content
  carries, Strengths always the resume's own, Soft Skills the content's list
  or, when that is empty, the resume's own; no render padding the skills
  block, the preview and generation alike, in the order the person keeps
  them; links reaching an `href` only as http(s); and the DOCX carrying
  Strengths and Soft Skills exactly when the PDF does, the model's soft-skill
  group staying in Technical Skills in both where the template has no section
- a tailored resume as printed (`tailoredRender.test.js`): the model's
  `skillGroups` verbatim when Grouped and flattened without repeats when
  Plain, nothing from the library added, filtered or reordered; the soft-skill
  group routed to the Soft Skills section only while the switch is on for the
  template; the resume's own strengths; a block with nothing printable
  falling back to the resume's own skills; older content's flat list printed
  unpadded; the library filing and filtering only an untailored block and an
  older content's Grouped list - never the model's, never an older Plain list,
  never padding; no role description and no empty box where it was - and a
  template whose `{{#if description}}` block crosses the element's edges
  still rendering, the guard taking such a block whole or leaving it - at
  most eight bullets, the title printed as composed with its separators - in every
  built-in, both layouts and both switch states, in the DOCX, and in
  the gallery's tailored sample; and a cover letter keeping its paragraphs
  when the model separated them with single newlines. The shared reader of
  the block itself - sanitising, the soft group's mark, drawn heading and
  closed heading list, the Plain flattening - is `skillGroups.test.js`
- the templates and the two skills layouts (`templateLayouts.test.js`): every
  built-in rendered in both layouts (one item per skill Plain, headings
  Grouped, nothing padded, Burgundy Rule's and Navy Rule's one Plain group
  marked to span their grid's row and their own rule for it in their
  stylesheets) and with each switch on and off, its capability flags against
  its markup, the section-stripping regressions, no layout list on any
  built-in and none read from a stored file, an import or an override row
  (and dropped by the next write of a saved file), the admin edit taking a
  name, a description or disabled and refusing a body with none of them,
  the gallery preview's options and no-script policy, and the template
  resolver's order - requested, the resume's own, `default`, any enabled
  template, null - whatever the layout. Its fixtures read the built-ins only
  (the files without a `source`)
- the two skills layouts as rendered (`skillsLayoutRender.test.js`): Plain as
  skill names and Grouped under headings, nothing padded; a joined skills line
  (`<p>...{{join hardSkills ", "}}</p>`) drawn Grouped one line per heading in
  its own element, class and separator, its static label giving way, a
  headless group with no empty label, a join in an attribute or beside text
  left as written, and the owner's saved ATS templates when the checkout has
  them (else skipped); the Plain net marking a category loop's element, a
  guarded one too, with one stylesheet in the head - after a leading doctype
  when there is no head - and nothing for a per-item template, a void
  element or a loop with markup before it; and a span loop's lines turned
  into heading blocks with their separator
- a switched-off section leaving no heading (`sectionHeadings.test.js`): every
  built-in and uploaded-style markups with neither the class nor
  `data-section` - a heading before the loop, in a plain div, outside a guard
  around the loop, both sections in one column, in capitals, as a label before
  an inline list, over a divider, as a bold label and a line break, printed by
  the `join` helper, inside a guard that closes after the section's element -
  with nothing else removed, the section and its heading back when switched
  on, no empty heading when on with none, and none of them needing the compile
  fallback; a photo, an icon, a CSS picture and lines of static text sharing
  the section's element kept in every mode, while the section's own wrapper
  still goes whole; an element that also holds the summary or the Experience
  loop never taken - a column, a heading box holding the summary, the element
  before the list - nor a paragraph past 60 characters that says "strength",
  each built so that removing any one of the overlapping checks fails it; a
  `data-section` element taken whole whatever its heading reads, so the
  attribute decides on its own; a template the finds would stop compiling
  drawn with less found and logged once, and one broken by itself failing with
  its own error; markup that only looks like a section left alone; and the
  resume preview route and the render a PDF prints from agreeing, the stored
  file never rewritten
- the live resume preview over HTTP (`resumeDraftPreview.test.js`, `POST
  /api/resumes/preview`), run with all three seats locked so a 200 also proves
  no model was asked: nothing written or charged even at the subscription's
  profile limit, the draft laid over the caller's own resume and somebody
  else's a 404 (*Resume not found*), half-typed drafts rendering, nothing typed
  able to run, the layout and switches reaching the page, the template order
  (a Plain draft drawn on Burgundy Rule, its grid marked for the one group), a
  disabled template a 404 for a user only, and a 503 with a ref when no
  template is enabled
- tailoring by the switches (`resumeSectionPrompts.test.js`): no switch a
  prompt value - the strengths in `profileJson` only while on, her own soft
  skills never - the shipped prompt naming the drawn soft-skill heading, the
  source resume's own strengths while on, the model's soft-skill group in its
  section while Soft Skills is on and in the block while off, Grouped and
  Plain the same content, nothing added to the summary, held content - a
  builder preview, a queued task - finished against the source resume as it is
  now with no model call, an answer with no skill groups falling back to her
  own, and a template with no section reading as off; and end to end, two resumes
  (each its own person's) on one analysis, previewed one after the other
  through `/api/resume/preview` (a preview builds one profile) and each drawn by
  its own switches, a repeat reusing the tailoring and its revision
  (`sectionSwitchesEndToEnd.test.js`)
- the tailoring prompt's promises (`tailorContract.test.js`): its values
  exactly the declared variables, the posting's own lists (skills, prose
  keywords with the banned verbs out, concepts) read from either analysis
  shape, the five it leans on (requirements, must-include, early, Go as
  spelled, topped up), the concept tools and soft-skill heading seeded per
  resume and posting, the title's kind (levels taken off its edges only,
  never the kind alone as a headline) and its six shapes, roles restored,
  dropped and put back with no description, two stints at one company under
  one title told apart by their dates (a resume typed oldest first, answered
  newest first), the eight-bullet cap by checklist terms, numerals (a compound
  past twenty, hyphenated or spaced, left as written) and the
  dash backstop (a range beside a unit, a currency or a quarter kept a range;
  the cover letter's too), the soft
  group found by mark, heading or a soft heading last, and the parse
  idempotent for every resume shape; the pure lists of
  `resumeExperienceSkills.test.js` alongside
- the revise pass (`reviseCoverage.test.js`): the missing terms in priority
  order with banned words out and the cap, what counts as a figure, the
  figures sentence, the merge (summary, whole roles by the n-th company and
  title - or, when only one of two such stints comes back, the one whose
  bullets it repeats, through tailorResume too - nothing else, never a line
  the finishing would cut - "our" keeps the draft's), when it runs and what
  it is told, the revision
  finished like the draft, a failure leaving the draft uncached and said
  once, an abort passed on, the cache keeping the revised resume but never a
  fallback's revision, the resume's model whatever the prompt overrides, and
  content a page sends back never revised; the revision inside the queue's
  provider pin is `providerQueues.test.js`
- Partial and Fully tailor (`tailorModes.test.js`): what each mode sends
  (Fully: each role's title, company and dates, no summary, the rest alike),
  the mode the RUN passes (no resume carries one: a stored `tailorMode` is read
  past and dropped by the next save, and `DEFAULT_TAILOR_MODE` decides nothing
  about how a resume is tailored), a task with no mode building Partial and
  Choose Suitable Resume never tailoring - the resume printing as written, with
  the cover letter alone asked for; Fully running Tailor Resume (Fully) whatever
  the Building prompt and Partial the resume's own; a bare resume printing the model's
  bullets and skills with its own facts back; the revise pass after a Fully
  draft asked for every checklist term and no figure; the two modes never
  sharing a cached tailoring; the fallback cover letter told what the
  tailored resume says (two stints at one company and title kept apart by
  their dates) and, untailored, the resume's own text in either mode; the
  span of experience worked out from the role dates when the resume states
  none; and the posting's banned opener verbs kept out of `jobAnalysisJson`
- the three builder modes (`buildModes.test.js`), through the real routes and
  queue with stub seats that count their calls per call site: Choose Suitable
  Resume asking for no tailoring and one cover letter a resume, Partial
  running the matched resume's Building prompt and the revise pass, Fully the
  profile's effective default (a disabled chosen default skipped); the labels,
  snapshots and order items carrying the resume, the profile and the match; a
  restart keeping the choice and the mode; a task with no mode building
  Partial; a deleted pick failing its task and refunded; a run naming one
  profile and every other shape refused, a junk mode, Suitable with content, a
  preview that no longer agrees (409, nothing reserved); a Default account
  building in every mode; `/resume/preview` in each mode and drawing held
  content again, and no `/resume/preview-all`
- resume keywords (`resumeKeywords.test.js`): computed from the titles, the
  curated skills and the prose against the SHIPPED vocabulary, never the live
  library, with the class rules for everyday words ("Go-live", "Kind regards",
  a lowercase "spring"), synonyms, the caps, determinism, the memo keyed by id
  and time that writes nothing back, and keywords served derived on the two
  GETs and never stored, read from a body, or let into a render, a prompt or a
  cache key
- choosing the suitable resume (`resumeMatch.test.js`): the score formula, the
  factors, the tie order, each `TaskMatch` reason and its explanation, the
  worked example on the analysis path and on the text path, and 500 jobs among
  25 resumes in well under three seconds
- prompt variables (`promptVariables.test.js`): every feature declaring
  exactly the variables its code supplies, a typo refused on save and named
  on validate (also through the routes), the shipped prompts validating
  clean with their required sets, a save that leaves out a required variable
  refused naming it and the rule, a stored feature record without one - or
  naming one no longer supplied, or saved before its feature's contract
  changed whatever it names (`savedForOlderVersion`; never the shipped file,
  never the cover letter, cleared by a save, and the shipped files' date the
  contract's) - marked `needsUpdate` with the names and
  never run (an unattached one never marked) - the built-in runs in its
  place, said once, and the shipped text when the built-in's own edit needs
  updating too, by exact id, by runtime id and rendered by feature - nothing
  appended to a tailoring turn whichever record runs and the answer held to
  the source resume, through a stub seat, and a resume naming a deleted tailoring
  prompt running the built-in, warned once, while a cover letter always runs
  its built-in
- the three CLI seats, each with no binary, no subprocess and no network:
  the Claude provider - argv, child environment, event reduction, failure
  classification, rate limits, outages and concurrency, and a sign-in hold
  lifted by a fresh seat check that finds the subscription signed in
  (`claudeCli.test.js`);
  the Codex provider, including a CLI signed in with an API key reading as not
  signed in (`codexCli.test.js`); and the Gemini provider - argv and the
  forbidden flags, the pinned-empty key variables, the workspace settings and
  deny-all policy, the stream reduction that answers only on a `success`
  result, failure classification and holds (a sign-in hold lifted only by a
  sign-in written after it), a JSON answer that opened its sentinels and never
  closed them refused as truncated, the paid-credits and tool-call refusals,
  the prompt guards and the per-turn cleanup (`geminiCli.test.js`)
- the platform-dependent decisions - the default database directory, Windows
  binary resolution, the Windows command-line budget and the path characters
  Windows reserves. Each of those takes its platform as an argument rather than
  reading `process.platform`, so both branches are covered from either host and
  a Windows-only regression fails on Linux CI.
- where a resume is filed (`outputPath.test.js`): the administrator's prefix
  and an account's folder path - every token in its place, an unknown one and
  the old spellings named, a token in the other half's place refused as
  misplaced, `{{order_number}}` missing, doubled or not a folder of its own,
  `.` and `..`, an empty folder, nine folders, a drive letter and `~` - every
  problem reported; a folder rendered then sanitized whole, an empty one
  `unknown`, no value adding or climbing a folder; `OUTPUT_PATH_PREFIX` /
  `OUTPUT_PATH_SUFFIX` refused with one warning each; the account's routes
  (saved canonically, refused with `field`, reset by `''` or `null`, its
  source, a reporter refused and told nothing), the preview with the asker's
  own folder, the builder's Role box following the ASKER's folder path, the
  admin's prefix refused by name with its field, previewed whole and reset;
  migration 10 giving an older run the folder its recorded files name, once,
  and the two new columns reaching a database without them. Who may download
  a file by its run's folder - after the prefix changed, a run with no folder
  recorded, a file nobody claims - is `orderFileAccess.test.js`'s, and the
  run's place fixed at submission `orderLifecycle.test.js`'s
- a run's files once they are on disk (`runFiles.test.js`): two resumes of one
  run at one company with one role written to two files (the second `_2`), a
  retry and a restored task keeping their names, another run's first resume
  taking the plain one; and a run found - and purged - in the output folder it
  was placed in after an administrator changed it, or where the tree was moved
  across.
- generated output paths (`aiModelConfig.test.js`, `utils.test.js`)
- JSON extraction utilities
- array utilities
- output path safety helpers
- current auth middleware behavior, and who may reach what
  (`routeAccess.test.js`): one row per router `src/index.ts` mounts, deciding
  whether it is public, for any signed-in account, for users and
  administrators (never a reporter), for reporters and administrators (never a
  user: Report Jobs), or for administrators; the test fails on a
  mount with no row and on any route whose guard - read off the router - is
  not the one its row decides, and over HTTP with a session per role it
  refuses a reporter every route that is not theirs (403 `role-not-allowed`)
  and lets them reach their own account, credits, bell, sheet and refund
  history. Roles and subscriptions (one this build lacks refused by name, on
  a create - which then creates nothing - as on an edit), a reporter's rate
  per job (served on the list too), which setting names a configured
  administrator, and recorded payouts are in `accountRoutes.test.js` and
  `accounts.test.js`
- the reporter's side of the frontend (`frontendRoles.test.js`): its copy of
  the role catalog is the backend's; a reporter's Credits mounts no buyer's
  panel and reads only their own requests (for payouts) and the payout routes;
  of every App Router page, a reporter
  opens exactly Report Jobs, Credits and Settings -> Account / Job Sheet and is
  sent to Report Jobs from the rest (a profile's page, the chooser and the
  editor among the pages the walk finds); the rail and Settings tabs offer them only those (an entry naming
  no roles is a builder's, and a builder's rail is one Profiles entry that
  needs no tier, with no locked row); the rate per job box and
  Record payout say what `parseReportRateUsd` and the real payout route say,
  word for word; a 403 `role-not-allowed` re-reads the account rather than
  signing anybody out - from every place the frontend calls `fetch` itself,
  the Bid Assistant's client included, each of which is listed with why it
  may; a configured administrator's row names ADMIN_EMAILS or SMTP_USER as
  the server says; and every address the code writes out as a link - an
  `href`, a `router.push`, a `*_PATH` constant, a function named `...Href`, a
  notice's `link` on the server - is a page of the App Router, so a page that
  moved cannot leave a link on its old address (the scan itself pinned on
  every shape a link is written in)
- which dev server the root `npm run dev` starts: the frontend on Turbopack,
  with webpack's opt-in by name, because webpack's reloads every other open tab
  when a new one connects - measured by `e2e/dev-reload.js`
  (`devServer.test.js`)
- what the root `npm run dev` (and `dev:live`, `dev:poll`) checks first, from
  npm's `pre` hooks: every package the three package.json files name is in
  that package's node_modules, else one message naming what is missing and
  `npm run install:all` from the repository root by its path, the
  devDependencies sentence only when npm's settings, as a script sees them,
  leave them out - each row measured with npm 10.9.4, and worded as a hint
  pointing to `npm config get omit`, since an `omit=dev` behind
  `NODE_ENV=production` never reaches a script (run through the real npm) -
  and exit 1 before concurrently; `install:all` passing `--include=dev` to all
  three installs; the real runner silent on this checkout (skipped where the
  root or the frontend was never installed) (`installCheck.test.js`)
- which wins, the environment or `.env`: the environment, on both halves, with
  any name set in both reported by name only (`envFile.test.js`), and the mail
  doctor naming such a setting as overriding the file (`mailDoctor.test.js`)
- the operational settings read from `.env`: the shared readers and their
  policy - empty means default, junk warns once and falls back, out of range
  clamps (`envValue.test.js`); every setting's default, bounds and the startup
  line (`operational.test.js`); and that each setting reaches the thing it
  controls, with fetch, nodemailer and puppeteer's launch stubbed
  (`operationalWiring.test.js`), and the same for the AI layer's own - the
  request deadline and the CLI health-probe timeouts - with `execFile` stubbed
  (`aiOperationalWiring.test.js`)
- the documentation of those settings: `.env.example` and the README's
  Configuration table checked against the table in `config/operational.ts` -
  every setting documented, shipped commented out with the code's own default
  and range, and tagged with when it is read - and its README row showing the
  same default, range and tag; plus the CLI budgets shipped commented out
  (`envExample.test.js`)
- the job sheet writer Find Jobs' Export into Sheet appends with
  (`jobSheetRoutes.test.js`): `appendJobRows` on the caller's own sheet only,
  A to F - or A to L for a row carrying its analysis cells - after the last
  row used, NO(DATE) carrying on the day's count, a posting already in the
  tab skipped (the same link, tracking parameters aside, else the same
  company and title), a row typed meanwhile stepped over, and a tab that is
  not a job tab refused before anything is read; and POST
  /api/jobs/lake/export: the picked lake jobs into All, A:L with each job's
  analysis, newest first, the same again in All already, a gone job missing,
  the cap, a body's sheet never read, an All held by a tab of the
  person's own refused before anything is read, and the app's own All with
  its row 1 edited refused in words that say how to get it back - renamed,
  a new All takes the next export

## The v4.2 vocabulary

v4.1 called a resume a "profile" and a list of resumes a "group". v4.2 calls
the first a **resume** in every name, path, id, SQL text, line of copy and
comment, calls the second a **profile** (a person), and calls the Settings tab
of the signed-in user's own account **Account** (it was "Profile"). Two stages
made the change: Stage R (profile becomes resume, and the account's Profile
becomes Account) and Stage G (group becomes profile). The test files that
carried the old word moved with it (retired names): `profileExperienceSkills`, `profileImport`,
`profilePreview` and `profileSections` (retired names) are now `resumeExperienceSkills`,
`resumeImport`, `resumeDraftPreview` and `sectionCatalogue`
(`resumeSections.test.js` was already taken, by the section switches).
`database/glossaryRename.ts` brings a database written under the old words to
the new ones once, in place, inside `getDb()`'s transaction, and
`glossaryRename.test.js` holds all of it true.

**The database.** A fresh database is born with the new names: `resumes`, and
`profiles` for the people (what v4.1 stored as `profile_groups`). The people's
table must never gain a `disabled` column: the step tells v4.1's `profiles`
table of resumes from it by that column alone, so one that had it would be
renamed over `resumes`. A database as v4.1 left it, stamped by that build or
not yet, is made in raw SQL and opened the way the server opens it. Its tables
are renamed (`profiles` to `resumes`, then `profile_groups` to `profiles`), and
so are the `order_items` and `tailor_cache` columns and the stored JSON keys -
a resume's `profileSettings`, the settings' `defaultProfileId` and then
`defaultGroupId` (retired name; in that order, so the new key never reads a resume id), and
five keys of a queued task, so that a task queued before the upgrade restores
and builds - with every row intact, one `[db] Renamed for v4.2: ...` line, a
Bid Assistant answer for a resume that is there kept through its sweep and the
orphan removed, and a second open changing nothing. A database only the resume
rename reached gets only the people's. A stray empty table (an older build
makes one at every start) is dropped. Two tables that both hold rows are
refused by name (`VocabularyConflictError`, ending *Restore the backup taken
before upgrading, then start this build on it.*) with nothing touched, not
even the startup guard's first stamp, and the real server, spawned on such a
database, prints that sentence and exits 1 before any route loads. A default
that is already there is never overwritten, and a key is never deleted. The
startup guard's list of columns stays build ac3df79's, in its names, and the
guard still reads an unstamped database by them.

**What a model reads.** Golden values, computed from v4.1's build and not to be
edited by hand, pin the tailoring prompt's values in both modes and every
tailoring cache key (a resume's in both modes, and a cover letter's), so the
rename changed no byte a model reads and every cached tailoring stays a hit. A
second test names the literals themselves, so that a helpful rename is stopped
at the word and not only at a hash: the hashed field `profile:`, the revise
pass's *FIGURES THE PROFILE STATES AND THE DRAFT DROPPED*, the name
`'Untitled Profile'`, and the prompt id `extract-profile-from-resume` with its
file name.

**The Bid Assistant** keeps its own words (see its bullet above) and still
reaches resumes: it requires `resumeRepository` and `resumeDocument` (it is
`@ts-nocheck`, so the compiler cannot say when a require goes stale), every
member it calls on them is exported, the limit it checks comes from
`database/profileLimit`, and its orphan sweep reads `resumes` while its answers
stay keyed by `profile_id`.

**Spellings that stay.** Some words still say "profile" on purpose, and no scan
asks for them to change: the limit (`profileLimit`, `profilesUsed`,
`orphanedProfiles`, `ProfileLimitError`, `assertCanAddProfile`, the code
`profile-limit`), which counts people; the people themselves (a run's
`profileId`, which names ONE profile, `ProfileSummary`, `ProfileSelector` and
the Profiles desk at `/admin/profiles`, with a profile's page under it, which
lists people and their resumes); and what is stored or sent to a model
(`[[profileJson]]`, `{{profile_name}}` in folder paths and file names,
`answers.profile_id`, `'Untitled Profile'`). The run's other names that once
kept the word - a list of profile ids, the several-profile targets and the
lock on a run - are retired, and the scan for retired names below fails on
them.

**The scans** read every script and stylesheet under `backend/src`,
`backend/scripts`, `backend/test`, `frontend/src`, `frontend/scripts` and
`scripts` (the Bid Assistant's files keep their own words and are read
separately). R-4 and the retired-name scan blank the comments first, with the
TypeScript parser, so that a hit keeps its line number; A-1 and the group
scans read comments too, since a comment says where to click:

- *The paths.* No compiled module of a retired path is left in `backend/dist`
  (above), the retired source paths are gone (the frontend rewrite put the
  Groups page, the several-profile targets, the Models price helper and the
  Multiple flow's previews on that list), and the moved files are where they were put. *R-1*: no path in
  the tree names a profile but the limit's file (`database/profileLimit.ts`),
  the people's files (`types/profile.ts`, `database/profileRepository.ts`,
  `database/profileTree.ts`, `routes/profiles.ts`, `services/profileRules.ts`
  and `test/profileTree.test.js`), the prompt file
  `extract-profile-from-resume.json`, whose name is its id, and the profiles
  desk, which draws and tests people: the dashboard and a profile's page under
  `app/admin/profiles/`, `ProfileSelector.tsx`, `components/profiles/*`,
  `lib/profileDashboard.ts`, `test/frontendProfiles.test.js` and the browser
  script `test/e2e/profiles.js`. A path about people added later is listed in
  `PATHS_STILL_NAMED_PROFILE` in the test, with the reason.
- *R-4*: no SQL text, bound parameter, route path, module name, DOM id or
  stylesheet name still carries the old word, and no retired name of the
  resume record is left (`ProfileSettings`, `profileForTemplate`,
  `buildNewProfile` and the rest of the test's list); `profileSettings` itself
  lives in the import and the step alone. The people's spellings - the
  `profiles` table, `/api/profiles`, `profilesApi`, `defaultProfileId`,
  `#default-profile` - stand only in the files that are about people
  (`PEOPLE_FILES` in the test) and are a leak anywhere else, which is how the
  scans go on working after a word has changed its meaning; even there, a
  quoted (retired) `/profiles/preview`, `/profiles/import`, `/profiles/upload` or
  `/profiles/entries` is a retired leftover of the resume router. A profile's
  page address (`/admin/profiles/<id>`) is a person's too, while the old
  chooser and editor addresses under it stay a leak (only the browser script
  that checks they redirect may say one); and every allowance of this kind is
  held to be used, so a file that no longer draws a `profile-` DOM id, calls
  the people's routes or says a profile's page address comes off its list.
- *A-1*: the Settings tab is Account, and nothing - comments included - says
  "Settings > Profile" (retired name) or calls the page `ProfileSettingsPage`.
- *G-1* and *G-2*: every `group` word left is another sense of it (skill
  groups, the Grouped layout, `GROUP BY`, `role="group"` and
  `role="radiogroup"`, a MultiSelect's option groups...) or sits in one of
  the three BACKEND files that hold the key an older settings row may still
  carry (`defaultGroupId` (retired name) in `config/aiModelConfig.ts` and in
  the two tests that assert it is read past and not served), each of which
  lists the group words it holds, so that a new one in it fails, and so does
  a word the list keeps after the file has lost it. The frontend rewrite
  emptied the rest of that list: the Groups page, its rail row, lock and icon, the Specific group
  target and the tier copy that named groups are gone, so no file of the
  frontend, of the e2e scripts or of the frontend tests may be listed (G-1
  fails if one comes back), and the test checks that each file the surface
  once held says no group word of the retired sense, the capitalised bare
  words included. A few browser scripts and tests still say some, to assert
  that the old rail row, the lock's id and the setting's box are absent, and
  nothing else. The retired group
  strings (retired: `/api/groups`, `groupRepository`, `groupsApi`, `defaultGroupId`,
  `Untitled Group`, and the `Group` type declared, annotated, cast or
  imported) are gone, but for the step and the guard, which name the old table
  and key on purpose; the frontend rewrite added the Groups page's address,
  the lock id `many-profiles`, the `data-locked-panel` attribute, *Select Group* and
  *Specific group* to them, and nothing may say any of them. (The browser
  scripts and the page tests no longer probe that the Groups page or its ids
  stay away - owner's decision - so no file is allowed one of these words;
  this scan still fails on any source or test file that says one.)
- *The run and frontend rewrites*: the names the run, price and mode rewrite
  and the frontend rewrite retired are gone from the WHOLE tree - the backend,
  the frontend, the e2e scripts and the frontend tests alike: the
  several-profile run (`ProfileTargets` (retired name), the builder's target
  helpers, `canBuildForManyProfiles`, `describeTooLowRefusal`), the template
  rule (`templatesUsedByOthers`, `templateOptions`), the resume's tailoring
  mode (`TAILOR_MODE_CHOICES`), the model's price (`formatPricePerResume`),
  the Multiple flow's previews and the locked panel and subscription gate
  components. The only files that may still say one are the tests that assert
  it is gone, each allowance naming the file and why, and the scan fails on
  an allowance a file no longer uses; a few narrow ones stay for names that
  are the quote's own (`pricePerResumeMilli` in the client's quote, in
  `lib/generationQueue.ts` and `lib/format.ts`). Every pattern is proven to
  catch its shapes in a backend file, a frontend one, an e2e script and a
  frontend test.
- The clients ask `/resumes` for the record and `/resume/` for the tailoring
  and the server mounts both, and the main routes say *Resume not found* where
  the Bid Assistant keeps *Profile not found.*
- The patterns are tested too: each runs against samples it must catch and
  against the spellings that stay (`[[profileJson]]`, `{{profile_name}}`,
  `role="group"`, `GROUP BY`, `profileLimit`, `ProfileSelector`,
  `BuildModeChoice`...), and the
  comment stripper against a `/*` that is not a comment, so that a scan that
  stopped working fails instead of passing the tree for nothing.

The one scan that is not automated is the bare word "profile" in copy and
comments: each such line is the limit, a person (a profile since Stage G, a
run's `profileId` among them), a word a model or a stored value reads, or the
printed section heading, which only a reader can tell from a leftover.

**G-3 needs the files as they were before Stage G.** It checks that Stage G
edited no line that already said "profile". That state is not in git (the
stages were applied before anything was committed), so the test compares only
when `V42_PRE_G_FILES` names a folder holding the files Stage G changed as they
were before it, at their repository-relative paths: 23 files, three of them the
group files Stage G moved, under their old names, which are skipped. The
snapshot taken when Stage G was applied is `snap-pre-G/files` in the v4.2
working materials, outside the repository:

```sh
cd backend && V42_PRE_G_FILES=/path/to/snap-pre-G/files node scripts/runTests.js test/glossaryRename.test.js
```

(In PowerShell set `$env:V42_PRE_G_FILES` first. `runTests.js` passes the
environment through, so the same variable serves `npm test`.) Without it the
test still passes, after running its comparison over samples, and says so:
*G-3 compared no files: V42_PRE_G_FILES does not name the folder of the files as
they were before Stage G.* Read the run's output, not the tick: G-3 has
checked the tree only when the run prints *G-3 compared 20 files against*
and the folder.

## Testing the CLI providers

`claudeCli.test.js`, `codexCli.test.js` and `geminiCli.test.js` never spawn a
process, never touch the network, and do not need the `claude`, `codex` or
`gemini` binary. They work because `child_process` is confined to one module
(`services/ai/providers/cli/runner.ts`) behind the injectable `CliRunner`
interface; the tests pass `makeFakeCliRunner` from `helpers.js`, which replays
NDJSON event streams from `test/fixtures/cli/`, `test/fixtures/codex/` and
`test/fixtures/gemini/`. The health checks stub `child_process.execFile`
instead.

All three suites set `AI_CLI_BIN`, `AI_CODEX_BIN` and `AI_GEMINI_BIN` - and
the binary every adapter they build is configured with - to paths that do not
exist, so a code path that accidentally reached a real spawn fails loudly
rather than passing by accident on a developer machine that has the CLI
installed.

A fixture's name says what it is, because a fixture that LOOKS recorded is how
a test ends up agreeing with an assumption: `recorded-` is a real capture;
`constructed-` is the real CLI's envelope around an answer that could not be
captured on a machine with no subscription signed in (every successful Codex
and Gemini turn here); `verified-` is a file that was run against the real
binary and is pinned so what the adapter writes cannot drift from it.

**Record fixtures, do not invent them.** Several rules in the provider exist
because the real event shapes are surprising - a hard model 404 arrives with
`subtype: "success"` and `is_error: true`, and the answer is repeated in full on
the final `result` event. To add one, capture the real thing:

```sh
claude -p --output-format stream-json --include-partial-messages --verbose \
  --model haiku --tools "" --safe-mode --no-session-persistence \
  <<< 'your prompt' > backend/test/fixtures/cli/your-case.ndjson
```

`makeFakeCliRunner` also accepts raw `chunks` instead of `lines`, which is how
line splitting is exercised across real chunk boundaries (including mid-UTF-8).
