const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');

const {
  CLI_TIMEOUT_DEFAULTS_MS,
  OPERATIONAL_VARIABLES,
  describeAiTimeoutsAboveRequestDeadline,
  describeNonDefaultOperationalSettings,
} = require('../dist/config/operational');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');

/**
 * `.env.example` against `config/operational.ts`, so the two cannot drift.
 *
 * The table in operational.ts is where each operational setting's name, default,
 * range and read timing are decided; `.env.example` is where an operator learns
 * them. Nothing tied the two together, so a variable could be added in code and
 * never documented - which is how APIFY_API_TOKEN came to be required by every
 * scraper and written down nowhere - or documented with a default the code
 * stopped using.
 * Every test here reads both files as they are on disk and fails naming the
 * variable that disagrees.
 *
 * The file is read the way an operator uses it. A tuning setting ships
 * COMMENTED OUT with its default shown (`#SESSION_TTL_DAYS=30`), so the code
 * stays the single source of the default and a copied example pins nothing;
 * uncommenting the line unchanged must therefore produce exactly the default.
 * Its value is parsed with dotenv, as `config/env.ts` parses the real `.env`,
 * so quoting and trailing text are judged the way the server would judge them.
 */

const REPO_ROOT = path.join(__dirname, '..', '..');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');
const README_PATH = path.join(REPO_ROOT, 'README.md');

/**
 * A variable line, live or commented out. `#NAME=` and `# NAME=` count; deeper
 * indentation does not, because that is how the prose shows an example inside a
 * comment (`#   APP_URL=https://example.org`) rather than a line to uncomment.
 */
const VARIABLE_LINE = /^(#\s?)?([A-Z][A-Z0-9_]*)=/;

/**
 * Every variable line in the file: its name, whether it is commented out, the
 * value uncommenting it would set, and the paragraph around it - the run of
 * non-blank lines that holds it, which is where its explanation and tags are.
 */
function parseEnvExample(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];

  lines.forEach((line, index) => {
    const match = VARIABLE_LINE.exec(line);
    if (!match) return;

    const commented = Boolean(match[1]);
    const name = match[2];
    const assignment = commented ? line.slice(match[1].length) : line;
    const value = dotenv.parse(assignment)[name] ?? '';

    let start = index;
    while (start > 0 && lines[start - 1].trim() !== '') start -= 1;
    let end = index;
    while (end < lines.length - 1 && lines[end + 1].trim() !== '') end += 1;

    entries.push({
      name,
      commented,
      value,
      lineNumber: index + 1,
      paragraph: lines.slice(start, end + 1).join('\n'),
    });
  });

  return entries;
}

const envExampleText = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
const entries = parseEnvExample(envExampleText);
const byName = new Map(entries.map((entry) => [entry.name, entry]));

/** Runs `read` with console.warn captured, so a test can say what was warned. */
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

test('the table is not empty, so the checks below are checking something', () => {
  assert.ok(OPERATIONAL_VARIABLES.length >= 30, `only ${OPERATIONAL_VARIABLES.length} operational variables`);
  assert.ok(entries.length > OPERATIONAL_VARIABLES.length, 'parsed suspiciously few variable lines from .env.example');
});

test('every operational setting is documented in .env.example', () => {
  const missing = OPERATIONAL_VARIABLES.map((variable) => variable.name).filter((name) => !byName.has(name));
  assert.deepEqual(
    missing,
    [],
    `.env.example does not mention ${missing.join(', ')}. Every entry in config/operational.ts is ` +
      'documented there as `#NAME=default` in the section of the feature it tunes.'
  );
});

test('each one ships commented out, showing exactly the default the code uses', () => {
  const problems = [];
  for (const variable of OPERATIONAL_VARIABLES) {
    const entry = byName.get(variable.name);
    if (!entry) continue; // reported by the test above
    if (!entry.commented) {
      problems.push(
        `${variable.name} (line ${entry.lineNumber}) ships uncommented, so a copied file would pin it; ` +
          `write it as #${variable.name}=${variable.defaultValue}`
      );
    } else if (entry.value !== variable.defaultValue) {
      problems.push(
        `${variable.name} (line ${entry.lineNumber}) shows ${JSON.stringify(entry.value)} but the code ` +
          `default is ${JSON.stringify(variable.defaultValue)}`
      );
    }
  }
  assert.deepEqual(problems, []);
});

/**
 * `Range min..max` as a whole: "Range 1..3650" must not pass for 1..365. The
 * `#` lets the phrase wrap onto the next comment line.
 */
function saysRange(text, { min, max }) {
  return new RegExp(`\\bRange[\\s#]+${min}\\.\\.${max}(?![0-9])`).test(text);
}

test('the range written beside each whole-number setting is the one the code clamps to', () => {
  const problems = [];
  for (const variable of OPERATIONAL_VARIABLES) {
    const entry = byName.get(variable.name);
    if (!entry || !variable.bounds) continue;
    if (!saysRange(entry.paragraph, variable.bounds)) {
      problems.push(
        `${variable.name} (line ${entry.lineNumber}) does not say "Range ${variable.bounds.min}..${variable.bounds.max}"`
      );
    }
  }
  assert.deepEqual(problems, []);
});

test('the range check reads a range as a whole, not as a prefix of a longer one', () => {
  assert.equal(saysRange('# Range 1..365.', { min: 1, max: 365 }), true);
  assert.equal(saysRange('# client_max_body_size). Range\n# 60000..3600000', { min: 60000, max: 3600000 }), true);
  assert.equal(saysRange('# Range 1..3650.', { min: 1, max: 365 }), false);
  assert.equal(saysRange('# Range 11..365.', { min: 1, max: 365 }), false);
});

/** The tag each read timing carries, in .env.example. Per-call carries none. */
const EXPECTED_TAG = {
  startup: 'READ AT STARTUP',
  'frontend-build': 'NEXT_PUBLIC: rebuild to change',
  'frontend-runtime': 'restart the frontend, no rebuild',
};

test('the read-timing tags agree with the table - the right one, and no other', () => {
  const problems = [];
  for (const variable of OPERATIONAL_VARIABLES) {
    const entry = byName.get(variable.name);
    if (!entry) continue;
    const expected = EXPECTED_TAG[variable.readAt];
    if (expected && !entry.paragraph.includes(expected)) {
      problems.push(`${variable.name} (line ${entry.lineNumber}) is ${variable.readAt} and should say "${expected}"`);
    }
    for (const tag of Object.values(EXPECTED_TAG)) {
      if (tag !== expected && entry.paragraph.includes(tag)) {
        problems.push(`${variable.name} (line ${entry.lineNumber}) is ${variable.readAt} but says "${tag}"`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('a straight copy of .env.example leaves every operational setting at its default', () => {
  // What an operator gets from `cp .env.example .env` and nothing else: the
  // commented lines set nothing, so every getter must answer its default,
  // without a single warning, and the startup line must have nothing to say.
  const copied = dotenv.parse(envExampleText);
  const { value: changed, warnings } = withWarnings(() =>
    OPERATIONAL_VARIABLES.filter((variable) => variable.current)
      .map((variable) => ({ name: variable.name, value: variable.current(copied), expected: variable.defaultValue }))
      .filter((reading) => reading.value !== reading.expected)
  );
  assert.deepEqual(changed, []);
  assert.deepEqual(warnings, []);
  assert.equal(describeNonDefaultOperationalSettings(copied), null);
  // Nor may the copy make lowering the request deadline - a legitimate cap on
  // every AI call - warn about CLI budgets the operator never wrote.
  assert.deepEqual(describeAiTimeoutsAboveRequestDeadline({ ...copied, AI_REQUEST_TIMEOUT_MS: '60000' }), []);
});

test('the CLI per-call budgets ship commented out, showing the defaults the providers use', () => {
  // They used to ship uncommented, so every copied .env pinned all six.
  const problems = [];
  for (const [name, defaultMs] of Object.entries(CLI_TIMEOUT_DEFAULTS_MS)) {
    const entry = byName.get(name);
    if (!entry) problems.push(`${name} is not documented`);
    else if (!entry.commented) problems.push(`${name} (line ${entry.lineNumber}) ships uncommented`);
    else if (entry.value !== String(defaultMs)) {
      problems.push(`${name} (line ${entry.lineNumber}) shows ${JSON.stringify(entry.value)}, the default is ${defaultMs}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('AI_BATCH_CONCURRENCY ships unset, so a copied file keeps the per-provider batch width', () => {
  // It used to ship as AI_BATCH_CONCURRENCY=6, which every copied .env then
  // carried: an override that wins over each seat's own slot count, offering
  // six items to a four-slot seat and queueing two where nobody could see them.
  const entry = byName.get('AI_BATCH_CONCURRENCY');
  assert.ok(entry, 'AI_BATCH_CONCURRENCY is no longer documented');
  assert.equal(entry.commented, true);
  assert.equal(entry.value, '');
  assert.equal(dotenv.parse(envExampleText).AI_BATCH_CONCURRENCY, undefined);
});

test('no variable is written twice, so there is no second line silently winning', () => {
  const seen = new Map();
  const duplicates = [];
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      duplicates.push(`${entry.name} (lines ${seen.get(entry.name)} and ${entry.lineNumber})`);
    } else {
      seen.set(entry.name, entry.lineNumber);
    }
  }
  assert.deepEqual(duplicates, []);
});

/** The README's Configuration section, and the table rows in it keyed by their first cell. */
function readmeConfiguration() {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const start = readme.indexOf('## 🔧 Configuration');
  assert.notEqual(start, -1, 'README.md has no "## 🔧 Configuration" section');
  const next = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, next === -1 ? undefined : next);
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => ({ line, first: line.split('|')[1] ?? '' }));
  return { section, rows };
}

/** The row whose FIRST cell names the variable: other rows may mention it in passing. */
const rowFor = (rows, name) => rows.find((row) => row.first.includes(`\`${name}\``));

test("the README's Configuration table names every operational setting", () => {
  const { rows } = readmeConfiguration();
  const missing = OPERATIONAL_VARIABLES.map((variable) => variable.name).filter((name) => !rowFor(rows, name));
  assert.deepEqual(missing, [], `README.md's Configuration table has no row for ${missing.join(', ')}`);
});

test("the README's Configuration table shows each setting's default, range and read timing", () => {
  // Rows combine several variables, so each is checked against its own row:
  // a whole-number setting's default and range must both be in it; a text
  // setting's default may instead be left to .env.example when the row says
  // so (the User-Agent); and the row's tags must match the
  // read timings of the variables it holds.
  const { rows } = readmeConfiguration();
  const problems = [];
  for (const variable of OPERATIONAL_VARIABLES) {
    const row = rowFor(rows, variable.name);
    if (!row) continue; // reported by the test above
    const { line } = row;

    if (variable.defaultValue !== '') {
      const shown = line.includes(`\`${variable.defaultValue}\``);
      const deferred = !variable.bounds && /defaults? in `\.env\.example`/.test(line);
      if (!shown && !deferred) problems.push(`${variable.name}: its row does not show the default \`${variable.defaultValue}\``);
    }
    if (variable.bounds) {
      const { min, max } = variable.bounds;
      if (!new RegExp(`(^|[^0-9])${min}-${max}([^0-9]|$)`).test(line)) {
        problems.push(`${variable.name}: its row does not give the range ${min}-${max}`);
      }
    }
  }

  // Tags, per row: *Startup* exactly when a variable in it is read at startup,
  // *Rebuild* exactly when one is compiled into the bundle.
  for (const row of rows) {
    const held = OPERATIONAL_VARIABLES.filter((variable) => row.first.includes(`\`${variable.name}\``));
    if (held.length === 0) continue;
    const names = held.map((variable) => variable.name).join(', ');
    const wants = (readAt) => held.some((variable) => variable.readAt === readAt);
    if (wants('startup') !== row.line.includes('*Startup*')) {
      problems.push(`${names}: the row ${wants('startup') ? 'lacks' : 'should not carry'} *Startup*`);
    }
    if (wants('frontend-build') !== row.line.includes('*Rebuild*')) {
      problems.push(`${names}: the row ${wants('frontend-build') ? 'lacks' : 'should not carry'} *Rebuild*`);
    }
    if (wants('frontend-runtime') && !row.line.includes('restart the frontend, no rebuild')) {
      problems.push(`${names}: the row should say "restart the frontend, no rebuild"`);
    }
  }
  assert.deepEqual(problems, []);
});
