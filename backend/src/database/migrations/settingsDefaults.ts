import path from 'path';
import type Database from 'better-sqlite3';

import { DEFAULT_GENERATED_RESUMES_DIR } from '../../utils/outputStorage';
import type { MigrationOutcome, MigrationStep } from './index';

/**
 * Step 9, `settings-defaults` (owner decision S3): the app-settings row stops
 * holding defaults nobody chose.
 *
 * Until this build every save wrote the WHOLE settings document - every field,
 * whatever the page had changed - so on an upgraded install the row holds the
 * code defaults of the day as if an administrator had typed them. Read under
 * the new rule (stored > `.env` > code, config/aiModelConfig.ts
 * `composeSettings`) those would beat every `.env` default for ever. So each
 * field that now has a `.env` default and still holds EXACTLY its old code
 * default is taken out of the row; it then follows `.env`, and with nothing
 * there reads as the same value it held. A value an administrator changed is
 * kept, and so is every field without a `.env` default.
 *
 * The old defaults are written out here, as they were, rather than read from
 * the code: they are what older builds wrote, and a later change to a code
 * default must not change what this step recognises. The two that depended on
 * the install are worked out the way those builds did: the default model is
 * the seed the locks allowed (`defaultSeedModelId`), and the output folder is
 * `generated/` in the checkout.
 *
 * Only the app-settings row. The contact details and the Job Data Lake's
 * settings were always kept in rows of their own, written only when an
 * administrator saved one, so whatever they hold was chosen.
 *
 * Idempotent: a second run finds nothing equal to an old default left to take
 * out (`ran: false`). Never touches a row that does not parse; the settings
 * read reports that one by name.
 */

export const SETTINGS_DEFAULTS_STEP_VERSION = 9;

const APP_SETTINGS_KEY = 'app-settings';

type OldDefaultCheck = (value: unknown) => boolean;

/** The payment limits every older build shipped, in cents, as they wrote them. */
const OLD_PAYMENT_LIMITS = [
  { target: 'card', minCents: 250, maxCents: 10_000, presetsCents: [250, 500, 1_000, 2_500, 5_000, 10_000] },
  {
    target: 'crypto',
    minCents: 5_000,
    maxCents: 200_000,
    presetsCents: [5_000, 10_000, 15_000, 25_000, 50_000, 100_000],
  },
];

/** The old limits, row for row, whatever order the rows were stored in; a fee field an old row carries is not compared. */
function isOldPaymentLimits(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== OLD_PAYMENT_LIMITS.length) return false;
  return OLD_PAYMENT_LIMITS.every((expected) => {
    const row = value.find(
      (entry) => entry && typeof entry === 'object' && (entry as { target?: unknown }).target === expected.target
    ) as { minCents?: unknown; maxCents?: unknown; presetsCents?: unknown } | undefined;
    if (!row || row.minCents !== expected.minCents || row.maxCents !== expected.maxCents) return false;
    const presets = Array.isArray(row.presetsCents)
      ? [...new Set(row.presetsCents)].sort((a, b) => Number(a) - Number(b))
      : [];
    return (
      presets.length === expected.presetsCents.length &&
      presets.every((cents, index) => cents === expected.presetsCents[index])
    );
  });
}

function isOldOutputBaseDir(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  return path.resolve(value.trim()) === path.resolve(DEFAULT_GENERATED_RESUMES_DIR);
}

/**
 * The seed model an older build defaulted to here. Read when the step runs,
 * not when this module loads: config/aiModelConfig.ts reads the database
 * through the module that runs this step, so loading it with this one would
 * load it half-built.
 */
function oldDefaultModelId(): string {
  const config = require('../../config/aiModelConfig') as Partial<typeof import('../../config/aiModelConfig')>;
  if (typeof config.defaultSeedModelId !== 'function') {
    throw new Error('The default model could not be worked out; the settings are left as they are.');
  }
  return config.defaultSeedModelId();
}

function oldDefaultChecks(): Array<[string, OldDefaultCheck]> {
  const seed = oldDefaultModelId();
  return [
    // Empty is what clearing it meant; the seed is what every save wrote then.
    ['defaultModelId', (value) => typeof value === 'string' && (value.trim() === '' || value.trim() === seed)],
    ['analysisModelId', (value) => typeof value === 'string' && value.trim() === ''],
    ['defaultMode', (value) => value === 'preview'],
    ['defaultTheme', (value) => value === 'light'],
    ['defaultResumeSelection', (value) => value === 'single'],
    ['defaultResumeDocxEnabled', (value) => value === true],
    ['defaultCoverLetterDocxEnabled', (value) => value === true],
    ['outputBaseDir', isOldOutputBaseDir],
    ['paymentLimits', isOldPaymentLimits],
    ['requireThreeDSecure', (value) => value === false],
  ];
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function apply(db: Database.Database): MigrationOutcome {
  if (!hasTable(db, 'app_settings')) {
    return { ran: false, notes: [], summary: 'there is no settings table' };
  }

  // In one IMMEDIATE transaction, so an administrator's save from another
  // process cannot land between the read and the write and be undone.
  return db.transaction((): MigrationOutcome => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(APP_SETTINGS_KEY) as
      | { value: string }
      | undefined;
    if (!row) return { ran: false, notes: [], summary: 'nothing is stored' };

    let stored: unknown;
    try {
      stored = JSON.parse(row.value);
    } catch {
      return { ran: false, notes: [], summary: 'the stored settings do not parse' };
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return { ran: false, notes: [], summary: 'the stored settings are not an object' };
    }

    const document = stored as Record<string, unknown>;
    const dropped: string[] = [];
    for (const [key, isOldDefault] of oldDefaultChecks()) {
      if (Object.prototype.hasOwnProperty.call(document, key) && isOldDefault(document[key])) {
        delete document[key];
        dropped.push(key);
      }
    }
    if (dropped.length === 0) {
      return { ran: false, notes: [], summary: 'every stored setting with a .env default was chosen by an administrator' };
    }

    db.prepare('UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?').run(
      JSON.stringify(document),
      new Date().toISOString(),
      APP_SETTINGS_KEY
    );
    return {
      ran: true,
      notes: [],
      summary:
        `${dropped.length} setting(s) still at the old default now follow .env, else the same default ` +
        `(${dropped.join(', ')})`,
    };
  }).immediate();
}

export const settingsDefaultsStep: MigrationStep = {
  version: SETTINGS_DEFAULTS_STEP_VERSION,
  label: 'Migration 9 (settings-defaults)',
  apply,
};
