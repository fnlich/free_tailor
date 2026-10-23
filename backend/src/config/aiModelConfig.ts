import { randomUUID } from 'crypto';
import nodePath from 'path';

import { getSetting, setSetting } from '../database/settingsRepository';
import { getDatabasePath } from '../database/sqlite';
import { AIProvider } from '../types/template';
import { CODEX_DEFAULT_MODEL } from '../services/ai/providers/codexCli/options';
import { GEMINI_DEFAULT_MODEL } from '../services/ai/providers/geminiCli/options';
import {
  AI_PROVIDER_IDS,
  coerceProviderId,
  getProviderLabel as getCatalogProviderLabel,
  getProviderLockReason,
  isProviderLocked,
  listLockedProviderIds,
  LOCKED_PROVIDERS_ENV_VAR,
} from './providerCatalog';
import { DEFAULT_CLAUDE_CLI_MODEL } from '../services/aiModelCatalog';
import {
  describeProviderModelOptions,
  findProviderModelOption,
  listProviderModelOptions,
  type ProviderModelOptions,
} from './providerModels';
import {
  BUILD_MODES,
  BUILD_MODE_PRICE_FIELDS,
  buildModePriceFieldError,
  isBuildMode,
  isStoredBuildModePriceMilli,
  parseBuildModePriceInput,
  type BuildMode,
} from './buildModes';
import {
  MAX_SUBSCRIPTION_PRICE_MILLI,
  PAID_SUBSCRIPTION_IDS,
  SUBSCRIPTION_PRICE_FIELDS,
  SUBSCRIPTIONS,
  type PaidSubscriptionId,
  type SubscriptionPrices,
  type SubscriptionPriceSetting,
} from './accountSubscriptions';
import {
  centsToMilli,
  describeDollarProblem,
  formatMoney,
  isWholeCents,
  milliToCents,
  parseDollars,
} from '../utils/money';
import { AiUnavailableError, ModelUnavailableError } from './modelErrors';
import {
  AIProviderInputError,
  applyProviderEdit,
  buildNewProvider,
  isBuiltInProviderId,
  noteStoredProviders,
  normalizeStoredProviders,
  resolveProviders,
  storableProviders,
  toAdminProvider,
  type AdminAIProvider,
  type ResolvedAIProvider,
  type StoredAIProvider,
} from './aiProviders';
import { getStaticDir } from './staticPaths';
import { geminiCliStateDir, geminiCliWorkdir } from '../services/ai/providers/geminiCli/options';
import {
  ensureWritableOutputDir,
  normalizeOutputBaseDir,
  outputSuffixUsesRole,
  requireValidOutputPath,
  validateOutputPrefix,
} from '../utils/outputStorage';
import { warnEnvOnce, type EnvSource } from './envValue';
import {
  CODE_SETTING_DEFAULTS,
  codeDefaultOutputBaseDir,
  DEFAULT_PAYMENT_LIMITS,
  DEFAULTED_SETTING_KEYS,
  envAnalysisModelText,
  envDefaultCoverLetterDocx,
  envDefaultMode,
  envDefaultModelText,
  envBuildModePriceMilli,
  envDefaultBuildMode,
  envDefaultResumeDocx,
  envDefaultTheme,
  envOutputBaseDir,
  envOutputPathPrefix,
  envOutputPathSuffix,
  envPaymentLimits,
  envRequireThreeDSecure,
  envSubscriptionPriceMilli,
  MAX_AMOUNT_CENTS,
  settingEnvFingerprint,
  type DefaultedSettingKey,
  type DefaultMode,
  type PaymentTargetLimits,
  type SettingSource,
  type ThemeMode,
} from './settingDefaults';

export type { BuildMode, DefaultMode, PaymentTargetLimits, SettingSource, ThemeMode };
export { DEFAULT_PAYMENT_LIMITS };

export type AIModelRecord = {
  id: string;
  name: string;
  provider: AIProvider;
  modelName: string;
  description: string;
  enabled: boolean;
  /*
   * No price. What a resume costs is the price of the build mode it is built
   * in (config/buildModes.ts); the model that runs it never changes it. A
   * `pricePerResumeMilli` an older build stored on a record is read past here
   * and dropped by the next settings write.
   */
  createdAt: string;
  updatedAt: string;
};

/** Which providers an admin has left switched on, keyed by provider id. */
export type ProvidersEnabled = Record<AIProvider, boolean>;

type AppSettings = {
  /** Which seats an administrator has left switched on, keyed by provider type. */
  providersEnabled: ProvidersEnabled;
  defaultMode: DefaultMode;
  defaultTheme: ThemeMode;
  /**
   * The mode Build Resumes starts on, and the mode of a run that names none:
   * stored > `.env`'s DEFAULT_TAILOR_MODE > `partial`.
   */
  defaultBuildMode: BuildMode;
  /** One of the administrator's own profiles (a person); '' is automatic. */
  defaultProfileId: string;
  defaultModelId: string;
  /**
   * The ONE model every job analysis runs on (owner decision J1), so every
   * posting's job field is read by the same model. A model record id; '' -
   * the default - is "the app default model". Not a builder default and not
   * in any ordinary account's payload: which model reads postings is the
   * administrator's business. Changing it reaches only postings never
   * analysed before (services/jobAnalysis/gate.ts never analyses one twice).
   */
  analysisModelId: string;
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
  outputBaseDir: string;
  /**
   * The administrator's half of where a resume is filed:
   * `<outputBaseDir>/<prefix>/<the account's own suffix>/<file>` (owner
   * decision O1). Validated by utils/outputStorage.ts `validateOutputPrefix`,
   * in its canonical spelling. A run renders it once, when it is submitted,
   * and records the folder it names as `orders.output_root`.
   */
  outputPathPrefix: string;
  /**
   * What each payment method may be bought in.
   *
   * There is no price of a credit beside this: a credit is a dollar, so a
   * purchase of $X credits exactly $X, and these dollar bounds are the whole of
   * what limits one.
   *
   * One flat list rather than a field per method, because the targets were not
   * a fixed set while this application chose the coin itself: every asset an
   * operator enabled was another possible row. They ARE a fixed set now -
   * `card` and `crypto` - because the coin is chosen on the provider's own page
   * from the provider's own list, and nothing can ask to be priced as one.
   *
   * A stored row naming a coin (`ethereum:USDT`) is therefore a record from
   * before that, and it is kept rather than dropped: the normalizer accepts it,
   * the admin page renders it and writes it back, and a settings save does not
   * quietly discard somebody's configuration. Nothing prices off it any more.
   * `pricing.ts` says the same thing from the resolving end.
   *
   * Bounds are STORED in cents, because a card or an invoice charges whole
   * cents and nothing finer can be bought. They reach the admin API in
   * thousandths of a dollar like every other amount (`PaymentLimitsView`), and
   * come back from it in dollars (`PaymentLimitsInput`).
   */
  paymentLimits: PaymentTargetLimits[];
  /**
   * Force the cardholder's bank to authenticate every card payment.
   *
   * Off by default, because turning it on changes what every buyer sees and
   * no existing install asked for it. On, it sets Stripe's
   * `request_three_d_secure` rather than leaving Stripe to decide, which is
   * what moves chargeback liability to the issuing bank.
   *
   * It costs something, and the cost is the point of the setting rather than
   * a flaw in it: a challenge is a step the buyer can fail or abandon, and a
   * card kept for later stops charging in one tap. An operator weighing fraud
   * against conversion is the only one who can make that trade, which is why
   * this is a setting and not a constant.
   */
  requireThreeDSecure: boolean;
  /**
   * What each paid subscription costs for 30 days, taken from the account's
   * credit balance when it is bought and at every renewal
   * (services/subscriptions), in thousandths of a dollar: $0.001 to $10,000.
   * `null` is NOT OFFERED - nobody can buy that tier, and its card asks for
   * the administrator. STORED as 0 when an administrator chose "not offered"
   * (a save of '' or $0), which beats a price `.env` gives; absent, `.env`'s
   * SUBSCRIPTION_<TIER>_PRICE_USD, else not offered.
   */
  premiumPriceMilli: number | null;
  premiumPlusPriceMilli: number | null;
  premiumMaxPriceMilli: number | null;
  /**
   * What one resume costs in each build mode, in thousandths of a dollar (0 is
   * free): stored > `.env`'s RESUME_<MODE>_PRICE_USD > 0. Saved as
   * `suitablePriceUsd` and its two siblings (config/buildModes.ts).
   */
  suitablePriceMilli: number;
  partialPriceMilli: number;
  fullPriceMilli: number;
  aiModels: AIModelRecord[];
  /**
   * The model PROVIDERS (config/aiProviders.ts): every place a type can run,
   * each with its own sign-in folder and limit. Always the three built-ins
   * first among their types, plus whatever an administrator added; stored
   * with only what an administrator set (`storableProviders`), so an
   * untouched install stores none and reads `.env` as it always did.
   */
  aiProviders: StoredAIProvider[];
};

/**
 * The settings slice the AI layer runs on.
 *
 * Read on the request path, so it carries only what the provider gate needs:
 * which providers an administrator has left switched on. Whether a provider
 * can run at all is the lock's question, and the lock is answered from the
 * environment rather than from this row - see `isProviderEnabled`.
 */
export type AIModelSettings = Pick<AppSettings, 'providersEnabled'> & {
  /**
   * The providers, when the caller has them. A type runs only while at least
   * one provider of it is enabled; a settings slice without the list (an
   * older caller, a test) reads as the three built-ins, all enabled.
   */
  aiProviders?: StoredAIProvider[];
};

/** The builder defaults an administrator sets under Admin -> Settings, as every page reads them. */
type BuilderDefaults = Pick<
  AppSettings,
  | 'defaultMode'
  | 'defaultTheme'
  | 'defaultBuildMode'
  | 'defaultProfileId'
  | 'defaultModelId'
  | 'defaultResumeDocxEnabled'
  | 'defaultCoverLetterDocxEnabled'
>;

/**
 * What the administrator's payload is built on: the switches, the builder
 * defaults and the runnable models.
 *
 * It used to be sent to every signed-in account as it stands, and it says far
 * more than an ordinary account may know - which seats exist and are switched
 * on, every model's provider and CLI model name. An ordinary account gets
 * `UserAppSettings` now; this is only ever read on the way to
 * `AdminAppSettings`.
 */
type BaseAppSettings = AIModelSettings & BuilderDefaults &
  Pick<AppSettings, 'aiModels' | 'analysisModelId'>;

/** One model as an ordinary account sees it: the id a request names it by, and the name an administrator gave it. */
export type UserModelOption = { id: string; name: string };

/**
 * `GET /api/resume/models`: everything a signed-in account that is not an
 * administrator may know about models and the builder's defaults.
 *
 * `models` is the runnable list, in the administrator's order, as ids and
 * display names and NOTHING else - no provider, no CLI model name, no
 * description, no price, no locks. A person picks a model by the name an
 * administrator gave it; what a run costs is the build mode's price, never
 * part of a model's label.
 * `defaultModelId` is always one of `models`, or '' when nothing can run.
 */
export type UserAppSettings = BuilderDefaults & {
  models: UserModelOption[];
  outputPathUsesJobTitle: boolean;
  /**
   * What one resume costs in each build mode, in thousandths: what the
   * builder's mode cards show - the same figures a quote reveals.
   */
  suitablePriceMilli: number;
  partialPriceMilli: number;
  fullPriceMilli: number;
};

/**
 * One provider this installation cannot run, and the models it would offer.
 *
 * Sent to an administrator only, so Admin -> Models can say why those models
 * do not run; an ordinary account is simply not offered them, because the
 * reason names CLI commands and .env variables. They are carried HERE rather
 * than left in the runnable list because that list is the set of models a
 * request may name, and every consumer of it - the default-model select, the
 * request resolver - is entitled to keep assuming so. A locked model is a
 * label, not a choice.
 */
export type ProviderLock = {
  id: AIProvider;
  label: string;
  reason: string;
  /** This install's enabled model records for the provider, in stored order. */
  models: AIModelRecord[];
};

type BaseAppSettingsWithDerived = BaseAppSettings & {
  /** Providers locked in this build, so Admin -> Models can say why their models do not run. */
  providerLocks: ProviderLock[];
};

export type AdminAppSettings = Omit<BaseAppSettingsWithDerived, 'aiModels' | 'aiProviders'> & {
  /** Every record, runnable or not. */
  aiModels: AIModelRecord[];
  /**
   * Every provider (config/aiProviders.ts), built-ins first among their type,
   * with each value in effect and where it came from. Administrators only:
   * folders and binaries are this server's business.
   */
  aiProviders: AdminAIProvider[];
  /**
   * The model names Admin -> Models may pick, per seat: every seat in catalog
   * order, locked ones included so a model can be prepared before the lock is
   * lifted. On every admin settings and model response, so the form needs no
   * second request to stay in step with a mutation.
   */
  providerModelOptions: ProviderModelOptions[];
  outputBaseDir: string;
  /** Where a resume would be filed with it is POST /api/admin/output-path/preview's to say. */
  outputPathPrefix: string;
  /** Per method, in thousandths of a dollar. */
  paymentLimits: PaymentLimitsView[];
  requireThreeDSecure: boolean;
  /** Each paid subscription's price for 30 days, in thousandths; null is not offered. Saved as `premiumPriceUsd`... */
  premiumPriceMilli: number | null;
  premiumPlusPriceMilli: number | null;
  premiumMaxPriceMilli: number | null;
  /**
   * What one resume costs in each build mode, in thousandths; 0 is free and
   * Admin -> Settings shows it in red. Saved as `suitablePriceUsd`...
   */
  suitablePriceMilli: number;
  partialPriceMilli: number;
  fullPriceMilli: number;
  /**
   * The modes priced $0 only because a `.env` line (RESUME_<MODE>_PRICE_USD)
   * could not be read: reads 0 like an unset one, but is nobody's decision,
   * so the page shows it red and names the variable.
   */
  unreadableModePrices: BuildMode[];
  /**
   * Where each setting that has a `.env` default got the value in effect:
   * 'admin' (stored here - Reset to default is offered), 'env' (the variable
   * in config/settingDefaults.ts's `APP_SETTING_ENV_VARIABLES`) or 'default'
   * (the code's). Administrators only: an ordinary account is never told how
   * the server is configured.
   */
  settingSources: SettingSources;
  /** What each of those would be with nothing stored: what Reset to default gives. */
  settingDefaults: AppSettingDefaultsView;
  /**
   * Per payment method in `paymentLimits`, where ITS row came from - each
   * method resolves on its own: a stored row of the method, else `.env`'s
   * PAYMENT_<METHOD>_*_USD, else the code's - and, from `.env`, the
   * variables that set it (only those: "From .env (NAME)" names the line to
   * look for).
   */
  paymentLimitSources: Record<string, PaymentLimitSource>;
  /**
   * The default model an administrator set that cannot run now - switched
   * off, its provider off or locked, or gone - while another is the default
   * in its place (`settingSources.defaultModelId` says where that one came
   * from); null otherwise. Still stored: it is the default again the moment
   * it can run, so Admin -> Models names it and offers Reset to default.
   */
  staleDefaultModelId: string | null;
};

/** Where one payment method's limits came from (`AdminAppSettings.paymentLimitSources`). */
export type PaymentLimitSource = { source: SettingSource; variables: string[] };

/**
 * The app-settings fields an administrator may leave unset, as STORED: only
 * the ones an administrator set (owner decision S1). Absent is "not set": the
 * value in effect is then `.env`'s, else the code's. Every other field of the
 * row is stored whole, as before - none of them has a `.env` default.
 */
type SettingOverrides = Partial<Pick<AppSettings, DefaultedSettingKey>>;

export type SettingSources = Record<DefaultedSettingKey, SettingSource>;

/** Each defaulted field's value with no administrator's: `.env`'s, else the code's. Payment bounds in cents. */
type AppSettingDefaults = Pick<AppSettings, DefaultedSettingKey>;

/** The same, as the admin payload serves it: payment bounds in thousandths, like every amount. */
export type AppSettingDefaultsView = Omit<AppSettingDefaults, 'paymentLimits'> & {
  paymentLimits: PaymentLimitsView[];
};

/**
 * A settings read: the values in effect, and how they were arrived at. The
 * cache holds this, so a page's sources and defaults cost nothing extra.
 */
type SettingsState = {
  settings: AppSettings;
  overrides: SettingOverrides;
  sources: SettingSources;
  defaults: AppSettingDefaults;
  /** Per method in `settings.paymentLimits`: whose its row is. */
  limitSources: Record<string, PaymentLimitSource>;
  /** The paid tiers whose price is "not offered" only because a value somebody set could not be read. */
  unreadablePrices: UnreadableSubscriptionPrice[];
  /** The build modes priced $0 only because their `.env` line could not be read. */
  unreadableModePrices: BuildMode[];
};

/**
 * A paid tier whose price reads as not offered only because a value somebody
 * SET could not be read: a price hand-edited into the stored row in a shape
 * this app never writes ('admin'), or a SUBSCRIPTION_<TIER>_PRICE_USD that is
 * not an amount in dollars ('env') - with nothing under it that is a price.
 * The page and a purchase take it as not offered; the renewal sweep must not,
 * or one typo would end every subscription of that tier as it falls due
 * (`getSubscriptionPriceReading`).
 */
export type UnreadableSubscriptionPrice = { tier: PaidSubscriptionId; source: 'admin' | 'env' };

/** The prices in effect, and which of them could not be read. */
export type SubscriptionPriceReading = {
  prices: SubscriptionPrices;
  unreadable: UnreadableSubscriptionPrice[];
};

/**
 * A save from Admin -> Settings. Not the model list: models are created, edited
 * and edited one at a time through the /api/admin/models routes, which check
 * each model name against its seat's options. A list arriving here would
 * skip that, so `updateAppSettings` ignores one.
 *
 * Every field is optional and only what is named changes. A field that has a
 * `.env` default (`DEFAULTED_SETTING_KEYS`) may be `null`: Reset to default,
 * which removes the stored value so `.env` - else the code - decides again.
 */
export type AppSettingsUpdate = Resettable<Partial<Omit<BaseAppSettings, 'aiModels'>>> & {
  outputBaseDir?: string | null;
  outputPathPrefix?: string | null;
  /** Per method, in dollars. See `PaymentLimitsInput`. `null` or `[]` resets. */
  paymentLimits?: PaymentLimitsInput[] | null;
  requireThreeDSecure?: boolean | null;
  /**
   * A paid subscription's price for 30 days, in DOLLARS ("9.99", or the JSON
   * number 9.99) - never in thousandths: a `premiumPriceMilli` in a save is
   * refused. '' or $0 is the administrator's "not offered", which beats
   * `.env`; `null` is Reset to default.
   */
  premiumPriceUsd?: string | number | null;
  premiumPlusPriceUsd?: string | number | null;
  premiumMaxPriceUsd?: string | number | null;
  /**
   * What one resume costs in a build mode, in DOLLARS ("0.023", or the JSON
   * number 0.023) from 0 to 1000 in steps of $0.001 - never in thousandths: a
   * `partialPriceMilli` in a save is refused. A price is required: '' is
   * refused, and `null` is Reset to default.
   */
  suitablePriceUsd?: string | number | null;
  partialPriceUsd?: string | number | null;
  fullPriceUsd?: string | number | null;
};

/** `null` beside each defaulted field's own type: what a Reset to default sends. */
type Resettable<T> = {
  [K in keyof T]: K extends DefaultedSettingKey ? T[K] | null : T[K];
};

/**
 * The currency every amount is in. A credit is one of these, and the payment
 * limits below are the only bounds on buying them - read by the buy page from
 * `/api/payments/methods`, which also says which providers are configured, so
 * there is one answer to "what can I buy", not a settings copy that can
 * disagree with the checkout.
 */
export const CREDIT_CURRENCY = 'usd';

/** One method's limits as the admin API SENDS them: thousandths of a dollar, like every amount. */
export type PaymentLimitsView = {
  target: string;
  minMilli: number;
  maxMilli: number;
  presetsMilli: number[];
};

/**
 * One method's limits as the admin API TAKES them: dollars ("2.50", or the
 * JSON number 2.5), each a whole number of cents, since a card cannot be
 * charged half of one.
 */
export type PaymentLimitsInput = {
  target?: unknown;
  minUsd?: unknown;
  maxUsd?: unknown;
  presetsUsd?: unknown;
  /** `true` with a `target`: that method's stored row goes - Reset to default for one method. */
  reset?: unknown;
};

export const APP_SETTINGS_KEY = 'app-settings';

function slugifyModelPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildModelId(provider: AIProvider, modelName: string): string {
  const slug = slugifyModelPart(modelName) || 'model';
  return `${provider}-${slug}`;
}

function createDefaultModelRecords(): AIModelRecord[] {
  const now = new Date().toISOString();
  /*
   * Display names say what a person picks, and nothing about how it is paid
   * for: every model is a subscription seat, and the name is the only part
   * of a record a user ever sees.
   */
  const seeds: Array<Pick<AIModelRecord, 'name' | 'provider' | 'modelName' | 'description'>> = [
    // The Claude seat's models come first, so `runnableModels[0]` - the
    // fallback whenever a stored default no longer resolves - is on the seat a
    // fresh install defaults to.
    {
      name: 'Claude Sonnet',
      provider: 'claude-cli',
      modelName: 'sonnet',
      description: 'Balanced default for tailoring, analysis and extraction on the subscription seat.',
    },
    {
      name: 'Claude Opus',
      provider: 'claude-cli',
      modelName: 'opus',
      description: 'Highest-capability model on the subscription seat, for the most demanding prompts.',
    },
    {
      name: 'Claude Haiku',
      provider: 'claude-cli',
      modelName: 'haiku',
      description: 'Fastest model on the subscription seat, for classification and short extractions.',
    },
    /*
     * The ChatGPT seat, as ONE entry.
     *
     * `modelName: 'default'` is a sentinel: the argv builder omits `-m`
     * entirely, so the turn runs on whatever that account is configured for.
     * That is the only model name that is true on every account - Codex
     * resolves its catalog from the signed-in account at runtime, so there is
     * no static list to seed and any specific id hard-coded here would be a
     * guess that fails at request time on somebody else's plan.
     *
     * A specific model is a record an administrator adds under Admin -> Models,
     * which already takes a provider plus a model name.
     *
     * Seeded AFTER the Claude seat models on purpose: `defaultSeedModelId`
     * takes the first unlocked seed, and a fresh install should still land on
     * Claude Sonnet rather than silently changing which seat it spends.
     */
    {
      name: 'Codex',
      provider: 'codex-cli',
      modelName: CODEX_DEFAULT_MODEL,
      description:
        "Runs the local codex CLI on your ChatGPT subscription, using that account's own default model.",
    },
    /*
     * The Google seat, as one entry for the same reason: `auto` is the CLI's
     * own default, which picks Pro or Flash per request from what the signed-in
     * account may use. Last, so it changes nobody's default.
     */
    {
      name: 'Gemini',
      provider: 'gemini-cli',
      modelName: GEMINI_DEFAULT_MODEL,
      description:
        'Runs the local gemini CLI on the signed-in Google account, letting it choose the model per request.',
    },
  ];

  const seenProviderModels = new Set<string>();

  return seeds
    .filter((seed) => {
      const key = `${seed.provider}:${seed.modelName}`;
      if (seenProviderModels.has(key)) {
        return false;
      }
      seenProviderModels.add(key);
      return true;
    })
    .map((seed) => ({
      id: buildModelId(seed.provider, seed.modelName),
      name: seed.name,
      provider: seed.provider,
      modelName: seed.modelName,
      description: seed.description,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }));
}

function allProvidersEnabled(value = true): ProvidersEnabled {
  return AI_PROVIDER_IDS.reduce((acc, id) => {
    acc[id] = value;
    return acc;
  }, {} as ProvidersEnabled);
}

const DEFAULT_MODEL_RECORDS = createDefaultModelRecords();

/**
 * What a fresh install defaults to, skipping anything locked here.
 *
 * The Claude seat's default model, and otherwise the first seed of the first
 * seat this deployment does not lock: on a build with the Claude seat locked it
 * lands on the next seat in catalog order. Every seed is a subscription seat,
 * so nothing here can start billing per token. With every seat locked nothing
 * can run at all; the Claude seat's id is kept, so lifting the lock restores
 * it.
 */
export function defaultSeedModelId(): string {
  const preferred = buildModelId('claude-cli', DEFAULT_CLAUDE_CLI_MODEL);
  if (DEFAULT_MODEL_RECORDS.some((model) => model.id === preferred && !isProviderLocked(model.provider))) {
    return preferred;
  }
  return (
    DEFAULT_MODEL_RECORDS.find((model) => !isProviderLocked(model.provider))?.id ?? preferred
  );
}

/**
 * The CODE defaults: what every setting is when neither an administrator nor
 * `.env` says otherwise. The `.env` layer goes over these on every read
 * (`composeSettings`), never into this constant: it is built once, at load.
 */
const DEFAULT_SETTINGS: AppSettings = {
  providersEnabled: allProvidersEnabled(),
  defaultMode: CODE_SETTING_DEFAULTS.defaultMode,
  defaultTheme: CODE_SETTING_DEFAULTS.defaultTheme,
  defaultBuildMode: CODE_SETTING_DEFAULTS.defaultBuildMode,
  defaultProfileId: '',
  defaultModelId: defaultSeedModelId(),
  analysisModelId: CODE_SETTING_DEFAULTS.analysisModelId,
  defaultResumeDocxEnabled: CODE_SETTING_DEFAULTS.defaultResumeDocxEnabled,
  defaultCoverLetterDocxEnabled: CODE_SETTING_DEFAULTS.defaultCoverLetterDocxEnabled,
  outputBaseDir: codeDefaultOutputBaseDir(),
  outputPathPrefix: CODE_SETTING_DEFAULTS.outputPathPrefix,
  paymentLimits: DEFAULT_PAYMENT_LIMITS,
  requireThreeDSecure: CODE_SETTING_DEFAULTS.requireThreeDSecure,
  premiumPriceMilli: CODE_SETTING_DEFAULTS.premiumPriceMilli,
  premiumPlusPriceMilli: CODE_SETTING_DEFAULTS.premiumPlusPriceMilli,
  premiumMaxPriceMilli: CODE_SETTING_DEFAULTS.premiumMaxPriceMilli,
  suitablePriceMilli: CODE_SETTING_DEFAULTS.suitablePriceMilli,
  partialPriceMilli: CODE_SETTING_DEFAULTS.partialPriceMilli,
  fullPriceMilli: CODE_SETTING_DEFAULTS.fullPriceMilli,
  aiModels: DEFAULT_MODEL_RECORDS,
  aiProviders: normalizeStoredProviders([]),
};

function clonePaymentLimits(rows: PaymentTargetLimits[]): PaymentTargetLimits[] {
  return rows.map((row) => ({ ...row, presetsCents: [...row.presetsCents] }));
}

function cloneDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    providersEnabled: { ...DEFAULT_SETTINGS.providersEnabled },
    paymentLimits: clonePaymentLimits(DEFAULT_SETTINGS.paymentLimits),
    aiModels: DEFAULT_SETTINGS.aiModels.map((model) => ({ ...model })),
    aiProviders: DEFAULT_SETTINGS.aiProviders.map((entry) => ({ ...entry })),
  };
}

/**
 * A boolean from a stored row, or from an admin's save.
 *
 * `strict` is the difference between the two callers. Reading the database is
 * forgiving - a row written by an older release simply has no such key, and
 * falling back is right. A save from the admin page is not: a key that IS
 * present and is not a boolean is a client sending nonsense, and silently
 * substituting the old value would tell them it saved when it did not.
 */
function normalizeBooleanSetting(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  strict: boolean
): boolean {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (strict && hasOwnProperty(source, key)) {
    throw new Error(`${key} must be a boolean`);
  }
  return fallback;
}

function hasOwnProperty(source: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeThemeMode(value: unknown, fallback: ThemeMode): ThemeMode {
  return value === 'light' || value === 'dark' ? value : fallback;
}

function normalizeDefaultMode(value: unknown, fallback: DefaultMode): DefaultMode {
  return value === 'preview' || value === 'generate' ? value : fallback;
}

function normalizeDefaultBuildMode(value: unknown, fallback: BuildMode): BuildMode {
  return isBuildMode(value) ? value : fallback;
}

/**
 * The per-target purchase limits, as stored, checked field by field.
 *
 * Every bound here is its own check - and the cross-field one matters most: a
 * row whose minimum
 * sits above its maximum refuses every purchase of that method, with a message
 * pointing at the buyer's amount rather than at the setting that is wrong.
 *
 * A row naming no target, or a target already claimed, is dropped rather than
 * merged. Two rows for `card` would make which one applies depend on array
 * order, which is not a thing an operator can see or reason about.
 */
function normalizePaymentLimits(
  input: unknown,
  fallback: PaymentTargetLimits[],
  strict = false
): PaymentTargetLimits[] {
  if (strict && typeof input !== 'undefined' && !Array.isArray(input)) {
    throw new Error('Stored payment limits must be an array');
  }

  const rawEntries = Array.isArray(input) ? input : fallback;
  const seenTargets = new Set<string>();

  const rows = rawEntries
    .map((entry, index) => {
      const position = index + 1;
      if (typeof entry !== 'object' || entry === null) {
        if (strict) throw new Error(`Payment limit ${position} is invalid`);
        return null;
      }

      const raw = entry as Partial<PaymentTargetLimits>;
      const target = typeof raw.target === 'string' ? raw.target.trim() : '';
      if (!target) {
        if (strict) throw new Error(`Payment limit ${position} is missing a target`);
        return null;
      }
      if (seenTargets.has(target)) {
        if (strict) throw new Error(`Payment limit ${position} repeats the target ${target}`);
        return null;
      }
      seenTargets.add(target);

      const minCents = normalizeStoredCents(
        raw.minCents, 1, 1, MAX_AMOUNT_CENTS, `${target} minCents`, strict
      );
      const maxCents = normalizeStoredCents(
        raw.maxCents, MAX_AMOUNT_CENTS, 1, MAX_AMOUNT_CENTS, `${target} maxCents`, strict
      );
      if (minCents > maxCents) {
        if (strict) {
          throw new Error(`${target} minCents cannot be greater than maxCents`);
        }
        return null;
      }

      // A fee a stored row still carries (`feeBps`, `feeFixedCents`) is not
      // read: purchases take no fee, and the row is written without it.

      /*
       * Presets are sorted and deduped here, so the buttons come out in a
       * sensible order whatever order they were saved in. They are NOT filtered
       * against the bounds here - `presetsFor` does that, beside the bounds it
       * is judged against.
       */
      const presetSource = Array.isArray(raw.presetsCents) ? raw.presetsCents : [];
      const presetsCents = [
        ...new Set(
          presetSource
            .map((value) =>
              typeof value === 'number' ? value : /^\s*\d+\s*$/.test(String(value)) ? Number(value) : Number.NaN
            )
            .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT_CENTS)
        ),
      ].sort((left, right) => left - right);

      return { target, minCents, maxCents, presetsCents };
    })
    .filter((entry): entry is PaymentTargetLimits => entry !== null);

  /*
   * Never empty: an empty list would mean "no bounds anywhere", so the
   * fallback stands in - and the fallback IS the defaults, `.env`'s limits
   * over the code's (`composeSettings` lays the stored row over them). That
   * is also what an administrator who removes every row and saves gets: the
   * update path reads an empty list as a reset and stores nothing at all.
   */
  return rows.length > 0 ? rows : clonePaymentLimits(fallback);
}

function normalizeAIModelProvider(value: unknown): AIProvider | null {
  return coerceProviderId(value);
}

function normalizeAIModelText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeAIModelRecords(input: unknown, fallback: AIModelRecord[], strict = false): AIModelRecord[] {
  if (strict && typeof input !== 'undefined' && !Array.isArray(input)) {
    throw new Error('Stored AI models must be an array');
  }

  const rawEntries = Array.isArray(input) ? input : fallback;
  const seenIds = new Set<string>();
  const seenProviderModels = new Set<string>();

  return rawEntries
    .map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        if (strict) {
          throw new Error(`Stored AI model ${index + 1} is invalid`);
        }
        return null;
      }

      const raw = entry as Partial<AIModelRecord>;
      const provider = normalizeAIModelProvider(raw.provider);
      if (!provider) {
        if (strict) {
          throw new Error(`Stored AI model ${index + 1} has an invalid provider`);
        }
        return null;
      }

      const modelName = normalizeAIModelText(raw.modelName);
      if (!modelName) {
        if (strict) {
          throw new Error(`Stored AI model ${index + 1} is missing a modelName`);
        }
        return null;
      }

      const id = normalizeAIModelText(raw.id) || buildModelId(provider, modelName);
      if (seenIds.has(id)) {
        if (strict) {
          throw new Error(`Stored AI model ${index + 1} has a duplicate id`);
        }
        return null;
      }
      seenIds.add(id);

      const providerModelKey = `${provider}:${modelName.toLowerCase()}`;
      if (seenProviderModels.has(providerModelKey)) {
        if (strict) {
          throw new Error(`Stored AI model ${index + 1} duplicates provider/modelName`);
        }
        return null;
      }
      seenProviderModels.add(providerModelKey);

      const createdAt = normalizeAIModelText(raw.createdAt) || new Date().toISOString();
      const updatedAt = normalizeAIModelText(raw.updatedAt) || createdAt;

      return {
        id,
        name: normalizeAIModelText(raw.name) || modelName,
        provider,
        modelName,
        description: normalizeAIModelText(raw.description),
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
        // Built from the known fields only: a `pricePerResumeMilli` an older
        // build stored is read past, never fails the read, and is gone from
        // the row at the next write.
        createdAt,
        updatedAt,
      } satisfies AIModelRecord;
    })
    .filter((entry): entry is AIModelRecord => Boolean(entry));
}

function resolveDefaultModelId(
  requestedDefaultModelId: unknown,
  aiModels: AIModelRecord[],
  providerSettings: AIModelSettings,
  fallbackDefaultModelId: string
): string {
  const runnableModels = aiModels.filter((model) => model.enabled && isProviderEnabled(model.provider, providerSettings));
  const availableModels = runnableModels.length > 0 ? runnableModels : aiModels.filter((model) => model.enabled);
  const preferredId = typeof requestedDefaultModelId === 'string' ? requestedDefaultModelId.trim() : '';

  if (preferredId && availableModels.some((model) => model.id === preferredId)) {
    return preferredId;
  }

  if (availableModels.some((model) => model.id === fallbackDefaultModelId)) {
    return fallbackDefaultModelId;
  }

  return availableModels[0]?.id ?? aiModels[0]?.id ?? '';
}

/**
 * The models a resume or a request may pick: enabled, under a provider that is
 * both switched on and runnable here.
 *
 * This is exactly the list an ordinary account is shown (`UserAppSettings`),
 * by id and display name. A locked provider's models are not among them; the
 * administrator's payload describes those separately, as `providerLocks`.
 */
export function getRunnableModels(settings: AIModelSettings & Pick<AppSettings, 'aiModels'>): AIModelRecord[] {
  return settings.aiModels.filter(
    (model) => model.enabled && isProviderEnabled(model.provider, settings)
  );
}

/**
 * Reads the enable flags from the `providersEnabled` record, one per seat in
 * the catalog; a seat the record does not name keeps the fallback. Keys for
 * anything else are ignored, so they never reach a written row.
 */
function normalizeProvidersEnabled(source: Record<string, unknown>, fallback: ProvidersEnabled): ProvidersEnabled {
  const record =
    typeof source.providersEnabled === 'object' && source.providersEnabled !== null
      ? (source.providersEnabled as Record<string, unknown>)
      : null;

  const result = {} as ProvidersEnabled;
  for (const id of AI_PROVIDER_IDS) {
    const fromRecord = record?.[id];
    if (typeof fromRecord === 'boolean') {
      result[id] = fromRecord;
      continue;
    }
    result[id] = fallback[id] ?? true;
  }
  return result;
}

/**
 * A stored payment bound, in whole cents, inside a range - or the fallback.
 *
 * The only reader of the limits as STORED; what an administrator types arrives
 * in dollars and is parsed exactly by `parsePaymentLimitsInput` before it is
 * ever stored. So anything here that is not a whole number of cents - "2.5",
 * "25abc" - was hand-edited into the row, and is the fallback rather than
 * rounded or truncated into a bound nobody set. Strict mode - how the stored
 * row is read - refuses it instead, so it is reported; out of range clamps
 * outside strict mode, since the nearest bound is closer to what was meant.
 */
function normalizeStoredCents(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
  strict: boolean
): number {
  if (typeof value === 'undefined') return fallback;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    if (strict) throw new Error(`${field} must be a whole number of cents between ${min} and ${max}`);
    if (!Number.isSafeInteger(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
  return parsed;
}

/** The three subscription price fields, in catalogue order (accountSubscriptions.ts `SUBSCRIPTION_PRICE_FIELDS`). */
const SUBSCRIPTION_PRICE_SETTINGS: readonly SubscriptionPriceSetting[] = PAID_SUBSCRIPTION_IDS.map(
  (tier) => SUBSCRIPTION_PRICE_FIELDS[tier].setting
);

/**
 * A subscription price as this app STORES one: a whole number of thousandths
 * from 0 - the administrator's "not offered" - to $10,000.
 */
function isStoredPriceMilli(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SUBSCRIPTION_PRICE_MILLI;
}

/**
 * A stored price as it is in effect: 0 is not offered (null), anything else
 * the price. A value this app never writes - hand-edited into the row - was
 * taken out by `withoutUnsetOverrides` with a warning, and reads as the
 * fallback: `.env`'s price, else not offered.
 */
function readStoredPriceMilli(value: unknown, fallback: number | null): number | null {
  if (!isStoredPriceMilli(value)) return fallback;
  return value === 0 ? null : value;
}

/**
 * A stored build-mode price as it is in effect: the integer this app wrote
 * (0 is free, and an administrator's choice that beats `.env`), else the
 * fallback. A value this app never writes - hand-edited into the row - was
 * taken out by `withoutUnsetOverrides` with a warning.
 */
function readStoredModePriceMilli(value: unknown, fallback: number): number {
  return isStoredBuildModePriceMilli(value) ? value : fallback;
}

function normalizeSettings(
  input: unknown,
  fallback: AppSettings = DEFAULT_SETTINGS,
  strict = false
): AppSettings {
  if (strict && (typeof input !== 'object' || input === null)) {
    throw new Error('Settings file must contain a JSON object');
  }

  const source: Partial<AppSettings> & Record<string, unknown> =
    typeof input === 'object' && input !== null
      ? (input as Partial<AppSettings> & Record<string, unknown>)
      : {};

  const providersEnabled = normalizeProvidersEnabled(source, fallback.providersEnabled);

  const aiModels = normalizeAIModelRecords(source.aiModels, fallback.aiModels, strict);
  const defaultModelId = resolveDefaultModelId(
    source.defaultModelId,
    aiModels,
    { providersEnabled },
    fallback.defaultModelId
  );

  return {
    providersEnabled,
    defaultMode:
      typeof source.defaultMode === 'undefined'
        ? fallback.defaultMode
        : source.defaultMode === 'preview' || source.defaultMode === 'generate'
          ? source.defaultMode
          : strict
            ? (() => { throw new Error('defaultMode must be "preview" or "generate"'); })()
            : normalizeDefaultMode(source.defaultMode, fallback.defaultMode),
    defaultTheme:
      typeof source.defaultTheme === 'undefined'
        ? fallback.defaultTheme
        : source.defaultTheme === 'light' || source.defaultTheme === 'dark'
          ? source.defaultTheme
          : strict
            ? (() => { throw new Error('defaultTheme must be "light" or "dark"'); })()
            : normalizeThemeMode(source.defaultTheme, fallback.defaultTheme),
    defaultBuildMode:
      typeof source.defaultBuildMode === 'undefined'
        ? fallback.defaultBuildMode
        : isBuildMode(source.defaultBuildMode)
          ? source.defaultBuildMode
          : strict
            ? (() => { throw new DefaultBuildModeError(); })()
            : normalizeDefaultBuildMode(source.defaultBuildMode, fallback.defaultBuildMode),
    defaultProfileId:
      typeof source.defaultProfileId === 'string'
        ? source.defaultProfileId.trim()
        : strict && hasOwnProperty(source, 'defaultProfileId')
          ? (() => { throw new Error('defaultProfileId must be a string'); })()
          : fallback.defaultProfileId,
    defaultModelId,
    // Kept as stored, even when it no longer names a model that runs: a
    // switched-off model comes back on, and the gate falls back to the app
    // default meanwhile (resolveAnalysisModel).
    analysisModelId:
      typeof source.analysisModelId === 'string'
        ? source.analysisModelId.trim()
        : strict && hasOwnProperty(source, 'analysisModelId')
          ? (() => { throw new Error('analysisModelId must be a string'); })()
          : fallback.analysisModelId,
    defaultResumeDocxEnabled: typeof source.defaultResumeDocxEnabled === 'boolean'
      ? source.defaultResumeDocxEnabled
      : strict && hasOwnProperty(source, 'defaultResumeDocxEnabled')
        ? (() => { throw new Error('defaultResumeDocxEnabled must be a boolean'); })()
      : fallback.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: typeof source.defaultCoverLetterDocxEnabled === 'boolean'
      ? source.defaultCoverLetterDocxEnabled
      : strict && hasOwnProperty(source, 'defaultCoverLetterDocxEnabled')
        ? (() => { throw new Error('defaultCoverLetterDocxEnabled must be a boolean'); })()
      : fallback.defaultCoverLetterDocxEnabled,
    outputBaseDir:
      typeof source.outputBaseDir === 'undefined'
        ? normalizeOutputBaseDir(fallback.outputBaseDir)
        : typeof source.outputBaseDir === 'string' && source.outputBaseDir.trim()
          ? normalizeOutputBaseDir(source.outputBaseDir)
          : strict
            ? (() => { throw new Error('outputBaseDir must be a non-empty string'); })()
            : normalizeOutputBaseDir(fallback.outputBaseDir),
    // Refused by name - the validator's own sentences, as an OutputPathError
    // whose `field` the settings route passes on - when read strictly; read
    // leniently, a prefix that does not pass is not used.
    outputPathPrefix:
      typeof source.outputPathPrefix === 'undefined'
        ? fallback.outputPathPrefix
        : strict
          ? requireValidOutputPath('prefix', source.outputPathPrefix)
          : (() => {
              const check = validateOutputPrefix(source.outputPathPrefix);
              return check.ok ? check.value : fallback.outputPathPrefix;
            })(),
    paymentLimits: normalizePaymentLimits(source.paymentLimits, fallback.paymentLimits, strict),
    requireThreeDSecure: normalizeBooleanSetting(
      source, 'requireThreeDSecure', fallback.requireThreeDSecure, strict
    ),
    premiumPriceMilli: readStoredPriceMilli(source.premiumPriceMilli, fallback.premiumPriceMilli),
    premiumPlusPriceMilli: readStoredPriceMilli(source.premiumPlusPriceMilli, fallback.premiumPlusPriceMilli),
    premiumMaxPriceMilli: readStoredPriceMilli(source.premiumMaxPriceMilli, fallback.premiumMaxPriceMilli),
    suitablePriceMilli: readStoredModePriceMilli(source.suitablePriceMilli, fallback.suitablePriceMilli),
    partialPriceMilli: readStoredModePriceMilli(source.partialPriceMilli, fallback.partialPriceMilli),
    fullPriceMilli: readStoredModePriceMilli(source.fullPriceMilli, fallback.fullPriceMilli),
    aiModels,
    // Read leniently even from a strict caller: a provider this build cannot
    // use is dropped with a warning (normalizeStoredProviders), and the
    // admin's mutations - the only writer - check every field by name first.
    aiProviders: normalizeStoredProviders(
      Array.isArray(source.aiProviders) ? source.aiProviders : fallback.aiProviders
    ),
  };
}


function assertAtLeastOneProviderEnabled(settings: AppSettings): void {
  if (!AI_PROVIDER_IDS.some((id) => settings.providersEnabled[id])) {
    throw new Error('At least one AI model must remain enabled');
  }

  // Ticked-but-locked is not enough. Without this an admin could save a row
  // whose only enabled provider cannot run here, and every generate would then
  // fail with "no enabled AI models" - a message that points at the model list
  // rather than at the box they just ticked.
  if (!AI_PROVIDER_IDS.some((id) => isProviderEnabled(id, settings))) {
    const locked = listLockedProviderIds().map((id) => getCatalogProviderLabel(id)).join(', ');
    throw new Error(
      `At least one unlocked AI provider must remain enabled. Locked in this installation: ${locked}.`
    );
  }
}

function assertAtLeastOneRunnableModel(settings: AppSettings): void {
  if (getRunnableModels(settings).length === 0) {
    throw new Error('At least one enabled model must remain available under an enabled provider');
  }
}

/**
 * The default model id the app actually OFFERS, which is not always the one
 * stored.
 *
 * They differ whenever the stored id is not runnable right now - a provider
 * locked since it was chosen, say. The value served has to be one of the models
 * listed beside it, or the picker shows a default nobody can select; and it
 * falls back exactly as `resolveRequestedAIModel` does for a run that names no
 * model, so what the page shows as the default is what such a run uses.
 */
function effectiveDefaultModelId(settings: AppSettings): string {
  const runnable = getRunnableModels(settings);
  return runnable.some((model) => model.id === settings.defaultModelId)
    ? settings.defaultModelId
    : runnable[0]?.id ?? '';
}

/** The builder defaults, with the default model as the app actually offers it. */
function toBuilderDefaults(settings: AppSettings): BuilderDefaults {
  return {
    defaultMode: settings.defaultMode,
    defaultTheme: settings.defaultTheme,
    defaultBuildMode: settings.defaultBuildMode,
    defaultProfileId: settings.defaultProfileId,
    defaultModelId: effectiveDefaultModelId(settings),
    defaultResumeDocxEnabled: settings.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: settings.defaultCoverLetterDocxEnabled,
  };
}

function toBaseSettings(settings: AppSettings): BaseAppSettings {
  const runnable = getRunnableModels(settings);
  return {
    providersEnabled: { ...settings.providersEnabled },
    ...toBuilderDefaults(settings),
    aiModels: runnable.map((model) => ({ ...model })),
    analysisModelId: settings.analysisModelId,
  };
}

/**
 * The ordinary account's view, built field by field rather than by deleting
 * from a bigger object: a field added to the settings later reaches nobody
 * here until somebody decides it should.
 *
 * `outputPathUsesJobTitle` is the reader's own: whether THEIR folder path
 * files by `{{role}}`, which is when the builder asks for a role. The route
 * passes the account's suffix; without one it is the default's.
 */
function toUserSettings(settings: AppSettings, outputPathSuffix: string): UserAppSettings {
  return {
    models: getRunnableModels(settings).map((model) => ({ id: model.id, name: model.name })),
    ...toBuilderDefaults(settings),
    outputPathUsesJobTitle: outputSuffixUsesRole(outputPathSuffix),
    suitablePriceMilli: settings.suitablePriceMilli,
    partialPriceMilli: settings.partialPriceMilli,
    fullPriceMilli: settings.fullPriceMilli,
  };
}

function describeProviderLocks(settings: AppSettings): ProviderLock[] {
  return listLockedProviderIds().map((id) => ({
    id,
    label: getCatalogProviderLabel(id),
    reason: getProviderLockReason(id),
    models: settings.aiModels
      .filter((model) => model.provider === id && model.enabled)
      .map((model) => ({ ...model })),
  }));
}

function toBaseSettingsWithDerived(settings: AppSettings): BaseAppSettingsWithDerived {
  return {
    ...toBaseSettings(settings),
    providerLocks: describeProviderLocks(settings),
  };
}

/** Every seat's model-name options, in catalog order, as the admin payload carries them. */
export function listSeatModelOptions(env: NodeJS.ProcessEnv = process.env): ProviderModelOptions[] {
  return AI_PROVIDER_IDS.map((provider) => ({
    provider,
    label: getCatalogProviderLabel(provider),
    models: listProviderModelOptions(provider, env),
  }));
}

function toAdminSettings(state: SettingsState): AdminAppSettings {
  const { settings } = state;
  return {
    ...toBaseSettingsWithDerived(settings),
    aiModels: settings.aiModels.map((model) => ({ ...model })),
    aiProviders: resolveProviders(settings.aiProviders).map(toAdminProvider),
    providerModelOptions: listSeatModelOptions(),
    outputBaseDir: settings.outputBaseDir,
    outputPathPrefix: settings.outputPathPrefix,
    paymentLimits: settings.paymentLimits.map(toPaymentLimitsView),
    requireThreeDSecure: settings.requireThreeDSecure,
    premiumPriceMilli: settings.premiumPriceMilli,
    premiumPlusPriceMilli: settings.premiumPlusPriceMilli,
    premiumMaxPriceMilli: settings.premiumMaxPriceMilli,
    suitablePriceMilli: settings.suitablePriceMilli,
    partialPriceMilli: settings.partialPriceMilli,
    fullPriceMilli: settings.fullPriceMilli,
    unreadableModePrices: [...state.unreadableModePrices],
    settingSources: { ...state.sources },
    staleDefaultModelId:
      state.overrides.defaultModelId !== undefined && state.overrides.defaultModelId !== settings.defaultModelId
        ? state.overrides.defaultModelId
        : null,
    paymentLimitSources: Object.fromEntries(
      Object.entries(state.limitSources).map(([target, entry]) => [target, { ...entry, variables: [...entry.variables] }])
    ),
    settingDefaults: {
      ...state.defaults,
      // As the builder defaults serve it: one of the models listed beside it.
      defaultModelId: effectiveDefaultModelId({ ...settings, defaultModelId: state.defaults.defaultModelId }),
      paymentLimits: state.defaults.paymentLimits.map(toPaymentLimitsView),
    },
  };
}

function toPaymentLimitsView(row: PaymentTargetLimits): PaymentLimitsView {
  return {
    target: row.target,
    minMilli: centsToMilli(row.minCents),
    maxMilli: centsToMilli(row.maxCents),
    presetsMilli: row.presetsCents.map(centsToMilli),
  };
}

/**
 * One dollar amount from the admin's limits form, as cents - or an error
 * naming the row and the field. Whole cents only: a purchase is charged in
 * cents, so a limit of $2.505 is a bound nothing could ever sit on.
 */
function limitCents(value: unknown, label: string): number {
  const parsed = parseDollars(value);
  if (!parsed.ok) throw new Error(describeDollarProblem(parsed.problem, label));
  if (!isWholeCents(parsed.milli)) throw new Error(`${label} must be a whole number of cents, like 2.50.`);
  const cents = milliToCents(parsed.milli);
  if (cents < 1 || cents > MAX_AMOUNT_CENTS) {
    throw new Error(`${label} must be between $0.01 and $${MAX_AMOUNT_CENTS / 100}.`);
  }
  return cents;
}

/** The admin's limit rows, in dollars, as the cents they are stored in. */
function parsePaymentLimitsInput(input: unknown): PaymentTargetLimits[] {
  if (!Array.isArray(input)) throw new Error('Payment limits must be a list.');
  return input.map((entry, index) => {
    const row = (entry && typeof entry === 'object' ? entry : {}) as PaymentLimitsInput;
    const target = typeof row.target === 'string' ? row.target.trim() : '';
    const name = target || `Payment limit ${index + 1}`;
    const minCents = limitCents(row.minUsd, `${name}: the smallest purchase`);
    const maxCents = limitCents(row.maxUsd, `${name}: the largest purchase`);
    if (minCents > maxCents) {
      throw new Error(`${name}: the smallest amount cannot be larger than the largest`);
    }
    const presets = row.presetsUsd === undefined ? [] : row.presetsUsd;
    if (!Array.isArray(presets)) throw new Error(`${name}: the preset amounts must be a list.`);
    return {
      target,
      minCents,
      maxCents,
      presetsCents: presets.map((preset, at) => limitCents(preset, `${name}: preset ${at + 1}`)),
    };
  });
}

/**
 * Settings are read on the hot path, so they are cached briefly.
 *
 * `readSettings` does a SQLite read, a JSON.parse and a full strict normalize
 * of the model list. A few seconds of cache takes that off the hot path
 * without letting an admin's change go unnoticed; every write path invalidates
 * it explicitly, so the TTL only covers changes made by another process
 * against the same database.
 */
const SETTINGS_CACHE_TTL_MS = 5_000;

/**
 * Keyed on the DATABASE PATH, not just held in a module variable - and on what
 * the environment says about the `.env`-defaulted settings.
 *
 * `getDatabasePath()` is resolved from `DB_DIR` on every call, so a single
 * process can legitimately address more than one database - which the test
 * suite does, giving each case a fresh temp directory. An unkeyed cache would
 * then serve one database's settings for another: reads that silently return
 * the wrong providers and models. The environment is in the key for the same
 * reason: a value in effect may be `.env`'s, and a test sets one and reads.
 */
let settingsCache: { key: string; path: string; value: SettingsState; at: number } | null = null;

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

/**
 * The stored row's keys with "not set" taken out: absent, `null`, an empty
 * default model id (what clearing it always meant) and an empty payment list
 * (what removing every row and saving always meant: the defaults). A
 * subscription price this app never writes - hand-edited into the row - is
 * taken out too, with one warning: read as set, it would show as "Set here"
 * holding `.env`'s price, and the next save would freeze that.
 */
function withoutUnsetOverrides(source: Record<string, unknown>): Record<string, unknown> {
  const row = { ...source };
  for (const key of DEFAULTED_SETTING_KEYS) {
    const value = row[key];
    const unset =
      value === undefined ||
      value === null ||
      (key === 'defaultModelId' && typeof value === 'string' && value.trim() === '') ||
      (key === 'paymentLimits' && Array.isArray(value) && value.length === 0);
    if (unset) delete row[key];
  }
  for (const key of SUBSCRIPTION_PRICE_SETTINGS) {
    if (!hasOwnProperty(row, key) || isStoredPriceMilli(row[key])) continue;
    warnOncePerPreference(
      `stored-price:${key}`,
      `[settings] The stored ${key} is ${JSON.stringify(row[key])}, which is not a price in thousandths of a ` +
        'dollar from 0 to 10000000; it is ignored until Admin -> Settings -> General saves one.'
    );
    delete row[key];
  }
  // A build-mode price this app never writes - hand-edited into the row - is
  // taken out too, with one warning: read as set, it would show "Set here"
  // holding `.env`'s price and the next save would freeze that.
  for (const mode of BUILD_MODES) {
    const key = BUILD_MODE_PRICE_FIELDS[mode].setting;
    if (!hasOwnProperty(row, key) || isStoredBuildModePriceMilli(row[key])) continue;
    warnOncePerPreference(
      `stored-price:${key}`,
      `[settings] The stored ${key} is ${JSON.stringify(row[key])}, which is not a price in thousandths of a ` +
        'dollar from 0 to 1000000; it is ignored until Admin -> Settings -> General saves one.'
    );
    delete row[key];
  }
  // Keys an older build stored and this one no longer reads: read past, never
  // a failure, and not carried by the next write (`storedRowOf` builds the row
  // from the fields this build knows). Removed here so none can be mistaken
  // for a setting.
  for (const retired of RETIRED_SETTING_KEYS) delete row[retired];
  return row;
}

/**
 * Stored app-settings keys that no longer mean anything: the builder's target
 * (`defaultResumeSelection`, a default resume or group - a profile is chosen by
 * `defaultProfileId` now) and a per-resume tailoring mode.
 */
const RETIRED_SETTING_KEYS = ['defaultResumeSelection', 'defaultResumeId', 'defaultGroupId', 'tailorMode'] as const;

/**
 * The model a `DEFAULT_MODEL` / `ANALYSIS_MODEL` text names: a runnable
 * record by id, else by display name in any case - or null, warned once, when
 * it names none. A model switched off, or on a provider switched off or
 * locked here, is not one: a default that cannot run is no default. With
 * nothing runnable at all there is nothing to name, and the lock has already
 * said why, so that says nothing more.
 */
function envModelChoice(name: string, text: string, runnable: AIModelRecord[]): string | null {
  if (!text) return null;
  const byId = runnable.find((model) => model.id === text);
  if (byId) return byId.id;
  const wanted = text.toLowerCase();
  const byName = runnable.find((model) => model.name.trim().toLowerCase() === wanted);
  if (byName) return byName.id;
  if (runnable.length > 0) {
    warnEnvOnce(
      name,
      `${name}=${JSON.stringify(text)} names no model that can run here (an id or a display name from ` +
        'Admin -> Models, enabled, on a provider that is switched on); ' +
        (name === 'ANALYSIS_MODEL'
          ? 'job postings are analysed on the default model.'
          : 'using the built-in default model.')
    );
  }
  return null;
}

/**
 * The settings in effect: the stored row over `.env`'s values over the code's
 * (owner decision S1), and where each of the `.env`-defaulted ones came from.
 *
 * `input` is the stored row (or the row a save is about to store); `strict`
 * refuses a value of the wrong shape by name, as a stored row and an admin's
 * save are both read. The two model choices are judged AFTER the row's model
 * list is read, because `DEFAULT_MODEL` and `ANALYSIS_MODEL` name a record in
 * it. Never writes.
 */
function composeSettings(input: unknown, strict: boolean, env: EnvSource = process.env): SettingsState {
  if (strict && (typeof input !== 'object' || input === null)) {
    throw new Error('Settings file must contain a JSON object');
  }
  const stored = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const source = withoutUnsetOverrides(stored);

  // The .env layer, over the code defaults.
  const readings = {
    defaultMode: envDefaultMode(env),
    defaultTheme: envDefaultTheme(env),
    defaultBuildMode: envDefaultBuildMode(env),
    suitablePriceMilli: envBuildModePriceMilli('suitable', env),
    partialPriceMilli: envBuildModePriceMilli('partial', env),
    fullPriceMilli: envBuildModePriceMilli('full', env),
    defaultResumeDocxEnabled: envDefaultResumeDocx(env),
    defaultCoverLetterDocxEnabled: envDefaultCoverLetterDocx(env),
    outputBaseDir: envOutputBaseDir(env),
    outputPathPrefix: envOutputPathPrefix(env),
    paymentLimits: envPaymentLimits(env),
    requireThreeDSecure: envRequireThreeDSecure(env),
    premiumPriceMilli: envSubscriptionPriceMilli('premium', env),
    premiumPlusPriceMilli: envSubscriptionPriceMilli('premium-plus', env),
    premiumMaxPriceMilli: envSubscriptionPriceMilli('premium-max', env),
  };
  const base = cloneDefaultSettings();
  base.defaultMode = readings.defaultMode.value;
  base.defaultTheme = readings.defaultTheme.value;
  base.defaultBuildMode = readings.defaultBuildMode.value;
  base.suitablePriceMilli = readings.suitablePriceMilli.value;
  base.partialPriceMilli = readings.partialPriceMilli.value;
  base.fullPriceMilli = readings.fullPriceMilli.value;
  base.defaultResumeDocxEnabled = readings.defaultResumeDocxEnabled.value;
  base.defaultCoverLetterDocxEnabled = readings.defaultCoverLetterDocxEnabled.value;
  base.outputBaseDir = readings.outputBaseDir.value;
  base.outputPathPrefix = readings.outputPathPrefix.value;
  base.paymentLimits = readings.paymentLimits.value;
  base.requireThreeDSecure = readings.requireThreeDSecure.value;
  base.premiumPriceMilli = readings.premiumPriceMilli.value;
  base.premiumPlusPriceMilli = readings.premiumPlusPriceMilli.value;
  base.premiumMaxPriceMilli = readings.premiumMaxPriceMilli.value;

  // The stored row over it. Its default model resolves against the code's for
  // now; the .env model choices need the row's models, read just here.
  const settings = normalizeSettings(source, base, strict);

  // Payment limits resolve PER METHOD: a stored row stands for its own method
  // only, and a method the row leaves out keeps `.env`'s bounds (else the
  // code's) - so changing the card's limits never freezes crypto's. Known
  // methods first, in their order; any other stored row (a coin's, from
  // before the coins went) after them.
  const storedLimits = hasOwnProperty(source, 'paymentLimits') ? clonePaymentLimits(settings.paymentLimits) : [];
  const limitSources: Record<string, PaymentLimitSource> = {};
  const storedFor = (target: string) => storedLimits.find((row) => row.target === target);
  settings.paymentLimits = [
    ...base.paymentLimits.map((row) => storedFor(row.target) ?? clonePaymentLimits([row])[0]),
    ...storedLimits.filter((row) => !base.paymentLimits.some((known) => known.target === row.target)),
  ];
  for (const row of settings.paymentLimits) {
    const variables = readings.paymentLimits.variables[row.target] ?? [];
    limitSources[row.target] = storedFor(row.target)
      ? { source: 'admin', variables: [] }
      : variables.length > 0
        ? { source: 'env', variables: [...variables] }
        : { source: 'default', variables: [] };
  }
  const runnable = getRunnableModels(settings);
  const envDefaultModelId = envModelChoice('DEFAULT_MODEL', envDefaultModelText(env), runnable);
  const envAnalysisModelId = envModelChoice('ANALYSIS_MODEL', envAnalysisModelText(env), runnable);

  const storedDefaultModelId =
    typeof source.defaultModelId === 'string' ? source.defaultModelId.trim() : undefined;
  // Without the administrator's: .env's when it names one, else the seed (and
  // the first model that runs when the seed does not).
  const defaultModelIdWithoutAdmin = resolveDefaultModelId(
    envDefaultModelId ?? '',
    settings.aiModels,
    settings,
    base.defaultModelId
  );
  settings.defaultModelId = resolveDefaultModelId(
    storedDefaultModelId ?? '',
    settings.aiModels,
    settings,
    defaultModelIdWithoutAdmin
  );
  const analysisStored = hasOwnProperty(source, 'analysisModelId');
  if (!analysisStored) settings.analysisModelId = envAnalysisModelId ?? CODE_SETTING_DEFAULTS.analysisModelId;

  // Only what the row holds is an administrator's - in its normalized form,
  // except a default model that stopped running, which is kept as stored so
  // switching that model back on makes it the default again.
  const overrides: SettingOverrides = {};
  for (const key of DEFAULTED_SETTING_KEYS) {
    if (!hasOwnProperty(source, key)) continue;
    if (key === 'defaultModelId') {
      // Not a string is no choice at all, as it always read; only an id is kept.
      if (storedDefaultModelId !== undefined) overrides.defaultModelId = storedDefaultModelId;
    } else if (key === 'paymentLimits') overrides.paymentLimits = clonePaymentLimits(storedLimits);
    // A price in its STORED form: "not offered" is the 0 an administrator
    // saved, where null would read back as no choice at all - .env's again.
    else if ((SUBSCRIPTION_PRICE_SETTINGS as readonly string[]).includes(key)) {
      (overrides as Record<string, unknown>)[key] = settings[key as SubscriptionPriceSetting] ?? 0;
    } else (overrides as Record<string, unknown>)[key] = settings[key];
  }

  const simpleSource = (key: keyof typeof readings): SettingSource =>
    hasOwnProperty(overrides, key) ? 'admin' : readings[key].fromEnv ? 'env' : 'default';
  const sources: SettingSources = {
    // Where the model IN EFFECT came from: a stored one that stopped running
    // is not what runs, so it is not what the page labels.
    defaultModelId:
      overrides.defaultModelId !== undefined && settings.defaultModelId === overrides.defaultModelId
        ? 'admin'
        : envDefaultModelId !== null && settings.defaultModelId === envDefaultModelId
          ? 'env'
          : 'default',
    // Kept as stored even when it stopped running (resolveAnalysisModel falls
    // back meanwhile), so a stored one is always what the page shows.
    analysisModelId: analysisStored ? 'admin' : envAnalysisModelId !== null ? 'env' : 'default',
    defaultMode: simpleSource('defaultMode'),
    defaultTheme: simpleSource('defaultTheme'),
    defaultBuildMode: simpleSource('defaultBuildMode'),
    suitablePriceMilli: simpleSource('suitablePriceMilli'),
    partialPriceMilli: simpleSource('partialPriceMilli'),
    fullPriceMilli: simpleSource('fullPriceMilli'),
    defaultResumeDocxEnabled: simpleSource('defaultResumeDocxEnabled'),
    defaultCoverLetterDocxEnabled: simpleSource('defaultCoverLetterDocxEnabled'),
    outputBaseDir: simpleSource('outputBaseDir'),
    outputPathPrefix: simpleSource('outputPathPrefix'),
    paymentLimits: simpleSource('paymentLimits'),
    requireThreeDSecure: simpleSource('requireThreeDSecure'),
    premiumPriceMilli: simpleSource('premiumPriceMilli'),
    premiumPlusPriceMilli: simpleSource('premiumPlusPriceMilli'),
    premiumMaxPriceMilli: simpleSource('premiumMaxPriceMilli'),
  };

  const defaults: AppSettingDefaults = {
    defaultModelId: defaultModelIdWithoutAdmin,
    analysisModelId: envAnalysisModelId ?? CODE_SETTING_DEFAULTS.analysisModelId,
    defaultMode: base.defaultMode,
    defaultTheme: base.defaultTheme,
    defaultBuildMode: base.defaultBuildMode,
    suitablePriceMilli: base.suitablePriceMilli,
    partialPriceMilli: base.partialPriceMilli,
    fullPriceMilli: base.fullPriceMilli,
    defaultResumeDocxEnabled: base.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: base.defaultCoverLetterDocxEnabled,
    outputBaseDir: normalizeOutputBaseDir(base.outputBaseDir),
    outputPathPrefix: base.outputPathPrefix,
    paymentLimits: clonePaymentLimits(base.paymentLimits),
    requireThreeDSecure: base.requireThreeDSecure,
    premiumPriceMilli: base.premiumPriceMilli,
    premiumPlusPriceMilli: base.premiumPlusPriceMilli,
    premiumMaxPriceMilli: base.premiumMaxPriceMilli,
  };

  // A price not offered only because what was set could not be read: a stored
  // value `withoutUnsetOverrides` dropped (present, not null, not a stored
  // price), else a .env line the reader refused - and no price under it. One
  // that a readable layer below prices (a junk row over .env's price) is in
  // effect at that price, as the page shows it.
  const unreadablePrices: UnreadableSubscriptionPrice[] = [];
  for (const tier of PAID_SUBSCRIPTION_IDS) {
    const key = SUBSCRIPTION_PRICE_FIELDS[tier].setting;
    if (settings[key] !== null || hasOwnProperty(source, key)) continue;
    const storedJunk = stored[key] !== undefined && stored[key] !== null;
    if (storedJunk) unreadablePrices.push({ tier, source: 'admin' });
    else if (readings[key].unreadable) unreadablePrices.push({ tier, source: 'env' });
  }

  // A mode priced $0 because its `.env` line could not be read (nothing stored
  // over it): the price reads 0 like an unset one, but nobody chose that.
  const unreadableModePrices: BuildMode[] = BUILD_MODES.filter((mode) => {
    const key = BUILD_MODE_PRICE_FIELDS[mode].setting;
    return !hasOwnProperty(source, key) && readings[key].unreadable;
  });

  return { settings, overrides, sources, defaults, limitSources, unreadablePrices, unreadableModePrices };
}

/**
 * The row as it is stored: every field without a `.env` default whole, as
 * before, and of the ones with one only what an administrator set - so a
 * value nobody chose keeps following `.env` instead of being frozen at the
 * day of the first save. Built-in providers likewise only where an
 * administrator set something (`storableProviders`). Keys this build does not
 * read are not carried: a save drops them.
 */
function storedRowOf(state: SettingsState): Record<string, unknown> {
  const { settings, overrides } = state;
  const row: Record<string, unknown> = {
    providersEnabled: { ...settings.providersEnabled },
    defaultProfileId: settings.defaultProfileId,
  };
  for (const key of DEFAULTED_SETTING_KEYS) {
    if (!hasOwnProperty(overrides, key)) continue;
    row[key] = key === 'paymentLimits' ? clonePaymentLimits(overrides.paymentLimits ?? []) : overrides[key];
  }
  row.aiModels = settings.aiModels.map((model) => ({ ...model }));
  row.aiProviders = storableProviders(settings.aiProviders);
  return row;
}

async function readState(): Promise<SettingsState> {
  const path = getDatabasePath();
  const key = `${path}\u0000${settingEnvFingerprint()}`;
  const cached = settingsCache;
  if (cached && cached.key === key && Date.now() - cached.at < SETTINGS_CACHE_TTL_MS) {
    noteStoredProviders(path, cached.value.settings.aiProviders);
    return cached.value;
  }

  const stored = getSetting<unknown>(APP_SETTINGS_KEY);
  // No row is a fresh install: nothing stored, everything .env's or the code's.
  const state = composeSettings(stored ?? {}, stored !== null);
  // With every seat locked here nothing can run, and no save could change that:
  // the lock is the deployment's, not the row's. Refusing the READ would take
  // down every page that reads settings - the admin pages that say why among
  // them - so the row is served as it is, with no runnable model and the lock
  // list beside it. A request to run something is refused where it resolves a
  // model. Saves keep both asserts.
  if (stored !== null && !everyProviderLocked()) {
    assertAtLeastOneProviderEnabled(state.settings);
    assertAtLeastOneRunnableModel(state.settings);
  }
  settingsCache = { key, path, value: state, at: Date.now() };
  // The providers, held synchronously for the queue's dispatcher and the pool
  // that spreads a type's calls (config/aiProviders.ts `currentProviders`).
  noteStoredProviders(path, state.settings.aiProviders);
  return state;
}

async function readSettings(): Promise<AppSettings> {
  return (await readState()).settings;
}

/** True when this deployment locks every provider, so nothing can run whatever the row says. */
function everyProviderLocked(): boolean {
  return AI_PROVIDER_IDS.every((id) => isProviderLocked(id));
}

/**
 * Stores a row - read strictly, both asserts held - and answers the state it
 * gives. Every writer builds the row from `storedRowOf(current)` and changes
 * only what it is about, so a model edit can never store a default that was
 * merely in effect.
 */
async function writeRow(row: Record<string, unknown>): Promise<SettingsState> {
  const state = composeSettings(row, true);
  assertAtLeastOneProviderEnabled(state.settings);
  assertAtLeastOneRunnableModel(state.settings);
  return persistState(state);
}

function persistState(state: SettingsState): SettingsState {
  setSetting(APP_SETTINGS_KEY, storedRowOf(state));
  const path = getDatabasePath();
  settingsCache = { key: `${path}\u0000${settingEnvFingerprint()}`, path, value: state, at: Date.now() };
  noteStoredProviders(path, state.settings.aiProviders);
  return state;
}

export async function getAppSettings(): Promise<AppSettings> {
  return readSettings();
}

/** What `GET /api/resume/models` serves to every signed-in account. See `UserAppSettings`. */
export async function getUserAppSettings(outputPathSuffix: string = envOutputPathSuffix().value): Promise<UserAppSettings> {
  return toUserSettings(await readSettings(), outputPathSuffix);
}

export async function getAdminAppSettings(): Promise<AdminAppSettings> {
  return toAdminSettings(await readState());
}

function pricesOf(settings: AppSettings): SubscriptionPrices {
  const prices = {} as SubscriptionPrices;
  for (const tier of PAID_SUBSCRIPTION_IDS) prices[tier] = settings[SUBSCRIPTION_PRICE_FIELDS[tier].setting];
  return prices;
}

/**
 * What each paid subscription costs for 30 days now, in thousandths - null is
 * not offered: the administrator's price, else `.env`'s, else not offered.
 * Throws when the settings cannot be read, and the renewal sweep relies on
 * it: a failed read must stop the pass, never read as "not offered" and end
 * everybody's subscription.
 */
export async function getSubscriptionPrices(): Promise<SubscriptionPrices> {
  return pricesOf(await readSettings());
}

/**
 * What one resume costs in each build mode now, in thousandths: the
 * administrator's price, else `.env`'s, else 0 (free). THROWS when the
 * settings cannot be read, so a run is never priced from nothing.
 */
export async function getBuildModePrices(): Promise<Record<BuildMode, number>> {
  const settings = await readSettings();
  return {
    suitable: settings.suitablePriceMilli,
    partial: settings.partialPriceMilli,
    full: settings.fullPriceMilli,
  };
}

/**
 * The prices, and the paid tiers among them that are "not offered" only
 * because a value somebody set could not be read (`UnreadableSubscriptionPrice`)
 * - the renewal sweep's read. A tier somebody stopped offering ends at
 * renewal; one whose price is merely unreadable must not, so the sweep holds
 * the subscriptions renewing as it until it can be read. Throws, like
 * `getSubscriptionPrices`, when the settings cannot be read at all.
 */
export async function getSubscriptionPriceReading(): Promise<SubscriptionPriceReading> {
  const state = await readState();
  return { prices: pricesOf(state.settings), unreadable: state.unreadablePrices.map((price) => ({ ...price })) };
}

/**
 * Set Default with a model that cannot run is refused, by name.
 *
 * The normalizer would otherwise put another default in its place without a
 * word: an administrator clicks Set Default on a switched-off model and the page
 * comes back showing a different default, with nothing saying why. Only an id
 * the save CHANGES is checked - a full-form save re-sends the default it loaded,
 * and one that stopped being runnable since must not stop the rest of the form
 * saving.
 */
function assertRequestedDefaultCanRun(input: AppSettingsUpdate, current: AppSettings, next: AppSettings): void {
  if (!hasOwnProperty(input, 'defaultModelId')) return;
  const requested = typeof input.defaultModelId === 'string' ? input.defaultModelId.trim() : '';
  // Empty clears it, which resolves to the seed default like an unset one.
  if (!requested) return;
  if (requested === current.defaultModelId || requested === effectiveDefaultModelId(current)) return;

  const model = next.aiModels.find((entry) => entry.id === requested);
  if (!model) {
    throw new Error(`AI model "${requested}" was not found, so it cannot be the default.`);
  }
  if (!model.enabled) {
    throw new Error(`"${model.name}" is switched off. Enable it under Admin -> Models before making it the default.`);
  }
  const lockReason = getProviderLockReason(model.provider);
  if (lockReason) {
    throw new Error(
      `"${model.name}" cannot be the default: ${getProviderLabel(model.provider)} is locked in this ` +
        `installation. ${lockReason}`
    );
  }
  if (!isProviderEnabled(model.provider, next)) {
    throw new Error(
      `"${model.name}" cannot be the default: ${getProviderLabel(model.provider)} is switched off under ` +
        'Admin -> Settings.'
    );
  }
}

/**
 * The analysis model is refused by name when a save CHANGES it to a model
 * that cannot run - as Set Default is - rather than accepted and silently
 * replaced by the app default on every analysis. Empty clears it.
 */
function assertRequestedAnalysisModelCanRun(input: AppSettingsUpdate, current: AppSettings, next: AppSettings): void {
  if (!hasOwnProperty(input, 'analysisModelId')) return;
  const requested = typeof input.analysisModelId === 'string' ? input.analysisModelId.trim() : '';
  if (!requested || requested === current.analysisModelId) return;
  const model = next.aiModels.find((entry) => entry.id === requested);
  if (!model) {
    throw new Error(`AI model "${requested}" was not found, so it cannot analyse job postings.`);
  }
  if (!getRunnableModels(next).some((entry) => entry.id === requested)) {
    throw new Error(
      `"${model.name}" cannot analyse job postings: it is switched off, or its provider is switched off or ` +
        'locked here. Enable it under Admin -> Models first.'
    );
  }
}

/**
 * The model a job analysis runs on: the administrator's analysis model when
 * it can run, otherwise the app default model (what an unset one means).
 *
 * A chosen model that stopped running - switched off, its seat locked - falls
 * back rather than failing every analysis, and says so once, naming the cause
 * for the administrator who can fix it: the analysis is not a request, and the
 * person whose build needs it did not choose the model.
 */
export async function resolveAnalysisModel(): Promise<AIModelRecord> {
  const settings = await readSettings();
  const chosen = settings.analysisModelId;
  if (chosen) {
    const runnable = getRunnableModels(settings).find((model) => model.id === chosen);
    if (runnable) return runnable;
    warnOncePerPreference(
      `analysis-model:${chosen}`,
      `[ai] The analysis model "${chosen}" cannot run (switched off, deleted, or its provider is switched ` +
        'off or locked); job postings are analysed on the app default model until one that can is chosen ' +
        'under Admin -> Models.'
    );
  }
  return resolveRequestedAIModel();
}

/**
 * A default build mode that is none of the three, refused naming its box
 * (`field`, `code`: PUT /api/admin/settings passes both on, as it does for a
 * price, so the page puts the sentence under the mode choice).
 */
export class DefaultBuildModeError extends Error {
  readonly field = 'defaultBuildMode';
  readonly code = 'bad-build-mode';

  constructor() {
    super('defaultBuildMode must be "suitable", "partial" or "full".');
    this.name = 'DefaultBuildModeError';
  }
}

/**
 * A subscription price refused, naming the box it came from (`field`, the
 * `...Usd` name it was sent under): PUT /api/admin/settings passes `field`
 * and `code` on, so the page puts the sentence under that price.
 */
export class SubscriptionPriceError extends Error {
  constructor(
    message: string,
    readonly field: string,
    readonly code: 'bad-price' | 'bad-price-field'
  ) {
    super(message);
    this.name = 'SubscriptionPriceError';
  }
}

/**
 * A price sent in thousandths is refused rather than read: every amount a
 * request carries is dollars, in a field ending `Usd`, and a `...Milli` field
 * read as dollars would price a tier a thousand times what was meant.
 */
function refusePriceInThousandths(body: Record<string, unknown>): void {
  for (const tier of PAID_SUBSCRIPTION_IDS) {
    const { setting, request } = SUBSCRIPTION_PRICE_FIELDS[tier];
    if (hasOwnProperty(body, setting)) {
      throw new SubscriptionPriceError(
        `Send the ${SUBSCRIPTIONS[tier].label} price in dollars, as ${request}.`,
        request,
        'bad-price-field'
      );
    }
  }
  for (const mode of BUILD_MODES) {
    if (hasOwnProperty(body, BUILD_MODE_PRICE_FIELDS[mode].setting)) throw buildModePriceFieldError(mode);
  }
}

/**
 * One price box, as it is STORED: `null` is Reset to default (nothing stored,
 * `.env` decides again), '' or $0 is 0 - the administrator's "not offered",
 * which beats a price `.env` gives - and anything else exactly the dollars
 * typed, up to $10,000, refused by name rather than rounded or clamped.
 */
function readSubscriptionPriceInput(tier: PaidSubscriptionId, value: unknown): number | null {
  if (value === null) return null;
  const { request } = SUBSCRIPTION_PRICE_FIELDS[tier];
  const label = `The ${SUBSCRIPTIONS[tier].label} price`;
  if (typeof value === 'string' && value.trim() === '') return 0;
  const parsed = parseDollars(value);
  if (!parsed.ok) throw new SubscriptionPriceError(describeDollarProblem(parsed.problem, label), request, 'bad-price');
  if (parsed.milli > MAX_SUBSCRIPTION_PRICE_MILLI) {
    throw new SubscriptionPriceError(
      `${label} must be at most ${formatMoney(MAX_SUBSCRIPTION_PRICE_MILLI)}.`,
      request,
      'bad-price'
    );
  }
  return parsed.milli;
}

export async function updateAppSettings(input: AppSettingsUpdate): Promise<AdminAppSettings> {
  const current = await readState();
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  refusePriceInThousandths(body);

  // A model list in a settings save is dropped, not merged: a list here would
  // skip the model-name check and clamp a mistyped price where the model
  // routes refuse it by name. Nothing the admin pages send carries one. And
  // the providers, which have routes of their own for the same reason: every
  // folder and binary they name is checked there, by name. The subscription
  // prices arrive in dollars under names of their own, read below.
  const {
    aiModels: _models,
    aiProviders: _providers,
    paymentLimits: limitsInput,
    providersEnabled: enabledInput,
    premiumPriceUsd: _premiumPrice,
    premiumPlusPriceUsd: _premiumPlusPrice,
    premiumMaxPriceUsd: _premiumMaxPrice,
    suitablePriceUsd: _suitablePrice,
    partialPriceUsd: _partialPrice,
    fullPriceUsd: _fullPrice,
    ...changes
  } = body;

  // The row as stored, changed only where the save names a field: a value
  // merely in effect (.env's, the code's) is never written by saving another.
  const row = storedRowOf(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null && (DEFAULTED_SETTING_KEYS as readonly string[]).includes(key)) {
      delete row[key]; // Reset to default.
    } else {
      row[key] = value;
    }
  }

  // Only the seats the save names change; the normalizer reads nothing but
  // catalog seats out of the record, so any other key never reaches the row.
  if (enabledInput && typeof enabledInput === 'object') {
    row.providersEnabled = { ...current.settings.providersEnabled, ...(enabledInput as Record<string, unknown>) };
  }

  /*
   * The payment limits arrive in DOLLARS and are parsed here, strictly, into
   * the cents they are stored in, so a bad amount or an inverted band is
   * reported by name rather than dropped while the save says it succeeded.
   * PER METHOD: each row sent replaces that method's stored row, and
   * `{ target, reset: true }` removes it (Reset to default for one method);
   * a method the save does not name keeps what it had - stored, or `.env`'s.
   * `null` - or an empty list, which the page has always said restores the
   * defaults - removes them all.
   */
  if (limitsInput !== undefined) {
    if (limitsInput === null || (Array.isArray(limitsInput) && limitsInput.length === 0)) {
      delete row.paymentLimits;
    } else {
      if (!Array.isArray(limitsInput)) throw new Error('Payment limits must be a list.');
      const entries: unknown[] = limitsInput;
      const resets = new Set<string>();
      const values: unknown[] = [];
      for (const entry of entries) {
        const candidate = entry as { target?: unknown; reset?: unknown } | null;
        if (candidate && candidate.reset === true && typeof candidate.target === 'string' && candidate.target.trim()) {
          resets.add(candidate.target.trim());
        } else {
          values.push(entry);
        }
      }
      const parsed = values.length > 0 ? parsePaymentLimitsInput(values) : [];
      const named = [...parsed.map((entry) => entry.target), ...resets];
      const repeated = named.find((target, index) => named.indexOf(target) !== index);
      if (repeated !== undefined) throw new Error(`The payment limits name ${repeated || 'a method'} twice.`);
      const stored = clonePaymentLimits(current.overrides.paymentLimits ?? []).filter((entry) => !resets.has(entry.target));
      for (const entry of parsed) {
        const at = stored.findIndex((existing) => existing.target === entry.target);
        if (at >= 0) stored[at] = entry;
        else stored.push(entry);
      }
      if (stored.length === 0) delete row.paymentLimits;
      else row.paymentLimits = stored;
    }
  }

  // Each subscription price the save names, in dollars, stored in thousandths.
  for (const tier of PAID_SUBSCRIPTION_IDS) {
    const { setting, request } = SUBSCRIPTION_PRICE_FIELDS[tier];
    if (body[request] === undefined) continue;
    const price = readSubscriptionPriceInput(tier, body[request]);
    if (price === null) delete row[setting];
    else row[setting] = price;
  }

  // Each build-mode price the save names, in dollars, stored in thousandths:
  // `null` is Reset to default, '' is refused (a price is required - Reset is
  // the button), anything else exactly the dollars typed from 0 to 1000.
  for (const mode of BUILD_MODES) {
    const { setting, request } = BUILD_MODE_PRICE_FIELDS[mode];
    if (body[request] === undefined) continue;
    if (body[request] === null) delete row[setting];
    else row[setting] = parseBuildModePriceInput(mode, body[request]);
  }

  // Read as strictly as the stored row is: a field that is present and of the
  // wrong shape is refused by name, never quietly left as it was.
  const next = composeSettings(row, true);

  assertAtLeastOneProviderEnabled(next.settings);
  assertAtLeastOneRunnableModel(next.settings);
  assertRequestedDefaultCanRun(input, current.settings, next.settings);
  assertRequestedAnalysisModelCanRun(input, current.settings, next.settings);

  // The folder in effect is created and checked whenever a save names it or
  // changes it - a Reset included, which puts `.env`'s (or the default) back
  // into effect: the administrator is told now, where they can fix it, not
  // by every run failing to write later.
  if (typeof changes.outputBaseDir === 'string' || next.settings.outputBaseDir !== current.settings.outputBaseDir) {
    await ensureWritableOutputDir(next.settings.outputBaseDir);
  }

  return toAdminSettings(persistState(next));
}

function getProviderLabel(provider: AIProvider): string {
  return getCatalogProviderLabel(provider);
}

export async function listAdminAIModels(): Promise<AIModelRecord[]> {
  const settings = await readSettings();
  return settings.aiModels.map((model) => ({ ...model }));
}

export async function listAvailableAIModels(): Promise<AIModelRecord[]> {
  const settings = await readSettings();
  return getRunnableModels(settings).map((model) => ({ ...model }));
}

/**
 * How a request may name its model.
 *
 * By record id, always - it is the only form the builder sends. `admin` also
 * opens the two older forms an administrator's tooling may still send: a bare
 * provider id (that seat's default model) and `provider:modelName`. Both
 * resolve only to records an administrator added, but they are spelled in seat
 * names and CLI model names, which is the vocabulary an ordinary account is not
 * given - so for anyone else they are refused like any id that is not a model.
 * Off unless a caller says otherwise, so a route that forgets to pass the
 * viewer fails closed.
 */
export type ModelRequestOptions = { admin?: boolean };

type ModelLookup = { model: AIModelRecord } | { problem: string };

/**
 * Whether `model` can run right now, and if not, why - in an administrator's
 * words, for the log and the `detail` only they are sent. A lock is named before
 * the admin switch: the two have different fixes, and pointing at a box that
 * will not help is worse than saying nothing.
 */
function runnableOrProblem(model: AIModelRecord, settings: AppSettings): ModelLookup {
  if (!model.enabled) {
    return { problem: `Selected AI model "${model.name}" is disabled.` };
  }
  const lockReason = getProviderLockReason(model.provider);
  if (lockReason) {
    return { problem: `${getProviderLabel(model.provider)} is locked in this installation. ${lockReason}` };
  }
  if (!isProviderEnabled(model.provider, settings)) {
    return { problem: `Selected AI model provider "${model.provider}" is disabled by admin.` };
  }
  return { model };
}

/** The model a name resolves to, in the shapes `ModelRequestOptions` allows, or why it does not. */
function lookUpModel(settings: AppSettings, requested: string, providerForms: boolean): ModelLookup {
  const byId = settings.aiModels.find((model) => model.id === requested);
  if (byId) return runnableOrProblem(byId, settings);

  const separator = requested.indexOf(':');
  const provider = coerceProviderId(requested);
  const pairProvider = separator > 0 ? coerceProviderId(requested.slice(0, separator)) : null;
  if (!providerForms) {
    return {
      problem:
        provider || pairProvider
          ? `"${requested}" names a model by its provider, which only an administrator's request may do.`
          : `AI model "${requested}" was not found.`,
    };
  }

  if (provider) {
    const lockReason = getProviderLockReason(provider);
    if (lockReason) {
      return { problem: `${getProviderLabel(provider)} is locked in this installation. ${lockReason}` };
    }
    const providerModels = getRunnableModels(settings).filter((model) => model.provider === provider);
    if (providerModels.length === 0) {
      return { problem: `No enabled models are configured for provider "${getProviderLabel(provider)}".` };
    }
    return { model: providerModels.find((model) => model.id === settings.defaultModelId) ?? providerModels[0] };
  }

  const pair = settings.aiModels.find((model) => `${model.provider}:${model.modelName}` === requested);
  if (pair) return runnableOrProblem(pair, settings);

  return { problem: `AI model "${requested}" was not found.` };
}

const warnedLockedPreferences = new Set<string>();

/**
 * Resolves a model id that was STORED rather than chosen for this run.
 *
 * A resume's model is a preference, set some time ago, and one that cannot run
 * now - switched off, its seat switched off or locked on this machine, deleted -
 * is stale rather than wrong. The person generating did not cause it and cannot
 * see why from anything they are shown: an ordinary account sees only the
 * models that run, and the resume form shows a stale choice as "the default
 * will be used". So it falls back to the app default, and the log says so once,
 * naming the cause for the administrator who can fix it. Failing instead would
 * mean one untick under Admin -> Models broke every generate for every resume
 * that had picked that model.
 *
 * An id named in the REQUEST goes through `resolveRequestedAIModel`, where the
 * same states are refused: somebody picked that model a moment ago, and quietly
 * running another would not be what they chose.
 *
 * Stored data, not a request, so the provider forms are read as they always
 * were: a resume saved by an administrator's tooling may hold one.
 */
export async function resolveStoredAIModelPreference(
  storedModelId?: string
): Promise<AIModelRecord> {
  const requested = typeof storedModelId === 'string' ? storedModelId.trim() : '';
  if (!requested) {
    return resolveRequestedAIModel();
  }

  const settings = await readSettings();
  const found = lookUpModel(settings, requested, true);
  if ('model' in found) {
    return found.model;
  }
  warnOncePerPreference(
    requested,
    `[ai] A stored preference names "${requested}", which cannot run: ${found.problem} Those calls run on ` +
      'the default model instead. Pick another model for the resume to silence this.'
  );
  return resolveRequestedAIModel();
}

/**
 * The model id a resume save may store, checked against the list its owner
 * picks from: '' to inherit, the id, or `ModelUnavailableError`.
 *
 * Only a CHANGED choice is checked. The resume editor's form sends the whole
 * record back, and a model switched off since it was picked must not stop its owner
 * saving their phone number - the stored choice already falls back to the
 * default when it is used (see resolveStoredAIModelPreference), and the form
 * says so. A NEW choice has to be one the owner could have picked: a runnable
 * model, by id.
 */
export async function checkResumeModelChoice(requested: unknown, stored: unknown): Promise<string> {
  const next = typeof requested === 'string' ? requested.trim() : '';
  const current = typeof stored === 'string' ? stored.trim() : '';
  if (!next || next === current) return next;

  const settings = await readSettings();
  const found = lookUpModel(settings, next, false);
  if ('model' in found) return next;
  throw new ModelUnavailableError(found.problem);
}

/** One line per stale preference, however many calls it makes. */
function warnOncePerPreference(key: string, message: string): void {
  if (warnedLockedPreferences.has(key)) return;
  warnedLockedPreferences.add(key);
  console.warn(message);
}

/**
 * The model a run asked for, or the app default when it named none.
 *
 * A name that cannot run is refused with `ModelUnavailableError` - one public
 * sentence for whatever the cause, the cause itself in its `detail` and in the
 * log - because the person chose that model, and running something else would
 * not be what they asked for. See `ModelRequestOptions` for which names a
 * caller may use. Nothing runnable at all is a different failure, the
 * installation's rather than the request's: `AiUnavailableError`, a 503.
 */
export async function resolveRequestedAIModel(
  requestedModelId?: string,
  options: ModelRequestOptions = {}
): Promise<AIModelRecord> {
  const settings = await readSettings();
  const runnableModels = getRunnableModels(settings);

  if (runnableModels.length === 0) {
    // The one way a READ ends up here: every seat locked, which the settings
    // read tolerates so the admin pages can say why. The reason is the
    // operator's - it names the variable and the seats - so it is `detail`,
    // and everybody else is told only who can fix it.
    if (everyProviderLocked()) {
      throw new AiUnavailableError(
        'No AI model can run: every AI provider is locked in this installation ' +
          `(${LOCKED_PROVIDERS_ENV_VAR}: ${listLockedProviderIds().join(', ')}).`
      );
    }
    throw new AiUnavailableError('No enabled AI models are configured.');
  }

  const requested = typeof requestedModelId === 'string' ? requestedModelId.trim() : '';
  if (!requested) {
    return runnableModels.find((model) => model.id === settings.defaultModelId) ?? runnableModels[0];
  }

  const found = lookUpModel(settings, requested, options.admin === true);
  if ('model' in found) {
    return found.model;
  }
  warnOncePerPreference(`refused:${requested}:${found.problem}`, `[ai] Refused a request for "${requested}": ${found.problem}`);
  throw new ModelUnavailableError(found.problem);
}

/** The boxes of Admin -> Models' dialog, by the name each has in a create or edit body. */
export const AI_MODEL_FIELDS = ['name', 'provider', 'modelName', 'description', 'enabled'] as const;

export type AIModelField = (typeof AI_MODEL_FIELDS)[number];

/**
 * A model create or edit refused over ONE of its fields. The route answers it
 * with `field` beside the sentence (`{ error, field }`), so the page shows the
 * sentence under that box rather than guessing the box from its wording -
 * which the next rewording would break.
 */
export class AIModelInputError extends Error {
  constructor(
    message: string,
    readonly field: AIModelField
  ) {
    super(message);
    this.name = 'AIModelInputError';
  }
}

type AIModelMutationInput = {
  name?: string;
  provider?: AIProvider;
  modelName?: string;
  description?: string;
  enabled?: boolean;
  // No price: a `pricePerResumeUsd` in a body is not read, as `creditsPerResume`
  // never was. What a resume costs is its build mode's (config/buildModes.ts).
};

/**
 * An administrator's create (no `fallback`) or edit (the stored record as
 * `fallback`) of one model record. Every message here reaches an administrator
 * only - the model routes are admin-only - so each names the field and the fix.
 *
 * The model name is checked against the seat's options (config/providerModels)
 * on a create, and on an edit only when it changes the provider or the model
 * name; it is stored in the option's own spelling, so `Sonnet` is saved as the
 * `sonnet` the CLI expects. An edit that leaves both alone - the enable switch,
 * a rename, a new description - is not asked about the list: a record saved
 * before the lists existed, or one a narrowed `.env` list no longer names,
 * keeps running and can still be renamed or switched off. Every field the
 * input leaves out keeps its stored value, so the enable switch, which sends
 * only `{ enabled }`, changes nothing else.
 */
function normalizeAIModelMutationInput(
  input: AIModelMutationInput,
  fallback?: AIModelRecord
): Omit<AIModelRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const provider = normalizeAIModelProvider(input.provider ?? fallback?.provider);
  if (!provider) {
    throw new AIModelInputError(`Model provider must be one of: ${AI_PROVIDER_IDS.join(', ')}.`, 'provider');
  }

  const requestedModelName = normalizeAIModelText(input.modelName, fallback?.modelName || '');
  if (!requestedModelName) {
    throw new AIModelInputError('Model name is required.', 'modelName');
  }

  const unchanged =
    fallback !== undefined &&
    provider === fallback.provider &&
    requestedModelName.toLowerCase() === fallback.modelName.toLowerCase();
  let modelName = unchanged ? fallback.modelName : requestedModelName;
  if (!unchanged) {
    const option = findProviderModelOption(provider, requestedModelName);
    if (!option) {
      throw new AIModelInputError(
        `"${requestedModelName}" is not one of the ${getProviderLabel(provider)} models: ` +
          `${describeProviderModelOptions(provider)}.`,
        'modelName'
      );
    }
    modelName = option.value;
  }

  // Required on a create rather than defaulted to the model name: the display
  // name is the only part of a record a user ever sees, and `sonnet` or
  // `default` says nothing to them.
  const name = normalizeAIModelText(input.name, fallback?.name ?? '');
  if (!name) {
    throw new AIModelInputError('Display name is required.', 'name');
  }

  return {
    name,
    provider,
    modelName,
    description: normalizeAIModelText(input.description, fallback?.description || ''),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : fallback?.enabled ?? true,
  };
}

function assertNoDuplicateModel(
  models: AIModelRecord[],
  candidate: { id?: string; provider: AIProvider; modelName: string }
): void {
  const normalizedModelName = candidate.modelName.trim().toLowerCase();
  const duplicate = models.find(
    (model) =>
      model.id !== candidate.id &&
      model.provider === candidate.provider &&
      model.modelName.trim().toLowerCase() === normalizedModelName
  );

  if (duplicate) {
    throw new AIModelInputError(
      `${getProviderLabel(candidate.provider)} already has a model for "${candidate.modelName}" ` +
        `("${duplicate.name}"). Edit that one instead.`,
      'modelName'
    );
  }
}

/**
 * The display name is the only part of a record a user ever sees, so two
 * records sharing one are two identical choices that may run on different
 * seats at different prices. Compared the way people read it: trimmed, in any
 * case. Checked on a create, and on an edit only when the name changes, so a
 * pair stored before this check can still be toggled or repriced.
 */
function assertUniqueDisplayName(models: AIModelRecord[], candidate: { id?: string; name: string }): void {
  const wanted = candidate.name.trim().toLowerCase();
  const owner = models.find((model) => model.id !== candidate.id && model.name.trim().toLowerCase() === wanted);
  if (owner) {
    throw new AIModelInputError(
      `"${owner.name}" is already the name of a ${getProviderLabel(owner.provider)} model. Users see only ` +
        'display names, so give this one a different name.',
      'name'
    );
  }
}

export async function createAIModel(input: AIModelMutationInput): Promise<AdminAppSettings> {
  const current = await readState();
  const { settings } = current;
  const normalized = normalizeAIModelMutationInput(input);
  assertNoDuplicateModel(settings.aiModels, normalized);
  assertUniqueDisplayName(settings.aiModels, normalized);

  const now = new Date().toISOString();
  const created: AIModelRecord = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...normalized,
  };

  // The default model is left alone: with none stored, the one in effect is
  // resolved on every read, and a list that had no model at all resolves to
  // this one without anything being stored for it.
  const saved = await writeRow({ ...storedRowOf(current), aiModels: [...settings.aiModels, created] });
  return toAdminSettings(saved);
}

export async function updateAIModel(id: string, input: AIModelMutationInput): Promise<AdminAppSettings> {
  const state = await readState();
  const { settings } = state;
  const current = settings.aiModels.find((model) => model.id === id);
  if (!current) {
    throw new Error('AI model not found.');
  }

  const normalized = normalizeAIModelMutationInput(input, current);
  assertNoDuplicateModel(settings.aiModels, { id, ...normalized });
  if (normalized.name.trim().toLowerCase() !== current.name.trim().toLowerCase()) {
    assertUniqueDisplayName(settings.aiModels, { id, name: normalized.name });
  }

  const saved = await writeRow({
    ...storedRowOf(state),
    aiModels: settings.aiModels.map((model) =>
      model.id === id
        ? {
            ...model,
            ...normalized,
            updatedAt: new Date().toISOString(),
          }
        : model
    ),
  });
  return toAdminSettings(saved);
}

export async function deleteAIModel(id: string): Promise<AdminAppSettings> {
  const state = await readState();
  const { settings } = state;
  const nextModels = settings.aiModels.filter((model) => model.id !== id);
  if (nextModels.length === settings.aiModels.length) {
    throw new Error('AI model not found.');
  }

  const row: Record<string, unknown> = { ...storedRowOf(state), aiModels: nextModels };
  // A deleted model is no choice at all. The administrator's default or
  // analysis model naming it is removed, so .env's - else the code's - is in
  // effect again, rather than a choice that warns for ever.
  if (state.overrides.defaultModelId === id) delete row.defaultModelId;
  if (state.overrides.analysisModelId === id) delete row.analysisModelId;

  const saved = await writeRow(row);
  return toAdminSettings(saved);
}

export async function getAIModelSettings(): Promise<AIModelSettings> {
  const settings = await readSettings();
  return {
    providersEnabled: { ...settings.providersEnabled },
    aiProviders: settings.aiProviders.map((entry) => ({ ...entry })),
  };
}

/** The bounds on one purchase, per method, and the card-authentication setting. */
export async function getPurchaseSettings(): Promise<{
  paymentLimits: PaymentTargetLimits[];
  /**
   * The limits with nothing stored - `.env`'s, else the code's - for a method
   * the stored list leaves out (services/payments/pricing.ts).
   */
  defaultPaymentLimits: PaymentTargetLimits[];
  requireThreeDSecure: boolean;
  currency: string;
}> {
  const { settings, defaults } = await readState();
  return {
    paymentLimits: settings.paymentLimits,
    defaultPaymentLimits: defaults.paymentLimits,
    requireThreeDSecure: settings.requireThreeDSecure,
    currency: CREDIT_CURRENCY,
  };
}

/** Where resumes are filed: the output folder and the administrator's prefix in effect. */
export async function getOutputStorageSettings(): Promise<Pick<AppSettings, 'outputBaseDir' | 'outputPathPrefix'>> {
  const settings = await readSettings();
  return {
    outputBaseDir: settings.outputBaseDir,
    outputPathPrefix: settings.outputPathPrefix,
  };
}

/**
 * Whether a call may actually be dispatched to this provider.
 *
 * Two conditions, and they are not interchangeable: the admin left it switched
 * on, AND this deployment can run it at all. Both live here rather than at the
 * call sites because this is the choke point every one of them already goes
 * through - runnable models, the public model list, request resolution and the
 * prompt executor - so a locked provider cannot be reached by forgetting a
 * check somewhere.
 */
export function isProviderEnabled(provider: AIProvider, settings: AIModelSettings): boolean {
  return (
    settings.providersEnabled[provider] === true &&
    !isProviderLocked(provider) &&
    hasEnabledProviderOfType(provider, settings)
  );
}

/**
 * Whether any provider of the type is switched on (config/aiProviders.ts). A
 * type whose every provider an administrator switched off cannot run anything,
 * exactly as if its own switch were off - so its models drop out of the
 * runnable list rather than being offered and then waiting for ever.
 */
function hasEnabledProviderOfType(type: AIProvider, settings: AIModelSettings): boolean {
  if (!settings.aiProviders) return true;
  return settings.aiProviders.some((entry) => entry.type === type && entry.enabled);
}

/**
 * What the admin chose, ignoring the lock.
 *
 * The Settings page needs this: a locked provider's checkbox still shows the
 * stored preference, so unlocking the deployment later restores exactly what
 * the operator had picked rather than a box that quietly reset itself.
 */
export function isProviderAdminEnabled(provider: AIProvider, settings: AIModelSettings): boolean {
  return settings.providersEnabled[provider] === true;
}

/**
 * What a caller that named no provider should run on: the first seat in
 * catalog order that is switched on and runnable here.
 *
 * Every provider is a subscription seat, so plain catalog order is the whole
 * rule - nothing down the list starts billing tokens. Locked providers are
 * skipped rather than returned and rejected later: this is an answer to "what
 * can this run on", and one that cannot run is not an answer to it. Only when
 * nothing can run does it fall back to a seat merely switched on, and then to
 * the first, for the caller to refuse by name.
 */
export function getDefaultEnabledProvider(settings: AIModelSettings): AIProvider {
  return (
    AI_PROVIDER_IDS.find((id) => isProviderEnabled(id, settings)) ??
    AI_PROVIDER_IDS.find((id) => settings.providersEnabled[id]) ??
    AI_PROVIDER_IDS[0]
  );
}

/* ============================================================= providers */

/**
 * This app's own directories, which no provider's folder or binary may be
 * inside (config/aiProviders.ts): the checkout, the database directory, the
 * shipped and saved assets, the output tree, and the seats' fixed working and
 * state directories when they are configured somewhere else. A sign-in folder
 * in there would sit where the app writes, serves or deletes files.
 */
export function listAppDirectories(settings: Pick<AppSettings, 'outputBaseDir'>, env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = ['AI_CLI_WORKDIR', 'AI_CODEX_WORKDIR']
    .map((name) => (env[name] ?? '').trim())
    .filter(Boolean)
    .map((value) => nodePath.resolve(value));
  return [
    // dist/config -> backend/dist -> backend -> the checkout.
    nodePath.resolve(__dirname, '..', '..', '..'),
    nodePath.dirname(getDatabasePath()),
    getStaticDir(),
    settings.outputBaseDir ? nodePath.resolve(settings.outputBaseDir) : '',
    ...configured,
    geminiCliWorkdir(env),
    geminiCliStateDir(env),
  ].filter(Boolean);
}

export type ProviderMutationResult = {
  /** The provider the call was about; absent after a removal. */
  provider?: AdminAIProvider;
  providers: AdminAIProvider[];
};

function providersView(settings: AppSettings): AdminAIProvider[] {
  return resolveProviders(settings.aiProviders).map(toAdminProvider);
}

/** The resolved providers in effect now, for the queue and the routes. */
export async function listResolvedProviders(): Promise<ResolvedAIProvider[]> {
  return resolveProviders((await readSettings()).aiProviders);
}

export async function listAdminAIProviders(): Promise<AdminAIProvider[]> {
  return providersView(await readSettings());
}

/**
 * Writes a provider list, refusing - by name, as a conflict - one that would
 * leave nothing runnable: every provider of every type with a model switched
 * off is the same as switching every seat off, which a settings save refuses.
 */
async function saveProviders(current: SettingsState, aiProviders: StoredAIProvider[]): Promise<AppSettings> {
  const next = composeSettings({ ...storedRowOf(current), aiProviders }, true);
  if (getRunnableModels(next.settings).length === 0) {
    throw new AIProviderInputError(
      'nothing-left',
      'That would leave no enabled model with an enabled provider to run on. Enable another provider first.',
      'enabled',
      409
    );
  }
  assertAtLeastOneProviderEnabled(next.settings);
  return persistState(next).settings;
}

function findStoredProvider(settings: AppSettings, id: string): StoredAIProvider {
  const found = settings.aiProviders.find((entry) => entry.id === id);
  if (!found) throw new AIProviderInputError('not-found', 'That provider does not exist.', undefined, 404);
  return found;
}

/** Adds a provider (owner decision P1): `{ type, label, homeDir, binaryPath?, concurrency_max_requests?, enabled? }`. */
export async function createAIProvider(input: unknown): Promise<ProviderMutationResult> {
  const state = await readState();
  const current = state.settings;
  const created = buildNewProvider(input, {
    providers: resolveProviders(current.aiProviders),
    appDirectories: listAppDirectories(current),
  });
  const saved = await saveProviders(state, [...current.aiProviders, created]);
  const providers = providersView(saved);
  return { provider: providers.find((entry) => entry.id === created.id), providers };
}

/** Edits one: any of `label`, `homeDir`, `binaryPath`, `concurrency_max_requests`, `enabled`. */
export async function updateAIProvider(id: string, input: unknown): Promise<ProviderMutationResult> {
  const state = await readState();
  const current = state.settings;
  const existing = findStoredProvider(current, id);
  const edited = applyProviderEdit(existing, input, {
    providers: resolveProviders(current.aiProviders),
    appDirectories: listAppDirectories(current),
  });
  const saved = await saveProviders(
    state,
    current.aiProviders.map((entry) => (entry.id === id ? edited : entry))
  );
  const providers = providersView(saved);
  return { provider: providers.find((entry) => entry.id === id), providers };
}

/**
 * Removes an added provider. A built-in one is part of what every stored model
 * and queued task names, so it is switched off instead (409 `built-in`). The
 * caller - the route - has already refused a provider with work running.
 */
export async function deleteAIProvider(id: string): Promise<ProviderMutationResult> {
  const state = await readState();
  const current = state.settings;
  findStoredProvider(current, id);
  if (isBuiltInProviderId(id)) {
    throw new AIProviderInputError(
      'built-in',
      "The built-in provider of a type cannot be removed; switch it off instead, and its type's other providers carry on.",
      undefined,
      409
    );
  }
  const saved = await saveProviders(
    state,
    current.aiProviders.filter((entry) => entry.id !== id)
  );
  return { providers: providersView(saved) };
}
