import os from 'os';
import path from 'path';

import {
  envRaw,
  envString,
  readEnvBool,
  readEnvDollarsMilli,
  readEnvEnum,
  warnEnvOnce,
  type EnvReading,
  type EnvSource,
} from './envValue';
import {
  MAX_SUBSCRIPTION_PRICE_MILLI,
  PAID_SUBSCRIPTION_IDS,
  SUBSCRIPTION_PRICE_FIELDS,
  type PaidSubscriptionId,
} from './accountSubscriptions';
import {
  BUILD_MODES,
  BUILD_MODE_PRICE_FIELDS,
  MAX_BUILD_MODE_PRICE_MILLI,
  type BuildMode,
} from './buildModes';
import type { OperationalVariable } from './operational';
import { MAX_REPORT_RATE_MILLI } from './reportRate';
import {
  DEFAULT_GENERATED_RESUMES_DIR,
  DEFAULT_OUTPUT_PATH_PREFIX,
  DEFAULT_OUTPUT_PATH_SUFFIX,
  validateOutputPrefix,
  validateOutputSuffix,
  type OutputPathCheck,
} from '../utils/outputStorage';
import { centsToMilli, formatMoney, isWholeCents, MILLI_PER_CENT, milliToCents } from '../utils/money';

/**
 * The `.env` half of every setting an administrator may leave unset (owner's
 * words: "All Setting value should have default value (on .env). Setting value
 * will be filled as default if this is not defined.").
 *
 * Each such setting resolves the same way, everywhere: the value an
 * administrator STORED, else the value `.env` gives, else the code default
 * here. The stored rows hold only what an administrator set
 * (config/aiModelConfig.ts `composeSettings`, services/contact.ts,
 * services/jobLake/settings.ts), so a value nobody chose keeps following
 * `.env` - and a `.env` edit reaches it at the next restart - instead of being
 * frozen at whatever the default was on the day of somebody's first save. A
 * PUT naming a field as `null` removes the stored value: that is "Reset to
 * default", and the admin payloads say what it would give
 * (`settingDefaults`) and where each value in effect came from
 * (`settingSources`: 'admin' | 'env' | 'default').
 *
 * Nothing here touches the database: every reader is a pure read of the
 * environment, which is what lets these sit in config/operational.ts's table
 * (spread in as `SETTING_DEFAULT_VARIABLES`, as the Gemini seat spreads its
 * own) and be held to `.env.example` and the README by test/envExample.test.js.
 * Two of them name things only the database knows - `DEFAULT_MODEL` and
 * `ANALYSIS_MODEL` name a model record - so this file reads their TEXT and
 * aiModelConfig.ts judges it against the stored model list, warning once when
 * it names nothing that runs.
 *
 * Junk never stops a boot (config/envValue.ts's policy): it warns once, naming
 * the variable, and the code default is used.
 */

/** Where a setting's value in effect came from: an administrator, `.env`, or the code. */
export type SettingSource = 'admin' | 'env' | 'default';

export const SETTING_SOURCES: readonly SettingSource[] = ['admin', 'env', 'default'];

/* ============================================================== unions */

export const DEFAULT_MODES = ['preview', 'generate'] as const;
export type DefaultMode = (typeof DEFAULT_MODES)[number];

export const THEME_MODES = ['light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/**
 * The mode the builder starts on, and the mode of a run that names none, when
 * neither an administrator nor `.env` says: Partial Tailor, which is what a
 * resume with no stored choice was always built with.
 */
export const CODE_DEFAULT_BUILD_MODE: BuildMode = 'partial';

/* ===================================================== payment limits */

/**
 * What one payment method - or one coin - may be bought in, as STORED: cents.
 *
 * There is no fee. A purchase credits exactly what it charges - pay $50 by
 * crypto, get $50 (the owner's decision M2) - so the `feeBps` and
 * `feeFixedCents` a stored row may still carry are read past and dropped on
 * the next save, and the provider's own fees are the operator's to absorb.
 */
export type PaymentTargetLimits = {
  /**
   * `card` or `crypto`. A stored row naming a coin id still reads and still
   * round-trips - see the note on `paymentLimits` in aiModelConfig.ts - but
   * nothing resolves one.
   */
  target: string;
  minCents: number;
  maxCents: number;
  /**
   * The amounts to offer as buttons, in cents.
   *
   * An INTENTION, not a promise: what a buyer sees is worked out from these by
   * `presetsFor`, which drops any that fall outside the bounds. A preset can
   * therefore never name an amount the server would refuse to charge.
   */
  presetsCents: number[];
};

/** The largest bound a payment limit may have, in cents: $1,000,000. */
export const MAX_AMOUNT_CENTS = 100_000_000;

/**
 * The code defaults, which are the figures in the design this was built to.
 *
 * Card starts at $2.50; crypto starts at $50 because sending coin costs the
 * buyer a network fee whatever we do, and a $2.50 purchase that costs $4 to
 * send is not a kindness. `.env`'s `PAYMENT_<METHOD>_MIN_USD` / `_MAX_USD`
 * move the bounds (`envPaymentLimits`); the presets stay these, and the buy
 * page offers only the ones inside the bounds.
 */
export const DEFAULT_PAYMENT_LIMITS: PaymentTargetLimits[] = [
  {
    target: 'card',
    minCents: 250,
    maxCents: 10_000,
    presetsCents: [250, 500, 1_000, 2_500, 5_000, 10_000],
  },
  {
    target: 'crypto',
    minCents: 5_000,
    maxCents: 200_000,
    presetsCents: [5_000, 10_000, 15_000, 25_000, 50_000, 100_000],
  },
];

/** The two variables per payment method, keyed by its target. */
export const PAYMENT_LIMIT_VARIABLES = {
  card: { min: 'PAYMENT_CARD_MIN_USD', max: 'PAYMENT_CARD_MAX_USD' },
  crypto: { min: 'PAYMENT_CRYPTO_MIN_USD', max: 'PAYMENT_CRYPTO_MAX_USD' },
} as const;

type PaymentMethodTarget = keyof typeof PAYMENT_LIMIT_VARIABLES;

/* ======================================================= code defaults */

/**
 * What every setting here is when neither an administrator nor `.env` says.
 * Today's values: an install that sets none of the variables behaves as it
 * did before they existed. The default MODEL is not here - it is the first
 * seed model this deployment can run (aiModelConfig.ts `defaultSeedModelId`),
 * which depends on the locks - nor the output folder, which is a path in the
 * checkout (`codeDefaultOutputBaseDir`).
 */
export const CODE_SETTING_DEFAULTS = {
  defaultMode: 'preview' as DefaultMode,
  defaultTheme: 'light' as ThemeMode,
  defaultBuildMode: CODE_DEFAULT_BUILD_MODE as BuildMode,
  /**
   * What one resume costs in each build mode, in thousandths: 0, free. There is
   * no default price on purpose - a mode is priced by an administrator, and
   * Admin -> Settings shows every free mode in red, so "free because nobody
   * set a price" is visible rather than a silent default.
   */
  suitablePriceMilli: 0,
  partialPriceMilli: 0,
  fullPriceMilli: 0,
  defaultResumeDocxEnabled: true,
  defaultCoverLetterDocxEnabled: true,
  /** '' is "the app default model": job postings are analysed on whatever builds resumes by default. */
  analysisModelId: '',
  outputPathPrefix: DEFAULT_OUTPUT_PATH_PREFIX as string,
  requireThreeDSecure: false,
  /**
   * What each paid subscription costs for 30 days, in thousandths: null, not
   * offered. Nobody is charged for a tier until somebody decides what it is
   * worth, as no model is priced until one is.
   */
  premiumPriceMilli: null as number | null,
  premiumPlusPriceMilli: null as number | null,
  premiumMaxPriceMilli: null as number | null,
} as const;

/** `generated/` in the checkout, as an absolute path - where resumes have always been filed by default. */
export function codeDefaultOutputBaseDir(): string {
  return path.resolve(DEFAULT_GENERATED_RESUMES_DIR);
}

/* ====================================================== env variables */

/**
 * The variable(s) behind each app-settings field that has a `.env` default, in
 * the order Admin -> Settings shows them. What "From .env (NAME)" names; the
 * frontend keeps a copy, held to this one by a test.
 */
export const APP_SETTING_ENV_VARIABLES = {
  defaultModelId: ['DEFAULT_MODEL'],
  analysisModelId: ['ANALYSIS_MODEL'],
  defaultMode: ['DEFAULT_MODE'],
  defaultTheme: ['DEFAULT_THEME'],
  defaultBuildMode: ['DEFAULT_TAILOR_MODE'],
  // Saved as `suitablePriceUsd` and its two siblings - a request carries dollars -
  // and served in thousandths under these names (buildModes.ts
  // `BUILD_MODE_PRICE_FIELDS`, which a test holds to this table).
  suitablePriceMilli: [BUILD_MODE_PRICE_FIELDS.suitable.env],
  partialPriceMilli: [BUILD_MODE_PRICE_FIELDS.partial.env],
  fullPriceMilli: [BUILD_MODE_PRICE_FIELDS.full.env],
  defaultResumeDocxEnabled: ['DEFAULT_RESUME_DOCX'],
  defaultCoverLetterDocxEnabled: ['DEFAULT_COVER_LETTER_DOCX'],
  outputBaseDir: ['OUTPUT_BASE_DIR'],
  outputPathPrefix: ['OUTPUT_PATH_PREFIX'],
  paymentLimits: [
    PAYMENT_LIMIT_VARIABLES.card.min,
    PAYMENT_LIMIT_VARIABLES.card.max,
    PAYMENT_LIMIT_VARIABLES.crypto.min,
    PAYMENT_LIMIT_VARIABLES.crypto.max,
  ],
  requireThreeDSecure: ['REQUIRE_THREE_D_SECURE'],
  // Saved as `premiumPriceUsd` and its two siblings - a request carries dollars -
  // and served in thousandths under these names (accountSubscriptions.ts
  // `SUBSCRIPTION_PRICE_FIELDS`, which a test holds to this table).
  premiumPriceMilli: ['SUBSCRIPTION_PREMIUM_PRICE_USD'],
  premiumPlusPriceMilli: ['SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD'],
  premiumMaxPriceMilli: ['SUBSCRIPTION_PREMIUM_MAX_PRICE_USD'],
} as const satisfies Record<string, readonly string[]>;

/** The app-settings fields that resolve stored > `.env` > code default. */
export type DefaultedSettingKey = keyof typeof APP_SETTING_ENV_VARIABLES;

export const DEFAULTED_SETTING_KEYS = Object.keys(APP_SETTING_ENV_VARIABLES) as DefaultedSettingKey[];

/** The contact row's one field (services/contact.ts). */
export const CONTACT_SETTING_ENV_VARIABLES = { channels: ['CONTACT_CHANNELS'] } as const;

/** The Job Data Lake's three (services/jobLake/settings.ts), keyed as its payload serves them. */
export const LAKE_SETTING_ENV_VARIABLES = {
  reportRateMilli: ['JOB_LAKE_REPORT_RATE_USD'],
  duplicateWindowDays: ['JOB_LAKE_DUPLICATE_WINDOW_DAYS'],
  dailyCapMilli: ['JOB_LAKE_DAILY_CAP_USD'],
} as const;

/* ============================================================ readers */

export function envDefaultMode(env: EnvSource = process.env): EnvReading<DefaultMode> {
  const options = { values: DEFAULT_MODES, caseInsensitive: true };
  return readEnvEnum('DEFAULT_MODE', CODE_SETTING_DEFAULTS.defaultMode, options, env);
}

export function envDefaultTheme(env: EnvSource = process.env): EnvReading<ThemeMode> {
  const options = { values: THEME_MODES, caseInsensitive: true };
  return readEnvEnum('DEFAULT_THEME', CODE_SETTING_DEFAULTS.defaultTheme, options, env);
}

export function envDefaultResumeDocx(env: EnvSource = process.env): EnvReading<boolean> {
  return readEnvBool('DEFAULT_RESUME_DOCX', CODE_SETTING_DEFAULTS.defaultResumeDocxEnabled, env);
}

export function envDefaultCoverLetterDocx(env: EnvSource = process.env): EnvReading<boolean> {
  return readEnvBool('DEFAULT_COVER_LETTER_DOCX', CODE_SETTING_DEFAULTS.defaultCoverLetterDocxEnabled, env);
}

export function envRequireThreeDSecure(env: EnvSource = process.env): EnvReading<boolean> {
  return readEnvBool('REQUIRE_THREE_D_SECURE', CODE_SETTING_DEFAULTS.requireThreeDSecure, env);
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Where generated resumes are filed when Admin -> Settings names no folder.
 *
 * An ABSOLUTE path (`~` counts, as on the admin page): a relative one would be
 * read against whatever directory the server happened to be started from -
 * `backend/` under `npm run dev`, the checkout under a service - and files
 * would land in two places depending on how it was launched. Refused, it
 * warns once and `generated/` in the checkout is used. Whether the folder can
 * be written is checked when it is used, as an administrator's is when saved.
 */
export function envOutputBaseDir(env: EnvSource = process.env): EnvReading<string> {
  const fallback = codeDefaultOutputBaseDir();
  const raw = envRaw('OUTPUT_BASE_DIR', env);
  if (raw === null) return { value: fallback, fromEnv: false };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    warnEnvOnce('OUTPUT_BASE_DIR', `OUTPUT_BASE_DIR contains a line break or another control character; using ${fallback}.`);
    return { value: fallback, fromEnv: false };
  }
  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) {
    warnEnvOnce(
      'OUTPUT_BASE_DIR',
      `OUTPUT_BASE_DIR=${JSON.stringify(raw)} is not an absolute path; using ${fallback}.`
    );
    return { value: fallback, fromEnv: false };
  }
  return { value: path.resolve(expanded), fromEnv: true };
}

/** A prefix or suffix from `.env`, checked as an administrator's or an account's is; refused, the default, with one warning. */
function envOutputPath(
  name: string,
  fallback: string,
  validate: (value: unknown) => OutputPathCheck,
  env: EnvSource
): EnvReading<string> {
  const raw = envRaw(name, env);
  if (raw === null) return { value: fallback, fromEnv: false };
  const check = validate(raw);
  if (!check.ok) {
    warnEnvOnce(name, `${name}=${JSON.stringify(raw)} is refused: ${check.problems.join(' ')} Using ${fallback}.`);
    return { value: fallback, fromEnv: false };
  }
  return { value: check.value, fromEnv: true };
}

/**
 * The administrator's output prefix when Admin -> Settings stores none:
 * `<output folder>/<prefix>/...` for every account's runs. Its rules are
 * utils/outputStorage.ts `validateOutputPrefix`'s - `{{user_email}}`,
 * `{{order_number}}` (once, a folder of its own) and `{{date}}`.
 */
export function envOutputPathPrefix(env: EnvSource = process.env): EnvReading<string> {
  return envOutputPath('OUTPUT_PATH_PREFIX', DEFAULT_OUTPUT_PATH_PREFIX, validateOutputPrefix, env);
}

/**
 * The folder path after the prefix for an account that has not set its own
 * (Settings -> Account -> Resume files): `validateOutputSuffix`'s tokens,
 * `{{date}}`, `{{profile_name}}`, `{{company_name}}`, `{{role}}` and
 * `{{row_number}}`. A per-account default, not an app setting: the source an
 * account sees is 'account' | 'env' | 'default' (services/outputPath.ts).
 */
export function envOutputPathSuffix(env: EnvSource = process.env): EnvReading<string> {
  return envOutputPath('OUTPUT_PATH_SUFFIX', DEFAULT_OUTPUT_PATH_SUFFIX, validateOutputSuffix, env);
}

/**
 * The mode the builder starts on, and the mode of a run that names none, when
 * Admin -> Settings stores no choice: `.env`'s DEFAULT_TAILOR_MODE, which
 * takes `suitable`, `partial` or `full` in any case (an install whose
 * DEFAULT_TAILOR_MODE=full keeps meaning Fully Tailor). Junk warns once and
 * `partial` is used.
 */
export function envDefaultBuildMode(env: EnvSource = process.env): EnvReading<BuildMode> {
  return readEnvEnum('DEFAULT_TAILOR_MODE', CODE_DEFAULT_BUILD_MODE, { values: BUILD_MODES, caseInsensitive: true }, env);
}

/**
 * A mode's price as `.env` gives it - and whether the variable holds something
 * that is not a price at all (`unreadable`), which reads $0 like an unset one
 * but is nobody's decision: Admin -> Settings shows it red, naming the
 * variable.
 */
export type EnvBuildModePrice = EnvReading<number> & { unreadable: boolean };

/**
 * One mode's price per resume when Admin -> Settings stores none, in
 * thousandths: `RESUME_<MODE>_PRICE_USD`, in dollars to $0.001, at most $1000
 * (above it clamps, with a warning). Unset is $0, free. Junk warns once and
 * reads $0 too, flagged `unreadable`.
 */
export function envBuildModePriceMilli(mode: BuildMode, env: EnvSource = process.env): EnvBuildModePrice {
  const { env: name, setting } = BUILD_MODE_PRICE_FIELDS[mode];
  const fallback = CODE_SETTING_DEFAULTS[setting];
  const reading = readEnvDollarsMilli(name, fallback, { maxMilli: MAX_BUILD_MODE_PRICE_MILLI }, env);
  return {
    value: reading.value ?? fallback,
    fromEnv: reading.fromEnv,
    // Set, and still not read from the environment: the reader refused it.
    unreadable: !reading.fromEnv && envRaw(name, env) !== null,
  };
}

/** One payment bound from `.env`, in whole cents from $0.01 - or the default, with a warning. */
function envLimitCents(name: string, fallbackCents: number, env: EnvSource): EnvReading<number> {
  const reading = readEnvDollarsMilli(name, centsToMilli(fallbackCents), { maxMilli: centsToMilli(MAX_AMOUNT_CENTS) }, env);
  if (!reading.fromEnv || reading.value === null) return { value: fallbackCents, fromEnv: false };
  // A card or an invoice charges whole cents, so a bound between two cents is
  // one nothing could sit on - refused as an administrator's $2.505 is.
  if (!isWholeCents(reading.value) || reading.value < MILLI_PER_CENT) {
    warnEnvOnce(
      name,
      `${name}=${formatMoney(reading.value)} is not a whole number of cents from $0.01; using ` +
        `${formatMoney(centsToMilli(fallbackCents))}.`
    );
    return { value: fallbackCents, fromEnv: false };
  }
  return { value: milliToCents(reading.value), fromEnv: true };
}

/**
 * The purchase bounds when Admin -> Payments has stored none: each method's
 * `PAYMENT_<METHOD>_MIN_USD` / `_MAX_USD`, in dollars and whole cents, else
 * `DEFAULT_PAYMENT_LIMITS`. A method whose minimum `.env` puts above its
 * maximum keeps both defaults - a band nothing fits would refuse every
 * purchase with a sentence about the buyer's amount - and says so once. The
 * presets are the defaults' (outside the bounds, the buy page drops them).
 */
export function envPaymentLimits(
  env: EnvSource = process.env
): EnvReading<PaymentTargetLimits[]> & { variables: Record<string, string[]> } {
  let fromEnv = false;
  /** Per method, the variables that supplied a bound in effect: what "From .env (NAME)" names for it. */
  const variables: Record<string, string[]> = {};
  const rows = DEFAULT_PAYMENT_LIMITS.map((row) => {
    const names = PAYMENT_LIMIT_VARIABLES[row.target as PaymentMethodTarget];
    const defaults: PaymentTargetLimits = { ...row, presetsCents: [...row.presetsCents] };
    if (!names) return defaults;
    const min = envLimitCents(names.min, row.minCents, env);
    const max = envLimitCents(names.max, row.maxCents, env);
    if (min.value > max.value) {
      warnEnvOnce(
        names.min,
        `${names.min} (${formatMoney(centsToMilli(min.value))}) is above ${names.max} ` +
          `(${formatMoney(centsToMilli(max.value))}); using the ${row.target} defaults, ` +
          `${formatMoney(centsToMilli(row.minCents))} to ${formatMoney(centsToMilli(row.maxCents))}.`
      );
      return defaults;
    }
    const supplied = [min.fromEnv ? names.min : '', max.fromEnv ? names.max : ''].filter(Boolean);
    if (supplied.length > 0) {
      fromEnv = true;
      variables[row.target] = supplied;
    }
    return { ...defaults, minCents: min.value, maxCents: max.value };
  });
  return { value: rows, fromEnv, variables };
}

/**
 * `DEFAULT_MODEL` / `ANALYSIS_MODEL` as written: a model record's id, or its
 * display name (any case). Only the text - which record it names, and whether
 * that one can run, is aiModelConfig.ts's question, asked against the stored
 * models on every read (`envModelChoice`).
 */
export function envDefaultModelText(env: EnvSource = process.env): string {
  return envString('DEFAULT_MODEL', '', { maxLength: 200 }, env);
}

export function envAnalysisModelText(env: EnvSource = process.env): string {
  return envString('ANALYSIS_MODEL', '', { maxLength: 200 }, env);
}

/**
 * `CONTACT_CHANNELS` as written. services/contact.ts reads it into channels
 * under the contact rules, dropping an entry that fails them with one warning
 * naming its position.
 */
export function envContactChannelsText(env: EnvSource = process.env): string {
  return envRaw('CONTACT_CHANNELS', env) ?? '';
}

/** The daily cap's ceiling: $1,000,000, so an absurd figure is a typo refused rather than a cap. */
export const MAX_DAILY_CAP_MILLI = 1_000_000_000;

/**
 * The lake's global rate per accepted job when /admin/job-lake has stored
 * none, in thousandths; null when `.env` names none either ($0: nobody is
 * paid until somebody decides what a job is worth).
 */
export function envJobLakeReportRateMilli(env: EnvSource = process.env): EnvReading<number | null> {
  return readEnvDollarsMilli('JOB_LAKE_REPORT_RATE_USD', null, { maxMilli: MAX_REPORT_RATE_MILLI }, env);
}

/** The lake's daily cap per reporter when /admin/job-lake has stored none; null is no cap. */
export function envJobLakeDailyCapMilli(env: EnvSource = process.env): EnvReading<number | null> {
  return readEnvDollarsMilli('JOB_LAKE_DAILY_CAP_USD', null, { maxMilli: MAX_DAILY_CAP_MILLI }, env);
}

/**
 * A subscription price as `.env` gives it - and whether the variable holds
 * something that is not a price at all (`unreadable`), which reads as not
 * offered like an unset one, but is nobody's decision.
 */
export type EnvSubscriptionPrice = EnvReading<number | null> & { unreadable: boolean };

/**
 * A paid subscription's price for 30 days when Admin -> Settings -> General
 * stores none, in thousandths: `SUBSCRIPTION_<TIER>_PRICE_USD`, in dollars to
 * $0.001, at most $10,000 (above it clamps, with a warning). Unset - or 0 -
 * is null, not offered: the tier's card asks for the administrator, and
 * nobody can buy it. Junk warns once and is not offered either - but it is
 * flagged `unreadable`, because a typo must not end the subscriptions already
 * paid for as if somebody had stopped offering the tier
 * (aiModelConfig.ts `getSubscriptionPriceReading`, the renewal sweep's read).
 */
export function envSubscriptionPriceMilli(tier: PaidSubscriptionId, env: EnvSource = process.env): EnvSubscriptionPrice {
  const name = SUBSCRIPTION_PRICE_FIELDS[tier].env;
  const reading = readEnvDollarsMilli(
    name,
    CODE_SETTING_DEFAULTS[SUBSCRIPTION_PRICE_FIELDS[tier].setting],
    { maxMilli: MAX_SUBSCRIPTION_PRICE_MILLI },
    env
  );
  if (reading.value === 0) return { value: null, fromEnv: false, unreadable: false };
  // Set, and still not read from the environment: the reader refused it.
  return { ...reading, unreadable: !reading.fromEnv && envRaw(name, env) !== null };
}

/**
 * Every variable above, read as one string, for a cache keyed on what the
 * environment says: the settings cache must not serve a value `.env` (or a
 * test) has changed since.
 */
export function settingEnvFingerprint(env: EnvSource = process.env): string {
  return Object.values(APP_SETTING_ENV_VARIABLES)
    .flat()
    .map((name) => `${name}=${env[name] ?? ''}`)
    .join('\u0000');
}

/* ============================================================== table */

/** An amount as `.env` spells it: dollars, no `$`, no thousands separator ("2.5", "2000"). */
function dollarsText(milli: number | null): string {
  return milli === null ? '' : formatMoney(milli).slice(1).split(',').join('');
}

/**
 * A payment bound as `.env` spells it: whole cents, so dollars and two places
 * when there are cents ("2.50"), whole dollars otherwise ("100"). Built from
 * the digits, never through a float.
 */
function centsText(cents: number): string {
  const digits = String(cents).padStart(3, '0');
  const fraction = digits.slice(-2);
  return fraction === '00' ? digits.slice(0, -2) : `${digits.slice(0, -2)}.${fraction}`;
}

/**
 * `CONTACT_CHANNELS` as the startup line prints it: the entries the contact
 * rules accept, as `type:value|label`, and nothing of one they refuse - that is
 * warned about by its position only, so its text appears nowhere. Read through
 * services/contact.ts at call time, not imported: that module reads the
 * database too, and imports this one.
 */
function contactChannelsInEffect(env: EnvSource): string {
  if (!envContactChannelsText(env)) return '';
  const contact = require('../services/contact') as typeof import('../services/contact');
  return contact
    .contactChannelsFromEnv(env)
    .map((channel) => `${channel.type}:${channel.value}|${channel.label}`)
    .join(',');
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

function entry(
  name: string,
  defaultValue: string,
  readIn: string,
  current: (env: EnvSource) => string
): OperationalVariable {
  return { name, defaultValue, side: 'backend', readAt: 'per-call', readIn, current };
}

function paymentEntry(target: PaymentMethodTarget, bound: 'min' | 'max'): OperationalVariable {
  const row = DEFAULT_PAYMENT_LIMITS.find((limits) => limits.target === target)!;
  const cents = bound === 'min' ? row.minCents : row.maxCents;
  return entry(
    PAYMENT_LIMIT_VARIABLES[target][bound],
    centsText(cents),
    'services/payments/pricing.ts (when Admin -> Payments stores no limits)',
    (env) => {
      const limits = envPaymentLimits(env).value.find((limitsRow) => limitsRow.target === target)!;
      return centsText(bound === 'min' ? limits.minCents : limits.maxCents);
    }
  );
}

const SETTINGS_READ_IN = 'config/aiModelConfig.ts (when Admin -> Settings stores no value)';

/**
 * This file's rows of config/operational.ts's table. Every one is read per
 * call - a settings read - and `current` is a pure read of the environment, so
 * a copied `.env.example` leaves each at its default without a warning. The
 * two model variables show their text; whether it names a model that runs is
 * judged, and warned about, where the models are read.
 */
export const SETTING_DEFAULT_VARIABLES: readonly OperationalVariable[] = [
  entry('DEFAULT_MODEL', '', SETTINGS_READ_IN, envDefaultModelText),
  entry('ANALYSIS_MODEL', '', SETTINGS_READ_IN, envAnalysisModelText),
  entry('DEFAULT_MODE', CODE_SETTING_DEFAULTS.defaultMode, SETTINGS_READ_IN, (env) => envDefaultMode(env).value),
  entry('DEFAULT_THEME', CODE_SETTING_DEFAULTS.defaultTheme, SETTINGS_READ_IN, (env) => envDefaultTheme(env).value),
  entry('DEFAULT_TAILOR_MODE', CODE_DEFAULT_BUILD_MODE, SETTINGS_READ_IN, (env) => envDefaultBuildMode(env).value),
  ...BUILD_MODES.map((mode) =>
    entry(BUILD_MODE_PRICE_FIELDS[mode].env, '0', SETTINGS_READ_IN, (env) =>
      dollarsText(envBuildModePriceMilli(mode, env).value)
    )
  ),
  entry(
    'DEFAULT_RESUME_DOCX',
    onOff(CODE_SETTING_DEFAULTS.defaultResumeDocxEnabled),
    SETTINGS_READ_IN,
    (env) => onOff(envDefaultResumeDocx(env).value)
  ),
  entry(
    'DEFAULT_COVER_LETTER_DOCX',
    onOff(CODE_SETTING_DEFAULTS.defaultCoverLetterDocxEnabled),
    SETTINGS_READ_IN,
    (env) => onOff(envDefaultCoverLetterDocx(env).value)
  ),
  // '' is `generated/` in the checkout: a path that differs per install
  // cannot be written into .env.example as the default.
  entry('OUTPUT_BASE_DIR', '', SETTINGS_READ_IN, (env) => {
    const reading = envOutputBaseDir(env);
    return reading.fromEnv ? reading.value : '';
  }),
  entry('OUTPUT_PATH_PREFIX', DEFAULT_OUTPUT_PATH_PREFIX, SETTINGS_READ_IN, (env) => envOutputPathPrefix(env).value),
  entry(
    'OUTPUT_PATH_SUFFIX',
    DEFAULT_OUTPUT_PATH_SUFFIX,
    'services/outputPath.ts (for an account that has set no folder path of its own)',
    (env) => envOutputPathSuffix(env).value
  ),
  paymentEntry('card', 'min'),
  paymentEntry('card', 'max'),
  paymentEntry('crypto', 'min'),
  paymentEntry('crypto', 'max'),
  entry(
    'REQUIRE_THREE_D_SECURE',
    onOff(CODE_SETTING_DEFAULTS.requireThreeDSecure),
    'services/payments/pricing.ts (when Admin -> Payments stores no choice)',
    (env) => onOff(envRequireThreeDSecure(env).value)
  ),
  entry(
    'CONTACT_CHANNELS',
    '',
    'services/contact.ts (when Admin -> Settings stores no contact details)',
    contactChannelsInEffect
  ),
  entry(
    'JOB_LAKE_REPORT_RATE_USD',
    '',
    'services/jobLake/settings.ts (an administrator\'s rate on /admin/job-lake wins)',
    (env) => dollarsText(envJobLakeReportRateMilli(env).value)
  ),
  entry(
    'JOB_LAKE_DAILY_CAP_USD',
    '',
    'services/jobLake/settings.ts (an administrator\'s cap on /admin/job-lake wins)',
    (env) => dollarsText(envJobLakeDailyCapMilli(env).value)
  ),
  // '' is not offered: nobody can buy that tier until it has a price.
  ...PAID_SUBSCRIPTION_IDS.map((tier) =>
    entry(
      SUBSCRIPTION_PRICE_FIELDS[tier].env,
      '',
      'services/subscriptions (when Admin -> Settings -> General stores no price)',
      (env) => dollarsText(envSubscriptionPriceMilli(tier, env).value)
    )
  ),
];
