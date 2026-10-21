/**
 * Where an administrator's setting got the value in effect, and what the
 * pages do about it (owner decisions S1-S4).
 *
 * Every setting an administrator may leave unset resolves the same way on the
 * server: the value stored here, else the `.env` value, else the code's
 * default. The admin payloads say which, per field (`settingSources`:
 * 'admin' | 'env' | 'default'), and what each would be with nothing stored
 * (`settingDefaults`). A page shows the source beside the box - "Set here",
 * "From .env (NAME)" or "Default" - and offers **Reset to default** while it
 * is "Set here", which sends the field as `null`: the stored value goes and
 * `.env` decides again.
 *
 * And a save sends ONLY what changed. The server stores only what an
 * administrator set, so a form that sent every box would mark every one of
 * them "Set here" - frozen at whatever `.env` said the day of the save, and no
 * longer following it.
 *
 * No runtime import, so backend/test/frontendSettings.test.js runs it against
 * the server's own tables (config/settingDefaults.ts) and routes.
 */

/** Where a value in effect came from: an administrator, `.env`, or the code. The server's `SettingSource`. */
export type SettingSource = 'admin' | 'env' | 'default';

export const SETTING_SOURCES: readonly SettingSource[] = ['admin', 'env', 'default'];

/**
 * The variable(s) behind each app-settings field with a `.env` default - a
 * copy of the server's `APP_SETTING_ENV_VARIABLES`, held to it by a test.
 * What "From .env (NAME)" names.
 */
export const APP_SETTING_ENV_VARIABLES = {
  defaultModelId: ['DEFAULT_MODEL'],
  analysisModelId: ['ANALYSIS_MODEL'],
  defaultMode: ['DEFAULT_MODE'],
  defaultTheme: ['DEFAULT_THEME'],
  defaultResumeSelection: ['DEFAULT_RESUME_SELECTION'],
  defaultResumeDocxEnabled: ['DEFAULT_RESUME_DOCX'],
  defaultCoverLetterDocxEnabled: ['DEFAULT_COVER_LETTER_DOCX'],
  outputBaseDir: ['OUTPUT_BASE_DIR'],
  outputPathPrefix: ['OUTPUT_PATH_PREFIX'],
  paymentLimits: ['PAYMENT_CARD_MIN_USD', 'PAYMENT_CARD_MAX_USD', 'PAYMENT_CRYPTO_MIN_USD', 'PAYMENT_CRYPTO_MAX_USD'],
  requireThreeDSecure: ['REQUIRE_THREE_D_SECURE'],
  premiumPriceMilli: ['SUBSCRIPTION_PREMIUM_PRICE_USD'],
  premiumPlusPriceMilli: ['SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD'],
  premiumMaxPriceMilli: ['SUBSCRIPTION_PREMIUM_MAX_PRICE_USD'],
} as const;

/** The app-settings fields that resolve stored > `.env` > code default. */
export type AppSettingKey = keyof typeof APP_SETTING_ENV_VARIABLES;

export const APP_SETTING_KEYS = Object.keys(APP_SETTING_ENV_VARIABLES) as AppSettingKey[];

/**
 * The field each subscription price is SAVED under: dollars as typed, in a
 * field ending `Usd`, though the payload serves it in thousandths (`...Milli`,
 * null = not offered). A save naming the `...Milli` field is refused.
 */
export const SUBSCRIPTION_PRICE_REQUEST_FIELDS = {
  premiumPriceMilli: 'premiumPriceUsd',
  premiumPlusPriceMilli: 'premiumPlusPriceUsd',
  premiumMaxPriceMilli: 'premiumMaxPriceUsd',
} as const satisfies Partial<Record<AppSettingKey, string>>;

export type SubscriptionPriceKey = keyof typeof SUBSCRIPTION_PRICE_REQUEST_FIELDS;

/** The contact list's one field - a copy of the server's `CONTACT_SETTING_ENV_VARIABLES`. */
export const CONTACT_SETTING_ENV_VARIABLES = { channels: ['CONTACT_CHANNELS'] } as const;

export type ContactSettingKey = keyof typeof CONTACT_SETTING_ENV_VARIABLES;

/** The Job Data Lake's three, keyed as its payload serves them - a copy of `LAKE_SETTING_ENV_VARIABLES`. */
export const LAKE_SETTING_ENV_VARIABLES = {
  reportRateMilli: ['JOB_LAKE_REPORT_RATE_USD'],
  duplicateWindowDays: ['JOB_LAKE_DUPLICATE_WINDOW_DAYS'],
  dailyCapMilli: ['JOB_LAKE_DAILY_CAP_USD'],
} as const;

export type LakeSettingKey = keyof typeof LAKE_SETTING_ENV_VARIABLES;

export const LAKE_SETTING_KEYS = Object.keys(LAKE_SETTING_ENV_VARIABLES) as LakeSettingKey[];

/**
 * The field a lake setting is SAVED under: amounts go as dollars in a field
 * ending `Usd`, though the payload serves them in thousandths (`...Milli`).
 */
export const LAKE_SETTING_REQUEST_FIELDS = {
  reportRateMilli: 'reportRateUsd',
  duplicateWindowDays: 'duplicateWindowDays',
  dailyCapMilli: 'dailyCapUsd',
} as const satisfies Record<LakeSettingKey, string>;

/** One source as the server sent it. Anything else reads as 'default': nothing is offered to reset. */
export function readSettingSource(value: unknown): SettingSource {
  return value === 'admin' || value === 'env' ? value : 'default';
}

/** A payload's `settingSources`, every key present - 'default' for one the server left out. */
export function readSettingSources<K extends string>(value: unknown, keys: readonly K[]): Record<K, SettingSource> {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const sources = {} as Record<K, SettingSource>;
  for (const key of keys) sources[key] = readSettingSource(record[key]);
  return sources;
}

/**
 * The words beside a box: "Set here", "From .env (NAME)" - every variable
 * behind it, so the administrator knows which line to look for - or
 * "Default". The same words Admin -> Models -> Providers uses.
 */
export function sourceLabel(source: SettingSource, variables: readonly string[]): string {
  if (source === 'admin') return 'Set here';
  if (source === 'env') return `From .env (${variables.join(', ')})`;
  return 'Default';
}

/** `sourceLabel` for an app-settings field. */
export function appSettingSourceLabel(sources: Partial<Record<AppSettingKey, SettingSource>>, key: AppSettingKey): string {
  return sourceLabel(readSettingSource(sources[key]), APP_SETTING_ENV_VARIABLES[key]);
}

/** `sourceLabel` for a lake setting. */
export function lakeSettingSourceLabel(sources: Partial<Record<LakeSettingKey, SettingSource>>, key: LakeSettingKey): string {
  return sourceLabel(readSettingSource(sources[key]), LAKE_SETTING_ENV_VARIABLES[key]);
}

/** Reset to default is offered exactly while the value is the administrator's: otherwise there is nothing stored to remove. */
export function canReset(source: SettingSource | undefined): boolean {
  return source === 'admin';
}

/** The body of a Reset to default: the field, as `null`. */
export function resetBody<K extends string>(key: K): Record<K, null> {
  return { [key]: null } as Record<K, null>;
}

/** A lake setting's Reset to default, under the field it is saved by. */
export function lakeResetBody(key: LakeSettingKey): Record<string, null> {
  return resetBody(LAKE_SETTING_REQUEST_FIELDS[key]);
}

/**
 * An app setting's Reset to default, under the field it is saved by: a
 * subscription price under its `...Usd` name, every other field under its own.
 */
export function appSettingResetBody(key: AppSettingKey): Record<string, null> {
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PRICE_REQUEST_FIELDS, key)
    ? resetBody(SUBSCRIPTION_PRICE_REQUEST_FIELDS[key as SubscriptionPriceKey])
    : resetBody(key);
}

/**
 * Whether two settings values are the same, as JSON reads them: in key order
 * for objects, element by element for lists. A save compares what the form
 * would send with what is in effect, both plain data.
 */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameSettingValue(entry, b[index]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!sameSettingValue(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * A save's body: of `keys`, only those whose value in the form differs from
 * the value in effect. Empty when nothing changed - and then a page sends
 * nothing at all, so an untouched form never turns a `.env` value into
 * "Set here".
 */
export function changedSettings<T extends object, K extends keyof T>(
  draft: Pick<T, K>,
  current: Pick<T, K>,
  keys: readonly K[]
): Partial<Pick<T, K>> {
  const body: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (!sameSettingValue(draft[key], current[key])) body[key] = draft[key];
  }
  return body;
}
