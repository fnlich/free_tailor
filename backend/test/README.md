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

The suite needs only the backend installed. Two tests in `installCheck.test.js` check this checkout's own install - every package the root, backend and frontend `package.json` files name is installed, and `scripts/checkInstall.mjs` prints nothing - and are skipped, saying why, where the root's or the frontend's `node_modules` was never made (a backend-only install such as `npm ci --prefix backend`). A `node_modules` that is there but short of a package still fails them; `npm run install:all` from the repository root puts it right.

Storage tests point `DB_DIR` (SQLite database) and `TAILOR_STATIC_DIR` (default prompts, skill seed, built-in templates) at temporary folders under `os.tmpdir()`, so they never touch the real database or shipped assets.

**The run cleans up after itself.** The suite makes a fresh temporary directory for nearly every test (several hundred per run) and nothing deletes them one by one, so `scripts/runTests.js` gives the whole run a temporary root of its own - it sets `TMPDIR`, `TEMP` and `TMP` (what `os.tmpdir()` reads on each platform, inherited by any child a test spawns) to a new `tailor-test-run-*` directory - and `DB_DIR` to a `db` directory inside it, whatever the environment says, so a test that opens the database before it sets up its own storage (the PDF generator reads the skill library as it loads) never reaches the real one - runs `node --test "test/*.test.js"`, deletes the directory and exits with the suite's own code (`testRunner.test.js` holds it to that). The system temp directory gains nothing from a run. To look at what a failing test left behind, keep it:

```sh
TAILOR_KEEP_TEST_TMP=1 npm run test --prefix backend
```

To run one file the same way (after `npm run build --prefix backend`, since the tests load `dist/`):

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
  version 5 or never recorded, waiting for an administrator, credits never
  switched to dollars, saved templates never moved or moved incompletely,
  `users.plan` never renamed, lake rows without their facts - with nothing
  created and no stamp, every one of them in a single refusal; and the real
  server spawned on such a database printing that one line and exiting 1, no
  stack trace, never listening; and the README's quotes of that line held to
  the guard's own words
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
- the price per resume: `pricePerResumeMilli` on every record, in thousandths
  of a dollar (every seed free until priced and named in the admin payload; a
  record priced in credits, or with no price, read as free without a
  write-back; junk or out of range clamped or free on read, warned once; a
  dollar price refused by name on a save when missing or bad; kept by a
  partial edit and by every settings save), the credit primitives taking an
  amount, and the queue refunding each task's snapshotted `costMilli` -
  restored tasks included (`modelPricing.test.js`); and through the routes, the
  quote, a mixed-price
  batch charged the sum and refunded per task, the 402, free models, the
  exempt administrator and `/resume/generate` resolving before it charges
  (`generationPricing.test.js`)
- what an ordinary account may know of models: the slim `GET
  /api/resume/models`, a stored choice falling back while a requested one is
  refused with one generic sentence, the provider request forms kept for
  administrators, the profile-save check, the job filter naming the analysis
  model and the Bid Assistant on the app default model
  (`userModelAccess.test.js`)
- job analysis runs once (PLAN check 1): the ten cases that used to re-run it,
  each through the real routes and queue against a COUNTING stub seat that
  must see exactly one analysis call, and a damaged stored row analysed once
  more and repaired in place (`analysisOnce.test.js`); the store with
  no window, cap or overwrite, the prompt edit, the analysis model and the
  closed job-field list (`analysisCacheEndToEnd.test.js`); the in-flight join,
  a caller's abort, a failed call storing nothing (`analysisInFlight.test.js`);
  the gate as the only caller of the analysis prompt, its byte-identical
  cached prefix holding the job field and industry lists ahead of the
  posting, an administrator's analysis prompt that never names the lists not
  run - the built-in is, and no turn carries an addendum - and a sheet row's
  cell worth only the stored
  analysis its id names for that posting - an unknown id never stored, and
  nothing in the code writing `source = 'sheet'` (`analysisGate.test.js`); the
  table, its UNIQUE
  indexes, the link and text identities, EXPLAIN QUERY PLAN on every lookup
  (and on the lake's two reads) and the repair of an unreadable row, the
  closed industry list with stable ids (an unknown word Other), an industry
  only when the answer had the key - an older analysis, row or sheet cell
  stays without - and derived for such an analysis from its company category,
  else its free-text industry, else not specified, and job type (Remote,
  Hybrid, Onsite or blank) and clearance (required unless the analysis says
  none or does not say) (`jobAnalysisStore.test.js`); the industry, like the
  job field, salary and filter, never reaching the tailoring prompt nor
  changing a tailoring cache key (`tokenBudget.test.js`); and the app sheet's
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
  analysis path, an unknown clearance failing closed (`jobFilter.test.js`).
  `analysisHarness.js` is their shared install, stub seats and output stubs.
  The pages' half (`frontendAnalysis.test.js`): the builder holding one
  analysis per posting (re-spaced text the same posting, edited text or
  another link not, a 400 letting it go), the salary line, the posting
  normalisation, the Analysis cell's states and the sheet panel's column
  letters, and the prompt editor's required variables - which they are, what
  a text lacks, the *Needs update* note and the refusal of a save in the
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
  delete; the admin query; and four threads adding the same job at once
  (`jobLakeStore.test.js`); the admin sheet's outbox - created once (a failed
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
  own filters and refusals, the cap, writes of at most 200 rows and about
  1.5 MB with the grid grown first and a long description cut with the
  marker (never through a surrogate pair), a build from the pushed rows
  asking no model - a link-less job whose description was cut among them,
  matched by its cut copy until that is edited - one push per
  administrator, a Temp For AI that is not a job tab or whose name is the
  person's own refused before any write, admins only, and the read's plan
  (`jobLakePush.test.js`). The pages' half (`frontendJobLake.test.js`): the
  rows a run is asked for, the settings boxes and what a save sends, and the
  lake's filters, each refused by the page exactly when and in the words the
  server refuses them; the filter boxes in the owner's order (pinned, and
  drawn from it by the Lake tab), the job type and clearance choices against
  the server's, and the query string in that order; Push to Google Sheet's
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
  in the run's words
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
  no tailoring call and charged again, a one-character profile change, another
  model, an edited prompt, another template and a library skill the posting
  names each a miss, the key's parts, a cover letter's own key, every caller
  passing its context (/resume/preview, /resume/generate and the queue's
  tailoring and cover letter), nothing cached without an analysis id, an
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
  through the reader's own profiles, go with the profile - so an account that
  later takes its id reads none - and are all a job's "Answered" flag counts;
  and the shared job board's deletions are an administrator's
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
  of it run against the server's (`frontendMoney.test.js`)
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
  an administrator followed by a Contact admin link (`frontendRefunds.test.js`)
- Generate Immediately and Order: the two kinds, the tab lease through the
  stream, the release, the owner-checked per-file download and the deletion
  after the run (`immediateRuns.test.js`); the grace on a mock clock
  (`tabLease.test.js`); immediate work before orders on one lane
  (`queuePriority.test.js`); one profile on every subscription, several only
  from Premium, administrators exempt (`subscriptionGates.test.js`); the Tab
  select's listing (`sheetTabs.test.js`); the builder's reattach seeing only
  the caller's own runs (`builderRunListing.test.js`); a restored run keeping
  its reservation (`restoreReconcile.test.js`); an untitled row built for its
  analysis's title (`queuedRole.test.js`); and the page's own decisions - a
  tab's id, the downloads, the release request, how a run ended, the sheet
  rows (`immediateRunHelpers.test.js`)
- saved templates as files (`templateFiles.test.js`): import, extraction and
  the manual builder each writing `<id>.json` with its source, an edit
  rewriting it and a delete removing it while a built-in stays as shipped, ids
  checked before any path is built, a lookup taking an id exactly as its file
  carries it (no folding of case or underscores), a directory that cannot be
  written giving the generic error and leaving no `.tmp`, the startup line
  saying whether saved templates can be written, and a stale scratch file
  swept
- the profile preview's sample person (`sampleDefaults.test.js`): an empty
  draft filled field by field and section by section, typed values winning,
  and the sample reaching nothing but the preview route - never a save, a PDF
  or a prompt; and the editor's helpers - the pane width that stops the
  preview shaking, the "N kept" line, the sample-text notice and placeholders
  (`frontendEditorHelpers.test.js`)
- a profile's two section switches and its own soft skills
  (`resumeSections.test.js`): off unless stored `true`, kept by a save that
  omits them; the soft-skill list cleaned, bounded and kept; the preview's
  profile builder never throwing and taking only the settings that change the
  render; the render gate - a switched-off section empty whatever the content
  carries, a switched-on one showing the tailored list or, when that is empty,
  the profile's own; the live preview grouping only the skills entered while
  generation still pads; links reaching an `href` only as http(s); and the
  DOCX carrying Strengths and Soft Skills exactly when the PDF does
- the templates and the two skills layouts (`templateLayouts.test.js`): every
  built-in rendered in each layout it declares (one item per skill Plain,
  headings Grouped) and with each switch on and off, its capability flags
  against its markup, the section-stripping regressions, layouts inferred for
  a template that states none and kept for one that does (stored, imported,
  manual), an administrator's reclassification and its refusal by name, the
  gallery preview's options and no-script policy, and the template resolver's
  fallbacks
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
  profile preview route and the render a PDF prints from agreeing, the stored
  file never rewritten
- the live profile preview over HTTP (`profilePreview.test.js`), run with all
  three seats locked so a 200 also proves no model was asked: nothing written
  or charged even at the subscription's profile limit, the draft laid over the
  caller's own
  profile and somebody else's a 404, half-typed drafts rendering, nothing typed
  able to run, the layout and switches reaching the page, the template order
  and layout fallback, a disabled template a 404 for a user only, and a 503
  with a ref when no template is enabled
- tailoring by the switches (`resumeSectionPrompts.test.js`): the three
  prompt values as words outside `profileJson`, the shipped prompt and the
  appended override saying what the switches say, strengths and soft skills
  kept, replaced or emptied per switch with nothing invented, the summary's
  `Working style:` sentence only while Soft Skills is off, a Plain list with
  no library padding, job-relevance ordering that keeps every skill, and held
  content - a builder preview, a queued task - finished against the profile as
  it is now; and end to end, two profiles on one analysis each tailored by
  their own switches through `/api/resume/preview-all`
  (`sectionSwitchesEndToEnd.test.js`)
- prompt variables (`promptVariables.test.js`): every feature declaring
  exactly the variables its code supplies, a typo refused on save and named
  on validate (also through the routes), the shipped prompts validating
  clean, a save that leaves out a required variable refused naming it and the
  rule, a stored record without one marked `needsUpdate` with the names and
  never run - the built-in runs in its place, said once - and the switches
  stated on every tailoring turn whichever record runs, through a stub seat
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
- generated output paths
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
  history. Roles, a reporter's rate per job (served on the list too), which
  setting names a configured administrator, and recorded payouts are in
  `accountRoutes.test.js` and `accounts.test.js`
- the reporter's side of the frontend (`frontendRoles.test.js`): its copy of
  the role catalog is the backend's; a reporter's Credits mounts no buyer's
  panel and reads only their own requests (for payouts) and the payout routes;
  of every App Router page, a reporter
  opens exactly Report Jobs, Credits and Settings -> Profile / Job Sheet and is
  sent to Report Jobs from the rest; the rail and Settings tabs offer them only
  those (an entry naming no roles is a builder's); the rate per job box and
  Record payout say what `parseReportRateUsd` and the real payout route say,
  word for word; a 403 `role-not-allowed` re-reads the account rather than
  signing anybody out - from every place the frontend calls `fetch` itself,
  the Bid Assistant's client included, each of which is listed with why it
  may; and a configured administrator's row names ADMIN_EMAILS or SMTP_USER as
  the server says
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
- the job sheet writer the removed job search exported with, kept for Find
  Jobs (`jobSheetRoutes.test.js`): `appendJobRows` on the caller's own sheet
  only, A to F - or A to L for a row carrying its analysis cells - after the
  last row used, NO(DATE) carrying on the day's count, a company (or whatever
  `duplicateKeys` names) already in the tab skipped, a row typed meanwhile
  stepped over, and a tab that is not a job tab refused before anything is read

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
