const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * The jobs form's use of the scraper settings the server serves
 * (`frontend/src/lib/scraperForm.ts`).
 *
 * Tested from here because the frontend has no test runner and these are
 * plain functions with no React in them; the module is transpiled with the
 * backend's own TypeScript, the way `frontendEnv.test.js` loads its modules.
 * What is pinned: with nothing configured, the form offers what it offered
 * when the Job Board's 100 was a literal on the page, and a start-URL source
 * never lowers the count the other sources start with.
 */

const FILE = path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'scraperForm.ts');

function loadScraperForm() {
  const { outputText } = ts.transpileModule(fs.readFileSync(FILE, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: FILE,
  });
  const module = { exports: {} };
  const refuse = (specifier) => {
    throw new Error(`scraperForm.ts imports ${specifier}; it is meant to import nothing`);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, refuse);
  return module.exports;
}

const { LIMIT_OPTIONS, formatRunTimeout, limitOptionsFor, resultCapFor } = loadScraperForm();

test('uncapped, the Results menu offers every count, as it always did', () => {
  assert.deepEqual(limitOptionsFor(null), [25, 100, 250, 500, 1000]);
  assert.deepEqual([...LIMIT_OPTIONS], [25, 100, 250, 500, 1000]);
  // A copy: the page cannot reorder or extend the shared list by accident.
  assert.notEqual(limitOptionsFor(null), LIMIT_OPTIONS);
});

test('the Job Board cap of 100, now served, gives the menu the page used to hard-code', () => {
  assert.deepEqual(limitOptionsFor(100), [25, 100]);
});

test('a SCRAPER_MAX_RESULTS between two counts is offered itself', () => {
  assert.deepEqual(limitOptionsFor(300), [25, 100, 250, 300]);
  assert.deepEqual(limitOptionsFor(10), [10]);
  assert.deepEqual(limitOptionsFor(25), [25]);
  // At or above the largest count, nothing is added.
  assert.deepEqual(limitOptionsFor(1000), [25, 100, 250, 500, 1000]);
  assert.deepEqual(limitOptionsFor(10_000), [25, 100, 250, 500, 1000]);
});

test('a start-URL provider never caps the Results menu', () => {
  // Indeed is the initial source and reports 100; letting it through would
  // clamp the form's default of 250 before the user picked anything else.
  assert.equal(resultCapFor({ maxResults: 100 }, true), null);
  assert.equal(resultCapFor({ maxResults: 100 }, false), 100);
  assert.equal(resultCapFor({ maxResults: null }, false), null);
  assert.equal(resultCapFor(null, false), null, 'before the catalog arrives');
  assert.equal(resultCapFor(undefined, false), null);
});

test('the run timeout reads the way the page header always said it', () => {
  assert.equal(formatRunTimeout(300), '5-minute', 'the default, word for word');
  assert.equal(formatRunTimeout(600), '10-minute');
  assert.equal(formatRunTimeout(90), '90-second');
  assert.equal(formatRunTimeout(30), '30-second');
});
