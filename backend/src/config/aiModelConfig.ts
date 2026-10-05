import { randomUUID } from 'crypto';

import { getSetting, getSettingFamilyRaw, getSettingRaw, setSetting } from '../database/settingsRepository';
import {
  MIGRATION_LOG_KEY as BROWSER_CHAT_LOG_KEY,
  SETTINGS_BACKUP_KEY as BROWSER_CHAT_SNAPSHOT_KEY,
} from '../database/migrations/006_remove_browser_chat';
import {
  MIGRATION_LOG_KEY as METERED_LOG_KEY,
  SETTINGS_BACKUP_KEY as METERED_SNAPSHOT_KEY,
} from '../database/migrations/007_remove_metered_providers';
import { MIGRATION_LOG_KEY as SEED_LOG_KEY } from '../database/migrations/008_seed_gemini_and_rename_seeds';
import { getDatabasePath } from '../database/sqlite';
import { AIProvider } from '../types/template';
import { CODEX_DEFAULT_MODEL } from '../services/ai/providers/codexCli/options';
import { GEMINI_DEFAULT_MODEL } from '../services/ai/providers/geminiCli/options';
import {
  AI_PROVIDER_IDS,
  coerceProviderId,
  getProviderDescriptor,
  getProviderLabel as getCatalogProviderLabel,
  getProviderLockReason,
  isProviderLocked,
  isRetiredProviderId,
  listLockedProviderIds,
  LOCKED_PROVIDERS_ENV_VAR,
  RETIRED_FAMILY_DESCRIPTION,
  RETIRED_FAMILY_MIGRATION,
  retiredModelFamily,
  retiredProviderFamily,
  type RetiredProviderFamily,
} from './providerCatalog';
import { DEFAULT_CLAUDE_CLI_MODEL } from '../services/aiModelCatalog';
import {
  describeProviderModelOptions,
  findProviderModelOption,
  listProviderModelOptions,
  type ProviderModelOptions,
} from './providerModels';
import { parsePricePerResume, readPricePerResumeMilli } from './pricePerResume';
import { centsToMilli, describeDollarProblem, isWholeCents, milliToCents, parseDollars } from '../utils/money';
import { AiUnavailableError, ModelUnavailableError } from './modelErrors';
import {
  buildOutputPathPreview,
  DEFAULT_OUTPUT_PATH_TEMPLATE,
  DEFAULT_GENERATED_RESUMES_DIR,
  ensureWritableOutputDir,
  normalizeOutputBaseDir,
  normalizeOutputPathTemplate,
  outputPathTemplateUsesJobTitle,
  validateOutputPathTemplate,
} from '../utils/outputStorage';
export type DefaultMode = 'preview' | 'generate';
export type ThemeMode = 'light' | 'dark';
export type DefaultResumeSelection = 'single' | 'all' | 'group';

type GoogleSheetSource = {
  id: string;
  name: string;
  sheetId: string;
  createdAt: string;
  updatedAt: string;
};

export type AIModelRecord = {
  id: string;
  name: string;
  provider: AIProvider;
  modelName: string;
  description: string;
  enabled: boolean;
  /**
   * What one resume built on this model costs, in thousandths of a dollar (0
   * is free): $0.023 is 23. See config/pricePerResume. A record stored without
   * one - priced before credits were dollars, or a seed nobody has priced -
   * reads as 0, in memory only, and Admin -> Models flags it.
   */
  pricePerResumeMilli: number;
  createdAt: string;
  updatedAt: string;
};

/** Which providers an admin has left switched on, keyed by provider id. */
export type ProvidersEnabled = Record<AIProvider, boolean>;

type AppSettings = {
  /**
   * Canonical enable flags. Replaces the hand-written booleans this type used
   * to carry; the Claude seat's survives only as a derived, read-only field on
   * the wire so an already-loaded browser tab does not break across a deploy.
   */
  providersEnabled: ProvidersEnabled;
  defaultMode: DefaultMode;
  defaultTheme: ThemeMode;
  defaultResumeSelection: DefaultResumeSelection;
  defaultGroupId: string;
  defaultProfileId: string;
  defaultModelId: string;
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
  outputBaseDir: string;
  outputPathTemplate: string;
  /**
   * What each payment method may be bought in.
   *
   * There is no price of a credit beside this any more: a credit is a dollar,
   * so a purchase of $X credits exactly $X, and these dollar bounds are the
   * whole of what limits one. `creditPriceCents`, `creditMinCredits` and
   * `creditMaxCredits` - a credit's price and a purchase's bounds in credits -
   * were retired with that; a stored row that still has them is read without
   * them, and the next save drops them.
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
  aiModels: AIModelRecord[];
  googleSheetsSources: GoogleSheetSource[];
};

/**
 * The settings slice the AI layer runs on.
 *
 * Read on the request path, so it carries only what the provider gate needs:
 * which providers an administrator has left switched on. Whether a provider
 * can run at all is the lock's question, and the lock is answered from the
 * environment rather than from this row - see `isProviderEnabled`.
 */
export type AIModelSettings = Pick<AppSettings, 'providersEnabled'>;

/**
 * The flat per-provider boolean older clients read. Derived from
 * `providersEnabled` on the way out; accepted on the way in.
 *
 * Only the Claude seat's. The metered APIs' flags (`claudeEnabled`,
 * `openaiEnabled`, `deepseekEnabled`) went with them: a page that still sends
 * one is ignored, not refused, and a stored row that still has one is residue
 * migration 007 deletes.
 */
export type LegacyProviderFlags = {
  claudeCliEnabled: boolean;
};

/** The builder defaults an administrator sets under Admin -> Settings, as every page reads them. */
type BuilderDefaults = Pick<
  AppSettings,
  | 'defaultMode'
  | 'defaultTheme'
  | 'defaultResumeSelection'
  | 'defaultGroupId'
  | 'defaultProfileId'
  | 'defaultModelId'
  | 'defaultResumeDocxEnabled'
  | 'defaultCoverLetterDocxEnabled'
>;

/**
 * What the administrator's payload is built on: the switches, the builder
 * defaults, the runnable models and the shared sheet sources.
 *
 * It used to be sent to every signed-in account as it stands, and it says far
 * more than an ordinary account may know - which seats exist and are switched
 * on, every model's provider and CLI model name, the sheets the administrator
 * shares. An ordinary account gets `UserAppSettings` now; this is only ever
 * read on the way to `AdminAppSettings`.
 */
type BaseAppSettings = AIModelSettings & LegacyProviderFlags & BuilderDefaults &
  Pick<AppSettings, 'aiModels' | 'googleSheetsSources'>;

/** One model as an ordinary account sees it: the id a request names it by, and the name an administrator gave it. */
export type UserModelOption = { id: string; name: string };

/**
 * `GET /api/resume/models`: everything a signed-in account that is not an
 * administrator may know about models and the builder's defaults.
 *
 * `models` is the runnable list, in the administrator's order, as ids and
 * display names and NOTHING else - no provider, no CLI model name, no
 * description, no price, no locks. A person picks a model by the name an
 * administrator gave it; what a run costs is the separate quote
 * (`POST /api/generation/quote`), never part of a model's label.
 * `defaultModelId` is always one of `models`, or '' when nothing can run.
 */
export type UserAppSettings = BuilderDefaults & {
  models: UserModelOption[];
  outputPathUsesJobTitle: boolean;
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
  outputPathUsesJobTitle: boolean;
  /** Providers locked in this build, so Admin -> Models can say why their models do not run. */
  providerLocks: ProviderLock[];
};

export type AdminAppSettings = Omit<BaseAppSettingsWithDerived, 'aiModels'> & {
  /** Every record, runnable or not, each with its `pricePerResumeMilli`. */
  aiModels: AIModelRecord[];
  /**
   * The ids of every enabled model priced $0.000, in stored order: free to
   * everybody who picks it. Admin -> Models lists them in red. After the
   * switch to dollars that is every model until an administrator prices it,
   * and a model a migration seeds arrives unpriced too - free on purpose is
   * allowed (0 is a valid price), but never silently.
   */
  freeEnabledModelIds: string[];
  /**
   * The model names Admin -> Models may pick, per seat: every seat in catalog
   * order, locked ones included so a model can be prepared before the lock is
   * lifted. On every admin settings and model response, so the form needs no
   * second request to stay in step with a mutation.
   */
  providerModelOptions: ProviderModelOptions[];
  outputBaseDir: string;
  outputPathTemplate: string;
  outputPathPreview: string;
  /** Per method, in thousandths of a dollar. */
  paymentLimits: PaymentLimitsView[];
  requireThreeDSecure: boolean;
};

/**
 * A save from Admin -> Settings. Not the model list: models are created, edited
 * and priced one at a time through the /api/admin/models routes, which check
 * each model name against its seat's options and each price against its
 * bounds. A list arriving here would skip both, so `updateAppSettings` ignores
 * one.
 */
export type AppSettingsUpdate = Partial<Omit<BaseAppSettings, 'aiModels'>> & {
  /** Accepted for one release so a stale client can still save. */
  openrouterEnabled?: boolean;
  outputBaseDir?: string;
  outputPathTemplate?: string;
  /** Per method, in dollars. See `PaymentLimitsInput`. */
  paymentLimits?: PaymentLimitsInput[];
  requireThreeDSecure?: boolean;
};

/**
 * The currency every amount is in. A credit is one of these, and the payment
 * limits below are the only bounds on buying them - read by the buy page from
 * `/api/payments/methods`, which also says which providers are configured, so
 * there is one answer to "what can I buy", not a settings copy that can
 * disagree with the checkout.
 */
export const CREDIT_CURRENCY = 'usd';

/**
 * What one payment method - or one coin - may be bought in, as STORED: cents.
 *
 * There is no fee. A purchase credits exactly what it charges - pay $50 by
 * crypto, get $50.000 (the owner's decision M2) - so the `feeBps` and
 * `feeFixedCents` a stored row may still carry are read past and dropped on
 * the next save, and the provider's own fees are the operator's to absorb.
 */
export type PaymentTargetLimits = {
  /**
   * `card` or `crypto`. A stored row naming a coin id still reads and still
   * round-trips - see the note on `paymentLimits` - but nothing resolves one.
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
};

/**
 * The defaults, which are the figures in the design this was built to.
 *
 * Card starts at $2.50; crypto starts at $50 because sending coin costs the
 * buyer a network fee whatever we do, and a $2.50 purchase that costs $4 to
 * send is not a kindness.
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

const MAX_AMOUNT_CENTS = 100_000_000;

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
   * for: every model is a subscription seat now, and the name is the only part
   * of a record a user ever sees. Migration 008 renames the earlier
   * "(subscription)" names on installs that never changed them.
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
      // Free until priced: there is no default price, and Admin -> Models
      // lists every enabled model at $0.000 in red until somebody sets one.
      pricePerResumeMilli: 0,
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
function defaultSeedModelId(): string {
  const preferred = buildModelId('claude-cli', DEFAULT_CLAUDE_CLI_MODEL);
  if (DEFAULT_MODEL_RECORDS.some((model) => model.id === preferred && !isProviderLocked(model.provider))) {
    return preferred;
  }
  return (
    DEFAULT_MODEL_RECORDS.find((model) => !isProviderLocked(model.provider))?.id ?? preferred
  );
}

const DEFAULT_SETTINGS: AppSettings = {
  providersEnabled: allProvidersEnabled(),
  defaultMode: 'preview',
  defaultTheme: 'light',
  defaultResumeSelection: 'single',
  defaultGroupId: '',
  defaultProfileId: '',
  defaultModelId: defaultSeedModelId(),
  defaultResumeDocxEnabled: true,
  defaultCoverLetterDocxEnabled: true,
  outputBaseDir: DEFAULT_GENERATED_RESUMES_DIR,
  outputPathTemplate: DEFAULT_OUTPUT_PATH_TEMPLATE,
  paymentLimits: DEFAULT_PAYMENT_LIMITS,
  requireThreeDSecure: false,
  aiModels: DEFAULT_MODEL_RECORDS,
  googleSheetsSources: [],
};

function cloneDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    providersEnabled: { ...DEFAULT_SETTINGS.providersEnabled },
    aiModels: DEFAULT_SETTINGS.aiModels.map((model) => ({ ...model })),
    googleSheetsSources: [...DEFAULT_SETTINGS.googleSheetsSources],
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

function normalizeDefaultResumeSelection(
  value: unknown,
  fallback: DefaultResumeSelection
): DefaultResumeSelection {
  return value === 'single' || value === 'all' || value === 'group' ? value : fallback;
}

function normalizeGoogleSheetSourceName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
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
   * Never empty, and an EXPLICIT empty list means the defaults.
   *
   * An empty list would otherwise mean "no bounds anywhere", so something has
   * to stand in. Which something depends on what the caller actually said:
   *
   *   - nothing at all, or a stored value that is not an array - the settings
   *     row is absent or corrupt, so keep what is already in force;
   *   - an array that normalizes to nothing - somebody removed every row and
   *     saved, which is a reset, and the defaults are what a reset restores.
   *
   * The difference matters because the administrator page offers Remove on
   * each row and tells the operator that saving with none restores the
   * defaults. Folding both cases into `fallback` made that sentence false:
   * the update path passes the CURRENT settings as the fallback, so removing
   * every row and saving quietly kept the rows that were just removed, with
   * no error and no visible change.
   */
  if (rows.length > 0) return rows;
  return Array.isArray(input) ? DEFAULT_PAYMENT_LIMITS.map((row) => ({ ...row })) : fallback;
}

function normalizeGoogleSheetsSources(input: unknown, fallback: GoogleSheetSource[], strict = false): GoogleSheetSource[] {
  if (strict && typeof input !== 'undefined' && !Array.isArray(input)) {
    throw new Error('Stored Google Sheets sources must be an array');
  }

  const rawEntries = Array.isArray(input) ? input : fallback;
  const seenIds = new Set<string>();

  return rawEntries
    .map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        if (strict) {
          throw new Error(`Stored Google Sheets source ${index + 1} is invalid`);
        }
        return null;
      }

      const raw = entry as Partial<GoogleSheetSource>;
      const sheetId = typeof raw.sheetId === 'string' ? raw.sheetId.trim() : '';
      if (!sheetId) {
        if (strict) {
          throw new Error(`Stored Google Sheets source ${index + 1} is missing a sheetId`);
        }
        return null;
      }

      const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();
      if (seenIds.has(id)) {
        if (strict) {
          throw new Error(`Stored Google Sheets source ${index + 1} has a duplicate id`);
        }
        return null;
      }
      seenIds.add(id);

      const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim()
        ? raw.createdAt.trim()
        : new Date().toISOString();
      const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim()
        ? raw.updatedAt.trim()
        : createdAt;

      return {
        id,
        name: normalizeGoogleSheetSourceName(raw.name, `Google Sheet ${index + 1}`),
        sheetId,
        createdAt,
        updatedAt,
      } satisfies GoogleSheetSource;
    })
    .filter((entry): entry is GoogleSheetSource => Boolean(entry));
}

function normalizeAIModelProvider(value: unknown): AIProvider | null {
  return coerceProviderId(value);
}

/**
 * Ids of model records that ran on a retired provider - dropped on read, or
 * deleted by migration 006 or 007 - and which removal retired each.
 *
 * Remembered so that a reference to one - a profile's stored preference, a
 * request from a page loaded before the upgrade - is recognised as naming a
 * retired provider and falls back to the default, instead of failing as a model
 * that "was not found". The shipped ids are listed in `RETIRED_MODEL_IDS`; this
 * covers the ones an administrator created, whose ids are random UUIDs, and the
 * metered seed ids an install's own `*_MODEL` variables derived.
 *
 * Two sources, because a reference outlives the record it names. A read that
 * finds such a record notes its id; and the migrations, which delete the
 * records at boot - usually before anything has read them - log the ids they
 * removed, which `learnRemovedModelIds` reads back. A builder tab left open
 * across the upgrade, or a profile editor loaded before it that saves its old
 * choice again, sends one long after the row is clean and the process that saw
 * the record has restarted. Only ever added to, and it deliberately does not
 * grow into "any id that is missing falls back" - a model an administrator
 * deleted is still an error.
 */
const droppedRetiredModelIds = new Map<string, RetiredProviderFamily>();

function isLogEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where each removal logs its runs, and the snapshot it keeps of a row it rewrote. */
const REMOVAL_MIGRATIONS: ReadonlyArray<{ family: RetiredProviderFamily; logKey: string; snapshotKey: string }> = [
  { family: 'browser-chat', logKey: BROWSER_CHAT_LOG_KEY, snapshotKey: BROWSER_CHAT_SNAPSHOT_KEY },
  { family: 'metered-api', logKey: METERED_LOG_KEY, snapshotKey: METERED_SNAPSHOT_KEY },
];

type RemovalRun = { family: RetiredProviderFamily; entry: Record<string, unknown> };

/**
 * Every run migrations 006 and 007 have logged, oldest first across both: each
 * first run's entry, the later runs appended to it, and any run logged under a
 * dated key of its own. Read as data: an entry that is not an object is
 * skipped, and a log row that does not parse reads as no log at all.
 */
function removalMigrationRuns(
  families: readonly RetiredProviderFamily[] = REMOVAL_MIGRATIONS.map((migration) => migration.family)
): RemovalRun[] {
  const runs: RemovalRun[] = [];
  for (const { family, logKey } of REMOVAL_MIGRATIONS) {
    if (!families.includes(family)) continue;
    let values: string[];
    try {
      values = getSettingFamilyRaw(logKey);
    } catch {
      continue;
    }
    for (const raw of values) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isLogEntry(parsed)) continue;
      runs.push({ family, entry: parsed });
      if (Array.isArray(parsed.laterRuns)) {
        runs.push(...parsed.laterRuns.filter(isLogEntry).map((entry) => ({ family, entry })));
      }
    }
  }
  return runs.sort((left, right) => String(left.entry.at ?? '').localeCompare(String(right.entry.at ?? '')));
}

/**
 * `<family>:<database path>` for every removal log already read into
 * `droppedRetiredModelIds`. Per family, because the two migrations can run in
 * this process at different times - both wait for the first administrator, and
 * 007 waits on 006 - and having read one log must not stop the other being read
 * once it appears.
 */
const learnedRemovalLogs = new Set<string>();

/**
 * Reads the model ids 006 and 007 removed into `droppedRetiredModelIds`, once
 * per database and log. Looked for again on each uncached settings read until
 * the log exists, because either migration can run in this process after its
 * first read - on the sign-in or the promotion that makes the first
 * administrator.
 */
function learnRemovedModelIds(path: string): void {
  const pending = REMOVAL_MIGRATIONS.map((migration) => migration.family).filter(
    (family) => !learnedRemovalLogs.has(`${family}:${path}`)
  );
  if (pending.length === 0) return;
  const runs = removalMigrationRuns(pending);
  for (const { family, entry } of runs) {
    learnedRemovalLogs.add(`${family}:${path}`);
    if (!Array.isArray(entry.removedModelIds)) continue;
    for (const id of entry.removedModelIds) {
      if (typeof id === 'string' && id.trim() && !droppedRetiredModelIds.has(id.trim())) {
        droppedRetiredModelIds.set(id.trim(), family);
      }
    }
  }
}

/**
 * One line per kind of retired-provider residue, however many reads find it.
 *
 * Settings are re-read every few seconds; a warning per read would bury the log
 * under the same sentence for as long as the residue is there.
 */
const warnedRetiredResidue = new Set<string>();

function warnRetiredResidueOnce(key: string, message: string): void {
  if (warnedRetiredResidue.has(key)) return;
  warnedRetiredResidue.add(key);
  console.warn(message);
}

/** "the browser chat providers, which were removed", ready for a sentence. */
function removedFamilyPhrase(family: RetiredProviderFamily): string {
  return `the ${RETIRED_FAMILY_DESCRIPTION[family]}, which were removed`;
}

function noteDroppedRetiredModel(raw: Partial<Record<keyof AIModelRecord, unknown>>): void {
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const family = retiredProviderFamily(provider) ?? 'browser-chat';
  const id = normalizeAIModelText(raw.id);
  const modelName = normalizeAIModelText(raw.modelName);
  // The id a record with none would have been given, so a reference built the
  // same way is recognised too.
  const recordId = id || `${provider}-${slugifyModelPart(modelName) || 'model'}`;
  if (!droppedRetiredModelIds.has(recordId)) droppedRetiredModelIds.set(recordId, family);

  warnRetiredResidueOnce(
    `records:${provider}`,
    `[ai] Ignoring stored model record(s) for "${provider}": ${removedFamilyPhrase(family)}. ` +
      `Migration ${RETIRED_FAMILY_MIGRATION[family]} deletes these records on start-up, and saving ` +
      'Admin -> Settings writes the row without them.'
  );
}

/**
 * Which removal retired the model `id` names, or null when it names a model
 * that has not been retired.
 *
 * Asked by every path that resolves a model id, so that all of them agree on
 * what such a reference means: the app default, never "not found".
 */
function retiredReferenceFamily(id: string): RetiredProviderFamily | null {
  return retiredModelFamily(id) ?? droppedRetiredModelIds.get(id.trim()) ?? null;
}

function isRetiredModelReference(id: string): boolean {
  return retiredReferenceFamily(id) !== null;
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
      // Skipped EVEN WHEN STRICT. Strict exists to report a row somebody edited
      // into nonsense; this is a row an older release wrote correctly, and
      // nearly every install that ever saved its settings carries two of them.
      // Refusing it would fail every settings read - the model list, every
      // generation, and the very page an admin would repair it from.
      if (isRetiredProviderId(raw.provider)) {
        noteDroppedRetiredModel(raw);
        return null;
      }

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
        // Carried, or every save that goes through here would drop it and every
        // model would be free again. Lenient even when strict: a record priced
        // before credits were dollars has only `creditsPerResume` - another
        // unit, never read as a price - and reads as $0.000, and one
        // hand-edited out of range clamps rather than failing the read every
        // page depends on.
        pricePerResumeMilli: readPricePerResumeMilli(raw.pricePerResumeMilli, id),
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
  // A default that names a retired model - the browser entry, or one of the
  // records dropped on read - is not among them, so it lands on the seed
  // default below like any other default that no longer resolves.
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
 * The models a profile or a request may pick: enabled, under a provider that is
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
 * Reads the enable flags from a stored row.
 *
 * Accepts three shapes, in order: the canonical `providersEnabled` record; the
 * flat per-provider booleans an older release wrote (including
 * `openrouterEnabled`, which becomes the CLI provider's flag - so an install
 * whose ONLY enabled provider was OpenRouter comes back with a working one
 * rather than a settings row that fails `assertAtLeastOneProviderEnabled`);
 * and, failing both, the fallback.
 *
 * Keys for a retired provider are ignored, and so are the metered APIs' flat
 * flags. A row whose only switched-on providers were retired ones is given one
 * that runs by
 * `rescueRetiredProviderRow`, when it is read from the database - not here,
 * because this also normalizes an administrator's save, where nothing enabled
 * is a mistake to report rather than repair.
 */
function normalizeProvidersEnabled(
  source: Record<string, unknown>,
  fallback: ProvidersEnabled,
  strict: boolean
): ProvidersEnabled {
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

    // A provider added after the flat flags stopped being written has none, so
    // there is nothing older that could be asking about it.
    const legacyField = getProviderDescriptor(id).legacyEnabledField;
    if (legacyField) {
      const fromLegacy = source[legacyField];
      if (typeof fromLegacy === 'boolean') {
        result[id] = fromLegacy;
        continue;
      }
      if (strict && hasOwnProperty(source, legacyField)) {
        throw new Error(`${legacyField} must be a boolean`);
      }
    }

    // The one alias that carries meaning: a row written before the CLI
    // provider existed says `openrouterEnabled`, and that flag is what the
    // admin actually chose for the provider this one replaced.
    if (id === 'claude-cli' && typeof source.openrouterEnabled === 'boolean') {
      result[id] = source.openrouterEnabled;
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


/**
 * Whether the row still runs on exactly what a removal migration left it
 * running on, as its log records: every provider switched on or off as it was,
 * and the same models switched on. Saves that change nothing of that - the
 * default mode, prices, the API key store the reader removes - leave it the
 * migration's row.
 */
/**
 * The model ids migration 008 appended to a row at or after `since`, as its log says.
 *
 * 008 adds the Gemini seed to an explicit list, switched on, so a row 007 left
 * would otherwise stop matching 007's record of it the moment 008 ran - and a
 * lock added later would find a row nobody answers for. What a migration added
 * after the removal is still what the migrations left.
 */
function seedAppendsSince(since: string): string[] {
  let values: string[];
  try {
    values = getSettingFamilyRaw(SEED_LOG_KEY);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const raw of values) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isLogEntry(parsed)) continue;
    const runs = [parsed, ...(Array.isArray(parsed.laterRuns) ? parsed.laterRuns.filter(isLogEntry) : [])];
    for (const run of runs) {
      // Strictly before, not "at or before": 008 runs straight after 007 in
      // one chain, and the two can log the same millisecond.
      if (String(run.at ?? '') < since || !Array.isArray(run.appendedModelIds)) continue;
      for (const id of run.appendedModelIds) {
        if (typeof id === 'string' && id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
      }
    }
  }
  return ids;
}

function stillRunsAsMigrationLeftIt(
  left: Record<string, unknown>,
  providersEnabled: ProvidersEnabled,
  aiModels: AIModelRecord[],
  leftAt: string
): boolean {
  const flags = isLogEntry(left.providersEnabled) ? left.providersEnabled : {};
  // Only the providers the run recorded and this build still has: one added to
  // the catalog since reads as its default, which is not a choice anybody
  // made, and a retired one's flag is ignored on read.
  if (AI_PROVIDER_IDS.some((id) => typeof flags[id] === 'boolean' && flags[id] !== providersEnabled[id])) {
    return false;
  }
  const enabledIds = (models: AIModelRecord[]): string[] =>
    models.filter((model) => model.enabled).map((model) => model.id).sort();
  // null: the row had no list of its own, and inherited the seed models. A
  // logged id that has since been retired - 006 logged the metered models it
  // left on - is not on the row any more for the reader to compare against.
  const was = Array.isArray(left.enabledModelIds)
    ? [
        ...new Set([
          ...left.enabledModelIds.filter(
            (id): id is string => typeof id === 'string' && !isRetiredModelReference(id)
          ),
          ...seedAppendsSince(leftAt),
        ]),
      ].sort()
    : enabledIds(DEFAULT_MODEL_RECORDS);
  const now = enabledIds(aiModels);
  return was.length === now.length && was.every((id, index) => id === now[index]);
}

/** Keys an older row carries only for a retired provider, as residue on their own. */
const RETIRED_SETTINGS_FLAGS: ReadonlyArray<{ key: string; family: RetiredProviderFamily }> = [
  { key: 'claudeEnabled', family: 'metered-api' },
  { key: 'openaiEnabled', family: 'metered-api' },
  { key: 'deepseekEnabled', family: 'metered-api' },
];

type RetiredTrace = { cause: 'residue' | 'migrated'; family: RetiredProviderFamily };

/**
 * What makes a stored row that can run nothing a removal's doing, if anything
 * does, and which removal:
 *
 *   - 'residue': the row still names a retired provider. The migration that
 *     removes it has not reached it, or a restored backup put the names back.
 *   - 'migrated': a removal migration rewrote it - the snapshot each keeps of
 *     every row it rewrote says so long after the row stops saying it - and it
 *     still runs on exactly what the LATEST such run, 006 or 007, left it on. A
 *     lock added since leaves that row with nothing, and that is still the
 *     migration's to answer for.
 *   - null: anything else, an administrator's own choice saved after the
 *     migrations among them. A lock that leaves THAT with nothing is theirs to
 *     answer, and the assert names it; repairing it would quietly switch back
 *     on a seat they had switched off.
 *
 * Asked only once a row has already failed to offer anything runnable, so the
 * extra reads cost nothing on any read that succeeds.
 */
function retiredProviderTrace(
  source: Record<string, unknown>,
  providersEnabled: ProvidersEnabled,
  aiModels: AIModelRecord[]
): RetiredTrace | null {
  const flags = source.providersEnabled;
  if (typeof flags === 'object' && flags !== null) {
    const retired = Object.keys(flags).map(retiredProviderFamily).find(Boolean);
    if (retired) return { cause: 'residue', family: retired };
  }
  if (Array.isArray(source.aiModels)) {
    for (const entry of source.aiModels) {
      const family =
        typeof entry === 'object' && entry !== null
          ? retiredProviderFamily((entry as Record<string, unknown>).provider)
          : null;
      if (family) return { cause: 'residue', family };
    }
  }
  const flat = RETIRED_SETTINGS_FLAGS.find(({ key }) => hasOwnProperty(source, key));
  if (flat) return { cause: 'residue', family: flat.family };

  const snapshotted = REMOVAL_MIGRATIONS.some(({ snapshotKey }) => {
    try {
      return getSettingRaw(snapshotKey) !== null;
    } catch {
      return false;
    }
  });
  if (!snapshotted) return null;
  const latest = [...removalMigrationRuns()].reverse().find((run) => isLogEntry(run.entry.leftRunning));
  // A removal that recorded no such thing ran on a build before the log said
  // it - 006's first version, only ever on its own development branch. Its row
  // is taken as untouched, as every such row was before the log said otherwise.
  if (!latest) {
    return { cause: 'migrated', family: 'browser-chat' };
  }
  return stillRunsAsMigrationLeftIt(
    latest.entry.leftRunning as Record<string, unknown>,
    providersEnabled,
    aiModels,
    String(latest.entry.at ?? '')
  )
    ? { cause: 'migrated', family: latest.family }
    : null;
}

/**
 * What the stored row records for `id`'s switch, read the way
 * `normalizeProvidersEnabled` reads it, or null when it records nothing - in
 * which case the reader takes it as switched on.
 */
function recordedProviderSwitch(source: Record<string, unknown>, id: AIProvider): boolean | null {
  const record = isLogEntry(source.providersEnabled) ? source.providersEnabled : null;
  if (typeof record?.[id] === 'boolean') return record[id] as boolean;
  const legacyField = getProviderDescriptor(id).legacyEnabledField;
  if (legacyField && typeof source[legacyField] === 'boolean') return source[legacyField] as boolean;
  if (id === 'claude-cli' && typeof source.openrouterEnabled === 'boolean') return source.openrouterEnabled;
  return null;
}

/**
 * Keeps a stored row that ran on a retired provider readable once it is gone.
 *
 * Without the browser chat providers or the metered APIs an install can be
 * left with nothing it can run: an operator who used them alone, or whose
 * seats are locked on this machine (`AI_LOCKED_PROVIDERS`) - which is exactly
 * what moved many installs onto them. The asserts in `readSettings` would then
 * refuse every settings read: the model list, every generation, and the
 * Settings page an administrator would repair it from. So one seat this
 * machine CAN run is read as switched on, and given a model that runs:
 *
 *   - not locked here - a locked seat switched on would repair nothing;
 *   - one the row explicitly switched on, then one it records no choice for,
 *     then one it switched off; one with a model already switched on before
 *     one without; catalog order after that;
 *   - its missing seed models added and, failing that, one of its own switched
 *     back on.
 *
 * That is exactly the repair migration 007 writes, rank for rank - so the
 * install does not change seat the moment its first administrator lets 007
 * run. Every seat is a subscription, so nothing a repair brings back bills per
 * token. It is needed after the migrations too, because a lock can be added at
 * any time and each runs once.
 *
 * Only for a row a removal answers for (`retiredProviderTrace`): one that still
 * names a retired provider, or the row the latest removal left, unchanged
 * since. Any other row an operator left with nothing runnable - every seat they
 * ticked since locked in .env, after an administrator's save - still fails by
 * name, pointing at the lock they set, which is the place to undo it. And
 * nothing is possible when every seat is locked: the read degrades to no
 * runnable models, and the lock list says why.
 *
 * In memory only. Nothing here writes; the migration, or the next save from the
 * admin page, persists it - so the migration still finds the residue and
 * snapshots the row before it changes anything. `providersEnabled` is the
 * caller's freshly normalized record and is updated in place.
 */
function rescueRetiredProviderRow(
  source: Record<string, unknown>,
  providersEnabled: ProvidersEnabled,
  aiModels: AIModelRecord[]
): AIModelRecord[] {
  const anyProvider = AI_PROVIDER_IDS.some((id) => isProviderEnabled(id, { providersEnabled }));
  if (anyProvider && getRunnableModels({ providersEnabled, aiModels }).length > 0) {
    return aiModels;
  }
  const trace = retiredProviderTrace(source, providersEnabled, aiModels);
  if (!trace) {
    return aiModels;
  }

  // Lowest first; a stable sort, so catalog order breaks ties.
  const rank = (id: AIProvider): number => {
    const recorded = recordedProviderSwitch(source, id);
    return (
      (recorded === true ? 0 : recorded === null ? 1 : 2) * 2 +
      (aiModels.some((model) => model.provider === id && model.enabled) ? 0 : 1)
    );
  };
  const target = AI_PROVIDER_IDS.filter((id) => !isProviderLocked(id)).sort((a, b) => rank(a) - rank(b))[0];
  if (!target) {
    return aiModels;
  }

  const switchedOn = providersEnabled[target] !== true;
  providersEnabled[target] = true;

  let rescued = aiModels;
  const added: string[] = [];
  let revived = '';
  if (getRunnableModels({ providersEnabled, aiModels: rescued }).length === 0) {
    const seeds = DEFAULT_MODEL_RECORDS.filter((model) => model.provider === target);
    const own = () => rescued.filter((model) => model.provider === target);
    // Its missing seed models, as 007 gives it them. By id AND by provider and
    // model name: the reader refuses two records for one pair, so a seed
    // beside a record the operator created under their own id would break the
    // row it is repairing.
    const presentIds = new Set(rescued.map((model) => model.id));
    const presentKeys = new Set(rescued.map((model) => `${model.provider}:${model.modelName.toLowerCase()}`));
    const fresh = seeds
      .filter(
        (model) =>
          !presentIds.has(model.id) && !presentKeys.has(`${model.provider}:${model.modelName.toLowerCase()}`)
      )
      .map((model) => ({ ...model }));
    rescued = [...fresh, ...rescued];
    added.push(...fresh.map((model) => model.id));
    // Its models were there all along but switched off. One is switched back
    // on - its seed default where it has that one - because a row that cannot
    // be read at all is worse than an administrator's untick being undone, and
    // the warning below says which it was.
    if (getRunnableModels({ providersEnabled, aiModels: rescued }).length === 0) {
      const seedDefault = seeds[0];
      const revive =
        own().find(
          (model) =>
            seedDefault !== undefined &&
            (model.id === seedDefault.id || model.modelName.toLowerCase() === seedDefault.modelName.toLowerCase())
        ) ?? own()[0];
      if (revive) {
        rescued = rescued.map((model) => (model === revive ? { ...model, enabled: true } : model));
        revived = revive.id;
      }
    }
  }

  const locked = listLockedProviderIds();
  const lockedHere = locked.length ? ` (locked here: ${locked.join(', ')})` : '';
  // About the lock when the row no longer names a retired provider: that is
  // what changed, and the removal is only why the row is the migration's.
  const cause =
    trace.cause === 'residue'
      ? `Nothing in the stored settings can run on this machine without ${removedFamilyPhrase(trace.family)}` +
        lockedHere
      : `Nothing the stored settings switch on can run on this machine${lockedHere}, and they are still what ` +
        `migration ${RETIRED_FAMILY_MIGRATION[trace.family]} left when it removed the ` +
        RETIRED_FAMILY_DESCRIPTION[trace.family];
  warnRetiredResidueOnce(
    `rescued:${target}`,
    `[ai] ${cause}; reading "${getCatalogProviderLabel(target)}" as ` +
      [
        switchedOn ? 'switched on' : '',
        added.length ? `given its models (${added.join(', ')})` : '',
        revived ? `with ${revived} switched back on` : '',
      ]
        .filter(Boolean)
        .join(', ') +
      ' instead. Review it under Admin -> Settings and Admin -> Models, and save to keep it.'
  );
  return rescued;
}

/**
 * `storedRow` marks the one caller that reads the row from the database, as
 * opposed to normalizing an administrator's save or a row about to be written:
 * only a stored row is repaired in memory or reported as retired-provider
 * residue.
 */
function normalizeSettings(
  input: unknown,
  fallback: AppSettings = DEFAULT_SETTINGS,
  strict = false,
  storedRow = false
): AppSettings {
  if (strict && (typeof input !== 'object' || input === null)) {
    throw new Error('Settings file must contain a JSON object');
  }

  const source: Partial<AppSettings> & Record<string, unknown> =
    typeof input === 'object' && input !== null
      ? (input as Partial<AppSettings> & Record<string, unknown>)
      : {};

  const providersEnabled = normalizeProvidersEnabled(source, fallback.providersEnabled, strict);

  const normalizedModels = normalizeAIModelRecords(source.aiModels, fallback.aiModels, strict);
  // Only for a STORED row. A save from the admin page that leaves nothing
  // runnable is refused by name instead, and repairing it behind the
  // operator's back would hide the mistake they made.
  const aiModels = storedRow
    ? rescueRetiredProviderRow(source, providersEnabled, normalizedModels)
    : normalizedModels;
  const defaultModelId = resolveDefaultModelId(
    source.defaultModelId,
    aiModels,
    { providersEnabled },
    fallback.defaultModelId
  );
  // A stored default that named a retired model is replaced like any default
  // that no longer resolves - but this one is residue with a known cause, so it
  // is said once, as a stored profile preference or prompt override naming one
  // is. After the records are normalized, so an administrator's own retired
  // model, whose id only its dropped record could name, is recognised too.
  const storedDefault = typeof source.defaultModelId === 'string' ? source.defaultModelId.trim() : '';
  const defaultFamily = storedRow && storedDefault ? retiredReferenceFamily(storedDefault) : null;
  if (defaultFamily) {
    warnRetiredResidueOnce(
      `default:${storedDefault}`,
      `[ai] The stored default model is "${storedDefault}", a model on ${removedFamilyPhrase(defaultFamily)}; ` +
        `"${defaultModelId || '(none)'}" is the default instead. Migration ` +
        `${RETIRED_FAMILY_MIGRATION[defaultFamily]} repoints it, and saving Admin -> Settings writes the new one.`
    );
  }

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
    defaultResumeSelection:
      typeof source.defaultResumeSelection === 'undefined'
        ? fallback.defaultResumeSelection
        : source.defaultResumeSelection === 'single'
          || source.defaultResumeSelection === 'all'
          || source.defaultResumeSelection === 'group'
          ? source.defaultResumeSelection
          : strict
            ? (() => { throw new Error('defaultResumeSelection must be "single", "all", or "group"'); })()
            : normalizeDefaultResumeSelection(
                source.defaultResumeSelection,
                fallback.defaultResumeSelection
              ),
    defaultGroupId:
      typeof source.defaultGroupId === 'string'
        ? source.defaultGroupId.trim()
        : strict && hasOwnProperty(source, 'defaultGroupId')
          ? (() => { throw new Error('defaultGroupId must be a string'); })()
          : fallback.defaultGroupId,
    defaultProfileId: typeof source.defaultProfileId === 'string'
      ? source.defaultProfileId.trim()
      : strict && hasOwnProperty(source, 'defaultProfileId')
        ? (() => { throw new Error('defaultProfileId must be a string'); })()
      : fallback.defaultProfileId,
    defaultModelId,
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
    outputPathTemplate:
      typeof source.outputPathTemplate === 'undefined'
        ? validateOutputPathTemplate(normalizeOutputPathTemplate(fallback.outputPathTemplate))
        : typeof source.outputPathTemplate === 'string' && source.outputPathTemplate.trim()
          ? validateOutputPathTemplate(source.outputPathTemplate)
        : strict
            ? (() => { throw new Error('outputPathTemplate must be a non-empty string'); })()
            : validateOutputPathTemplate(normalizeOutputPathTemplate(fallback.outputPathTemplate)),
    paymentLimits: normalizePaymentLimits(source.paymentLimits, fallback.paymentLimits, strict),
    requireThreeDSecure: normalizeBooleanSetting(
      source, 'requireThreeDSecure', fallback.requireThreeDSecure, strict
    ),
    aiModels,
    googleSheetsSources: normalizeGoogleSheetsSources(source.googleSheetsSources, fallback.googleSheetsSources, strict),
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

/** The flat boolean older clients still read, derived from the record. */
function toLegacyProviderFlags(settings: AppSettings): LegacyProviderFlags {
  return {
    claudeCliEnabled: settings.providersEnabled['claude-cli'],
  };
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
    defaultResumeSelection: settings.defaultResumeSelection,
    defaultGroupId: settings.defaultGroupId,
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
    ...toLegacyProviderFlags(settings),
    ...toBuilderDefaults(settings),
    aiModels: runnable.map((model) => ({ ...model })),
    googleSheetsSources: settings.googleSheetsSources,
  };
}

/**
 * The ordinary account's view, built field by field rather than by deleting
 * from a bigger object: a field added to the settings later reaches nobody
 * here until somebody decides it should.
 */
function toUserSettings(settings: AppSettings): UserAppSettings {
  return {
    models: getRunnableModels(settings).map((model) => ({ id: model.id, name: model.name })),
    ...toBuilderDefaults(settings),
    outputPathUsesJobTitle: outputPathTemplateUsesJobTitle(settings.outputPathTemplate),
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
    outputPathUsesJobTitle: outputPathTemplateUsesJobTitle(settings.outputPathTemplate),
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

function toAdminSettings(settings: AppSettings): AdminAppSettings {
  return {
    ...toBaseSettingsWithDerived(settings),
    aiModels: settings.aiModels.map((model) => ({ ...model })),
    providerModelOptions: listSeatModelOptions(),
    outputBaseDir: settings.outputBaseDir,
    outputPathTemplate: settings.outputPathTemplate,
    outputPathPreview: buildOutputPathPreview(settings.outputPathTemplate),
    paymentLimits: settings.paymentLimits.map(toPaymentLimitsView),
    requireThreeDSecure: settings.requireThreeDSecure,
    freeEnabledModelIds: settings.aiModels
      .filter((model) => model.enabled && model.pricePerResumeMilli === 0)
      .map((model) => model.id),
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

/**
 * The admin's limit rows, in dollars, as the cents they are stored in.
 *
 * A row still in cents (`minCents`) is from a Payments page loaded before
 * credits were dollars, and is refused rather than guessed at: read as dollars
 * it would set a $250 minimum where $2.50 was meant.
 */
function parsePaymentLimitsInput(input: unknown): PaymentTargetLimits[] {
  if (!Array.isArray(input)) throw new Error('Payment limits must be a list.');
  return input.map((entry, index) => {
    const row = (entry && typeof entry === 'object' ? entry : {}) as PaymentLimitsInput & Record<string, unknown>;
    if (row.minCents !== undefined || row.maxCents !== undefined || row.presetsCents !== undefined) {
      throw new Error('This page is from an older version of the app. Reload it and try again.');
    }
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
 * Keyed on the DATABASE PATH, not just held in a module variable.
 *
 * `getDatabasePath()` is resolved from `DB_DIR` on every call, so a single
 * process can legitimately address more than one database - which the test
 * suite does, giving each case a fresh temp directory. An unkeyed cache would
 * then serve one database's settings for another: reads that silently return
 * the wrong providers and models.
 */
let settingsCache: { path: string; value: AppSettings; at: number } | null = null;

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

/**
 * Whether a stored settings row still carries the removed key store.
 *
 * Keys used to live in the app's own database, managed from a panel on the
 * Settings page, for the metered API providers. Those providers are gone and
 * the app runs on subscription seats with no key at all, so an upgraded install
 * has secrets sitting in a row nothing reads. Detected here so `readSettings`
 * can rewrite the row without them, once - and PERMANENTLY, not only until
 * migration 007 has run: a restored backup can bring the store back any time.
 */
function purgeStoredApiKeys(stored: unknown): boolean {
  if (!stored || typeof stored !== 'object') return false;
  if (!hasOwnProperty(stored as object, 'apiKeys')) return false;
  console.warn(
    '[settings] Removing API keys stored in the database. Nothing in this release uses an API key - ' +
      'every AI provider is a subscription seat signed in on the server.'
  );
  return true;
}

async function readSettings(): Promise<AppSettings> {
  const path = getDatabasePath();
  const cached = settingsCache;
  if (cached && cached.path === path && Date.now() - cached.at < SETTINGS_CACHE_TTL_MS) {
    return cached.value;
  }

  // Before anything resolves a model id against what this returns: every path
  // that does reads settings first.
  learnRemovedModelIds(path);
  const stored = getSetting<unknown>(APP_SETTINGS_KEY);
  if (stored === null) {
    const defaults = cloneDefaultSettings();
    settingsCache = { path, value: defaults, at: Date.now() };
    return defaults;
  }

  const settings = normalizeSettings(stored, cloneDefaultSettings(), true, true);
  // A database written before keys moved to the environment still holds them.
  // Normalizing drops them from what this process uses, but the row on disk
  // would keep the secrets indefinitely with nothing left that can manage
  // them, so they are written out rather than merely ignored.
  //
  // The stored row minus its key store, and NOTHING else. Writing the
  // normalized row instead would also clean out whatever this read is only
  // tolerating - retired providers' records among them - before migrations 006
  // and 007 have snapshotted them, and would forget which profile preferences
  // named them.
  if (purgeStoredApiKeys(stored)) {
    const { apiKeys: _discarded, ...withoutKeys } = stored as Record<string, unknown>;
    setSetting(APP_SETTINGS_KEY, withoutKeys);
  }
  // With every seat locked here nothing can run, and no save could change that:
  // the lock is the deployment's, not the row's. Refusing the READ would take
  // down every page that reads settings - the admin pages that say why among
  // them - so the row is served as it is, with no runnable model and the lock
  // list beside it. A request to run something is refused where it resolves a
  // model. Saves keep both asserts.
  if (!everyProviderLocked()) {
    assertAtLeastOneProviderEnabled(settings);
    assertAtLeastOneRunnableModel(settings);
  }
  settingsCache = { path, value: settings, at: Date.now() };
  return settings;
}

/** True when this deployment locks every provider, so nothing can run whatever the row says. */
function everyProviderLocked(): boolean {
  return AI_PROVIDER_IDS.every((id) => isProviderLocked(id));
}

async function writeSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized = normalizeSettings(settings, cloneDefaultSettings(), true);
  assertAtLeastOneProviderEnabled(normalized);
  assertAtLeastOneRunnableModel(normalized);
  setSetting(APP_SETTINGS_KEY, normalized);
  settingsCache = { path: getDatabasePath(), value: normalized, at: Date.now() };
  return normalized;
}

export async function getAppSettings(): Promise<AppSettings> {
  return readSettings();
}

/** What `GET /api/resume/models` serves to every signed-in account. See `UserAppSettings`. */
export async function getUserAppSettings(): Promise<UserAppSettings> {
  return toUserSettings(await readSettings());
}

export async function getAdminAppSettings(): Promise<AdminAppSettings> {
  return toAdminSettings(await readSettings());
}

/**
 * Set Default with a model that cannot run is refused, by name.
 *
 * The normalizer would otherwise put another default in its place without a
 * word: an administrator clicks Set Default on a switched-off model and the page
 * comes back showing a different default, with nothing saying why. Only an id
 * the save CHANGES is checked - a full-form save re-sends the default it loaded,
 * and one that stopped being runnable since must not stop the rest of the form
 * saving - and a retired id from a page loaded before the upgrade still falls
 * back quietly, as every retired reference does.
 */
function assertRequestedDefaultCanRun(input: AppSettingsUpdate, current: AppSettings, next: AppSettings): void {
  if (!hasOwnProperty(input, 'defaultModelId')) return;
  const requested = typeof input.defaultModelId === 'string' ? input.defaultModelId.trim() : '';
  // Empty clears it, which resolves to the seed default like an unset one.
  if (!requested) return;
  if (requested === current.defaultModelId || requested === effectiveDefaultModelId(current)) return;
  if (isRetiredModelReference(requested)) return;

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

export async function updateAppSettings(input: AppSettingsUpdate): Promise<AdminAppSettings> {
  const current = await readSettings();

  // A client that still sends the flat per-provider booleans has to be heard.
  // Merged naively they never would be: `current` always carries a
  // `providersEnabled` record, and the record wins over the flat fields, so an
  // older client's provider toggle would appear to save and change nothing.
  const legacyFlags = input as Record<string, unknown>;
  // A page loaded before a provider was retired still sends its switches: a
  // flag per retired provider in `providersEnabled`, the metered APIs' flat
  // flags, the browser master switch and the list of debug browsers. Every one
  // is dropped without a word - the normalizer below names none of them, so
  // nothing reaches the row - because refusing the save would only stop a
  // stale tab saving the settings it CAN still change. The retired provider
  // flags are taken out here as well rather than left to it: a stored row whose
  // only ticked providers are retired reads with a seat switched on, and on a
  // save that would silently undo an administrator unticking everything else
  // instead of telling them why it cannot be saved.
  const requestedFlags = input.providersEnabled
    ? (Object.fromEntries(
        Object.entries(input.providersEnabled).filter(([id]) => !isRetiredProviderId(id))
      ) as Partial<ProvidersEnabled>)
    : null;
  const providersEnabled = requestedFlags
    ? { ...current.providersEnabled, ...requestedFlags }
    : AI_PROVIDER_IDS.reduce((acc, id) => {
        const legacyField =
          id === 'claude-cli' && typeof legacyFlags.openrouterEnabled === 'boolean'
            ? 'openrouterEnabled'
            : getProviderDescriptor(id).legacyEnabledField;
        const flat = legacyField ? legacyFlags[legacyField] : undefined;
        acc[id] = typeof flat === 'boolean' ? flat : current.providersEnabled[id];
        return acc;
      }, {} as ProvidersEnabled);

  // A model list in a settings save is dropped, not merged: this path
  // normalizes leniently, so a list here would skip the model-name check and
  // clamp a mistyped price where the model routes refuse it by name. Nothing
  // the admin pages send carries one.
  /*
   * A model list in a settings save is dropped, as above. So are the retired
   * pricing fields (`creditPriceCents`, `creditMinCredits`,
   * `creditMaxCredits`) a page from before credits were dollars still sends:
   * nothing reads them, and `normalizeSettings` builds the row field by field.
   *
   * The payment limits arrive in DOLLARS and are parsed here, strictly, into
   * the cents they are stored in. This path otherwise normalizes non-strict,
   * which drops a bad row and keeps what was there before - the kind direction
   * for most fields, and the wrong one here: it would tell an operator their
   * save succeeded while the limit they just typed was thrown away. So a bad
   * amount or an inverted band is reported by name.
   */
  const { aiModels: _models, paymentLimits: limitsInput, ...changes } = input as AppSettingsUpdate & {
    aiModels?: unknown;
  };
  const paymentLimits = limitsInput === undefined ? current.paymentLimits : parsePaymentLimitsInput(limitsInput);
  const next = normalizeSettings(
    {
      ...current,
      ...changes,
      paymentLimits,
      providersEnabled,
    },
    current
  );

  assertAtLeastOneProviderEnabled(next);
  assertAtLeastOneRunnableModel(next);
  assertRequestedDefaultCanRun(input, current, next);

  const shouldValidateOutputDir =
    typeof input.outputBaseDir !== 'undefined' ||
    current.outputBaseDir !== next.outputBaseDir;

  if (shouldValidateOutputDir) {
    await ensureWritableOutputDir(next.outputBaseDir);
  }

  const saved = await writeSettings(next);
  return toAdminSettings(saved);
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
 * A profile's model is a preference, set some time ago, and one that cannot run
 * now - switched off, its seat switched off or locked on this machine, deleted -
 * is stale rather than wrong. The person generating did not cause it and cannot
 * see why from anything they are shown: an ordinary account sees only the
 * models that run, and the profile form shows a stale choice as "the default
 * will be used". So it falls back to the app default, and the log says so once,
 * naming the cause for the administrator who can fix it. Failing instead would
 * mean one untick under Admin -> Models broke every generate for every profile
 * that had picked that model.
 *
 * An id named in the REQUEST goes through `resolveRequestedAIModel`, where the
 * same states are refused: somebody picked that model a moment ago, and quietly
 * running another would also quietly charge another price.
 *
 * Stored data, not a request, so the provider forms are read as they always
 * were: a profile saved by an administrator's tooling may hold one.
 */
export async function resolveStoredAIModelPreference(
  storedModelId?: string
): Promise<AIModelRecord> {
  const requested = typeof storedModelId === 'string' ? storedModelId.trim() : '';
  if (!requested) {
    return resolveRequestedAIModel();
  }

  const settings = await readSettings();

  // A preference for a model that ran on a removed provider - the browser
  // entry, a browser chat record, a metered API model - is stale in the same
  // way, and more permanently. Checked before the lookup, because the record is
  // not in `aiModels` any more and the lookup would only report it missing.
  const family = retiredReferenceFamily(requested);
  if (family) {
    warnOncePerPreference(
      requested,
      `[ai] A stored preference names "${requested}", a model on ${removedFamilyPhrase(family)}; those ` +
        'calls run on the default model instead. Pick a new model for it to silence this.'
    );
    return resolveRequestedAIModel();
  }

  const found = lookUpModel(settings, requested, true);
  if ('model' in found) {
    return found.model;
  }
  warnOncePerPreference(
    requested,
    `[ai] A stored preference names "${requested}", which cannot run: ${found.problem} Those calls run on ` +
      'the default model instead. Pick another model for the profile to silence this.'
  );
  return resolveRequestedAIModel();
}

/**
 * The model id a profile save may store, checked against the list its owner
 * picks from: '' to inherit, the id, or `ModelUnavailableError`.
 *
 * Only a CHANGED choice is checked. The profile form sends the whole profile
 * back, and a model switched off since it was picked must not stop its owner
 * saving their phone number - the stored choice already falls back to the
 * default when it is used (see resolveStoredAIModelPreference), and the form
 * says so. A NEW choice has to be one the owner could have picked: a runnable
 * model, by id. A retired id from a page loaded before the upgrade is stored as
 * no choice at all, which is what it means everywhere else.
 */
export async function checkProfileModelChoice(requested: unknown, stored: unknown): Promise<string> {
  const next = typeof requested === 'string' ? requested.trim() : '';
  const current = typeof stored === 'string' ? stored.trim() : '';
  if (!next || next === current) return next;

  const settings = await readSettings();
  const retired = namesRetiredModel(next);
  if (retired) {
    warnOncePerPreference(
      `profile-save:${next}`,
      `[ai] A profile save named "${next}", a model on ${removedFamilyPhrase(retired)}; it is saved as ` +
        'inheriting the default instead. Reloading the page that sent it stops this.'
    );
    return '';
  }

  const found = lookUpModel(settings, next, false);
  if ('model' in found) return next;
  throw new ModelUnavailableError(found.problem);
}

/**
 * Which removal a request id can only mean, or null: a retired model id, a
 * dropped record's id, a retired provider id on its own, or `provider:model`
 * with a retired provider - the four shapes `resolveRequestedAIModel` accepts.
 */
function namesRetiredModel(requested: string): RetiredProviderFamily | null {
  const direct = retiredReferenceFamily(requested) ?? retiredProviderFamily(requested);
  if (direct) return direct;
  const separator = requested.indexOf(':');
  return separator > 0 ? retiredProviderFamily(requested.slice(0, separator)) : null;
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
 * log - because the price of a resume is its model's, and running something
 * else would charge something else. See `ModelRequestOptions` for which names a
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

  const named = typeof requestedModelId === 'string' ? requestedModelId.trim() : '';
  /*
   * A request naming a model on a removed provider runs on the default.
   *
   * Not refused, unlike every other id this cannot find. It comes from a page
   * loaded before the upgrade, or a choice that page remembered, and the one
   * such id a person could have picked on purpose was the browser entry, which
   * the picker labelled as the default. Refusing would break every stale tab on
   * a change nobody using it made; running the default is what it asked for.
   */
  const retired = named ? namesRetiredModel(named) : null;
  if (retired) {
    warnOncePerPreference(
      `request:${named}`,
      `[ai] A request named "${named}", a model on ${removedFamilyPhrase(retired)}; it runs on the ` +
        'default model instead. Reloading the page that sent it stops this.'
    );
  }
  const requested = retired ? '' : named;
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

type AIModelMutationInput = {
  name?: string;
  provider?: AIProvider;
  modelName?: string;
  description?: string;
  enabled?: boolean;
  /**
   * The price per resume in DOLLARS ("0.023", or the JSON number 0.023), from
   * $0.000 to $1000.000 in steps of $0.001. Required on a create; left out of
   * an edit, the stored price stays.
   */
  pricePerResumeUsd?: unknown;
  /** From a page loaded before credits were dollars; refused, see below. */
  creditsPerResume?: unknown;
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
 * input leaves out keeps its stored value - the price included, so the enable
 * switch, which sends only `{ enabled }`, cannot reset what a model costs.
 */
function normalizeAIModelMutationInput(
  input: AIModelMutationInput,
  fallback?: AIModelRecord
): Omit<AIModelRecord, 'id' | 'createdAt' | 'updatedAt'> {
  // A price in credits, from an Admin -> Models page loaded before credits
  // were dollars. Refused rather than ignored: ignored, the page's own save
  // would "succeed" leaving the price at whatever it was, and read as dollars
  // a price of 2 credits would be $2.000 a resume.
  if (input.creditsPerResume !== undefined) {
    throw new Error('This page is from an older version of the app. Reload it and try again.');
  }
  const provider = normalizeAIModelProvider(input.provider ?? fallback?.provider);
  if (!provider) {
    throw new Error(`Model provider must be one of: ${AI_PROVIDER_IDS.join(', ')}.`);
  }

  const requestedModelName = normalizeAIModelText(input.modelName, fallback?.modelName || '');
  if (!requestedModelName) {
    throw new Error('Model name is required.');
  }

  const unchanged =
    fallback !== undefined &&
    provider === fallback.provider &&
    requestedModelName.toLowerCase() === fallback.modelName.toLowerCase();
  let modelName = unchanged ? fallback.modelName : requestedModelName;
  if (!unchanged) {
    const option = findProviderModelOption(provider, requestedModelName);
    if (!option) {
      throw new Error(
        `"${requestedModelName}" is not one of the ${getProviderLabel(provider)} models: ` +
          `${describeProviderModelOptions(provider)}.`
      );
    }
    modelName = option.value;
  }

  // Required on a create rather than defaulted to the model name: the display
  // name is the only part of a record a user ever sees, and `sonnet` or
  // `default` says nothing to them.
  const name = normalizeAIModelText(input.name, fallback?.name ?? '');
  if (!name) {
    throw new Error('Display name is required.');
  }

  return {
    name,
    provider,
    modelName,
    description: normalizeAIModelText(input.description, fallback?.description || ''),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : fallback?.enabled ?? true,
    pricePerResumeMilli: parsePricePerResume(input.pricePerResumeUsd, fallback?.pricePerResumeMilli),
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
    throw new Error(
      `${getProviderLabel(candidate.provider)} already has a model for "${candidate.modelName}" ` +
        `("${duplicate.name}"). Edit that one instead.`
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
    throw new Error(
      `"${owner.name}" is already the name of a ${getProviderLabel(owner.provider)} model. Users see only ` +
        'display names, so give this one a different name.'
    );
  }
}

export async function createAIModel(input: AIModelMutationInput): Promise<AdminAppSettings> {
  const settings = await readSettings();
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

  const next: AppSettings = {
    ...settings,
    aiModels: [...settings.aiModels, created],
    defaultModelId: settings.defaultModelId || created.id,
  };

  const saved = await writeSettings(next);
  return toAdminSettings(saved);
}

export async function updateAIModel(id: string, input: AIModelMutationInput): Promise<AdminAppSettings> {
  const settings = await readSettings();
  const current = settings.aiModels.find((model) => model.id === id);
  if (!current) {
    throw new Error('AI model not found.');
  }

  const normalized = normalizeAIModelMutationInput(input, current);
  assertNoDuplicateModel(settings.aiModels, { id, ...normalized });
  if (normalized.name.trim().toLowerCase() !== current.name.trim().toLowerCase()) {
    assertUniqueDisplayName(settings.aiModels, { id, name: normalized.name });
  }

  const next: AppSettings = {
    ...settings,
    aiModels: settings.aiModels.map((model) =>
      model.id === id
        ? {
            ...model,
            ...normalized,
            updatedAt: new Date().toISOString(),
          }
        : model
    ),
  };

  const saved = await writeSettings(next);
  return toAdminSettings(saved);
}

export async function deleteAIModel(id: string): Promise<AdminAppSettings> {
  const settings = await readSettings();
  const nextModels = settings.aiModels.filter((model) => model.id !== id);
  if (nextModels.length === settings.aiModels.length) {
    throw new Error('AI model not found.');
  }

  const next: AppSettings = {
    ...settings,
    aiModels: nextModels,
    defaultModelId: settings.defaultModelId === id ? '' : settings.defaultModelId,
  };

  const saved = await writeSettings(next);
  return toAdminSettings(saved);
}

export async function getAIModelSettings(): Promise<AIModelSettings> {
  const settings = await readSettings();
  return {
    providersEnabled: { ...settings.providersEnabled },
  };
}

/** The bounds on one purchase, per method, and the card-authentication setting. */
export async function getPurchaseSettings(): Promise<{
  paymentLimits: PaymentTargetLimits[];
  requireThreeDSecure: boolean;
  currency: string;
}> {
  const settings = await readSettings();
  return {
    paymentLimits: settings.paymentLimits,
    requireThreeDSecure: settings.requireThreeDSecure,
    currency: CREDIT_CURRENCY,
  };
}

export async function getOutputStorageSettings(): Promise<Pick<AppSettings, 'outputBaseDir' | 'outputPathTemplate'>> {
  const settings = await readSettings();
  return {
    outputBaseDir: settings.outputBaseDir,
    outputPathTemplate: settings.outputPathTemplate,
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
  return settings.providersEnabled[provider] === true && !isProviderLocked(provider);
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
