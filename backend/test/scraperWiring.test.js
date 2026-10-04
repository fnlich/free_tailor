const assert = require('node:assert/strict');
const test = require('node:test');

const { ApifyClient } = require('apify-client');

const { loadFresh, useAdminEmails, useTempStorage } = require('./helpers');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');
const {
  describeScraperSettings,
  listScraperProviderCatalog,
  resolveScraperProvider,
} = require('../dist/services/scraperProviders');

/**
 * That the SCRAPER_* and APIFY_* settings reach the actor runs.
 *
 * The scrapers are CommonJS and read no environment: services/scraperProviders.ts
 * resolves the settings and hands them to each run. `operational.test.js` pins
 * the getters and `scraperFilters.test.js` the mappers; this file pins the
 * wiring in between - the actor id each provider starts, the timeout it starts
 * and waits with, the input it sends - and the two routes that serve and apply
 * them.
 *
 * The first test is the one that matters most: with nothing set, every
 * provider sends the actor id, options and input it sent before any of these
 * variables existed, compared as JSON so the key order is pinned too.
 *
 * Nothing here reaches Apify. The client's `actor`, `run` and `dataset` are
 * replaced on its prototype for the duration of each test and restored after.
 */

/** Sets env vars for the duration of `run`, restoring whatever was there before. */
async function withEnv(vars, run) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Every scraper variable, unset - so a developer's own shell cannot leak into a test. */
const SCRAPER_ENV_UNSET = {
  SCRAPER_DEFAULT_LOCATION: undefined,
  SCRAPER_COUNTRY: undefined,
  SCRAPER_MAX_RESULTS: undefined,
  APIFY_PROXY_GROUPS: undefined,
  APIFY_RUN_TIMEOUT_S: undefined,
  APIFY_ACTOR_INDEED: undefined,
  APIFY_ACTOR_JOBBOARD: undefined,
  APIFY_ACTOR_WELLFOUND: undefined,
  APIFY_ACTOR_LEVER: undefined,
  APIFY_ACTOR_HIRINGCAFE: undefined,
  APIFY_ACTOR_HIRINGCAFE_CRAWLERBROS: undefined,
  APIFY_ACTOR_HIRINGCAFE_MEMO23: undefined,
};

/**
 * Runs `run` against a fake Apify and returns every actor run it made:
 * `{ actorId, method: 'call' | 'start', input, options, waitForFinish }`.
 *
 * `status` is what each run finishes with; `items` is the dataset every run
 * reads back.
 */
async function withFakeApify({ status = 'SUCCEEDED', items = [] } = {}, run) {
  const proto = ApifyClient.prototype;
  const original = { actor: proto.actor, run: proto.run, dataset: proto.dataset };
  const runs = [];
  const dataset = {
    listItems: async ({ offset }) => ({ items: offset === 0 ? items : [] }),
  };

  proto.actor = function actor(actorId) {
    return {
      call: async (input, options) => {
        runs.push({ actorId, method: 'call', input, options });
        return { id: `run-${runs.length}`, status, defaultDatasetId: `dataset-${runs.length}` };
      },
      start: async (input, options) => {
        runs.push({ actorId, method: 'start', input, options });
        return { id: `run-${runs.length}` };
      },
    };
  };
  proto.run = function runClient(runId) {
    return {
      waitForFinish: async (options) => {
        runs[runs.length - 1].waitForFinish = options;
        return { id: runId, status };
      },
      dataset: () => dataset,
    };
  };
  proto.dataset = function datasetClient() {
    return dataset;
  };

  try {
    await withEnv({ APIFY_API_TOKEN: 'test-token', APIFY_API_KEY: undefined }, run);
    return runs;
  } finally {
    Object.assign(proto, original);
  }
}

/** Captures console.warn for the duration of `run`, with the once-per-name memory cleared. */
async function withWarnings(run) {
  resetEnvWarningsForTests();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const value = await run();
    return { value, warnings };
  } finally {
    console.warn = original;
  }
}

const INDEED_URL = 'https://www.indeed.com/jobs/?q=data+analyst&sort=date';
const MEMO23_URL = 'https://hiring.cafe/?searchState=%7B%7D';

/**
 * One run per provider, with the filters the routes would hand it. `remoteOnly`
 * and `timePosted` are left out so each input is the plain shape.
 */
const PROVIDER_RUNS = [
  { source: 'indeed', provider: 'apify-misceres', filters: { startUrl: INDEED_URL } },
  { source: 'jobboard', provider: 'apify-jobboard', filters: { keywords: 'data analyst', maxResults: 250 } },
  { source: 'wellfound', provider: 'apify-wellfound', filters: { keywords: 'data analyst', maxResults: 250 } },
  { source: 'lever', provider: 'apify-lever', filters: { keywords: 'data analyst', maxResults: 250 } },
  { source: 'hiringcafe', provider: 'apify-manojachari', filters: { keywords: 'data analyst', maxResults: 250 } },
  { source: 'hiringcafe', provider: 'apify-crawlerbros', filters: { keywords: 'data analyst', maxResults: 250 } },
  { source: 'hiringcafe', provider: 'apify-memo23', filters: { startUrl: MEMO23_URL } },
];

async function runEveryProvider(env) {
  return withFakeApify({}, async () => {
    for (const { source, provider, filters } of PROVIDER_RUNS) {
      await resolveScraperProvider(source, provider, env).run(filters);
    }
  });
}

/** What each provider sent before SCRAPER_* and APIFY_* existed, in the order it sent it. */
const SENT_BEFORE = [
  {
    actorId: 'misceres/indeed-scraper',
    method: 'call',
    options: { timeout: 300 },
    input: {
      country: 'US',
      followApplyRedirects: false,
      maxItemsPerSearch: 100,
      parseCompanyDetails: false,
      saveOnlyUniqueItems: true,
      startUrls: [{ url: INDEED_URL }],
    },
  },
  {
    actorId: 'openclawai/job-board-scraper',
    method: 'start',
    options: { timeout: 300 },
    waitForFinish: { waitSecs: 300 },
    input: {
      searchTerm: 'data analyst',
      maxResults: 100,
      sites: ['linkedin', 'indeed', 'glassdoor', 'google', 'zip_recruiter'],
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    },
  },
  {
    actorId: 'blackfalcondata/wellfound-scraper',
    method: 'start',
    options: { timeout: 300 },
    waitForFinish: { waitSecs: 300 },
    input: {
      maxResults: 250,
      remote: false,
      enrichDetail: true,
      descriptionMaxLength: 0,
      compact: false,
      roles: ['data-analyst'],
    },
  },
  {
    actorId: 'deadlyaccurate/lever-jobs-scraper',
    method: 'start',
    options: { timeout: 300 },
    waitForFinish: { waitSecs: 300 },
    input: {
      mode: 'all',
      remoteOnly: false,
      includeDescriptions: true,
      outputFormat: 'both',
      keywordFilter: 'data.*analyst',
    },
  },
  {
    actorId: 'manojachari/hiring-cafe-scraper',
    method: 'start',
    options: { timeout: 300 },
    waitForFinish: { waitSecs: 300 },
    input: {
      searchQuery: 'data analyst',
      maxResults: 250,
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    },
  },
  {
    actorId: 'crawlerbros/hiring-cafe-scraper',
    method: 'call',
    options: { timeout: 300 },
    input: { searchQueries: ['data analyst'], maxItems: 250 },
  },
  {
    actorId: 'memo23/apify-hiring-cafe-scraper',
    method: 'call',
    options: { timeout: 300 },
    input: {
      flattenOutput: false,
      location: 'United States',
      maxConcurrency: 2,
      maxItems: 50,
      maxRequestRetries: 0,
      minConcurrency: 1,
      proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'US' },
      startUrls: [{ url: MEMO23_URL }],
    },
  },
];

/* ============================================================== the runs */

test('with nothing set, every provider sends exactly what it sent before', async () => {
  for (const env of [{}, { APIFY_RUN_TIMEOUT_S: '', APIFY_PROXY_GROUPS: '  ', SCRAPER_MAX_RESULTS: '' }]) {
    const runs = await runEveryProvider(env);
    assert.equal(runs.length, SENT_BEFORE.length);
    SENT_BEFORE.forEach((expected, index) => {
      const sent = runs[index];
      assert.equal(sent.actorId, expected.actorId);
      assert.equal(sent.method, expected.method, expected.actorId);
      assert.deepEqual(sent.options, expected.options, expected.actorId);
      assert.deepEqual(sent.waitForFinish, expected.waitForFinish, expected.actorId);
      // As JSON, so the key order - the bytes Apify receives - is pinned as well.
      assert.equal(JSON.stringify(sent.input), JSON.stringify(expected.input), expected.actorId);
    });
  }
});

test('the APIFY_ACTOR_* variables pick the actor each provider starts', async () => {
  const env = {
    APIFY_ACTOR_INDEED: 'me/indeed-fork',
    APIFY_ACTOR_JOBBOARD: 'me/jobboard-fork',
    APIFY_ACTOR_WELLFOUND: 'me~wellfound-fork',
    APIFY_ACTOR_LEVER: 'aBcDeFgHiJkLmNoPq',
    APIFY_ACTOR_HIRINGCAFE: 'me/manoj-fork',
    APIFY_ACTOR_HIRINGCAFE_CRAWLERBROS: 'me/crawlerbros-fork',
    APIFY_ACTOR_HIRINGCAFE_MEMO23: 'me/memo23-fork',
  };
  const runs = await runEveryProvider(env);
  assert.deepEqual(
    runs.map((run) => run.actorId),
    [
      'me/indeed-fork',
      'me/jobboard-fork',
      'me~wellfound-fork',
      'aBcDeFgHiJkLmNoPq',
      'me/manoj-fork',
      'me/crawlerbros-fork',
      'me/memo23-fork',
    ]
  );
});

test('APIFY_RUN_TIMEOUT_S bounds every run and every wait, and the timeout message names it', async () => {
  const runs = await runEveryProvider({ APIFY_RUN_TIMEOUT_S: '600' });
  for (const run of runs) {
    assert.deepEqual(run.options, { timeout: 600 }, run.actorId);
    if (run.method === 'start') assert.deepEqual(run.waitForFinish, { waitSecs: 600 }, run.actorId);
  }

  // A run Apify still reports as RUNNING is the timeout, and routes/jobs.ts
  // turns "timed out" into a 429 - so the number in it must be the real one.
  await withFakeApify({ status: 'RUNNING' }, async () => {
    await assert.rejects(
      resolveScraperProvider('lever', undefined, { APIFY_RUN_TIMEOUT_S: '600' }).run({ keywords: 'x' }),
      /Lever scraper run run-1 timed out after 600 seconds\./
    );
    await assert.rejects(
      resolveScraperProvider('indeed', undefined, { APIFY_RUN_TIMEOUT_S: '600' }).run({ startUrl: INDEED_URL }),
      /Indeed scraper run run-2 timed out after 600 seconds\./
    );
  });
});

test('APIFY_RUN_TIMEOUT_S: junk warns once and uses 300, out of range is clamped', async () => {
  const junk = await withWarnings(() => runEveryProvider({ APIFY_RUN_TIMEOUT_S: '5m' }));
  assert.ok(junk.value.every((run) => run.options.timeout === 300));
  assert.equal(junk.warnings.length, 1, 'once for seven runs');
  assert.match(junk.warnings[0], /APIFY_RUN_TIMEOUT_S="5m" is not a whole number; using 300 s/);

  const low = await withWarnings(() => runEveryProvider({ APIFY_RUN_TIMEOUT_S: '10' }));
  assert.ok(low.value.every((run) => run.options.timeout === 30));
  assert.equal(low.warnings.length, 1);

  const high = await withWarnings(() => runEveryProvider({ APIFY_RUN_TIMEOUT_S: '99999' }));
  assert.ok(high.value.every((run) => run.options.timeout === 3_600));
});

test('a junk actor id warns once and runs the shipped actor', async () => {
  const { value: runs, warnings } = await withWarnings(() =>
    runEveryProvider({ APIFY_ACTOR_LEVER: 'https://apify.com/me/fork' })
  );
  assert.equal(runs[3].actorId, 'deadlyaccurate/lever-jobs-scraper');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /APIFY_ACTOR_LEVER/);
});

test('SCRAPER_COUNTRY, SCRAPER_DEFAULT_LOCATION and APIFY_PROXY_GROUPS reach the inputs that carry them', async () => {
  const runs = await runEveryProvider({
    SCRAPER_COUNTRY: 'gb',
    SCRAPER_DEFAULT_LOCATION: 'United Kingdom',
    APIFY_PROXY_GROUPS: 'residential, google_serp',
  });
  const [indeed, jobboard, , , manoj, crawlerbros, memo23] = runs;

  assert.equal(indeed.input.country, 'GB');
  assert.deepEqual(jobboard.input.proxyConfiguration, {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL', 'GOOGLE_SERP'],
  });
  assert.deepEqual(manoj.input.proxyConfiguration.apifyProxyGroups, ['RESIDENTIAL', 'GOOGLE_SERP']);
  assert.equal(crawlerbros.input.proxyConfiguration, undefined, 'CrawlerBros never took a proxy setting');
  assert.equal(memo23.input.location, 'United Kingdom');
  assert.deepEqual(memo23.input.proxy, {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL', 'GOOGLE_SERP'],
    apifyProxyCountry: 'GB',
  });

  const auto = await runEveryProvider({ APIFY_PROXY_GROUPS: 'auto' });
  assert.deepEqual(auto[1].input.proxyConfiguration, { useApifyProxy: true });
  assert.deepEqual(auto[6].input.proxy, { useApifyProxy: true, apifyProxyCountry: 'US' });

  // Junk: one warning, and the shipped values, never a half-applied list.
  const { value: junk, warnings } = await withWarnings(() =>
    runEveryProvider({ SCRAPER_COUNTRY: 'USA', APIFY_PROXY_GROUPS: 'RESIDENTIAL, two words!' })
  );
  assert.equal(junk[0].input.country, 'US');
  assert.deepEqual(junk[1].input.proxyConfiguration.apifyProxyGroups, ['RESIDENTIAL']);
  assert.equal(warnings.length, 2, 'one per variable');
});

test('SCRAPER_MAX_RESULTS bounds the count each actor is asked for', async () => {
  const runs = await runEveryProvider({ SCRAPER_MAX_RESULTS: '30' });
  const [indeed, jobboard, wellfound, lever, manoj, crawlerbros, memo23] = runs;

  assert.equal(indeed.input.maxItemsPerSearch, 30);
  assert.equal(jobboard.input.maxResults, 30);
  assert.equal(wellfound.input.maxResults, 30);
  assert.equal(manoj.input.maxResults, 30);
  assert.equal(crawlerbros.input.maxItems, 30);
  assert.equal(memo23.input.maxItems, 30);
  // Lever's input has no count to bound; routes/jobs.ts trims its results.
  assert.equal(JSON.stringify(lever.input), JSON.stringify(SENT_BEFORE[3].input));
});

test('a runner called without its settings refuses before it starts an actor', async () => {
  const { runLeverScraper, runIndeedScraper } = require('../scrapers');
  const runs = await withFakeApify({}, async () => {
    await assert.rejects(runLeverScraper({ keywords: 'x' }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /Lever scraper needs settings\.actorId/);
      return true;
    });
    await assert.rejects(
      runIndeedScraper({ startUrl: INDEED_URL }, { actorId: 'me/fork', runTimeoutS: 0 }),
      /settings\.runTimeoutS/
    );
  });
  assert.equal(runs.length, 0, 'nothing was started, so nothing was billed');
});

/* ============================================================ the catalog */

function providerCaps(catalog) {
  return Object.fromEntries(
    catalog.flatMap((entry) => entry.providers.map((provider) => [provider.id, provider.maxResults]))
  );
}

test('the settings serve the default location and the run timeout', () => {
  assert.deepEqual(describeScraperSettings({}), { defaultLocation: 'United States', runTimeoutS: 300 });
  assert.deepEqual(
    describeScraperSettings({ SCRAPER_DEFAULT_LOCATION: 'United Kingdom', APIFY_RUN_TIMEOUT_S: '600' }),
    { defaultLocation: 'United Kingdom', runTimeoutS: 600 }
  );
});

test('the catalog serves each provider\'s result cap', () => {
  const shipped = listScraperProviderCatalog({});
  assert.deepEqual(
    shipped.map((entry) => [entry.source, entry.defaultProviderId]),
    [
      ['indeed', 'apify-misceres'],
      ['jobboard', 'apify-jobboard'],
      ['wellfound', 'apify-wellfound'],
      ['lever', 'apify-lever'],
      ['hiringcafe', 'apify-manojachari'],
    ]
  );
  // Uncapped: only the actors' own limits.
  assert.deepEqual(providerCaps(shipped), {
    'apify-misceres': 100,
    'apify-jobboard': 100,
    'apify-wellfound': null,
    'apify-lever': null,
    'apify-manojachari': null,
    'apify-crawlerbros': null,
    'apify-memo23': 50,
  });

  const configured = listScraperProviderCatalog({ SCRAPER_MAX_RESULTS: '75' });
  assert.deepEqual(providerCaps(configured), {
    'apify-misceres': 75,
    'apify-jobboard': 75,
    'apify-wellfound': 75,
    'apify-lever': 75,
    'apify-manojachari': 75,
    'apify-crawlerbros': 75,
    'apify-memo23': 50,
  });
});

/* ============================================================== the routes */

async function serveJobs(name) {
  useTempStorage(name);
  useAdminEmails('admin@example.com');
  const express = require('express');
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const jobRoutes = loadFresh('../dist/routes/jobs');

  const user = users.createUser({ email: 'alice@example.com' });
  const token = users.createSession(user.id);
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/jobs', jobRoutes.default);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/jobs`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  return {
    close: () => server.close(),
    get: async (path) => {
      const response = await fetch(`${base}${path}`, { headers });
      return { status: response.status, body: await response.json() };
    },
    post: async (path, body) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
  };
}

/** Lever postings that survive the route's filters: published now, not remote-only. */
function leverItems(count) {
  const publishedAt = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => ({
    id: `lever-${index}`,
    title: 'Data Analyst',
    companyName: `Company ${index}`,
    applyUrl: `https://jobs.lever.co/company-${index}/apply`,
    description: 'Analyze data',
    publishedAt,
  }));
}

test('GET /scrapers/providers is still the bare array every jobs page iterates', async () => {
  // A jobs page and a backend on different versions is ordinary here (dev:poll
  // restarts the backend on a pull and keeps the built frontend). An older
  // page iterates this body, so it stays an array and only gains fields.
  const server = await serveJobs('scraper-catalog');
  try {
    await withEnv(SCRAPER_ENV_UNSET, async () => {
      const shipped = await server.get('/scrapers/providers');
      assert.equal(shipped.status, 200);
      assert.ok(Array.isArray(shipped.body), 'an array, as before');
      assert.equal(shipped.body.length, 5);
      assert.equal(providerCaps(shipped.body)['apify-jobboard'], 100);
      assert.equal(providerCaps(shipped.body)['apify-wellfound'], null);
    });

    await withEnv({ ...SCRAPER_ENV_UNSET, SCRAPER_MAX_RESULTS: '40' }, async () => {
      const configured = await server.get('/scrapers/providers');
      assert.equal(providerCaps(configured.body)['apify-wellfound'], 40);
    });
  } finally {
    server.close();
  }
});

test('GET /scrapers/settings serves the default location and the run timeout beside it', async () => {
  const server = await serveJobs('scraper-settings');
  try {
    await withEnv(SCRAPER_ENV_UNSET, async () => {
      const shipped = await server.get('/scrapers/settings');
      assert.equal(shipped.status, 200);
      assert.deepEqual(shipped.body, { defaultLocation: 'United States', runTimeoutS: 300 });
    });
    await withEnv({ ...SCRAPER_ENV_UNSET, SCRAPER_DEFAULT_LOCATION: 'Deutschland', APIFY_RUN_TIMEOUT_S: '600' }, async () => {
      const configured = await server.get('/scrapers/settings');
      assert.deepEqual(configured.body, { defaultLocation: 'Deutschland', runTimeoutS: 600 });
    });
  } finally {
    server.close();
  }
});

test('POST /scrapers/run applies SCRAPER_DEFAULT_LOCATION to an empty location', async () => {
  const server = await serveJobs('scraper-location');
  try {
    for (const [location, expected] of [[undefined, 'United States'], ['Deutschland', 'Deutschland']]) {
      let response;
      const runs = await withFakeApify({ items: [] }, () =>
        withEnv({ ...SCRAPER_ENV_UNSET, SCRAPER_DEFAULT_LOCATION: location }, async () => {
          response = await server.post('/scrapers/run', { source: 'jobboard', keywords: 'data analyst', location: '' });
        })
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.filters.location, expected);
      assert.equal(runs[0].input.location, expected, 'and the actor is sent it');
    }
  } finally {
    server.close();
  }
});

test('POST /scrapers/run holds the request under SCRAPER_MAX_RESULTS, and trims what comes back', async () => {
  const server = await serveJobs('scraper-cap');
  try {
    // Unset: the request's own number, and nothing trimmed when it names none.
    let response;
    let runs = await withFakeApify({ items: leverItems(12) }, () =>
      withEnv(SCRAPER_ENV_UNSET, async () => {
        response = await server.post('/scrapers/run', { source: 'wellfound', keywords: 'data analyst', maxResults: 1000 });
      })
    );
    assert.equal(response.body.filters.maxResults, 1000);
    assert.equal(runs[0].input.maxResults, 1000);

    await withFakeApify({ items: leverItems(12) }, () =>
      withEnv(SCRAPER_ENV_UNSET, async () => {
        response = await server.post('/scrapers/run', { source: 'lever', keywords: 'data analyst' });
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.filters.maxResults, undefined);
    assert.equal(response.body.results.length, 12);

    // Set: a larger request is clamped (and the response says so), and Lever -
    // whose actor takes no count - is trimmed to the cap.
    runs = await withFakeApify({ items: leverItems(12) }, () =>
      withEnv({ ...SCRAPER_ENV_UNSET, SCRAPER_MAX_RESULTS: '5' }, async () => {
        response = await server.post('/scrapers/run', { source: 'wellfound', keywords: 'data analyst', maxResults: 1000 });
      })
    );
    assert.equal(response.body.filters.maxResults, 5);
    assert.equal(runs[0].input.maxResults, 5);

    await withFakeApify({ items: leverItems(12) }, () =>
      withEnv({ ...SCRAPER_ENV_UNSET, SCRAPER_MAX_RESULTS: '5' }, async () => {
        response = await server.post('/scrapers/run', { source: 'lever', keywords: 'data analyst' });
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.results.length, 5);
  } finally {
    server.close();
  }
});
