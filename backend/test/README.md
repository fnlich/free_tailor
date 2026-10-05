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

Storage tests point `DB_DIR` (SQLite database) and `TAILOR_STATIC_DIR` (default prompts, skill seed, built-in templates) at temporary folders under `os.tmpdir()`, so they never touch the real database or shipped assets.

**The run cleans up after itself.** The suite makes a fresh temporary directory for nearly every test (several hundred per run) and nothing deletes them one by one, so `scripts/runTests.js` gives the whole run a temporary root of its own - it sets `TMPDIR`, `TEMP` and `TMP` (what `os.tmpdir()` reads on each platform, inherited by any child a test spawns) to a new `tailor-test-run-*` directory, runs `node --test "test/*.test.js"`, deletes the directory and exits with the suite's own code. The system temp directory gains nothing from a run. To look at what a failing test left behind, keep it:

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
- app settings persistence and the provider migrations, among them the two
  removals - the browser chat providers (006, `browserChatRemoval.test.js`) and
  the metered API providers (007, `meteredRemoval.test.js`) - each pinned both
  as the migration and as the read-time tolerance that stands without it
- the Gemini seat wired in - catalog, registry, health card (which asks every
  seat for a fresh check, the one that can lift a hold), operational
  settings, fresh-install seeds - and migration 008, which gives an upgraded
  model list the Gemini model and renames untouched seed names
  (`geminiSeat.test.js`)
- model administration: the per-seat model-name lists and their `.env`
  overrides, the admin payload that serves them, create and edit validation,
  Set Default refusing a model that cannot run, and prompt overrides checked
  against the same lists (`modelAdministration.test.js`)
- the price per resume: the `creditsPerResume` field on every record (seeded,
  read as the default without a write-back, clamped on read, refused by name on
  a save, kept by a partial edit), the credit primitives taking an amount, and
  the queue refunding each task's snapshotted price - restored tasks included
  (`modelPricing.test.js`); and through the routes, the quote, a mixed-price
  batch charged the sum and refunded per task, the 402, free models, the
  exempt administrator and `/resume/generate` resolving before it charges
  (`generationPricing.test.js`)
- what an ordinary account may know of models: the slim `GET
  /api/resume/models`, a stored choice falling back while a requested one is
  refused with one generic sentence, the provider request forms kept for
  administrators, the profile-save check, and the job filter and Bid Assistant
  on the app default model (`userModelAccess.test.js`)
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
  cause and a ref; the payment method reasons and the scraper actors are
  pinned beside their routes (`paymentRoutes.test.js`, `scraperWiring.test.js`)
- whose Bid Assistant data is whose (`bidAssistantScoping.test.js`): a saved
  sheet source is its owner's, and a legacy owner-less one or a deleted
  account's an administrator's to change; answers are read and deleted
  through the reader's own profiles, go with the profile - so an account that
  later takes its id reads none - and are all a job's "Answered" flag counts;
  and the shared job board's deletions are an administrator's
- the batch progress stream's bare-newline heartbeat, which keeps a proxy's
  idle timeout from cutting a long batch (`batchStream.test.js`)
- the account tier's rename from plan to subscription
  (`subscriptionRename.test.js`): `users.plan` renamed in place on a database
  the older build made, values and default kept, logged once and a no-op on
  the next start, renamed forward again after a rollback renamed it back, and
  both columns left alone with a warning; Settings > Subscription as a tab
  with `/settings/plan` a `redirect()` to it; and no frontend code or copy
  still calling the tier a plan. The tier gate itself, `requireSubscription`,
  is in `sectionPermissions.test.js`, the admin payloads in
  `accountRoutes.test.js`, and the frontend's copy of the tier order is held
  to the backend's in `frontendHelpers.test.js`
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
- the live profile preview over HTTP (`profilePreview.test.js`), run with all
  three seats locked so a 200 also proves no model was asked: nothing written
  or charged even at the subscription's profile limit, the draft laid over the caller's own
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
  clean, the note on a tailoring prompt that predates the switches, and such a
  prompt still obeying them through a stub seat
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
  administrators (never a reporter), or for administrators; the test fails on a
  mount with no row and on any route whose guard - read off the router - is
  not the one its row decides, and over HTTP with a session per role it
  refuses a reporter every route that is not theirs (403 `role-not-allowed`)
  and lets them reach their own account, credits, bell, sheet and refund
  history. Roles, a reporter's rate per job (served on the list too, and
  added to a `users` table from before reporters), which setting names a
  configured administrator, and recorded payouts are in
  `accountRoutes.test.js` and `accounts.test.js`
- the reporter's side of the frontend (`frontendRoles.test.js`): its copy of
  the role catalog is the backend's; of every App Router page, a reporter
  opens exactly Report Jobs, Credits and Settings -> Profile / Job Sheet and is
  sent to Report Jobs from the rest; the rail and Settings tabs offer them only
  those (an entry naming no roles is a builder's); the rate per job box and
  Record payout say what `parseReportRateUsd` and the real payout route say,
  word for word; a 403 `role-not-allowed` re-reads the account rather than
  signing anybody out - from every place the frontend calls `fetch` itself,
  the Bid Assistant's client included, each of which is listed with why it
  may; and a configured administrator's row names ADMIN_EMAILS or SMTP_USER as
  the server says
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
- the job scrapers' SCRAPER_* and APIFY_* settings: the actor inputs each
  mapper builds from them (`scraperFilters.test.js`); the actor id, run
  timeout and input every provider sends - identical to the old literals when
  nothing is set - plus the served catalog and the routes' default location
  and result cap, with the Apify client stubbed on its prototype
  (`scraperWiring.test.js`); and the jobs form's handling of the served values
  (`scraperForm.test.js`)
- the documentation of those settings: `.env.example` and the README's
  Configuration table checked against the table in `config/operational.ts` -
  every setting documented, shipped commented out with the code's own default
  and range, and tagged with when it is read - and its README row showing the
  same default, range and tag; plus the CLI budgets shipped commented out
  (`envExample.test.js`)

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
