const assert = require('node:assert/strict');
const test = require('node:test');

const op = require('../dist/config/operational');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');

/**
 * The table of operational settings that used to be literals.
 *
 * Two promises are pinned here. First, the DEFAULTS are exactly the literals
 * they replaced, so an installation that sets none of these runs as it did
 * before they existed - the table's own `defaultValue` is checked against what
 * each getter returns for an empty environment, and the important ones against
 * the old literal written out by hand. Second, no value can stop the server:
 * every getter, given junk, warns once and answers with its default; given a
 * number out of range, clamps and warns once.
 */

function withWarnings(read) {
  resetEnvWarningsForTests();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { value: read(), warnings };
  } finally {
    console.warn = original;
  }
}

/** Every whole-number getter, by the variable it reads. */
const INT_GETTERS = {
  SESSION_TTL_DAYS: op.sessionTtlDays,
  JSON_BODY_MAX_MB: op.jsonBodyMaxMb,
  UPLOAD_MAX_MB: op.uploadMaxMb,
  HTTP_REQUEST_TIMEOUT_MS: op.httpRequestTimeoutMs,
  AI_REQUEST_TIMEOUT_MS: op.aiRequestTimeoutMs,
  CLAUDE_MAX_ATTEMPTS: op.claudeMaxAttempts,
  AI_CLI_HEALTH_TIMEOUT_MS: op.aiCliHealthTimeoutMs,
  AI_CODEX_HEALTH_TIMEOUT_MS: op.aiCodexHealthTimeoutMs,
  GENERATION_RENDER_CONCURRENCY: op.generationRenderConcurrency,
  PDF_RENDER_TIMEOUT_MS: op.pdfRenderTimeoutMs,
  ORDER_RETENTION_SWEEP_MS: op.orderRetentionSweepMs,
  SMTP_CONNECTION_TIMEOUT_MS: op.smtpConnectionTimeoutMs,
  SMTP_SOCKET_TIMEOUT_MS: op.smtpSocketTimeoutMs,
  SMTP_MAX_CONNECTIONS: op.smtpMaxConnections,
  SHEET_BACKFILL_PAUSE_MS: op.sheetBackfillPauseMs,
  JOB_PAGE_FETCH_TIMEOUT_MS: op.jobPageFetchTimeoutMs,
  JOB_PAGE_BROWSER_TIMEOUT_MS: op.jobPageBrowserTimeoutMs,
  APIFY_RUN_TIMEOUT_S: op.apifyRunTimeoutS,
  CRYPTOMUS_INVOICE_LIFETIME_S: op.cryptomusInvoiceLifetimeS,
};

/** The literals these replaced, written out rather than read from the table. */
const OLD_LITERALS = {
  SESSION_TTL_DAYS: 30,
  JSON_BODY_MAX_MB: 10,
  UPLOAD_MAX_MB: 10,
  HTTP_REQUEST_TIMEOUT_MS: 15 * 60_000,
  AI_REQUEST_TIMEOUT_MS: 300_000,
  CLAUDE_MAX_ATTEMPTS: 4,
  AI_CLI_HEALTH_TIMEOUT_MS: 20_000,
  AI_CODEX_HEALTH_TIMEOUT_MS: 15_000,
  GENERATION_RENDER_CONCURRENCY: 4,
  PDF_RENDER_TIMEOUT_MS: 30_000,
  ORDER_RETENTION_SWEEP_MS: 6 * 60 * 60 * 1000,
  SMTP_CONNECTION_TIMEOUT_MS: 10_000,
  SMTP_SOCKET_TIMEOUT_MS: 20_000,
  SMTP_MAX_CONNECTIONS: 2,
  SHEET_BACKFILL_PAUSE_MS: 250,
  JOB_PAGE_FETCH_TIMEOUT_MS: 20_000,
  JOB_PAGE_BROWSER_TIMEOUT_MS: 25_000,
  APIFY_RUN_TIMEOUT_S: 300,
  CRYPTOMUS_INVOICE_LIFETIME_S: 3600,
};

/* ===================================================== whole-number getters */

test('every whole-number setting defaults to the literal it replaced', () => {
  for (const [name, read] of Object.entries(INT_GETTERS)) {
    assert.equal(read({}), OLD_LITERALS[name], `${name} unset`);
    assert.equal(read({ [name]: '' }), OLD_LITERALS[name], `${name} empty (a copied NAME= line)`);
    assert.equal(read({ [name]: '  ' }), OLD_LITERALS[name], `${name} whitespace`);
  }
});

test('every whole-number setting takes a valid override', () => {
  for (const [name, read] of Object.entries(INT_GETTERS)) {
    const { min, max } = op.OPERATIONAL_INT_BOUNDS[name];
    const inside = min === max ? min : min + 1;
    assert.equal(read({ [name]: String(inside) }), inside, name);
    assert.equal(read({ [name]: String(max) }), max, `${name} at its maximum`);
  }
});

test('every whole-number setting warns once on junk and uses its default', () => {
  for (const [name, read] of Object.entries(INT_GETTERS)) {
    const { value, warnings } = withWarnings(() => {
      const first = read({ [name]: 'ten' });
      read({ [name]: 'ten' });
      return first;
    });
    assert.equal(value, OLD_LITERALS[name], name);
    assert.equal(warnings.length, 1, `${name} warns exactly once`);
    assert.match(warnings[0], new RegExp(`${name}="ten"`));
  }
});

test('every whole-number setting clamps an out-of-range value and warns', () => {
  for (const [name, read] of Object.entries(INT_GETTERS)) {
    const { min, max } = op.OPERATIONAL_INT_BOUNDS[name];
    const above = withWarnings(() => read({ [name]: String(max + 1) }));
    assert.equal(above.value, max, `${name} above max`);
    assert.equal(above.warnings.length, 1, `${name} above max warns`);

    const below = withWarnings(() => read({ [name]: String(min - 1) }));
    assert.equal(below.value, min, `${name} below min`);
    assert.equal(below.warnings.length, 1, `${name} below min warns`);
  }
});

test('the bounds the plan fixed, so a change to one is a decision and not a slip', () => {
  const bounds = (name) => {
    const { min, max } = op.OPERATIONAL_INT_BOUNDS[name];
    return [min, max];
  };
  assert.deepEqual(bounds('SESSION_TTL_DAYS'), [1, 365]);
  assert.deepEqual(bounds('JSON_BODY_MAX_MB'), [1, 100]);
  assert.deepEqual(bounds('UPLOAD_MAX_MB'), [1, 100]);
  // Never 0: Node reads requestTimeout 0 as "no limit at all".
  assert.deepEqual(bounds('HTTP_REQUEST_TIMEOUT_MS'), [60_000, 3_600_000]);
  assert.deepEqual(bounds('AI_REQUEST_TIMEOUT_MS'), [5_000, 3_600_000]);
  assert.deepEqual(bounds('GENERATION_RENDER_CONCURRENCY'), [1, 32]);
  // Never 0: nodemailer reads 0 as "wait for ever".
  assert.deepEqual(bounds('SMTP_CONNECTION_TIMEOUT_MS'), [1_000, 300_000]);
  assert.deepEqual(bounds('SHEET_BACKFILL_PAUSE_MS'), [0, 60_000]);
  assert.deepEqual(bounds('CRYPTOMUS_INVOICE_LIFETIME_S'), [300, 43_200]);
  assert.deepEqual(bounds('CALENDAR_API_TIMEOUT_MS'), [1_000, 120_000]);
  assert.deepEqual(bounds('CALENDAR_DETAIL_CONCURRENCY'), [1, 32]);
});

test('the derived getter uses the same reader as its base', () => {
  assert.equal(op.sessionTtlMs({}), 30 * 24 * 60 * 60 * 1000);
  assert.equal(op.sessionTtlMs({ SESSION_TTL_DAYS: '7' }), 7 * 24 * 60 * 60 * 1000);
});

/* ====================================================================== PORT */

test('PORT: a valid port is used, anything else warns and uses 3001 - never a crash in listen', () => {
  assert.equal(op.serverPort({}), 3001);
  assert.equal(op.serverPort({ PORT: '4000' }), 4000);

  // `Number(x) || 3001` made 0 and junk mean 3001, and a negative or too-large
  // port reach listen(), which throws. Now all of them are 3001 with a warning
  // - and 0 does NOT become port 1, which clamping would have done.
  for (const raw of ['0', '-1', '70000', 'http', '3001.5']) {
    const { value, warnings } = withWarnings(() => op.serverPort({ PORT: raw }));
    assert.equal(value, 3001, raw);
    assert.equal(warnings.length, 1, raw);
  }
});

/* ================================================================== AI URLs */

test('the three metered base URLs default to the vendor endpoints', () => {
  assert.deepEqual(op.claudeBaseUrl({}), { ok: true, url: 'https://api.anthropic.com' });
  assert.deepEqual(op.deepseekBaseUrl({}), { ok: true, url: 'https://api.deepseek.com' });
  assert.deepEqual(op.openaiBaseUrl({}), { ok: true, url: 'https://api.openai.com/v1' });
  assert.deepEqual(op.openaiBaseUrl({ OPENAI_BASE_URL: '' }), { ok: true, url: 'https://api.openai.com/v1' });
});

test('a base URL override is validated and normalized', () => {
  assert.equal(op.claudeBaseUrl({ CLAUDE_BASE_URL: 'https://gateway.example/anthropic/' }).url, 'https://gateway.example/anthropic');
  assert.equal(op.deepseekBaseUrl({ DEEPSEEK_BASE_URL: 'http://127.0.0.1:4000' }).url, 'http://127.0.0.1:4000');
  assert.equal(op.openaiBaseUrl({ OPENAI_BASE_URL: 'https://llm.example/v1' }).url, 'https://llm.example/v1');

  const http = withWarnings(() => op.claudeBaseUrl({ CLAUDE_BASE_URL: 'http://gateway.example' }));
  assert.equal(http.value.url, 'http://gateway.example', 'an operator-set endpoint is never swapped for the vendor');
  assert.equal(http.warnings.length, 1);
  assert.match(http.warnings[0], /CLAUDE_BASE_URL/);
});

test('a base URL that is set but refused is not the vendor endpoint: it is a refusal', () => {
  for (const [read, name, vendor] of [
    [op.claudeBaseUrl, 'CLAUDE_BASE_URL', 'https://api.anthropic.com'],
    [op.deepseekBaseUrl, 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com'],
    [op.openaiBaseUrl, 'OPENAI_BASE_URL', 'https://api.openai.com/v1'],
  ]) {
    const { value, warnings } = withWarnings(() => read({ [name]: 'gateway.corp:8443' }));
    assert.equal(value.ok, false, name);
    assert.match(value.problem, new RegExp(`^${name}[ =]`));
    assert.ok(value.remedy.includes(vendor), `${name}: the remedy says what removing it would mean`);
    assert.equal(warnings.length, 1, name);
  }
});

test('CLAUDE_BASE_URL is its own name: ANTHROPIC_BASE_URL belongs to the claude CLI child', () => {
  assert.equal(op.claudeBaseUrl({ ANTHROPIC_BASE_URL: 'https://elsewhere.example' }).url, 'https://api.anthropic.com');
});

/* ============================================================ AI timeouts */

test('a CLI budget set above the request deadline is reported, because it can never take effect', () => {
  const warnings = op.describeAiTimeoutsAboveRequestDeadline({
    AI_CLI_TIMEOUT_MS_TAILOR: '600000',
    AI_CODEX_TIMEOUT_MS: '400000',
    AI_CLI_TIMEOUT_MS_FILTER: '60000',
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /AI_CLI_TIMEOUT_MS_TAILOR=600000 is longer than AI_REQUEST_TIMEOUT_MS=300000/);
  assert.match(warnings[1], /AI_CODEX_TIMEOUT_MS=400000/);
});

test('raising the request deadline to match silences it', () => {
  assert.deepEqual(
    op.describeAiTimeoutsAboveRequestDeadline({
      AI_CLI_TIMEOUT_MS_TAILOR: '600000',
      AI_REQUEST_TIMEOUT_MS: '600000',
    }),
    []
  );
});

test('defaults nobody wrote are not reported, even under a lowered request deadline', () => {
  // Lowering AI_REQUEST_TIMEOUT_MS below the CLI defaults is a legitimate way
  // to cap everything; it is only an explicitly SET budget that is wasted.
  assert.deepEqual(op.describeAiTimeoutsAboveRequestDeadline({ AI_REQUEST_TIMEOUT_MS: '60000' }), []);
  assert.deepEqual(op.describeAiTimeoutsAboveRequestDeadline({}), []);
  // And junk in a CLI variable is the provider's warning, not this one's.
  assert.deepEqual(op.describeAiTimeoutsAboveRequestDeadline({ AI_CLI_TIMEOUT_MS: 'long' }), []);
});

test('a CLI budget is compared the way the provider reads it: clamped to 3600000', () => {
  const [warning] = op.describeAiTimeoutsAboveRequestDeadline({ AI_CLI_TIMEOUT_MS: '99999999' });
  assert.match(warning, /AI_CLI_TIMEOUT_MS=3600000/);
});

test('a CLI budget the provider reads loosely is reported the same - 600000ms is 600000 to both', () => {
  // The providers have always read these with parseInt. A stricter reader here
  // skipped `600000ms`, which the provider uses as 600000 and the request
  // deadline then silently caps - the exact case this warning is for.
  for (const raw of ['600000ms', '600000.5', ' 600000 ']) {
    assert.equal(op.cliTimeoutMs('AI_CLI_TIMEOUT_MS_TAILOR', { AI_CLI_TIMEOUT_MS_TAILOR: raw }), 600_000, raw);
    const warnings = op.describeAiTimeoutsAboveRequestDeadline({ AI_CLI_TIMEOUT_MS_TAILOR: raw });
    assert.equal(warnings.length, 1, raw);
    assert.match(warnings[0], /AI_CLI_TIMEOUT_MS_TAILOR=600000 is longer than AI_REQUEST_TIMEOUT_MS=300000/, raw);
  }
  const [codex] = op.describeAiTimeoutsAboveRequestDeadline({ AI_CODEX_TIMEOUT_MS_TAILOR: '600000ms' });
  assert.match(codex, /AI_CODEX_TIMEOUT_MS_TAILOR=600000/);
});

test('a CLI budget left at its own default is not reported under a lowered deadline', () => {
  // Older copies of .env.example wrote all six budgets out at their defaults,
  // so a .env made from one has them. Lowering AI_REQUEST_TIMEOUT_MS there is
  // the same legitimate cap as on an install that never wrote them, and a
  // warning would tell the operator to undo it.
  const copiedFromOlderExample = {
    AI_CLI_TIMEOUT_MS: '180000',
    AI_CLI_TIMEOUT_MS_TAILOR: '300000',
    AI_CLI_TIMEOUT_MS_FILTER: '60000',
    AI_CODEX_TIMEOUT_MS: '180000',
    AI_CODEX_TIMEOUT_MS_TAILOR: '300000',
    AI_CODEX_TIMEOUT_MS_FILTER: '60000',
  };
  assert.deepEqual(
    op.describeAiTimeoutsAboveRequestDeadline({ ...copiedFromOlderExample, AI_REQUEST_TIMEOUT_MS: '120000' }),
    []
  );
  assert.deepEqual(
    op.describeAiTimeoutsAboveRequestDeadline({ AI_CLI_TIMEOUT_MS_TAILOR: '300000', AI_REQUEST_TIMEOUT_MS: '120000' }),
    []
  );
  // A budget actually raised is still reported.
  assert.equal(op.describeAiTimeoutsAboveRequestDeadline({ AI_CLI_TIMEOUT_MS_TAILOR: '600000' }).length, 1);
});

test('only the six budgets a provider reads are reported - not every name that looks like one', () => {
  assert.deepEqual(op.describeAiTimeoutsAboveRequestDeadline({ AI_CLI_TIMEOUT_MS_COVER: '600000' }), []);
  assert.deepEqual(Object.keys(op.CLI_TIMEOUT_DEFAULTS_MS).sort(), [
    'AI_CLI_TIMEOUT_MS',
    'AI_CLI_TIMEOUT_MS_FILTER',
    'AI_CLI_TIMEOUT_MS_TAILOR',
    'AI_CODEX_TIMEOUT_MS',
    'AI_CODEX_TIMEOUT_MS_FILTER',
    'AI_CODEX_TIMEOUT_MS_TAILOR',
  ]);
});

/* =============================================================== job pages */

test('JOB_PAGE_USER_AGENT: the pinned Chrome 131 string by default, a single line when set', () => {
  assert.match(op.jobPageUserAgent({}), /Chrome\/131\.0\.0\.0 Safari\/537\.36$/);
  assert.equal(op.jobPageUserAgent({ JOB_PAGE_USER_AGENT: ' Custom/1.0 ' }), 'Custom/1.0');

  const injected = withWarnings(() => op.jobPageUserAgent({ JOB_PAGE_USER_AGENT: 'A\r\nX-Evil: 1' }));
  assert.match(injected.value, /Chrome\/131/);
  assert.equal(injected.warnings.length, 1);

  const long = withWarnings(() => op.jobPageUserAgent({ JOB_PAGE_USER_AGENT: 'x'.repeat(513) }));
  assert.match(long.value, /Chrome\/131/);
  assert.equal(long.warnings.length, 1);
});

test('JOB_PAGE_USER_AGENT: a character fetch cannot send in a header warns and uses the default', () => {
  // Pasted from a web page: an ellipsis (U+2026) or a line separator (U+2028).
  // Node's fetch throws on either, and the job-page reader would then send
  // every link to headless Chrome without saying why.
  for (const raw of ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML\u2026', 'A\u2028B']) {
    const { value, warnings } = withWarnings(() => op.jobPageUserAgent({ JOB_PAGE_USER_AGENT: raw }));
    assert.match(value, /Chrome\/131/, raw);
    assert.equal(warnings.length, 1, raw);
    assert.match(warnings[0], /printable-ASCII/);
  }
  // What it guards against, pinned so the pattern is not loosened by accident:
  // fetch builds its headers this way, and throws the same.
  assert.throws(() => new Headers({ 'User-Agent': 'KHTML\u2026' }), /ByteString/);
  // And what is accepted is sendable.
  assert.equal(op.jobPageUserAgent({ JOB_PAGE_USER_AGENT: 'Mozilla/5.0 (Custom; rv:1) Gecko/2' }), 'Mozilla/5.0 (Custom; rv:1) Gecko/2');
});

/* ================================================================ scrapers */

test('SCRAPER_DEFAULT_LOCATION and SCRAPER_COUNTRY', () => {
  assert.equal(op.scraperDefaultLocation({}), 'United States');
  assert.equal(op.scraperDefaultLocation({ SCRAPER_DEFAULT_LOCATION: ' United Kingdom ' }), 'United Kingdom');
  assert.equal(withWarnings(() => op.scraperDefaultLocation({ SCRAPER_DEFAULT_LOCATION: 'x'.repeat(101) })).value, 'United States');

  assert.equal(op.scraperCountry({}), 'US');
  assert.equal(op.scraperCountry({ SCRAPER_COUNTRY: 'gb' }), 'GB');
  const junk = withWarnings(() => op.scraperCountry({ SCRAPER_COUNTRY: 'USA' }));
  assert.equal(junk.value, 'US');
  assert.equal(junk.warnings.length, 1);
});

test('APIFY_PROXY_GROUPS: empty is RESIDENTIAL, `auto` omits the groups, junk falls back', () => {
  // EMPTY MEANS THE DEFAULT. A copied `APIFY_PROXY_GROUPS=` reading as "no
  // group" would quietly move an install onto datacenter proxies.
  assert.deepEqual(op.apifyProxyGroups({}), ['RESIDENTIAL']);
  assert.deepEqual(op.apifyProxyGroups({ APIFY_PROXY_GROUPS: '' }), ['RESIDENTIAL']);
  assert.deepEqual(op.apifyProxyGroups({ APIFY_PROXY_GROUPS: 'auto' }), []);
  assert.deepEqual(op.apifyProxyGroups({ APIFY_PROXY_GROUPS: ' AUTO ' }), []);
  assert.deepEqual(op.apifyProxyGroups({ APIFY_PROXY_GROUPS: 'residential, google_serp' }), ['RESIDENTIAL', 'GOOGLE_SERP']);
  const junk = withWarnings(() => op.apifyProxyGroups({ APIFY_PROXY_GROUPS: 'RESIDENTIAL, two words!' }));
  assert.deepEqual(junk.value, ['RESIDENTIAL']);
  assert.equal(junk.warnings.length, 1);
});

test('SCRAPER_MAX_RESULTS: unset means no cap, and so does junk', () => {
  assert.equal(op.scraperMaxResults({}), null);
  assert.equal(op.scraperMaxResults({ SCRAPER_MAX_RESULTS: '' }), null);
  assert.equal(op.scraperMaxResults({ SCRAPER_MAX_RESULTS: '250' }), 250);
  const junk = withWarnings(() => op.scraperMaxResults({ SCRAPER_MAX_RESULTS: 'lots' }));
  assert.equal(junk.value, null);
  assert.equal(junk.warnings.length, 1);
  const high = withWarnings(() => op.scraperMaxResults({ SCRAPER_MAX_RESULTS: '50000' }));
  assert.equal(high.value, 10_000);
  assert.equal(high.warnings.length, 1);
  assert.equal(withWarnings(() => op.scraperMaxResults({ SCRAPER_MAX_RESULTS: '0' })).value, 1);
});

test('APIFY_ACTOR_*: the shipped actors by default, owner/name, owner~name or an id when set', () => {
  // The literals the scrapers had, written out rather than read from the table.
  const shipped = {
    APIFY_ACTOR_INDEED: 'misceres/indeed-scraper',
    APIFY_ACTOR_JOBBOARD: 'openclawai/job-board-scraper',
    APIFY_ACTOR_WELLFOUND: 'blackfalcondata/wellfound-scraper',
    APIFY_ACTOR_LEVER: 'deadlyaccurate/lever-jobs-scraper',
    APIFY_ACTOR_HIRINGCAFE: 'manojachari/hiring-cafe-scraper',
    APIFY_ACTOR_HIRINGCAFE_CRAWLERBROS: 'crawlerbros/hiring-cafe-scraper',
    APIFY_ACTOR_HIRINGCAFE_MEMO23: 'memo23/apify-hiring-cafe-scraper',
  };
  assert.deepEqual(Object.keys(op.APIFY_ACTOR_DEFAULTS).sort(), Object.keys(shipped).sort());
  for (const [name, literal] of Object.entries(shipped)) {
    const read = (env) => op.apifyActorId(name, env);
    assert.equal(read({}), literal, `${name} default`);
    assert.equal(op.APIFY_ACTOR_DEFAULTS[name], literal);
    assert.equal(read({ [name]: 'me/my-fork' }), 'me/my-fork');
    assert.equal(read({ [name]: 'me~my.fork_2' }), 'me~my.fork_2');
    assert.equal(read({ [name]: 'aBcDeFgHiJkLmNoPq' }), 'aBcDeFgHiJkLmNoPq');
    const junk = withWarnings(() => read({ [name]: 'https://apify.com/me/my-fork' }));
    assert.equal(junk.value, literal, `${name} junk`);
    assert.equal(junk.warnings.length, 1);
  }
});

/* =================================================================== table */

test('the table: unique names, units only in the suffixes already in use', () => {
  const names = op.OPERATIONAL_VARIABLES.map((variable) => variable.name);
  assert.equal(new Set(names).size, names.length, 'no name twice');
  for (const name of names) {
    assert.doesNotMatch(name, /_(SECONDS|SECS|MILLIS|MINUTES|HOURS|LIMIT_MB)$/, `${name}: unit spelled out`);
  }
  // Every whole-number bound has an entry, and every entry with bounds agrees with them.
  for (const [name, spec] of Object.entries(op.OPERATIONAL_INT_BOUNDS)) {
    const entry = op.OPERATIONAL_VARIABLES.find((variable) => variable.name === name);
    assert.ok(entry, `${name} is in the table`);
    assert.deepEqual(entry.bounds, { min: spec.min, max: spec.max }, name);
    assert.equal(entry.defaultValue, String(spec.fallback), name);
  }
});

test('the table: every backend entry reports its own default for an empty environment', () => {
  for (const variable of op.OPERATIONAL_VARIABLES.filter((entry) => entry.side === 'backend')) {
    assert.equal(typeof variable.current, 'function', `${variable.name} has a reader`);
    assert.equal(variable.current({}), variable.defaultValue, variable.name);
  }
});

test('the table: frontend entries are documentation, with no backend reader', () => {
  const frontend = op.OPERATIONAL_VARIABLES.filter((entry) => entry.side === 'frontend').map((entry) => entry.name);
  assert.deepEqual(frontend.sort(), [
    'CALENDAR_API_TIMEOUT_MS',
    'CALENDAR_DETAIL_CONCURRENCY',
    'NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE',
  ]);
  for (const entry of op.OPERATIONAL_VARIABLES.filter((variable) => variable.side === 'frontend')) {
    assert.equal(entry.current, undefined, entry.name);
  }
  const timezone = op.OPERATIONAL_VARIABLES.find((entry) => entry.name === 'NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE');
  assert.equal(timezone.defaultValue, 'America/Los_Angeles');
  assert.equal(timezone.readAt, 'frontend-build');
});

test('the table: no secret is in it, since the startup line prints every value', () => {
  for (const { name } of op.OPERATIONAL_VARIABLES) {
    assert.doesNotMatch(name, /KEY|SECRET|TOKEN|PASS/, name);
  }
});

/* ============================================================ startup line */

test('the startup line is silent when everything is at its default', () => {
  assert.equal(op.describeNonDefaultOperationalSettings({}), null);
  // Set, but to the default value, is still the default.
  assert.equal(op.describeNonDefaultOperationalSettings({ SESSION_TTL_DAYS: '30', UPLOAD_MAX_MB: '10' }), null);
});

test('the startup line names every non-default setting once, with its EFFECTIVE value', () => {
  const { value: line } = withWarnings(() =>
    op.describeNonDefaultOperationalSettings({
      SESSION_TTL_DAYS: '7',
      UPLOAD_MAX_MB: '500', // clamped to 100, and shown as 100
      PDF_RENDER_TIMEOUT_MS: 'slow', // junk: warned, back at its default, not listed
      SCRAPER_DEFAULT_LOCATION: 'United Kingdom',
      APIFY_PROXY_GROUPS: 'auto',
      SCRAPER_MAX_RESULTS: '200',
      CALENDAR_API_TIMEOUT_MS: '30000', // frontend: not this process's to report
    })
  );
  assert.match(line, /^\[env\] Non-default settings: /);
  assert.match(line, /SESSION_TTL_DAYS=7/);
  assert.match(line, /UPLOAD_MAX_MB=100/);
  assert.doesNotMatch(line, /PDF_RENDER_TIMEOUT_MS/);
  assert.match(line, /SCRAPER_DEFAULT_LOCATION="United Kingdom"/, 'a value with a space is quoted');
  assert.match(line, /APIFY_PROXY_GROUPS=auto/);
  assert.match(line, /SCRAPER_MAX_RESULTS=200/);
  assert.doesNotMatch(line, /CALENDAR_API_TIMEOUT_MS/);
  assert.equal(line.split('\n').length, 1, 'one line');
});

test('the startup line lists a refused base URL as refused - never at the default, never with its value', () => {
  // A refused base URL leaves its provider unavailable, so leaving it off the
  // line would read as "not set, using the vendor", which is the opposite.
  const { value: line } = withWarnings(() =>
    op.describeNonDefaultOperationalSettings({
      OPENAI_BASE_URL: 'https://user:hunter2@gw.example/v1',
      DEEPSEEK_BASE_URL: 'https://ds.example/',
    })
  );
  assert.match(line, /OPENAI_BASE_URL=\(refused\)/);
  assert.match(line, /DEEPSEEK_BASE_URL=https:\/\/ds\.example(,|$)/);
  assert.doesNotMatch(line, /hunter2/);
});
