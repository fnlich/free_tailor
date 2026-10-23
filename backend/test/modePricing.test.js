const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const express = require('express');

/** Every seat is unlocked here, whatever the machine running this says. Set before any dist module loads. */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
/** One go per resume, so a failed task refunds at once rather than after retries. */
process.env.GENERATION_MAX_ATTEMPTS = '1';

const { loadFresh, readSettingRaw, seedProfileWithResumes, useAdminEmails, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * What a resume costs: the build mode's price, never the model's (owner
 * decision 8; part F2). Renamed from modelPricing.test.js, which pinned a price
 * on every model record; a model carries none now.
 *
 * Each of the three modes - Choose Suitable Resume, Partial Tailor and Fully
 * Tailor - has ONE price per resume, an administrator's setting with a `.env`
 * default (`RESUME_SUITABLE_PRICE_USD`, `RESUME_PARTIAL_PRICE_USD`,
 * `RESUME_FULL_PRICE_USD`), in thousandths of a dollar. What is pinned here is
 * everything that keeps that number honest:
 *
 *   - the three settings: the code's value, `.env`'s, the administrator's, the
 *     source of each, Reset (null), the refusals by field and code, a `.env`
 *     price that cannot be read (reads $0, flagged), and a stored one nobody
 *     could have written (read past, said once);
 *   - the model records, which carry no price: one an older build stored is read
 *     past and dropped by the next write, and a create needs no price;
 *   - `getBuildModePrices()`, which throws when the settings cannot be read, so
 *     a run is never priced from nothing;
 *   - the preview token, which names the mode that wrote the content, and the
 *     price of supplied content, which is the run mode's only when a token
 *     vouches for exactly that (account, resume, mode) and otherwise the
 *     dearest of the run mode's, Partial's and Fully's;
 *   - the routes: the quote is jobs x the mode's price, the charge is the
 *     quote, administrators are exempt, a free mode takes nothing, and the
 *     history line is by mode;
 *   - the queue: each failure refunds the price ITS task was charged, a
 *     restored task keeps it, and a resume deleted before its turn is refunded
 *     its own.
 *
 * Modules are required once, not loaded fresh: the settings are cached per
 * database path in the module, and a route holding one copy of it while the
 * test writes through another would read a stale cache. Each test gets a
 * database of its own instead.
 */

const APP_SETTINGS_KEY = 'app-settings';
const config = require('../dist/config/aiModelConfig');
const modes = require('../dist/config/buildModes');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');
const credits = require('../dist/services/credits');
const users = require('../dist/database/userRepository');
const queueModule = require('../dist/services/queue/index');
const choice = require('../dist/services/resumeChoice');
const previewTokens = require('../dist/services/credits/previewToken');

const MODE_ENV = ['DEFAULT_TAILOR_MODE', 'RESUME_SUITABLE_PRICE_USD', 'RESUME_PARTIAL_PRICE_USD', 'RESUME_FULL_PRICE_USD'];
const MODEL_OPTION_ENV = ['AI_CLI_MODEL_OPTIONS', 'AI_CODEX_MODEL_OPTIONS', 'AI_GEMINI_MODEL_OPTIONS'];

// None of the build-mode variables is set for the tests that do not mean to set
// one, whatever the machine running them has in its environment (`withEnv`
// sets exactly the ones a test names, and restores what it found: nothing).
for (const name of MODE_ENV) delete process.env[name];

/**
 * Fresh storage with the database opened, so the data migrations have run
 * (step 9 rewrites a row still holding its old defaults, once, as the database
 * opens): what these tests pin is that READING writes nothing.
 */
function fresh(name) {
  const dirs = useTempStorage(`mode-pricing-${name}`);
  config.invalidateSettingsCache();
  require('../dist/database/sqlite').getDb();
  return dirs;
}

/**
 * Runs `fn` with exactly `values` set among the build-mode variables (every
 * other one unset), the once-only warnings forgotten and console.warn
 * captured; restores everything after.
 */
async function withEnv(values, fn) {
  const saved = Object.fromEntries(MODE_ENV.map((name) => [name, process.env[name]]));
  for (const name of MODE_ENV) delete process.env[name];
  Object.assign(process.env, values);
  resetEnvWarningsForTests();
  config.invalidateSettingsCache();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return await fn(warnings);
  } finally {
    console.warn = original;
    for (const name of MODE_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    config.invalidateSettingsCache();
  }
}

function clearModelOptionOverrides() {
  for (const name of MODEL_OPTION_ENV) delete process.env[name];
}

/** The settings save's refusal, or null when it was accepted. */
async function refusalOf(body) {
  try {
    await config.updateAppSettings(body);
  } catch (error) {
    return error;
  }
  return null;
}

const priceSettings = (admin) => ({
  suitable: admin.suitablePriceMilli,
  partial: admin.partialPriceMilli,
  full: admin.fullPriceMilli,
});
const priceSources = (admin) => ({
  suitable: admin.settingSources.suitablePriceMilli,
  partial: admin.settingSources.partialPriceMilli,
  full: admin.settingSources.fullPriceMilli,
});

/* ------------------------------------------------------ the mode constants */

test('the three modes, their labels, the names a price goes by, and the ceiling', () => {
  assert.deepEqual([...modes.BUILD_MODES], ['suitable', 'partial', 'full']);
  assert.deepEqual(modes.BUILD_MODE_LABELS, {
    suitable: 'Choose Suitable Resume',
    partial: 'Partial Tailor',
    full: 'Fully Tailor',
  });
  assert.equal(modes.MAX_BUILD_MODE_PRICE_MILLI, 1_000_000);
  assert.deepEqual(modes.BUILD_MODE_PRICE_FIELDS, {
    suitable: { setting: 'suitablePriceMilli', request: 'suitablePriceUsd', env: 'RESUME_SUITABLE_PRICE_USD' },
    partial: { setting: 'partialPriceMilli', request: 'partialPriceUsd', env: 'RESUME_PARTIAL_PRICE_USD' },
    full: { setting: 'fullPriceMilli', request: 'fullPriceUsd', env: 'RESUME_FULL_PRICE_USD' },
  });
  for (const mode of modes.BUILD_MODES) assert.equal(modes.isBuildMode(mode), true, mode);
  for (const junk of ['Partial', 'FULL', 'everything', '', null, undefined, 1, ['partial']]) {
    assert.equal(modes.isBuildMode(junk), false, JSON.stringify(junk));
  }
  // A price this app writes: a whole number of thousandths from 0 to the ceiling.
  for (const good of [0, 1, 23, 1_000_000]) assert.equal(modes.isStoredBuildModePriceMilli(good), true, String(good));
  for (const bad of [-1, 1_000_001, 1.5, '23', null, undefined, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.equal(modes.isStoredBuildModePriceMilli(bad), false, String(bad));
  }
});

test('an administrator\'s price is dollars in, thousandths out, and nothing is rounded', () => {
  assert.equal(modes.parseBuildModePriceInput('partial', '0.023'), 23);
  assert.equal(modes.parseBuildModePriceInput('partial', '$0.023'), 23);
  assert.equal(modes.parseBuildModePriceInput('full', ' 12.5 '), 12_500);
  assert.equal(modes.parseBuildModePriceInput('suitable', 0.05), 50, 'a JSON number');
  assert.equal(modes.parseBuildModePriceInput('suitable', 0), 0, '0 is free, on purpose');
  assert.equal(modes.parseBuildModePriceInput('suitable', '1000'), 1_000_000, 'the ceiling itself');
  for (const [mode, bad, why] of [
    ['partial', '0.0235', /at most three decimal places/],
    ['partial', 0.1 + 0.2, /at most three decimal places/],
    ['partial', '-1', /cannot be negative/],
    ['partial', '1000.001', /from \$0 to \$1000 in steps of \$0\.001/],
    ['full', 'two', /must be an amount in dollars/],
    ['full', '1,5', /must be an amount in dollars/],
    ['full', true, /must be an amount in dollars/],
    ['full', '', /is required/],
    ['full', '  ', /is required/],
    ['suitable', undefined, /is required/],
  ]) {
    assert.throws(
      () => modes.parseBuildModePriceInput(mode, bad),
      (error) =>
        error instanceof modes.BuildModePriceError &&
        error.field === modes.BUILD_MODE_PRICE_FIELDS[mode].request &&
        error.code === 'bad-price' &&
        error.status === 400 &&
        why.test(error.message) &&
        error.message.includes(`The ${modes.BUILD_MODE_LABELS[mode]} price`),
      `${mode}: ${JSON.stringify(bad)}`
    );
  }
});

/* ------------------------------------------------ the settings: the layers */

test('every mode is free until somebody prices it, and reading the settings stores nothing', async () => {
  const { dbDir } = fresh('defaults');
  await withEnv({}, async (warnings) => {
    const admin = await config.getAdminAppSettings();
    assert.deepEqual(priceSettings(admin), { suitable: 0, partial: 0, full: 0 });
    assert.deepEqual(priceSources(admin), { suitable: 'default', partial: 'default', full: 'default' });
    assert.deepEqual(
      [admin.settingDefaults.suitablePriceMilli, admin.settingDefaults.partialPriceMilli, admin.settingDefaults.fullPriceMilli],
      [0, 0, 0],
      'what Reset would give'
    );
    assert.deepEqual(admin.unreadableModePrices, []);
    assert.equal(admin.defaultBuildMode, 'partial');
    assert.deepEqual(await config.getBuildModePrices(), { suitable: 0, partial: 0, full: 0 });

    // Everybody is told the prices - they are what the builder's mode cards show -
    // but not where they came from.
    const user = await config.getUserAppSettings();
    assert.deepEqual([user.suitablePriceMilli, user.partialPriceMilli, user.fullPriceMilli], [0, 0, 0]);
    assert.equal(user.defaultBuildMode, 'partial');
    assert.equal('settingSources' in user, false);
    assert.equal('unreadableModePrices' in user, false);

    assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), null, 'a read writes no row');
    assert.deepEqual(warnings, []);
  });
});

test('.env prices each mode on its own, the administrator\'s price beats it mode by mode ($0 included), and null puts .env back', async () => {
  const { dbDir } = fresh('layers');
  const row = () => JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY) ?? '{}');
  await withEnv(
    { RESUME_SUITABLE_PRICE_USD: '0.005', RESUME_PARTIAL_PRICE_USD: '$0.010', RESUME_FULL_PRICE_USD: '1000' },
    async (warnings) => {
      let admin = await config.getAdminAppSettings();
      assert.deepEqual(priceSettings(admin), { suitable: 5, partial: 10, full: 1_000_000 });
      assert.deepEqual(priceSources(admin), { suitable: 'env', partial: 'env', full: 'env' });
      assert.deepEqual(await config.getBuildModePrices(), { suitable: 5, partial: 10, full: 1_000_000 });

      // A save names only the price it changes: the others keep following .env.
      admin = await config.updateAppSettings({ partialPriceUsd: '0.023' });
      assert.deepEqual(priceSettings(admin), { suitable: 5, partial: 23, full: 1_000_000 });
      assert.deepEqual(priceSources(admin), { suitable: 'env', partial: 'admin', full: 'env' });
      assert.equal(admin.settingDefaults.partialPriceMilli, 10, 'what Reset would give is .env\'s');
      assert.equal(row().partialPriceMilli, 23);
      assert.equal('suitablePriceMilli' in row(), false, 'a value merely in effect is not stored');
      assert.equal('fullPriceMilli' in row(), false);

      // Saving something else leaves it set, and freezes nothing.
      await config.updateAppSettings({ defaultTheme: 'dark' });
      assert.equal(row().partialPriceMilli, 23);
      assert.equal('suitablePriceMilli' in row() || 'fullPriceMilli' in row(), false);

      // A .env edit reaches the prices nobody set, and not the one somebody did.
      process.env.RESUME_SUITABLE_PRICE_USD = '0.007';
      process.env.RESUME_PARTIAL_PRICE_USD = '0.099';
      config.invalidateSettingsCache();
      assert.deepEqual(await config.getBuildModePrices(), { suitable: 7, partial: 23, full: 1_000_000 });

      // $0 is a price: the administrator's "free" beats a .env price.
      admin = await config.updateAppSettings({ fullPriceUsd: 0, suitablePriceUsd: '0' });
      assert.deepEqual(priceSettings(admin), { suitable: 0, partial: 23, full: 0 });
      assert.deepEqual(priceSources(admin), { suitable: 'admin', partial: 'admin', full: 'admin' });
      assert.equal(row().fullPriceMilli, 0);
      assert.equal(row().suitablePriceMilli, 0);

      // Reset to default, one mode: .env's price again, and nothing stored for it.
      admin = await config.updateAppSettings({ fullPriceUsd: null });
      assert.equal(admin.fullPriceMilli, 1_000_000);
      assert.equal(admin.settingSources.fullPriceMilli, 'env');
      assert.equal('fullPriceMilli' in row(), false);
      assert.equal(admin.suitablePriceMilli, 0, 'the others untouched');

      // Reset the rest.
      admin = await config.updateAppSettings({ suitablePriceUsd: null, partialPriceUsd: null });
      assert.deepEqual(priceSettings(admin), { suitable: 7, partial: 99, full: 1_000_000 });
      assert.deepEqual(priceSources(admin), { suitable: 'env', partial: 'env', full: 'env' });
      assert.equal(Object.keys(row()).some((key) => /PriceMilli$/.test(key) && !/^premium/.test(key)), false);

      config.invalidateSettingsCache();
      assert.deepEqual(priceSources(await config.getAdminAppSettings()), { suitable: 'env', partial: 'env', full: 'env' }, 'as read back');
      assert.deepEqual(warnings, []);
    }
  );

  // .env removed after the reset: the code's $0, nothing frozen in the row.
  await withEnv({}, async () => {
    const admin = await config.getAdminAppSettings();
    assert.deepEqual(priceSettings(admin), { suitable: 0, partial: 0, full: 0 });
    assert.deepEqual(priceSources(admin), { suitable: 'default', partial: 'default', full: 'default' });
  });
});

test('a price stored exactly as this app writes it is read exactly, over .env, at both ends of the range', async () => {
  const { dbDir } = fresh('stored-valid');
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify({ suitablePriceMilli: 0, partialPriceMilli: 1_000_000, fullPriceMilli: 23 }));
  await withEnv(
    { RESUME_SUITABLE_PRICE_USD: '0.5', RESUME_PARTIAL_PRICE_USD: '0.5', RESUME_FULL_PRICE_USD: '0.5' },
    async () => {
      const admin = await config.getAdminAppSettings();
      assert.deepEqual(priceSettings(admin), { suitable: 0, partial: 1_000_000, full: 23 });
      assert.deepEqual(priceSources(admin), { suitable: 'admin', partial: 'admin', full: 'admin' });
      assert.deepEqual(admin.settingDefaults.fullPriceMilli, 500);
      assert.deepEqual(await config.getBuildModePrices(), { suitable: 0, partial: 1_000_000, full: 23 });
    }
  );
});

/* -------------------------------------------- the settings: refusals, junk */

test('a price that is not an amount is refused by the box it came from, with the code a page branches on, and nothing is saved', async () => {
  const { dbDir } = fresh('refusals');
  await withEnv({}, async () => {
    await config.updateAppSettings({ partialPriceUsd: '0.01', defaultTheme: 'dark' });
    const before = readSettingRaw(dbDir, APP_SETTINGS_KEY);

    const dollars = ' It is from \\$0 to \\$1000 in steps of \\$0\\.001, like 0\\.023; 0 makes it free\\.$';
    for (const [body, field, code, sentence] of [
      // Required: '' is refused (Reset to default is the button that clears it).
      [{ partialPriceUsd: '' }, 'partialPriceUsd', 'bad-price', new RegExp(`^The Partial Tailor price is required: an amount in dollars, like 0\\.023\\.${dollars}`)],
      [{ suitablePriceUsd: '   ' }, 'suitablePriceUsd', 'bad-price', /^The Choose Suitable Resume price is required/],
      [{ fullPriceUsd: 'abc' }, 'fullPriceUsd', 'bad-price', new RegExp(`^The Fully Tailor price must be an amount in dollars, like 0\\.023 or 12\\.50\\.${dollars}`)],
      [{ fullPriceUsd: true }, 'fullPriceUsd', 'bad-price', /^The Fully Tailor price must be an amount in dollars/],
      [{ suitablePriceUsd: '0.0235' }, 'suitablePriceUsd', 'bad-price', /^The Choose Suitable Resume price can have at most three decimal places/],
      [{ suitablePriceUsd: 0.1 + 0.2 }, 'suitablePriceUsd', 'bad-price', /at most three decimal places/],
      [{ suitablePriceUsd: '-1' }, 'suitablePriceUsd', 'bad-price', /^The Choose Suitable Resume price cannot be negative\./],
      [{ partialPriceUsd: '1000.001' }, 'partialPriceUsd', 'bad-price', /^The Partial Tailor price must be from \$0 to \$1000 in steps of \$0\.001, like 0\.023; 0 makes it free\.$/],
      [{ partialPriceUsd: 5000 }, 'partialPriceUsd', 'bad-price', /^The Partial Tailor price must be from \$0 to \$1000/],
      // Requests carry dollars: a price in thousandths is never read.
      [{ partialPriceMilli: 23 }, 'partialPriceUsd', 'bad-price-field', /^Send the Partial Tailor price in dollars, as partialPriceUsd\.$/],
      [{ suitablePriceMilli: null }, 'suitablePriceUsd', 'bad-price-field', /^Send the Choose Suitable Resume price in dollars, as suitablePriceUsd\.$/],
      [{ fullPriceMilli: '0.02' }, 'fullPriceUsd', 'bad-price-field', /^Send the Fully Tailor price in dollars, as fullPriceUsd\.$/],
      // One bad price refuses the whole save, whatever else it carried.
      [{ defaultTheme: 'light', fullPriceUsd: 'x' }, 'fullPriceUsd', 'bad-price', /Fully Tailor price/],
    ]) {
      const refusal = await refusalOf(body);
      assert.ok(refusal, `refused: ${JSON.stringify(body)}`);
      assert.ok(refusal instanceof modes.BuildModePriceError, JSON.stringify(body));
      assert.match(refusal.message, sentence, JSON.stringify(body));
      assert.equal(refusal.field, field, JSON.stringify(body));
      assert.equal(refusal.code, code, JSON.stringify(body));
      assert.equal(refusal.status, 400);
      assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), before, `nothing saved by ${JSON.stringify(body)}`);
    }
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.partialPriceMilli, 10, 'a refused save changed nothing');
    assert.equal(admin.defaultTheme, 'dark');

    // The extremes are accepted, exactly.
    const edges = await config.updateAppSettings({ suitablePriceUsd: '1000', fullPriceUsd: '0.001', partialPriceUsd: '0' });
    assert.deepEqual(priceSettings(edges), { suitable: 1_000_000, partial: 0, full: 1 });
  });
});

test('a .env price that cannot be read reads $0, is flagged unreadable until somebody sets one, and says so once', async () => {
  fresh('unreadable-env');
  await withEnv(
    { RESUME_SUITABLE_PRICE_USD: '0.004', RESUME_PARTIAL_PRICE_USD: 'cheap', RESUME_FULL_PRICE_USD: '0.0235' },
    async (warnings) => {
      let admin = await config.getAdminAppSettings();
      assert.deepEqual(priceSettings(admin), { suitable: 4, partial: 0, full: 0 });
      assert.deepEqual(priceSources(admin), { suitable: 'env', partial: 'default', full: 'default' }, 'nothing came from .env for the junk ones');
      assert.deepEqual(admin.unreadableModePrices, ['partial', 'full']);
      assert.deepEqual(await config.getBuildModePrices(), { suitable: 4, partial: 0, full: 0 });
      assert.deepEqual((await config.getUserAppSettings()).partialPriceMilli, 0, 'and everybody is quoted $0');

      config.invalidateSettingsCache();
      await config.getAdminAppSettings();
      const partial = warnings.filter((line) => line.includes('RESUME_PARTIAL_PRICE_USD'));
      const full = warnings.filter((line) => line.includes('RESUME_FULL_PRICE_USD'));
      assert.equal(partial.length, 1, warnings.join('\n'));
      assert.equal(full.length, 1, warnings.join('\n'));
      assert.match(partial[0], /"cheap" is not an amount in dollars/);
      assert.match(full[0], /more than three decimal places/);
      assert.equal(warnings.some((line) => line.includes('RESUME_SUITABLE_PRICE_USD')), false);

      // An administrator's price is a decision over the junk: no longer flagged.
      admin = await config.updateAppSettings({ partialPriceUsd: '0.02' });
      assert.equal(admin.partialPriceMilli, 20);
      assert.equal(admin.settingSources.partialPriceMilli, 'admin');
      assert.deepEqual(admin.unreadableModePrices, ['full']);
      // ...and Reset puts the junk back under it.
      admin = await config.updateAppSettings({ partialPriceUsd: null });
      assert.equal(admin.partialPriceMilli, 0);
      assert.deepEqual(admin.unreadableModePrices, ['partial', 'full']);
    }
  );

  // Unset, blank and "0" are decisions - free - not prices that could not be read; above $1000 clamps.
  await withEnv({ RESUME_SUITABLE_PRICE_USD: '0', RESUME_PARTIAL_PRICE_USD: '   ', RESUME_FULL_PRICE_USD: '5000' }, async (warnings) => {
    const admin = await config.getAdminAppSettings();
    assert.deepEqual(priceSettings(admin), { suitable: 0, partial: 0, full: 1_000_000 });
    assert.deepEqual(admin.unreadableModePrices, []);
    assert.equal(admin.settingSources.fullPriceMilli, 'env');
    assert.equal(warnings.filter((line) => line.includes('RESUME_FULL_PRICE_USD=5000 is above $1,000; using $1,000.')).length, 1, warnings.join('\n'));
  });
  const { envBuildModePriceMilli } = require('../dist/config/settingDefaults');
  assert.deepEqual(envBuildModePriceMilli('partial', {}), { value: 0, fromEnv: false, unreadable: false });
  assert.deepEqual(envBuildModePriceMilli('partial', { RESUME_PARTIAL_PRICE_USD: '0.023' }), { value: 23, fromEnv: true, unreadable: false });
  assert.deepEqual(envBuildModePriceMilli('full', { RESUME_FULL_PRICE_USD: '9,99' }), { value: 0, fromEnv: false, unreadable: true });
});

test('a stored price nobody could have written is read past with one warning, writes nothing, and the next save drops it', async () => {
  const { dbDir } = fresh('stored-junk');
  // Over the ceiling, a fraction of a thousandth, and not a number at all.
  const row = JSON.stringify({ suitablePriceMilli: 2_000_000, partialPriceMilli: 1.5, fullPriceMilli: 'free' });
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, row);
  await withEnv({ RESUME_PARTIAL_PRICE_USD: '0.007' }, async (warnings) => {
    await config.getAdminAppSettings();
    config.invalidateSettingsCache();
    const admin = await config.getAdminAppSettings();
    // The junk is not "set here": .env's price (else the code's $0) is in effect.
    assert.deepEqual(priceSettings(admin), { suitable: 0, partial: 7, full: 0 });
    assert.deepEqual(priceSources(admin), { suitable: 'default', partial: 'env', full: 'default' });
    for (const [key, shown] of [['suitablePriceMilli', '2000000'], ['partialPriceMilli', '1.5'], ['fullPriceMilli', '"free"']]) {
      const lines = warnings.filter((line) => line.includes(`The stored ${key} is ${shown}`));
      assert.equal(lines.length, 1, `${key}: said once, however many reads\n${warnings.join('\n')}`);
    }
    assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), row, 'a read rewrites nothing');

    await config.updateAppSettings({ defaultTheme: 'dark' });
    const after = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
    for (const key of ['suitablePriceMilli', 'partialPriceMilli', 'fullPriceMilli']) {
      assert.equal(key in after, false, `${key} is dropped by the next write`);
    }
  });
});

/* ------------------------------------------------------ the model records */

test('a model carries no price: one an older build stored is read past and dropped by the next write', async () => {
  const { dbDir } = fresh('stored-model-price');
  const stamp = '2026-01-01T00:00:00.000Z';
  const stored = (id, provider, modelName, extra = {}) => ({
    id, name: id, provider, modelName, description: '', enabled: true, createdAt: stamp, updatedAt: stamp, ...extra,
  });
  const row = JSON.stringify({
    providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': true },
    defaultModelId: 'claude-cli-sonnet',
    aiModels: [
      stored('claude-cli-sonnet', 'claude-cli', 'sonnet', { pricePerResumeMilli: 23 }),
      // Priced in CREDITS, before credits were dollars.
      stored('codex-cli-default', 'codex-cli', 'default', { creditsPerResume: 2 }),
      stored('too-dear', 'gemini-cli', 'auto', { pricePerResumeMilli: 5_000_000 }),
    ],
  });
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, row);
  clearModelOptionOverrides();

  await withEnv({}, async (warnings) => {
    const admin = await config.getAdminAppSettings();
    assert.deepEqual(admin.aiModels.map((model) => model.id), ['claude-cli-sonnet', 'codex-cli-default', 'too-dear']);
    for (const model of admin.aiModels) {
      assert.equal('pricePerResumeMilli' in model, false, `${model.id}: no price on the record`);
      assert.equal('creditsPerResume' in model, false);
    }
    // Nothing lists "the free ones" any more, and a stored price is not warned about.
    assert.equal('freeEnabledModelIds' in admin, false);
    assert.deepEqual(warnings, []);
    for (const model of (await config.getUserAppSettings()).models) assert.deepEqual(Object.keys(model).sort(), ['id', 'name']);
    assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), row, 'reading writes nothing back');

    // Any write of the row drops them for good.
    await config.updateAppSettings({ defaultTheme: 'dark' });
    const after = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
    assert.equal(after.aiModels.length, 3);
    for (const model of after.aiModels) {
      assert.equal('pricePerResumeMilli' in model, false, model.id);
      assert.equal('creditsPerResume' in model, false, model.id);
    }
  });
});

test('a model is created without a price, and a price in the body is not read, refused or stored', async () => {
  fresh('model-create');
  clearModelOptionOverrides();
  assert.deepEqual([...config.AI_MODEL_FIELDS], ['name', 'provider', 'modelName', 'description', 'enabled']);

  const plain = await config.createAIModel({ name: 'Fable', provider: 'claude-cli', modelName: 'fable' });
  const fable = plain.aiModels.find((model) => model.modelName === 'fable');
  assert.ok(fable, 'created with no price');
  assert.equal('pricePerResumeMilli' in fable, false);
  assert.equal('freeEnabledModelIds' in plain, false);

  // Whatever a stale page sends: junk, out of range, a number, in thousandths - none of it is read.
  for (const extra of [
    { pricePerResumeUsd: 'junk' },
    { pricePerResumeUsd: '5000' },
    { pricePerResumeUsd: '' },
    { pricePerResumeUsd: null },
    { pricePerResumeUsd: 0.023, pricePerResumeMilli: 23, creditsPerResume: 2 },
  ]) {
    const created = await config.createAIModel({ name: 'Luna', provider: 'codex-cli', modelName: 'gpt-6-luna', ...extra });
    const record = created.aiModels.find((entry) => entry.modelName === 'gpt-6-luna');
    assert.ok(record, `created: ${JSON.stringify(extra)}`);
    for (const key of ['pricePerResumeMilli', 'pricePerResumeUsd', 'creditsPerResume']) {
      assert.equal(key in record, false, `${JSON.stringify(extra)}: ${key}`);
    }
    // The same model twice is refused, so each round starts from none.
    await config.deleteAIModel(record.id);
  }

  // An edit does not read one either (and keeps everything else).
  const edited = await config.updateAIModel('claude-cli-opus', { pricePerResumeUsd: '9999', description: 'Hardest prompts.' });
  const opus = edited.aiModels.find((model) => model.id === 'claude-cli-opus');
  assert.equal(opus.description, 'Hardest prompts.');
  assert.equal('pricePerResumeMilli' in opus, false);
});

/* ----------------------------------------------- the settings over HTTP */

async function serveAdmin(name) {
  const dirs = fresh(`http-${name}`);
  useAdminEmails('boss@example.com');
  clearModelOptionOverrides();
  const boss = users.createUser({ email: 'boss@example.com' });
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin', require('../dist/routes/admin').default);
  const server = app.listen(0);
  const port = server.address().port;
  const token = users.createSession(boss.id);
  const call = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...dirs, call, close: () => server.close() };
}

test('PUT /api/admin/settings: a price is saved in dollars, null resets it, and a refusal names its box and its code', async () => {
  await withEnv({ RESUME_FULL_PRICE_USD: '0.03' }, async () => {
    const s = await serveAdmin('settings');
    try {
      let reply = await s.call('PUT', '/settings', { suitablePriceUsd: '0.004', partialPriceUsd: 0.02, defaultBuildMode: 'suitable' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual(priceSettings(reply.body), { suitable: 4, partial: 20, full: 30 });
      assert.deepEqual(priceSources(reply.body), { suitable: 'admin', partial: 'admin', full: 'env' });
      assert.equal(reply.body.defaultBuildMode, 'suitable');
      assert.deepEqual(reply.body.unreadableModePrices, []);
      assert.equal(reply.body.freeEnabledModelIds, undefined);

      reply = await s.call('GET', '/settings');
      assert.deepEqual(priceSettings(reply.body), { suitable: 4, partial: 20, full: 30 });

      reply = await s.call('PUT', '/settings', { partialPriceUsd: null });
      assert.equal(reply.status, 200);
      assert.equal(reply.body.partialPriceMilli, 0);
      assert.equal(reply.body.settingSources.partialPriceMilli, 'default');

      for (const [body, field, code, sentence] of [
        [{ partialPriceUsd: '' }, 'partialPriceUsd', 'bad-price', /^The Partial Tailor price is required/],
        [{ fullPriceUsd: '1000.001' }, 'fullPriceUsd', 'bad-price', /^The Fully Tailor price must be from \$0 to \$1000/],
        [{ suitablePriceUsd: '0.0001' }, 'suitablePriceUsd', 'bad-price', /at most three decimal places/],
        [{ fullPriceMilli: 5 }, 'fullPriceUsd', 'bad-price-field', /^Send the Fully Tailor price in dollars, as fullPriceUsd\.$/],
      ]) {
        reply = await s.call('PUT', '/settings', body);
        assert.equal(reply.status, 400, JSON.stringify(body));
        assert.match(reply.body.error, sentence);
        assert.equal(reply.body.field, field);
        assert.equal(reply.body.code, code);
      }
      reply = await s.call('GET', '/settings');
      assert.deepEqual(priceSettings(reply.body), { suitable: 4, partial: 0, full: 30 }, 'refused saves changed nothing');
    } finally {
      s.close();
    }
  });
});

test('POST /api/admin/models: a model is created without a price (201), and a price in the body is ignored', async () => {
  const s = await serveAdmin('models');
  try {
    const plain = await s.call('POST', '/models', { name: 'Fable', provider: 'claude-cli', modelName: 'fable' });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    assert.equal('pricePerResumeMilli' in plain.body.aiModels.find((model) => model.modelName === 'fable'), false);

    const priced = await s.call('POST', '/models', {
      name: 'Luna',
      provider: 'codex-cli',
      modelName: 'gpt-6-luna',
      pricePerResumeUsd: 'not a price',
      pricePerResumeMilli: 5,
    });
    assert.equal(priced.status, 201, JSON.stringify(priced.body));
    const luna = priced.body.aiModels.find((model) => model.modelName === 'gpt-6-luna');
    assert.equal('pricePerResumeMilli' in luna, false);
    assert.equal('pricePerResumeUsd' in luna, false);

    const edited = await s.call('PUT', `/models/${luna.id}`, { pricePerResumeUsd: '1001', enabled: false });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.aiModels.find((model) => model.id === luna.id).enabled, false);
    assert.equal(edited.body.freeEnabledModelIds, undefined);
  } finally {
    s.close();
  }
});

test('getBuildModePrices() throws when the settings cannot be read, and never reads as $0', async () => {
  const { dbDir } = fresh('unreadable-settings');
  const invalid = '{ invalid json';
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, invalid);
  config.invalidateSettingsCache();
  await assert.rejects(() => config.getBuildModePrices(), /contains invalid JSON/);
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), invalid, 'and the row is not overwritten with defaults');
  // Mended, it reads again.
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify({ partialPriceMilli: 12 }));
  config.invalidateSettingsCache();
  await withEnv({}, async () => assert.deepEqual(await config.getBuildModePrices(), { suitable: 0, partial: 12, full: 0 }));
});

/* ------------------------------------------------------- credit primitives */

function creditSetup(name) {
  fresh(`credits-${name}`);
  useAdminEmails('admin@example.com');
  queueModule.resetGenerationQueueForTests();
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  return { admin, alice };
}

test('a reserve takes an amount of money, not a count of resumes to multiply', () => {
  const { alice, admin } = creditSetup('amount');
  credits.setBalance(alice.id, 200, admin.id);
  const reservation = credits.reserveCredits(users.getUserById(alice.id), 161, { kind: 'batch', id: 'bat_1' });
  assert.equal(reservation.costMilli, 161);
  assert.equal(users.getUserById(alice.id).balanceMilli, 39);
  assert.throws(
    () => credits.reserveCredits(users.getUserById(alice.id), 46, { kind: 'batch', id: 'bat_2' }),
    (error) => error.name === 'InsufficientCreditsError' && error.neededMilli === 46 && error.balanceMilli === 39
  );
});

test('a free run takes nothing, writes nothing, and runs on an empty balance', () => {
  const { alice } = creditSetup('free');
  const reservation = credits.reserveCredits(users.getUserById(alice.id), 0, { kind: 'batch', id: 'bat_free' });
  assert.deepEqual({ costMilli: reservation.costMilli, exempt: reservation.exempt }, { costMilli: 0, exempt: false });
  assert.equal(credits.getReservation('bat_free'), null);
  assert.equal(credits.getLedger(alice.id).length, 0);
  assert.equal(credits.refundTaskUnit('bat_free', 'tsk_1', 0, 'failed'), 0);
});

test('each unit refunds its own price, and the run still cannot refund more than it took', () => {
  const { alice, admin } = creditSetup('mixed-refunds');
  credits.setBalance(alice.id, 10_000, admin.id);
  credits.reserveCredits(users.getUserById(alice.id), 33, { kind: 'batch', id: 'bat_1' });

  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_dear', 23, 'failed'), 23);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_dear', 23, 'failed'), 0, 'once per task');
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_other', 23, 'failed'), 0, 'capped: only $0.010 is left');
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_cheap', 10, 'failed'), 10);
  assert.equal(users.getUserById(alice.id).balanceMilli, 10_000);
});

test('the history line breaks a charge down by build mode, in the mode\'s own name', () => {
  const { describeCharge } = credits;
  assert.equal(
    describeCharge([
      { label: 'Partial Tailor', costMilli: 20 },
      { label: 'Partial Tailor', costMilli: 20 },
      { label: 'Partial Tailor', costMilli: 20 },
    ]),
    '3 resumes: 3 x Partial Tailor @ $0.02 = $0.06'
  );
  assert.equal(
    describeCharge([
      { label: modes.BUILD_MODE_LABELS.suitable, costMilli: 5 },
      { label: modes.BUILD_MODE_LABELS.full, costMilli: 23 },
      { label: modes.BUILD_MODE_LABELS.suitable, costMilli: 5 },
    ]),
    '3 resumes: 2 x Choose Suitable Resume @ $0.005, 1 x Fully Tailor @ $0.023 = $0.033'
  );
  assert.equal(describeCharge([{ label: 'Partial Tailor', costMilli: 1 }]), '1 resume: 1 x Partial Tailor @ $0.001 = $0.001');
  assert.equal(describeCharge([{ label: 'Fully Tailor', costMilli: 0 }]), '1 resume: 1 x Fully Tailor @ $0 = $0');
  assert.equal(describeCharge([{ label: 'Fully Tailor', costMilli: 1_000_000 }]), '1 resume: 1 x Fully Tailor @ $1,000 = $1,000');
  // The same mode at two prices - repriced between two charges - is two groups.
  assert.equal(
    describeCharge([
      { label: 'Partial Tailor', costMilli: 10 },
      { label: 'Partial Tailor', costMilli: 30 },
    ]),
    '2 resumes: 1 x Partial Tailor @ $0.01, 1 x Partial Tailor @ $0.03 = $0.04'
  );
  // Seven resumes at $0.023 are exactly $0.161: an integer sum, every time.
  assert.equal(
    describeCharge(Array.from({ length: 7 }, () => ({ label: 'Fully Tailor', costMilli: 23 }))),
    '7 resumes: 7 x Fully Tailor @ $0.023 = $0.161'
  );
});

/* -------------------------------------------------------- the preview token */

function signedToken(claims, secretHex) {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

test('a preview token names the mode, the account and the resume it was issued for, and nothing else is believed', () => {
  fresh('tokens');
  const { issuePreviewToken, readPreviewToken } = previewTokens;
  const owner = { userId: 'user-a', resumeId: 'r-1' };

  for (const buildMode of modes.BUILD_MODES) {
    assert.equal(readPreviewToken(issuePreviewToken({ ...owner, buildMode }), owner), buildMode, buildMode);
  }

  const token = issuePreviewToken({ ...owner, buildMode: 'partial' });
  assert.equal(readPreviewToken(token, { userId: 'user-b', resumeId: 'r-1' }), null, 'another account');
  assert.equal(readPreviewToken(token, { userId: 'user-a', resumeId: 'r-2' }), null, 'another resume');
  // It survives a restart: the secret is kept in the settings table.
  assert.equal(loadFresh('../dist/services/credits/previewToken').readPreviewToken(token, owner), 'partial');

  // A day, to the millisecond; and a clock that is a minute ahead is tolerated, no more.
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = 1_700_000_000_000;
  const dated = issuePreviewToken({ ...owner, buildMode: 'full' }, T0);
  assert.equal(readPreviewToken(dated, owner, T0 + DAY), 'full');
  assert.equal(readPreviewToken(dated, owner, T0 + DAY + 1), null, 'expired');
  assert.equal(readPreviewToken(dated, owner, T0 - 60_000), 'full');
  assert.equal(readPreviewToken(dated, owner, T0 - 60_001), null, 'from the future');

  // Forged: another mode under the real signature, a flipped signature, the wrong shape.
  const [payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(claims).sort(), ['b', 'r', 't', 'u']);
  const swapped = Buffer.from(JSON.stringify({ ...claims, b: 'full' }), 'utf8').toString('base64url');
  assert.equal(readPreviewToken(`${swapped}.${signature}`, owner), null, 'a mode the signature never covered');
  assert.equal(readPreviewToken(`${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`, owner), null);
  for (const junk of [`${token}.extra`, payload, `.${signature}`, `${payload}.`, '', 'a.b', 'x'.repeat(3000), undefined, null, 12, {}, ['a.b']]) {
    assert.equal(readPreviewToken(junk, owner), null, String(junk).slice(0, 40));
  }

  // Signed with the real secret: only the current shape, with a real mode, is read.
  const secret = require('../dist/database/settingsRepository').getSetting('preview-token-secret');
  assert.match(secret, /^[0-9a-f]{64}$/);
  const now = Date.now();
  assert.equal(readPreviewToken(signedToken({ u: 'user-a', r: 'r-1', b: 'full', t: now }, secret), owner), 'full', 'the helper signs as the server does');
  for (const [why, bad] of [
    ['an old token, which named a model', { u: 'user-a', p: 'r-1', m: 'claude-cli-sonnet', t: now }],
    ['a mode that is not one', { u: 'user-a', r: 'r-1', b: 'everything', t: now }],
    ['no mode', { u: 'user-a', r: 'r-1', t: now }],
    ['a time that is text', { u: 'user-a', r: 'r-1', b: 'full', t: String(now) }],
    ['no time', { u: 'user-a', r: 'r-1', b: 'full' }],
  ]) {
    assert.equal(readPreviewToken(signedToken(bad, secret), owner), null, why);
  }
  assert.equal(
    readPreviewToken(signedToken({ u: 'user-a', r: 'r-1', b: 'full', t: now }, crypto.randomBytes(32).toString('hex')), owner),
    null,
    'another secret'
  );
});

/* ------------------------------------------------------------ priceRun */

const PLAN_MATCH = { v: 1, mode: 'partial', reason: 'only', candidates: 1 };
const planOf = (...ids) => ids.map((id, jobIndex) => ({ jobIndex, resume: { id }, match: PLAN_MATCH }));
const WRITTEN = { summary: 'Written by the model.', hardSkills: [], softSkills: [], experience: [] };

function priceRun(args) {
  return choice.priceRun({ suppliedContent: {}, previewTokens: {}, userId: 'user-a', admin: false, ...args });
}

test('priceRun: a resume costs its mode\'s price, summed as integers', () => {
  fresh('price-run-plain');
  const prices = { suitable: 5, partial: 20, full: 7 };
  for (const mode of modes.BUILD_MODES) {
    const { costs, totalMilli } = priceRun({ plan: planOf('r-1', 'r-2', 'r-3'), mode, prices });
    assert.deepEqual(costs, [prices[mode], prices[mode], prices[mode]], mode);
    assert.equal(totalMilli, 3 * prices[mode], mode);
  }
  assert.deepEqual(priceRun({ plan: [], mode: 'full', prices }), { costs: [], totalMilli: 0 });
  // Seven at $0.023 are exactly $0.161; a thousand at the ceiling are exactly a million dollars.
  assert.equal(priceRun({ plan: planOf(...'abcdefg'), mode: 'full', prices: { suitable: 0, partial: 0, full: 23 } }).totalMilli, 161);
  assert.equal(
    priceRun({ plan: planOf(...Array.from({ length: 1000 }, (_, i) => `r-${i}`)), mode: 'partial', prices: { suitable: 0, partial: 1_000_000, full: 0 } }).totalMilli,
    1_000_000_000
  );
  // A free mode is free.
  assert.deepEqual(priceRun({ plan: planOf('r-1', 'r-2'), mode: 'partial', prices: { suitable: 0, partial: 0, full: 0 } }).costs, [0, 0]);
});

test('priceRun: supplied content is the run mode\'s price only when a token vouches for it, else the dearest of the mode, Partial and Fully', () => {
  fresh('price-run-content');
  const { issuePreviewToken } = previewTokens;
  const token = (resumeId, buildMode, userId = 'user-a', now) => issuePreviewToken({ userId, resumeId, buildMode }, now);
  const prices = { suitable: 5, partial: 20, full: 7 };

  // A Fully Tailor run over r-1 (valid Fully token), r-2 (a Partial token: not this mode's work) and r-3 (no content).
  let result = priceRun({
    plan: planOf('r-1', 'r-2', 'r-3'),
    mode: 'full',
    prices,
    suppliedContent: { 'r-1': WRITTEN, 'r-2': WRITTEN },
    previewTokens: { 'r-1': token('r-1', 'full'), 'r-2': token('r-2', 'partial') },
  });
  assert.deepEqual(result.costs, [7, 20, 7], 'the token binds the mode; the floor is Partial\'s $0.020 here');
  assert.equal(result.totalMilli, 34);

  // Everything that is not a token valid for (this account, this resume, this mode) gets the floor.
  const DAY = 24 * 60 * 60 * 1000;
  const stale = Date.now() - DAY - 60_000;
  for (const [why, tokens] of [
    ['no token', {}],
    ['a forged one', { 'r-1': `${token('r-1', 'full').split('.')[0]}.forged` }],
    ['another resume\'s', { 'r-1': token('r-2', 'full') }],
    ['another account\'s', { 'r-1': token('r-1', 'full', 'user-b') }],
    ['another mode\'s', { 'r-1': token('r-1', 'partial') }],
    ['an expired one', { 'r-1': token('r-1', 'full', 'user-a', stale) }],
    ['junk', { 'r-1': 'not-a-token' }],
  ]) {
    result = priceRun({ plan: planOf('r-1'), mode: 'full', prices, suppliedContent: { 'r-1': WRITTEN }, previewTokens: tokens });
    assert.deepEqual(result.costs, [20], why);
  }
  // Tokens without the content they vouch for charge nothing extra.
  assert.deepEqual(
    priceRun({ plan: planOf('r-1'), mode: 'full', prices, previewTokens: { 'r-1': token('r-1', 'partial') } }).costs,
    [7]
  );
  // A resume id that is a property of every object is not content.
  assert.deepEqual(priceRun({ plan: planOf('toString', 'constructor'), mode: 'full', prices, suppliedContent: { r: WRITTEN } }).costs, [7, 7]);

  // Administrators are charged nothing, and never held to the floor: their figure is the mode's own.
  result = priceRun({ plan: planOf('r-1', 'r-2'), mode: 'full', prices, suppliedContent: { 'r-1': WRITTEN }, admin: true });
  assert.deepEqual(result.costs, [7, 7]);
});

test('priceRun: whichever mode is dearest sets the floor, for every mode and every set of prices', () => {
  fresh('price-run-floor');
  const { issuePreviewToken } = previewTokens;
  for (const prices of [
    { suitable: 0, partial: 0, full: 0 },
    { suitable: 5, partial: 20, full: 7 },
    { suitable: 5, partial: 10, full: 23 },
    { suitable: 1_000_000, partial: 1, full: 1 },
    { suitable: 3, partial: 3, full: 3 },
    { suitable: 0, partial: 0, full: 23 },
  ]) {
    for (const mode of modes.BUILD_MODES) {
      const floor = Math.max(prices[mode], prices.partial, prices.full);
      const vouched = priceRun({
        plan: planOf('r-1'),
        mode,
        prices,
        suppliedContent: { 'r-1': WRITTEN },
        previewTokens: { 'r-1': issuePreviewToken({ userId: 'user-a', resumeId: 'r-1', buildMode: mode }) },
      });
      const unvouched = priceRun({ plan: planOf('r-1'), mode, prices, suppliedContent: { 'r-1': WRITTEN } });
      const admin = priceRun({ plan: planOf('r-1'), mode, prices, suppliedContent: { 'r-1': WRITTEN }, admin: true });
      const label = `${mode} at ${JSON.stringify(prices)}`;
      assert.deepEqual(vouched.costs, [prices[mode]], `${label}: a token for this mode`);
      assert.deepEqual(unvouched.costs, [floor], `${label}: content nobody vouches for`);
      assert.ok(unvouched.costs[0] >= vouched.costs[0], label);
      assert.ok(unvouched.costs[0] >= prices.partial && unvouched.costs[0] >= prices.full, `${label}: never below a tailoring mode`);
      assert.deepEqual(admin.costs, [prices[mode]], `${label}: an administrator`);
    }
  }
  // So a FREE mode's content of unknown origin still pays the dearest tailoring.
  assert.deepEqual(
    priceRun({ plan: planOf('r-1'), mode: 'partial', prices: { suitable: 0, partial: 0, full: 23 }, suppliedContent: { 'r-1': WRITTEN } }).costs,
    [23]
  );
});

/* ----------------------------------------------------------- the routes */

const GENERIC = "That model isn't available. Choose another, or contact your administrator.";

/** The three prices, in thousandths: distinct, and Fully cheaper than Partial, so a figure names its mode. */
const PRICES = { suitable: 3, partial: 20, full: 7 };
const PRICES_USD = { suitable: '0.003', partial: '0.020', full: '0.007' };

function resumeInput(id, name, extra = {}) {
  return {
    id,
    name,
    title: 'Engineer',
    skills: ['C#'],
    contact: { email: 'a@b.c', phone: '1', location: 'X' },
    summary: 's',
    experience: [],
    strengths: [],
    education: [],
    ...extra,
  };
}

function jobsFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    companyName: `Company ${index}`,
    role: 'Engineer',
    jobDescription: 'A job description long enough to be analysed. '.repeat(4),
  }));
}

/**
 * The routes, with no template in the temp static directory: every task fails
 * at its template, after the charge and before any model call, which is what
 * lets these follow the money through a real run with nothing spawned.
 */
async function serve(name, prices = PRICES_USD) {
  const dirs = fresh(`routes-${name}`);
  useAdminEmails('admin@example.com');
  clearModelOptionOverrides();
  queueModule.resetGenerationQueueForTests();

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const tokens = { admin: users.createSession(admin.id), alice: users.createSession(alice.id) };

  // Two people for Alice, one for the administrator: a run builds ONE of them.
  const ada = seedProfileWithResumes(alice, 'Ada', [resumeInput('p-ada', 'Ada')]).profileId;
  const bea = seedProfileWithResumes(alice, 'Bea', [resumeInput('p-bea', 'Bea')]).profileId;
  const cy = seedProfileWithResumes(admin, 'Cy', [resumeInput('p-cy', 'Cy')]).profileId;

  await config.updateAppSettings({
    suitablePriceUsd: prices.suitable,
    partialPriceUsd: prices.partial,
    fullPriceUsd: prices.full,
  });

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/generation', require('../dist/routes/generation').default);
  const server = app.listen(0);
  const port = server.address().port;

  const post = async (who, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A route that does not exist answers Express's HTML 404.
    }
    return { status: response.status, body: parsed };
  };

  return {
    ...dirs,
    post,
    admin,
    alice,
    profiles: { ada, bea, cy },
    balance: (account) => users.getUserById(account.id).balanceMilli,
    ledger: (account, reason) =>
      credits.getLedger(account.id, 500).filter((entry) => !reason || entry.reason === reason),
    close: () => {
      server.close();
      queueModule.resetGenerationQueueForTests();
    },
  };
}

async function untilFinished(batchId) {
  const queue = queueModule.getGenerationQueue();
  for (let i = 0; i < 300; i += 1) {
    const snapshot = queue.snapshot(batchId);
    if (snapshot && snapshot.state !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`batch ${batchId} did not finish`);
}

const sum = (entries) => entries.reduce((total, entry) => total + entry.deltaMilli, 0);

test('the quote is jobs x the mode\'s price, a submission charges exactly the quote, and each failed resume gives back its own price', async () => {
  const s = await serve('quote-charge');
  try {
    credits.setBalance(s.alice.id, 10_000, s.admin.id);
    const orders = require('../dist/database/orderRepository');

    // A model never changes a price: models carry none.
    for (const model of [undefined, 'claude-cli-opus', 'codex-cli-default', 'gemini-cli-auto']) {
      const quoted = await s.post('alice', '/generation/quote', {
        jobs: jobsFor(1),
        profileId: s.profiles.ada,
        buildMode: 'partial',
        ...(model ? { model } : {}),
      });
      assert.equal(quoted.status, 200, String(model));
      assert.equal(quoted.body.costMilli, 20, String(model));
    }

    for (const buildMode of modes.BUILD_MODES) {
      const body = { jobs: jobsFor(3), profileId: s.profiles.ada, buildMode };
      const quote = await s.post('alice', '/generation/quote', body);
      assert.equal(quote.status, 200, buildMode);
      assert.deepEqual(
        quote.body,
        { resumes: 3, costMilli: 3 * PRICES[buildMode], pricePerResumeMilli: PRICES[buildMode], balanceMilli: 10_000, exempt: false, buildMode },
        buildMode
      );
      const before = s.ledger(s.alice, 'generation-reserve').length;
      assert.equal(s.balance(s.alice), 10_000, 'a quote reserves nothing');
      const submitted = await s.post('alice', '/generation/batches', { ...body, ...(buildMode === 'partial' ? { mode: 'order' } : {}) });
      assert.equal(submitted.status, 202, `${buildMode}: ${JSON.stringify(submitted.body)}`);
      assert.equal(submitted.body.buildMode, buildMode);
      assert.equal(submitted.body.total, 3);

      // The charge is the quote, in one reservation whose line is by mode.
      const reserves = s.ledger(s.alice, 'generation-reserve');
      assert.equal(reserves.length, before + 1, buildMode);
      assert.equal(reserves[0].deltaMilli, -quote.body.costMilli, `${buildMode}: charged exactly what was quoted`);
      assert.equal(
        reserves[0].note,
        `3 resumes: 3 x ${modes.BUILD_MODE_LABELS[buildMode]} @ ${{ suitable: '$0.003', partial: '$0.02', full: '$0.007' }[buildMode]} = ${{ suitable: '$0.009', partial: '$0.06', full: '$0.021' }[buildMode]}`
      );

      // Every task carries the price it was charged and the mode it was charged at.
      const batch = queueModule.getGenerationQueue().getBatch(submitted.body.batchId);
      assert.equal(batch.shared.buildMode, buildMode);
      for (const task of batch.tasks) {
        assert.equal(task.payload.costMilli, PRICES[buildMode], buildMode);
        assert.equal(task.payload.buildMode, buildMode, buildMode);
        assert.equal('costMilli' in task.payload.choice, false, 'the price is not part of the model choice');
      }
      if (buildMode === 'partial') {
        assert.deepEqual(
          orders.listOrderItems(submitted.body.orderId).map((item) => item.costMilli),
          [20, 20, 20],
          "the order's items keep their own price, for after the batch is gone"
        );
      }

      // No template here, so every resume fails - and gives back its own price.
      await untilFinished(submitted.body.batchId);
      assert.equal(s.balance(s.alice), 10_000, `${buildMode}: refunded in full`);
    }
    assert.equal(sum(s.ledger(s.alice, 'generation-reserve')), -3 * (3 + 20 + 7));
    assert.equal(sum(s.ledger(s.alice, 'generation-refund')), 3 * (3 + 20 + 7));
    assert.deepEqual(
      s.ledger(s.alice, 'generation-refund').map((entry) => entry.deltaMilli).sort((a, b) => a - b),
      [3, 3, 3, 7, 7, 7, 20, 20, 20],
      'one refund per failed resume, each its own price'
    );
  } finally {
    s.close();
  }
});

test('a run that names no mode runs in the administrator\'s default mode, at that mode\'s price; a price edit applies to the next quote', async () => {
  const s = await serve('default-mode');
  try {
    credits.setBalance(s.alice.id, 1_000, s.admin.id);
    const body = { jobs: jobsFor(2), profileId: s.profiles.bea };

    let quote = await s.post('alice', '/generation/quote', body);
    assert.deepEqual([quote.body.buildMode, quote.body.costMilli], ['partial', 40], 'the code default');

    await config.updateAppSettings({ defaultBuildMode: 'full' });
    quote = await s.post('alice', '/generation/quote', body);
    assert.deepEqual([quote.body.buildMode, quote.body.costMilli, quote.body.pricePerResumeMilli], ['full', 14, 7]);
    quote = await s.post('alice', '/generation/quote', { ...body, buildMode: 'suitable' });
    assert.deepEqual([quote.body.buildMode, quote.body.costMilli], ['suitable', 6], 'a mode in the body beats the default');

    const submitted = await s.post('alice', '/generation/batches', body);
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    assert.equal(submitted.body.buildMode, 'full');
    assert.equal(s.ledger(s.alice, 'generation-reserve')[0].deltaMilli, -14);
    await untilFinished(submitted.body.batchId);

    await config.updateAppSettings({ fullPriceUsd: '0.5' });
    quote = await s.post('alice', '/generation/quote', body);
    assert.equal(quote.body.costMilli, 1_000, 'the next quote follows the price in effect now');
    assert.equal(quote.body.pricePerResumeMilli, 500);
  } finally {
    s.close();
  }
});

test('a batch the balance cannot cover by a thousandth is a 402 naming the whole sum, and nothing is queued or taken; the exact balance runs', async () => {
  const s = await serve('402');
  try {
    credits.setBalance(s.alice.id, 59, s.admin.id);
    const body = { jobs: jobsFor(3), profileId: s.profiles.ada, buildMode: 'partial' };
    const refused = await s.post('alice', '/generation/batches', body);
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, 'insufficient-credits');
    assert.equal(refused.body.neededMilli, 60);
    assert.equal(refused.body.balanceMilli, 59);
    assert.match(refused.body.error, /needs \$0\.06 of credit and the account has \$0\.059/);
    assert.equal(s.balance(s.alice), 59);
    assert.deepEqual(s.ledger(s.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);

    credits.setBalance(s.alice.id, 60, s.admin.id);
    const submitted = await s.post('alice', '/generation/batches', body);
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    assert.equal(s.ledger(s.alice, 'generation-reserve')[0].deltaMilli, -60);
    await untilFinished(submitted.body.batchId);
    assert.equal(s.balance(s.alice), 60, 'and the failures gave it all back');
  } finally {
    s.close();
  }
});

test('administrators are quoted the full amount and told they are exempt; they are charged nothing, with or without previewed content', async () => {
  const s = await serve('admin');
  try {
    credits.setBalance(s.admin.id, 1, s.admin.id);
    const body = { jobs: jobsFor(3), profileId: s.profiles.cy, buildMode: 'full' };
    const quote = await s.post('admin', '/generation/quote', body);
    assert.deepEqual(quote.body, { resumes: 3, costMilli: 21, pricePerResumeMilli: 7, balanceMilli: 1, exempt: true, buildMode: 'full' });

    // Not held to the floor either: content nobody vouches for is quoted the mode's own price.
    const withContent = await s.post('admin', '/generation/quote', { ...body, tailoredContentByResumeId: { 'p-cy': WRITTEN } });
    assert.equal(withContent.body.costMilli, 21);
    assert.equal(withContent.body.exempt, true);

    const submitted = await s.post('admin', '/generation/batches', body);
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    await untilFinished(submitted.body.batchId);
    assert.equal(s.balance(s.admin), 1, '$0.001, untouched by a $0.021 run');
    assert.deepEqual(s.ledger(s.admin).filter((entry) => entry.reason.startsWith('generation')), []);
  } finally {
    s.close();
  }
});

test('a free mode takes nothing, writes nothing and runs on an empty balance, while the other modes stay priced', async () => {
  const s = await serve('free-mode');
  try {
    await config.updateAppSettings({ partialPriceUsd: '0' });
    const body = { jobs: jobsFor(2), profileId: s.profiles.bea };

    const quote = await s.post('alice', '/generation/quote', { ...body, buildMode: 'partial' });
    assert.deepEqual(quote.body, { resumes: 2, costMilli: 0, pricePerResumeMilli: 0, balanceMilli: 0, exempt: false, buildMode: 'partial' });
    const submitted = await s.post('alice', '/generation/batches', { ...body, buildMode: 'partial', mode: 'order' });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    const items = require('../dist/database/orderRepository').listOrderItems(submitted.body.orderId);
    assert.deepEqual(items.map((item) => item.costMilli), [0, 0]);
    await untilFinished(submitted.body.batchId);
    assert.deepEqual(
      s.ledger(s.alice).filter((entry) => entry.reason.startsWith('generation')),
      [],
      'no reservation, no refund'
    );

    // Fully Tailor is still $0.007 a resume: an empty balance cannot pay it.
    assert.equal((await s.post('alice', '/generation/quote', { ...body, buildMode: 'full' })).body.costMilli, 14);
    const refused = await s.post('alice', '/generation/batches', { ...body, buildMode: 'full' });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.neededMilli, 14);

    // Every mode free: a quote of $0 a resume.
    await config.updateAppSettings({ suitablePriceUsd: 0, fullPriceUsd: '0.000' });
    for (const buildMode of modes.BUILD_MODES) {
      const free = await s.post('alice', '/generation/quote', { ...body, buildMode });
      assert.deepEqual([free.body.costMilli, free.body.pricePerResumeMilli], [0, 0], buildMode);
    }
  } finally {
    s.close();
  }
});

test('finalising a preview: the token binds the mode, content nobody vouches for pays the dearest of the mode, Partial and Fully, and the line is by the run\'s mode', async () => {
  const s = await serve('finalize');
  const { issuePreviewToken } = previewTokens;
  try {
    credits.setBalance(s.alice.id, 10_000, s.admin.id);
    const issue = (resumeId, buildMode, userId = s.alice.id, now) => issuePreviewToken({ userId, resumeId, buildMode }, now);
    const priced = async (extra) => {
      const quote = await s.post('alice', '/generation/quote', {
        jobs: jobsFor(2),
        profileId: s.profiles.bea,
        tailoredContentByResumeId: { 'p-bea': WRITTEN },
        ...extra,
      });
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      return quote.body.costMilli;
    };
    const tokenFor = (previewToken) => ({ previewTokenByResumeId: { 'p-bea': previewToken } });

    // Partial costs $0.020 and Fully $0.007 here: Fully content nobody vouches for costs Partial's.
    assert.equal(await priced({ buildMode: 'full', ...tokenFor(issue('p-bea', 'full')) }), 14, 'written in this mode');
    for (const [why, previewToken] of [
      ['no token', undefined],
      ['a token for the other mode', issue('p-bea', 'partial')],
      ['a token for another resume', issue('p-ada', 'full')],
      ['another account\'s token', issue('p-bea', 'full', s.admin.id)],
      ['an expired token', issue('p-bea', 'full', s.alice.id, Date.now() - 25 * 60 * 60 * 1000)],
      ['a forged token', `${issue('p-bea', 'full').split('.')[0]}.forged`],
    ]) {
      assert.equal(await priced({ buildMode: 'full', ...(previewToken ? tokenFor(previewToken) : {}) }), 40, why);
    }
    // Tokens without the content they vouch for add nothing: an ordinary run.
    const bare = { jobs: jobsFor(2), profileId: s.profiles.bea, buildMode: 'full', previewTokenByResumeId: { 'p-bea': issue('p-bea', 'partial') } };
    assert.equal((await s.post('alice', '/generation/quote', bare)).body.costMilli, 14);
    assert.deepEqual(s.ledger(s.alice, 'generation-reserve'), [], 'a quote charges nothing');

    // The submission charges the same, and its line names the run's mode at the price charged.
    const run = { jobs: jobsFor(2), profileId: s.profiles.bea, buildMode: 'full', tailoredContentByResumeId: { 'p-bea': WRITTEN } };
    const vouched = await s.post('alice', '/generation/batches', { ...run, ...tokenFor(issue('p-bea', 'full')) });
    assert.equal(vouched.status, 202, JSON.stringify(vouched.body));
    assert.equal(s.ledger(s.alice, 'generation-reserve')[0].note, '2 resumes: 2 x Fully Tailor @ $0.007 = $0.014');
    await untilFinished(vouched.body.batchId);

    const unvouched = await s.post('alice', '/generation/batches', run);
    assert.equal(unvouched.status, 202, JSON.stringify(unvouched.body));
    assert.equal(s.ledger(s.alice, 'generation-reserve')[0].deltaMilli, -40);
    assert.equal(s.ledger(s.alice, 'generation-reserve')[0].note, '2 resumes: 2 x Fully Tailor @ $0.02 = $0.04');
    const batch = queueModule.getGenerationQueue().getBatch(unvouched.body.batchId);
    assert.deepEqual(batch.tasks.map((task) => task.payload.costMilli), [20, 20], 'each task is refunded what it was charged');
    await untilFinished(unvouched.body.batchId);
    assert.equal(s.balance(s.alice), 10_000);

    // Now Fully is the dearer: Partial content nobody vouches for pays Fully's price.
    await config.updateAppSettings({ partialPriceUsd: '0.010', fullPriceUsd: '0.023' });
    assert.equal(await priced({ buildMode: 'partial', ...tokenFor(issue('p-bea', 'partial')) }), 20);
    assert.equal(await priced({ buildMode: 'partial', ...tokenFor(issue('p-bea', 'full')) }), 46);
    assert.equal(await priced({ buildMode: 'partial' }), 46);

    // Choose Suitable Resume builds each resume as written: it takes no content, and no token.
    for (const extra of [{ tailoredContentByResumeId: { 'p-bea': WRITTEN } }, tokenFor(issue('p-bea', 'partial'))]) {
      const refused = await s.post('alice', '/generation/batches', { jobs: jobsFor(1), profileId: s.profiles.bea, buildMode: 'suitable', ...extra });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.code, 'suitable-takes-no-content');
    }
    assert.equal(s.ledger(s.alice, 'generation-reserve').length, 2, 'the refusals charged nothing');
  } finally {
    s.close();
  }
});

test('a run that is refused for what it asks costs nothing: it is refused before anything is reserved', async () => {
  const s = await serve('refused');
  try {
    credits.setBalance(s.alice.id, 1_000, s.admin.id);
    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    const jobs = jobsFor(2);
    const ada = s.profiles.ada;
    const bea = s.profiles.bea;
    for (const [who, body, status, code] of [
      ['alice', { jobs, profileId: s.profiles.cy }, 404, 'profile-not-found'],
      ['admin', { jobs, profileId: ada }, 404, 'profile-not-found'],
      ['alice', { jobs, profileId: 'no-such-profile' }, 404, 'profile-not-found'],
      ['alice', { jobs }, 400, 'one-profile-per-run'],
      ['alice', { jobs, profileIds: [ada, bea] }, 400, 'one-profile-per-run'],
      ['alice', { jobs, profileId: ada, resumeIds: ['p-ada'] }, 400, 'one-profile-per-run'],
      ['alice', { jobs, profileId: ada, buildMode: 'lazy' }, 400, 'bad-build-mode'],
      ['alice', { jobs, profileId: ada, buildMode: 'suitable', previewTokenByResumeId: { 'p-ada': 'x' } }, 400, 'suitable-takes-no-content'],
      // The page previewed another of the person's resumes than this run would build.
      ['alice', { jobs, profileId: bea, previewedResumeId: 'p-ada' }, 409, 'preview-changed'],
      ['alice', { jobs, profileId: ada, model: 'claude-cli-haiku' }, 400, 'model-unavailable'],
    ]) {
      // The quote makes the same refusals - it is lenient only about the jobs -
      // except that it plans nothing, so it cannot find a preview out of date.
      const routes = code === 'preview-changed' ? ['/generation/batches'] : ['/generation/batches', '/generation/quote'];
      for (const route of routes) {
        const reply = await s.post(who, route, body);
        assert.equal(reply.status, status, `${route} ${JSON.stringify(body)}: ${JSON.stringify(reply.body)}`);
        assert.equal(reply.body.code, code, `${route} ${JSON.stringify(body)}`);
        if (code === 'preview-changed') {
          assert.match(reply.body.error, /^Bea's resumes have changed since the preview: this run would now build .+\. Preview again\.$/);
          assert.equal(reply.body.resumeId, 'p-bea');
        }
      }
    }
    const model = await s.post('alice', '/generation/batches', { jobs, profileId: ada, model: 'claude-cli-haiku' });
    assert.equal(model.body.error, GENERIC);
    assert.equal(s.balance(s.alice), 1_000);
    assert.deepEqual(s.ledger(s.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
  } finally {
    s.close();
  }
});

test('a run is never priced from nothing: when the settings cannot be read it is refused and charges nothing', async () => {
  const s = await serve('unreadable');
  try {
    credits.setBalance(s.alice.id, 1_000, s.admin.id);
    writeSettingRaw(s.dbDir, APP_SETTINGS_KEY, '{ invalid json');
    config.invalidateSettingsCache();
    for (const route of ['/generation/quote', '/generation/batches']) {
      const reply = await s.post('alice', route, { jobs: jobsFor(2), profileId: s.profiles.ada, buildMode: 'partial' });
      assert.ok(reply.status >= 400, `${route} answered ${reply.status}, not a price of $0`);
    }
    assert.equal(s.balance(s.alice), 1_000);
    assert.deepEqual(s.ledger(s.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
  } finally {
    s.close();
  }
});

/* ---------------------------------------------------------- the queue's refunds */

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(condition, what, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

test('the queue refunds what each failed task was charged, read from its payload and never re-priced', async () => {
  const { admin, alice } = creditSetup('queue-snapshot');
  process.env.AI_CLI_CONCURRENCY = '1';
  try {
    queueModule.resetGenerationQueueForTests();
    const { registerTaskRunner, newBatchId } = require('../dist/services/queue/taskQueue');
    const kind = 'pricing-stub';
    registerTaskRunner(kind, async (payload) => {
      if (payload.fail) throw new Error('no');
      return 'ok';
    });

    credits.setBalance(alice.id, 1_000, admin.id);
    // The mode is repriced after the run was charged: nothing it refunds moves.
    await config.updateAppSettings({ partialPriceUsd: '0.5', fullPriceUsd: '0.5' });
    const batchId = newBatchId();
    // 23 + 40, plus a payload from before credits were dollars: it was paid
    // for in credits the reset cleared, so it adds nothing here and refunds
    // nothing.
    credits.reserveCredits(users.getUserById(alice.id), 63, { kind: 'batch', id: batchId });
    const task = (label, payload) => ({
      queue: 'cli',
      label: { resumeId: label, resumeName: label, companyName: 'Acme', role: 'SWE' },
      kind,
      payload: { label, ...payload },
    });
    const queue = queueModule.getGenerationQueue();
    queue.submit(
      [
        task('dear-fails', { costMilli: 23, buildMode: 'full', fail: true }),
        task('dearer-delivers', { costMilli: 40, buildMode: 'partial' }),
        task('pre-dollars-fails', { creditCost: 1, fail: true }),
      ],
      { id: batchId }
    );
    await queue.refreshCapacity();
    await until(() => queue.snapshot(batchId)?.state !== 'running', 'the batch to finish');
    await settle();

    // $1.000 - $0.063 + $0.023: the delivered resume's $0.040 is spent, and
    // the one from before dollars gives back nothing.
    assert.equal(users.getUserById(alice.id).balanceMilli, 960);
    const refunds = credits
      .getLedger(alice.id)
      .filter((entry) => entry.reason === 'generation-refund')
      .map((entry) => entry.deltaMilli);
    assert.deepEqual(refunds, [23]);
    assert.equal(credits.getReservation(batchId).state, 'closed');

    assert.equal(queueModule.taskCostMilli({ costMilli: 0 }), 0);
    assert.equal(queueModule.taskCostMilli({ costMilli: 23 }), 23);
    // A payload from before dollars, or none at all: nothing - never its
    // whole-credit figure read as thousandths.
    assert.equal(queueModule.taskCostMilli({}), 0);
    assert.equal(queueModule.taskCostMilli({ creditCost: 3 }), 0);
    assert.equal(queueModule.taskCostMilli({ costMilli: -2 }), 0, 'a nonsense snapshot refunds nothing');
    assert.equal(queueModule.taskCostMilli({ costMilli: 22.6 }), 0, 'never floored into a refund');
    assert.equal(queueModule.taskCostMilli(null), 0);
  } finally {
    delete process.env.AI_CLI_CONCURRENCY;
    queueModule.resetGenerationQueueForTests();
  }
});

/** A batch as the queue wrote it to disk before a restart: its tasks name a resume and a job by id. */
function storeRunningBatch(batchId, ownerId, rows) {
  const store = require('../dist/database/generationRepository');
  const choiceOf = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'claude-cli-sonnet', modelLabel: 'Claude Sonnet' };
  store.saveBatchWithTasks(
    {
      id: batchId,
      state: 'running',
      data: {
        label: 'Queued before the restart',
        jobCount: 1,
        shared: { jobs: [{ companyName: 'Acme', role: 'SWE', jobDescription: '' }], ownerId },
        createdAt: Date.now(),
      },
    },
    rows.map(({ id, seq, resumeId, payload }) => ({
      id,
      batchId,
      seq,
      state: 'queued',
      data: {
        queue: 'cli',
        label: { resumeId, resumeName: 'Ada', companyName: `Co ${seq}`, role: 'SWE' },
        kind: 'resume',
        payload: { batchId, resumeId, jobIndex: 0, choice: choiceOf, ...payload },
      },
    }))
  );
}

test('a restored task keeps the price and the mode it was charged at, whatever the mode costs now', async () => {
  // Queued with a snapshot of $0.040 in Fully Tailor, then both tailoring modes
  // were repriced to $0.090. The restore must not move its price with the
  // setting, or the refund would hand back money never taken.
  const { admin, alice } = creditSetup('restore');
  try {
    await config.updateAppSettings({ partialPriceUsd: '0.090', fullPriceUsd: '0.090' });
    credits.setBalance(alice.id, 1_000, admin.id);
    credits.reserveCredits(users.getUserById(alice.id), 40, { kind: 'batch', id: 'bat_restore' });
    storeRunningBatch('bat_restore', alice.id, [
      { id: 'tsk_priced', seq: 0, resumeId: 'p-ada', payload: { costMilli: 40, buildMode: 'full' } },
      // Queued before v4.2: no price, no mode.
      { id: 'tsk_legacy', seq: 1, resumeId: 'p-ada', payload: {} },
    ]);

    queueModule.resetGenerationQueueForTests();
    const seen = [];
    const queue = queueModule.getGenerationQueue();
    queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async (payload) => {
      seen.push({ model: payload.choice.modelId, costMilli: payload.costMilli, buildMode: payload.buildMode });
      throw new Error('the build failed');
    });

    await queueModule.restoreGenerationQueue();
    await until(() => queue.snapshot('bat_restore')?.state !== 'running', 'the restored batch to finish');
    await settle();

    assert.deepEqual(
      seen.sort((a, b) => String(a.costMilli).localeCompare(String(b.costMilli))),
      [
        { model: 'claude-cli-sonnet', costMilli: 40, buildMode: 'full' },
        { model: 'claude-cli-sonnet', costMilli: undefined, buildMode: undefined },
      ],
      'the snapshot and the mode carried, not re-priced and not invented'
    );
    // $1.000 - $0.040 + $0.040: what was charged comes back, not the mode's
    // $0.090 - and a task with no snapshot adds nothing.
    assert.equal(users.getUserById(alice.id).balanceMilli, 1_000);
    assert.deepEqual(
      credits.getLedger(alice.id).filter((entry) => entry.reason === 'generation-refund').map((entry) => entry.deltaMilli),
      [40]
    );
  } finally {
    queueModule.resetGenerationQueueForTests();
  }
});

test('a chosen resume deleted before its turn fails its task and refunds that task\'s own price, whatever the mode costs now', async () => {
  const { admin, alice } = creditSetup('resume-gone');
  try {
    await config.updateAppSettings({ suitablePriceUsd: '0.5', partialPriceUsd: '0.5', fullPriceUsd: '0.5' });
    credits.setBalance(alice.id, 1_000, admin.id);
    credits.reserveCredits(users.getUserById(alice.id), 33, { kind: 'batch', id: 'bat_gone' });
    // No resume 'p-missing' exists: the REAL runner meets it, so no stub is registered.
    storeRunningBatch('bat_gone', alice.id, [
      { id: 'tsk_full', seq: 0, resumeId: 'p-missing', payload: { costMilli: 23, buildMode: 'full' } },
      { id: 'tsk_partial', seq: 1, resumeId: 'p-missing', payload: { costMilli: 10, buildMode: 'partial' } },
      { id: 'tsk_legacy', seq: 2, resumeId: 'p-missing', payload: {} },
    ]);

    queueModule.resetGenerationQueueForTests();
    const queue = queueModule.getGenerationQueue();
    await queueModule.restoreGenerationQueue();
    await until(() => queue.snapshot('bat_gone')?.state !== 'running', 'the restored batch to finish');
    await settle();

    const tasks = queue.getBatch('bat_gone').tasks;
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every((entry) => entry.state === 'failed'), tasks.map((entry) => entry.state).join(','));
    for (const entry of tasks) assert.match(entry.error, /This resume was deleted before it could be built\./);
    const refunds = credits
      .getLedger(alice.id)
      .filter((entry) => entry.reason === 'generation-refund')
      .map((entry) => entry.deltaMilli)
      .sort((a, b) => a - b);
    assert.deepEqual(refunds, [10, 23], 'each its own price; the task with no snapshot adds nothing');
    assert.equal(users.getUserById(alice.id).balanceMilli, 1_000, 'all that was reserved is back');
  } finally {
    queueModule.resetGenerationQueueForTests();
  }
});
