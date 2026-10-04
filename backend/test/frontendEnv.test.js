const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * The frontend's configuration readers: `frontend/src/lib/env.ts`, the
 * calendar settings built on it, and `lib/upload.ts`, which reads the PDF cap
 * the backend serves on /auth/me.
 *
 * Tested from here because the frontend has no test runner, and these are
 * plain functions with no React in them. Each module is transpiled with the
 * backend's own TypeScript and evaluated with a `process` whose `env` the test
 * supplies - which is also how a NEXT_PUBLIC_ value read at module level is
 * set, since Next inlines that expression at build time and there is no
 * later moment to change it. Every load is fresh, so the warn-once memory of
 * one test cannot hide a warning in the next.
 */

const FRONTEND_SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function loadFrontendModule(relativePath, env = {}, loaded = new Map()) {
  const file = path.join(FRONTEND_SRC, relativePath);
  if (loaded.has(file)) return loaded.get(file).exports;

  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: file,
  });
  const module = { exports: {} };
  loaded.set(file, module);

  // Only the `@/` alias is resolved: these modules are meant to import nothing
  // else, and a new import of something heavier should fail loudly here.
  const localRequire = (specifier) => {
    if (specifier.startsWith('@/')) {
      return loadFrontendModule(`${specifier.slice(2)}.ts`, env, loaded);
    }
    throw new Error(`${relativePath} imports ${specifier}, which this test does not provide`);
  };
  new Function('module', 'exports', 'require', 'process', outputText)(
    module,
    module.exports,
    localRequire,
    { env }
  );
  return module.exports;
}

function warnings(t) {
  return t.mock.method(console, 'warn', () => {}).mock;
}

test('envInt: unset, empty and whitespace are the default, without a word', (t) => {
  const { envInt } = loadFrontendModule('lib/env.ts');
  const warned = warnings(t);

  assert.equal(envInt(undefined, 12000, 1000, 120000, 'X_MS'), 12000);
  // The root .env is copied key by key, so a bare `X_MS=` arrives as ''.
  assert.equal(envInt('', 12000, 1000, 120000, 'X_MS'), 12000);
  assert.equal(envInt('   ', 12000, 1000, 120000, 'X_MS'), 12000);
  assert.equal(warned.callCount(), 0);
});

test('envInt: a whole number in range is taken as written', (t) => {
  const { envInt } = loadFrontendModule('lib/env.ts');
  const warned = warnings(t);

  assert.equal(envInt('30000', 12000, 1000, 120000, 'X_MS'), 30000);
  assert.equal(envInt(' 4 ', 12, 1, 32, 'Y'), 4);
  assert.equal(envInt('1000', 12000, 1000, 120000, 'X_MS'), 1000, 'the bounds are inclusive');
  assert.equal(envInt('120000', 12000, 1000, 120000, 'X_MS'), 120000);
  assert.equal(warned.callCount(), 0);
});

test('envInt: junk is the default, with one warning per setting', (t) => {
  const { envInt } = loadFrontendModule('lib/env.ts');
  const warned = warnings(t);

  // `Number()` would read the first as 12000 and the third as 1.5. A value
  // that is quietly a different number from the one written is worse than the
  // default, so anything but digits is junk.
  for (const junk of ['12e3', '12000ms', '1.5', '12,000', 'fast', '0x10']) {
    assert.equal(envInt(junk, 12000, 1000, 120000, 'X_MS'), 12000, junk);
  }
  assert.equal(warned.callCount(), 1, 'one warning per setting, not one per read');
  assert.match(warned.calls[0].arguments[0], /X_MS="12e3" is not a whole number; using 12000/);

  // A different setting gets its own warning.
  assert.equal(envInt('nope', 12, 1, 32, 'Y'), 12);
  assert.equal(warned.callCount(), 2);
  assert.match(warned.calls[1].arguments[0], /^\[env\] Y="nope"/);
});

test('envInt: out of range is clamped to the nearest bound, with a warning', (t) => {
  const { envInt } = loadFrontendModule('lib/env.ts');
  const warned = warnings(t);

  assert.equal(envInt('10', 12000, 1000, 120000, 'LOW_MS'), 1000);
  assert.match(warned.calls[0].arguments[0], /LOW_MS=10 is outside 1000\.\.120000; using 1000\./);

  assert.equal(envInt('999999', 12000, 1000, 120000, 'HIGH_MS'), 120000);
  assert.match(warned.calls[1].arguments[0], /HIGH_MS=999999 is outside 1000\.\.120000; using 120000\./);

  assert.equal(envInt('-5', 12, 1, 32, 'NEG'), 1);
  assert.equal(warned.callCount(), 3);
});

test('envString: trimmed, and empty or whitespace is the default', () => {
  const { envString } = loadFrontendModule('lib/env.ts');

  assert.equal(envString(undefined, 'fallback'), 'fallback');
  assert.equal(envString('', 'fallback'), 'fallback');
  assert.equal(envString('  \t ', 'fallback'), 'fallback');
  assert.equal(envString('  value  ', 'fallback'), 'value');
});

test('envTimeZone: any zone Intl knows, as written; anything else is the default', (t) => {
  const { envTimeZone, isTimeZoneName } = loadFrontendModule('lib/env.ts');
  const warned = warnings(t);

  assert.equal(envTimeZone(undefined, 'America/Los_Angeles', 'TZ_SETTING'), 'America/Los_Angeles');
  assert.equal(envTimeZone(' ', 'America/Los_Angeles', 'TZ_SETTING'), 'America/Los_Angeles');
  assert.equal(envTimeZone('Europe/Berlin', 'America/Los_Angeles', 'TZ_SETTING'), 'Europe/Berlin');
  assert.equal(envTimeZone('UTC', 'America/Los_Angeles', 'TZ_SETTING'), 'UTC');
  // Not resolvedOptions()' spelling: V8 reports this one as Asia/Calcutta and
  // other engines do not, and the page runs on the server and in the browser.
  assert.equal(envTimeZone('Asia/Kolkata', 'America/Los_Angeles', 'TZ_SETTING'), 'Asia/Kolkata');
  assert.equal(warned.callCount(), 0);

  assert.equal(envTimeZone('Mars/Olympus_Mons', 'America/Los_Angeles', 'TZ_SETTING'), 'America/Los_Angeles');
  assert.equal(warned.callCount(), 1);
  assert.match(warned.calls[0].arguments[0], /TZ_SETTING="Mars\/Olympus_Mons" is not a time zone/);

  // Offsets are accepted by newer Intl but are not zone names.
  assert.equal(isTimeZoneName('+05:00'), false);
  assert.equal(isTimeZoneName('Pacific Time'), false);
  assert.equal(isTimeZoneName('../etc/passwd'), false);
  assert.equal(isTimeZoneName('America/New_York'), true);
  assert.equal(isTimeZoneName('Etc/GMT+5'), true);
});

test('calendar time zone: an installation that sets nothing starts on Pacific time, as before', (t) => {
  const warned = warnings(t);
  const zones = loadFrontendModule('lib/calendar/timeZone.ts', {});

  assert.equal(zones.CALENDAR_DEFAULT_TIME_ZONE, 'America/Los_Angeles');
  assert.deepEqual(
    zones.CALENDAR_TIME_ZONE_OPTIONS.map((option) => option.value),
    ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Asia/Vladivostok']
  );
  assert.equal(zones.calendarTimeZoneLabel('America/Los_Angeles'), 'PT');
  assert.equal(zones.calendarTimeZoneLabel('Asia/Vladivostok'), 'Vladivostok');

  // `NAME=` copied from .env.example is the same as not setting it.
  const blank = loadFrontendModule('lib/calendar/timeZone.ts', {
    NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE: '',
  });
  assert.equal(blank.CALENDAR_DEFAULT_TIME_ZONE, 'America/Los_Angeles');
  assert.equal(warned.callCount(), 0);
});

test('calendar time zone: one of the listed zones selects that entry, in any case', () => {
  const zones = loadFrontendModule('lib/calendar/timeZone.ts', {
    NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE: 'america/new_york',
  });

  assert.equal(zones.CALENDAR_DEFAULT_TIME_ZONE, 'America/New_York');
  assert.equal(zones.CALENDAR_TIME_ZONE_OPTIONS.length, 5, 'no lower-case duplicate is added');
  assert.equal(zones.calendarTimeZoneLabel(zones.CALENDAR_DEFAULT_TIME_ZONE), 'ET');
});

test('calendar time zone: a zone outside the list is added to it, so the selector can show it', () => {
  const zones = loadFrontendModule('lib/calendar/timeZone.ts', {
    NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE: 'America/Argentina/Buenos_Aires',
  });

  assert.equal(zones.CALENDAR_DEFAULT_TIME_ZONE, 'America/Argentina/Buenos_Aires');
  assert.equal(zones.CALENDAR_TIME_ZONE_OPTIONS.length, 6);
  assert.deepEqual(zones.CALENDAR_TIME_ZONE_OPTIONS.at(-1), {
    label: 'Buenos Aires',
    value: 'America/Argentina/Buenos_Aires',
  });
  assert.equal(zones.calendarTimeZoneLabel('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  // The base list itself is left alone.
  assert.equal(zones.BASE_CALENDAR_TIME_ZONES.length, 5);
});

test('calendar time zone: an unknown zone is Pacific time, and says which setting was wrong', (t) => {
  const warned = warnings(t);
  const zones = loadFrontendModule('lib/calendar/timeZone.ts', {
    NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE: 'Pacific Time',
  });

  assert.equal(zones.CALENDAR_DEFAULT_TIME_ZONE, 'America/Los_Angeles');
  assert.equal(zones.CALENDAR_TIME_ZONE_OPTIONS.length, 5);
  assert.equal(warned.callCount(), 1);
  assert.match(warned.calls[0].arguments[0], /NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE="Pacific Time"/);
});

test('CALENDAR_API_TIMEOUT_MS: 12 seconds by default, read per call, clamped to 1s..2min', (t) => {
  const warned = warnings(t);
  const config = loadFrontendModule('lib/calendar/serverConfig.ts', {
    CALENDAR_API_TIMEOUT_MS: '45000',
  });

  // Unset is today's value.
  assert.equal(config.calendarApiTimeoutMs({}), 12000);
  assert.equal(config.calendarApiTimeoutMs({ CALENDAR_API_TIMEOUT_MS: '' }), 12000);
  // With no argument it reads the process environment - the `next start`
  // process, which next.mjs fills from the repository .env.
  assert.equal(config.calendarApiTimeoutMs(), 45000);
  assert.equal(config.calendarApiTimeoutMs({ CALENDAR_API_TIMEOUT_MS: '30000' }), 30000);
  assert.equal(warned.callCount(), 0);

  assert.equal(config.calendarApiTimeoutMs({ CALENDAR_API_TIMEOUT_MS: '12s' }), 12000);
  assert.equal(warned.callCount(), 1);
  assert.match(warned.calls[0].arguments[0], /CALENDAR_API_TIMEOUT_MS="12s"/);

  const fresh = loadFrontendModule('lib/calendar/serverConfig.ts', {});
  assert.equal(fresh.calendarApiTimeoutMs({ CALENDAR_API_TIMEOUT_MS: '50' }), 1000);
  assert.equal(fresh.calendarApiTimeoutMs({ CALENDAR_API_TIMEOUT_MS: '600000' }), 120000);
});

test('CALENDAR_DETAIL_CONCURRENCY: 12 by default, clamped to 1..32', (t) => {
  const warned = warnings(t);
  const config = loadFrontendModule('lib/calendar/serverConfig.ts', {});

  assert.equal(config.calendarDetailConcurrency({}), 12);
  assert.equal(config.calendarDetailConcurrency(), 12);
  assert.equal(config.calendarDetailConcurrency({ CALENDAR_DETAIL_CONCURRENCY: '4' }), 4);
  assert.equal(config.calendarDetailConcurrency({ CALENDAR_DETAIL_CONCURRENCY: '1' }), 1);
  assert.equal(warned.callCount(), 0);

  assert.equal(config.calendarDetailConcurrency({ CALENDAR_DETAIL_CONCURRENCY: '0' }), 1);
  assert.match(warned.calls[0].arguments[0], /CALENDAR_DETAIL_CONCURRENCY=0 is outside 1\.\.32; using 1\./);

  const fresh = loadFrontendModule('lib/calendar/serverConfig.ts', {});
  assert.equal(fresh.calendarDetailConcurrency({ CALENDAR_DETAIL_CONCURRENCY: '500' }), 32);
  assert.equal(fresh.calendarDetailConcurrency({ CALENDAR_DETAIL_CONCURRENCY: 'lots' }), 12);
});

test('uploadMaxMb: the served number, or the old fixed 10 from a server that does not send it', () => {
  const { readUploadMaxMb, DEFAULT_UPLOAD_MAX_MB } = loadFrontendModule('lib/upload.ts');

  assert.equal(DEFAULT_UPLOAD_MAX_MB, 10);
  assert.equal(readUploadMaxMb(25), 25);
  assert.equal(readUploadMaxMb(1), 1);
  // A backend that predates the field, and anything that is not a usable cap.
  assert.equal(readUploadMaxMb(undefined), 10);
  assert.equal(readUploadMaxMb(null), 10);
  assert.equal(readUploadMaxMb('25'), 10);
  assert.equal(readUploadMaxMb(0), 10);
  assert.equal(readUploadMaxMb(-5), 10);
  assert.equal(readUploadMaxMb(2.5), 10);
  assert.equal(readUploadMaxMb(Number.NaN), 10);
});

test('a PDF over the cap is refused before it is sent, with the server\'s rule and the cap named', () => {
  const { pdfTooLargeMessage } = loadFrontendModule('lib/upload.ts');
  const MB = 1024 * 1024;

  assert.equal(pdfTooLargeMessage({ name: 'cv.pdf', size: 3 * MB }, 10), null);
  // multer's rule: exactly the cap is accepted, one byte more is not.
  assert.equal(pdfTooLargeMessage({ name: 'cv.pdf', size: 10 * MB }, 10), null);
  const refused = pdfTooLargeMessage({ name: 'scan.pdf', size: 10 * MB + 1 }, 10);
  assert.match(refused, /scan\.pdf is larger than 10 MB/);

  // The cap is the served one, not a constant.
  assert.equal(pdfTooLargeMessage({ name: 'scan.pdf', size: 30 * MB }, 40), null);
  assert.match(pdfTooLargeMessage({ name: 'scan.pdf', size: 30 * MB }, 25), /larger than 25 MB/);
});

/*
 * config/operational.ts is the ONE table of these settings, the frontend's
 * included: it decides their defaults and bounds and .env.example documents
 * them from it. The frontend cannot import it - the Next bundle has no route to
 * backend code - so the frontend states the same numbers itself, and this is
 * what keeps the two from drifting apart.
 */
test('the frontend readers use the defaults and bounds config/operational.ts decides', (t) => {
  const { OPERATIONAL_INT_BOUNDS, OPERATIONAL_VARIABLES } = require('../dist/config/operational');
  const config = loadFrontendModule('lib/calendar/serverConfig.ts', {});
  warnings(t);

  for (const [name, read] of [
    ['CALENDAR_API_TIMEOUT_MS', config.calendarApiTimeoutMs],
    ['CALENDAR_DETAIL_CONCURRENCY', config.calendarDetailConcurrency],
  ]) {
    const spec = OPERATIONAL_INT_BOUNDS[name];
    assert.ok(spec, `${name} is in the operational table`);
    assert.equal(read({}), spec.fallback, `${name} default`);
    assert.equal(read({ [name]: String(spec.min - 1) }), spec.min, `${name} minimum`);
    assert.equal(read({ [name]: String(spec.max + 1) }), spec.max, `${name} maximum`);
  }

  const timeZone = OPERATIONAL_VARIABLES.find(
    (entry) => entry.name === 'NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE'
  );
  assert.ok(timeZone, 'NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE is in the operational table');
  assert.equal(
    loadFrontendModule('lib/calendar/timeZone.ts', {}).FALLBACK_CALENDAR_TIME_ZONE,
    timeZone.defaultValue
  );

  // What the upload pages assume when /auth/me does not say is the server's own default.
  assert.equal(
    loadFrontendModule('lib/upload.ts').DEFAULT_UPLOAD_MAX_MB,
    OPERATIONAL_INT_BOUNDS.UPLOAD_MAX_MB.fallback
  );
});

/*
 * Source checks, because the failure they guard against compiles and runs.
 *
 * Next inlines a NEXT_PUBLIC_ value only where `process.env.NEXT_PUBLIC_X` is
 * written out literally; a refactor to a lookup by name would leave the setting
 * reading undefined in the browser with nothing failing. And the calendar's
 * default zone and its two server settings each live in one place now, and the
 * upload copy prints the cap the server serves - a literal reappearing beside
 * any of them is the drift this change removed.
 */
test('the settings are read where they are configured, and nowhere else', () => {
  const read = (relativePath) => fs.readFileSync(path.join(FRONTEND_SRC, relativePath), 'utf8');

  assert.match(
    read('lib/calendar/timeZone.ts'),
    /process\.env\.NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE\b/,
    'the NEXT_PUBLIC_ value must be read with the literal expression Next inlines'
  );

  const service = read('lib/calendar/service.ts');
  assert.doesNotMatch(service, /America\/Los_Angeles/);
  assert.doesNotMatch(service, /AbortSignal\.timeout\(\d/);
  assert.match(service, /AbortSignal\.timeout\(calendarApiTimeoutMs\(\)\)/);

  assert.doesNotMatch(read('components/CalendarWorkspace.tsx'), /America\/Los_Angeles/);
  assert.match(
    read('app/api/calendars/[shareId]/links/route.ts'),
    /calendarDetailConcurrency\(\)/
  );
  // The upload copy says the served cap, not a number of its own.
  assert.doesNotMatch(read('app/admin/templates/page.tsx'), /max 10 ?MB/i);
  assert.match(read('app/admin/templates/page.tsx'), /PDF only, max \{uploadMaxMb\}MB/);
});
