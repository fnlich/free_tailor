# Backend Tests

Run from the repository root:

```sh
npm test
```

Or run only the backend test suite:

```sh
npm run test --prefix backend
```

The backend tests use Node's built-in `node:test` runner and require no extra test dependencies. The test script builds TypeScript first, then runs the compiled JavaScript from `backend/dist`.

Storage tests point `DB_DIR` (SQLite database) and `TAILOR_STATIC_DIR` (default prompts, skill seed, built-in templates) at temporary folders under the system temp directory, so they never touch the real database or shipped assets.

Coverage currently focuses on:

- SQLite-backed skills CRUD and seeding from the static skill library
- prompt CRUD, rendering, activation, and validation
- app settings persistence and the provider migrations, among them the two
  removals - the browser chat providers (006, `browserChatRemoval.test.js`) and
  the metered API providers (007, `meteredRemoval.test.js`) - each pinned both
  as the migration and as the read-time tolerance that stands without it
- the Gemini seat wired in - catalog, registry, health card, operational
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
- the Claude CLI provider: argv, child environment, event reduction, failure
  classification, rate limits, outages and concurrency
- the platform-dependent decisions - the default database directory, Windows
  binary resolution, the Windows command-line budget and the path characters
  Windows reserves. Each of those takes its platform as an argument rather than
  reading `process.platform`, so both branches are covered from either host and
  a Windows-only regression fails on Linux CI.
- generated output paths
- JSON extraction utilities
- array utilities
- output path safety helpers
- current auth middleware behavior
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

## Testing the Claude CLI provider

`claudeCli.test.js` never spawns a process, never touches the network, and does
not need the `claude` binary. It works because `child_process` is confined to
one module (`services/ai/providers/claudeCli/runner.ts`) behind the injectable
`CliRunner` interface; the tests pass `makeFakeCliRunner` from `helpers.js`,
which replays NDJSON event streams from `test/fixtures/cli/`.

`AI_CLI_BIN` is set to a path that does not exist, so a code path that
accidentally reached a real spawn fails loudly rather than passing by accident
on a developer machine that has Claude Code installed.

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
