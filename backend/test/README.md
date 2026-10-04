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
- app settings persistence and the provider migration
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
  request deadline, the metered base URLs and attempt count, the headers
  DeepSeek is sent and the CLI health-probe timeouts - with fetch and
  `execFile` stubbed (`aiOperationalWiring.test.js`)
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
  and range, and tagged with when it is read (`envExample.test.js`)

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
