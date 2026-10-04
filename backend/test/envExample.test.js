const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');

const {
  OPERATIONAL_VARIABLES,
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

test('the range written beside each whole-number setting is the one the code clamps to', () => {
  const problems = [];
  for (const variable of OPERATIONAL_VARIABLES) {
    const entry = byName.get(variable.name);
    if (!entry || !variable.bounds) continue;
    const range = `${variable.bounds.min}..${variable.bounds.max}`;
    if (!entry.paragraph.includes(range)) {
      problems.push(`${variable.name} (line ${entry.lineNumber}) does not say "Range ${range}"`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the read-timing tags agree with the table', () => {
  const expectedTag = {
    startup: 'READ AT STARTUP',
    'frontend-build': 'NEXT_PUBLIC: rebuild to change',
    'frontend-runtime': 'restart the frontend, no rebuild',
  };
  const problems = [];
  for (const variable of OPERATIONAL_VARIABLES) {
    const entry = byName.get(variable.name);
    const tag = expectedTag[variable.readAt];
    if (!entry || !tag) continue;
    if (!entry.paragraph.includes(tag)) {
      problems.push(`${variable.name} (line ${entry.lineNumber}) is ${variable.readAt} and should say "${tag}"`);
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

test("the README's Configuration table names every operational setting", () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const start = readme.indexOf('## 🔧 Configuration');
  assert.notEqual(start, -1, 'README.md has no "## 🔧 Configuration" section');
  const next = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, next === -1 ? undefined : next);

  const missing = OPERATIONAL_VARIABLES.map((variable) => variable.name).filter(
    (name) => !section.includes(`\`${name}\``)
  );
  assert.deepEqual(missing, [], `README.md's Configuration table does not mention ${missing.join(', ')}`);
});
