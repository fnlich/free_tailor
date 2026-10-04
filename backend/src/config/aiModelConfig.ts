import { randomUUID } from 'crypto';

import { getSetting, getSettingRaw, setSetting } from '../database/settingsRepository';
import { SETTINGS_BACKUP_KEY as BROWSER_CHAT_SNAPSHOT_KEY } from '../database/migrations/006_remove_browser_chat';
import { getDatabasePath } from '../database/sqlite';
import { AIProvider } from '../types/template';
import { CODEX_DEFAULT_MODEL } from '../services/ai/providers/codexCli/options';
import {
  AI_PROVIDER_IDS,
  coerceProviderId,
  getProviderDescriptor,
  getProviderLabel as getCatalogProviderLabel,
  getProviderLockReason,
  isProviderLocked,
  isRetiredModelId,
  isRetiredProviderId,
  listLockedProviderIds,
  providerRequiresApiKey,
} from './providerCatalog';
import {
  DEFAULT_CLAUDE_CLI_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_OPENAI_MODEL,
} from '../services/aiModelCatalog';
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
  createdAt: string;
  updatedAt: string;
};

/** Which providers an admin has left switched on, keyed by provider id. */
export type ProvidersEnabled = Record<AIProvider, boolean>;

type AppSettings = {
  /**
   * Canonical enable flags. Replaces the four hand-written booleans this type
   * used to carry; those survive only as derived, read-only fields on the wire
   * so an already-loaded browser tab does not break across a deploy.
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
   * What a credit costs, and how many may be bought at once.
   *
   * In the smallest currency unit, because money in a floating-point number is
   * a rounding error waiting for a large enough order. The bounds are not
   * decoration: an amount arrives from a browser, and a field with no ceiling
   * is a field somebody will send 100000000 to.
   */
  creditPriceCents: number;
  creditMinCredits: number;
  creditMaxCredits: number;
  /**
   * What each payment method may be bought in.
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
   * Bounds are in CENTS here and nowhere else in this file, because cents are
   * what an operator thinks in ("between $2.50 and $100"). They become credit
   * counts in services/payments/pricing.ts, which is the only place allowed to
   * know the price.
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
 * The flat per-provider booleans older clients read. Derived from
 * `providersEnabled` on the way out; accepted on the way in.
 */
export type LegacyProviderFlags = {
  claudeCliEnabled: boolean;
  claudeEnabled: boolean;
  openaiEnabled: boolean;
  deepseekEnabled: boolean;
};

export type PublicAppSettings = AIModelSettings & LegacyProviderFlags & Pick<
  AppSettings,
  | 'defaultMode'
  | 'defaultTheme'
  | 'defaultResumeSelection'
  | 'defaultGroupId'
  | 'defaultProfileId'
  | 'defaultModelId'
  | 'defaultResumeDocxEnabled'
  | 'defaultCoverLetterDocxEnabled'
  | 'aiModels'
  | 'googleSheetsSources'
>;
/**
 * One provider this installation cannot run, and the models it would offer.
 *
 * Sent so a picker can keep those models on screen behind a padlock. They are
 * carried HERE rather than left in `aiModels` because that list is the set of
 * models a request may name, and every consumer of it - the default-model
 * select, the request resolver - is entitled to keep assuming so. A locked
 * model is a label, not a choice.
 */
export type ProviderLock = {
  id: AIProvider;
  label: string;
  reason: string;
  /** This install's enabled model records for the provider, in stored order. */
  models: AIModelRecord[];
};

export type PublicAppSettingsWithDerived = PublicAppSettings & {
  outputPathUsesJobTitle: boolean;
  /** Providers locked in this build, so the UI can say so instead of hiding them. */
  providerLocks: ProviderLock[];
};

export type AdminAppSettings = Omit<PublicAppSettingsWithDerived, 'aiModels'> & {
  aiModels: AIModelRecord[];
  outputBaseDir: string;
  outputPathTemplate: string;
  outputPathPreview: string;
  creditPriceCents: number;
  creditMinCredits: number;
  creditMaxCredits: number;
  paymentLimits: PaymentTargetLimits[];
  requireThreeDSecure: boolean;
};

export type AppSettingsUpdate = Partial<PublicAppSettings> & {
  /** Accepted for one release so a stale client can still save. */
  openrouterEnabled?: boolean;
  outputBaseDir?: string;
  outputPathTemplate?: string;
  creditPriceCents?: number;
  creditMinCredits?: number;
  creditMaxCredits?: number;
  paymentLimits?: PaymentTargetLimits[];
  requireThreeDSecure?: boolean;
};

/**
 * The price of one credit, and the bounds on a single purchase.
 *
 * Deliberately NOT in the public settings: the buy page reads them from
 * `/api/payments/methods`, which also says which providers are actually
 * configured. Keeping the price beside the thing that charges it means there is
 * one answer to "what does this cost", not a settings copy that can disagree
 * with the checkout.
 */
export const DEFAULT_CREDIT_PRICE_CENTS = 50;
export const DEFAULT_CREDIT_MIN = 10;
export const DEFAULT_CREDIT_MAX = 5000;
export const CREDIT_CURRENCY = 'usd';

/**
 * What one payment method - or one coin - may be bought in.
 *
 * `feeBps` is retained from the gross: the buyer is charged the amount they
 * chose and credited the rest. It is basis points rather than a percentage
 * because 2.2% is 220 and needs no decimal anywhere in the arithmetic.
 */
export type PaymentTargetLimits = {
  /**
   * `card` or `crypto`. A stored row naming a coin id still reads and still
   * round-trips - see the note on `paymentLimits` - but nothing resolves one.
   */
  target: string;
  minCents: number;
  maxCents: number;
  /** Basis points of the gross retained as a fee. 0 for card. */
  feeBps: number;
  feeFixedCents: number;
  /**
   * The amounts to offer as buttons, in cents.
   *
   * An INTENTION, not a promise: what a buyer sees is worked out from these by
   * `presetsFor`, which drops any that fall outside the bounds and rounds each
   * to a whole number of credits. A preset can therefore never name a price
   * the server would refuse to charge.
   */
  presetsCents: number[];
};

/**
 * The defaults, which are the figures in the design this was built to.
 *
 * Card takes no fee and starts at $2.50; crypto starts at $50 because sending
 * coin costs the buyer a network fee whatever we do, and a $2.50 purchase that
 * costs $4 to send is not a kindness.
 */
export const DEFAULT_PAYMENT_LIMITS: PaymentTargetLimits[] = [
  {
    target: 'card',
    minCents: 250,
    maxCents: 10_000,
    feeBps: 0,
    feeFixedCents: 0,
    presetsCents: [250, 500, 1_000, 2_500, 5_000, 10_000],
  },
  {
    target: 'crypto',
    minCents: 5_000,
    maxCents: 200_000,
    feeBps: 220,
    feeFixedCents: 0,
    presetsCents: [5_000, 10_000, 15_000, 25_000, 50_000, 100_000],
  },
];

/** A fee above this would be a fault, not a policy. */
const MAX_FEE_BPS = 5_000;
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
  const seeds: Array<Pick<AIModelRecord, 'name' | 'provider' | 'modelName' | 'description'>> = [
    // The subscription-seat models come first so `runnableModels[0]` - the
    // fallback whenever a stored default no longer resolves - is a model that
    // costs nothing to run.
    {
      name: 'Claude Sonnet (subscription)',
      provider: 'claude-cli',
      modelName: 'sonnet',
      description: 'Balanced default for tailoring, analysis and extraction on the subscription seat.',
    },
    {
      name: 'Claude Opus (subscription)',
      provider: 'claude-cli',
      modelName: 'opus',
      description: 'Highest-capability model on the subscription seat, for the most demanding prompts.',
    },
    {
      name: 'Claude Haiku (subscription)',
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
      name: 'Codex (subscription)',
      provider: 'codex-cli',
      modelName: CODEX_DEFAULT_MODEL,
      description:
        "Runs the local codex CLI on your ChatGPT subscription, using that account's own default model.",
    },
    {
      name: DEFAULT_OPENAI_MODEL,
      provider: 'openai',
      modelName: DEFAULT_OPENAI_MODEL,
      description: 'OpenAI direct default configured for this app.',
    },
    {
      name: 'GPT-5',
      provider: 'openai',
      modelName: 'gpt-5',
      description: 'High-reasoning OpenAI direct model for more demanding resume and prompt tasks.',
    },
    {
      name: 'GPT-5 mini',
      provider: 'openai',
      modelName: 'gpt-5-mini',
      description: 'Fast OpenAI direct option for structured prompt work.',
    },
    {
      name: 'GPT-5 nano',
      provider: 'openai',
      modelName: 'gpt-5-nano',
      description: 'Low-cost OpenAI direct option for extraction and classification.',
    },
    {
      name: DEFAULT_CLAUDE_MODEL,
      provider: 'claude',
      modelName: DEFAULT_CLAUDE_MODEL,
      description: 'Anthropic direct default configured for this app.',
    },
    {
      name: DEFAULT_DEEPSEEK_MODEL,
      provider: 'deepseek',
      modelName: DEFAULT_DEEPSEEK_MODEL,
      description: 'DeepSeek direct default configured for this app.',
    },
    {
      name: 'DeepSeek V4 Pro',
      provider: 'deepseek',
      modelName: 'deepseek-v4-pro',
      description: 'DeepSeek direct high-capability model for long-context analysis and drafting.',
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
 * The seed list is ordered cheapest-and-most-capable first, so "the first
 * unlocked seed" is the right answer rather than a fallback: on a build with
 * the Claude seat locked it lands on the Codex seat, which costs nothing and
 * needs no key either. Only with BOTH seats locked does it reach a metered API
 * model - which is then the only kind of model this deployment can run, so it
 * is still the honest answer, but it is one that bills per token.
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
  creditPriceCents: DEFAULT_CREDIT_PRICE_CENTS,
  creditMinCredits: DEFAULT_CREDIT_MIN,
  creditMaxCredits: DEFAULT_CREDIT_MAX,
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

function getEnvironmentApiKey(provider: AIProvider): string {
  const envVar = getProviderDescriptor(provider).envKeyVar;
  if (!envVar) {
    return '';
  }
  return process.env[envVar]?.trim() || '';
}

function normalizeGoogleSheetSourceName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * The per-target purchase limits, checked field by field.
 *
 * `normalizeBoundedInteger` cannot reach inside an array, so every bound here
 * is its own check - and the cross-field one matters most: a row whose minimum
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

      const minCents = normalizeBoundedInteger(
        raw.minCents, 1, 1, MAX_AMOUNT_CENTS, `${target} minCents`, strict
      );
      const maxCents = normalizeBoundedInteger(
        raw.maxCents, MAX_AMOUNT_CENTS, 1, MAX_AMOUNT_CENTS, `${target} maxCents`, strict
      );
      if (minCents > maxCents) {
        if (strict) {
          throw new Error(`${target} minCents cannot be greater than maxCents`);
        }
        return null;
      }

      const feeBps = normalizeBoundedInteger(
        raw.feeBps, 0, 0, MAX_FEE_BPS, `${target} feeBps`, strict
      );
      const feeFixedCents = normalizeBoundedInteger(
        raw.feeFixedCents, 0, 0, MAX_AMOUNT_CENTS, `${target} feeFixedCents`, strict
      );

      /*
       * Presets are sorted and deduped here, so the buttons come out in a
       * sensible order whatever order they were saved in. They are NOT filtered
       * against the bounds here - that happens in `presetsFor`, where the price
       * is known, because a preset's validity depends on what a credit costs.
       */
      const presetSource = Array.isArray(raw.presetsCents) ? raw.presetsCents : [];
      const presetsCents = [
        ...new Set(
          presetSource
            .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
            .filter((value) => Number.isInteger(value) && value > 0 && value <= MAX_AMOUNT_CENTS)
        ),
      ].sort((left, right) => left - right);

      return { target, minCents, maxCents, feeBps, feeFixedCents, presetsCents };
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
 * Ids of stored model records dropped on read because their provider is retired.
 *
 * Remembered so that a reference to one - a profile's stored preference, a
 * request from a page loaded before the upgrade - is recognised as naming a
 * retired provider and falls back to the default, instead of failing as a model
 * that "was not found". The shipped ids are listed in `RETIRED_MODEL_IDS`; this
 * covers the ones an administrator created, whose ids are random UUIDs.
 *
 * Only for the life of the process, and only ever added to. That is enough
 * while the records are still in the row, which is exactly while a reference to
 * one can be outstanding: migration 006 clears the references in the same pass
 * that deletes the records, and it runs before an administrator's first save
 * could normalize them away - on the boot or the sign-in that makes the first
 * administrator (see `applyConfiguredAdmins`). It deliberately does not grow
 * into "any id that is missing falls back" - a model an administrator deleted
 * is still an error.
 */
const droppedRetiredModelIds = new Set<string>();

/**
 * One line per kind of browser chat residue, however many reads find it.
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

function noteDroppedRetiredModel(raw: Partial<Record<keyof AIModelRecord, unknown>>): void {
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const id = normalizeAIModelText(raw.id);
  const modelName = normalizeAIModelText(raw.modelName);
  // The id a record with none would have been given, so a reference built the
  // same way is recognised too.
  droppedRetiredModelIds.add(id || `${provider}-${slugifyModelPart(modelName) || 'model'}`);

  warnRetiredResidueOnce(
    `records:${provider}`,
    `[ai] Ignoring stored model record(s) for "${provider}": the browser chat providers were removed. ` +
      'Migration 006 deletes these records on start-up, and saving Admin -> Settings writes the row ' +
      'without them.'
  );
}

/**
 * True when `id` names a model that only ever ran on a retired provider.
 *
 * Asked by every path that resolves a model id, so that all of them agree on
 * what such a reference means: the app default, never "not found".
 */
function isRetiredModelReference(id: string): boolean {
  return isRetiredModelId(id) || droppedRetiredModelIds.has(id);
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
 * A locked provider's models are not among them - they are carried separately
 * as `providerLocks`, so a picker can show them behind a padlock without anyone
 * being able to choose one.
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
 * Keys for a retired provider are ignored. A row whose only switched-on
 * providers were the browser chat ones is given one that runs by
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
 * A whole number inside a range, or the fallback.
 *
 * Clamped rather than rejected outside strict mode, because these arrive from a
 * number input on the admin page and the useful behaviour for a price typed one
 * digit too long is the highest one allowed, not a settings save that fails.
 * Strict mode - which is how the stored row is read - still refuses, so a
 * hand-edited value out of range is reported instead of silently becoming
 * something else.
 */
function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
  strict: boolean
): number {
  if (typeof value === 'undefined') return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    if (strict) throw new Error(`${field} must be a whole number between ${min} and ${max}`);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }
  return parsed;
}


/**
 * Whether a stored row is one the browser chat removal may have left with
 * nothing to run on: it still names a browser provider, or migration 006
 * cleaned it - which the snapshot 006 keeps of every row it rewrote says, long
 * after the row itself stopped saying it.
 *
 * Asked only once a row has already failed to offer anything runnable, so the
 * extra read costs nothing on any read that succeeds.
 */
function rowRanRetiredProviders(source: Record<string, unknown>): boolean {
  const flags = source.providersEnabled;
  if (typeof flags === 'object' && flags !== null && Object.keys(flags).some((key) => isRetiredProviderId(key))) {
    return true;
  }
  if (
    Array.isArray(source.aiModels) &&
    source.aiModels.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        isRetiredProviderId((entry as Record<string, unknown>).provider)
    )
  ) {
    return true;
  }
  try {
    return getSettingRaw(BROWSER_CHAT_SNAPSHOT_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Keeps a stored row that ran on the browser chat providers readable once they
 * are gone.
 *
 * Without them an install can be left with nothing it can run: an operator who
 * used the free chat sites alone, or whose seats are locked on this machine
 * (`AI_LOCKED_PROVIDERS`) - which is exactly what moved many installs onto the
 * browsers. The asserts in `readSettings` would then refuse every settings read:
 * the model list, every generation, and the Settings page an administrator
 * would repair it from. So one provider this machine CAN run is read as
 * switched on, and given a model that runs:
 *
 *   - not locked here - a locked seat switched on would repair nothing;
 *   - a keyless seat before a metered API, so the repair does not start billing;
 *   - one the operator left switched on before one that has to be switched on,
 *     and one with a model already switched on before one without;
 *   - a seat's missing seed models added and, failing that, one of its own
 *     switched back on; a metered API's own model switched back on, and its
 *     seeds only when it has none.
 *
 * That is the repair migration 006 writes, made for the reason 001 switched the
 * seat on for an install that had run only on OpenRouter - and it is needed
 * after 006 too, because a lock can be added at any time and 006 runs once.
 *
 * Only for a row that ran browser chat (`rowRanRetiredProviders`). Any other
 * row an operator left with nothing runnable - every provider they ticked
 * since locked in .env - still fails by name, pointing at the lock they set,
 * which is the place to undo it. And nothing is possible when every provider
 * is locked: the assert names the locks.
 *
 * In memory only. Nothing here writes; 006, or the next save from the admin
 * page, persists it - so 006 still finds the residue and snapshots the row
 * before it changes anything. `providersEnabled` is the caller's freshly
 * normalized record and is updated in place.
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
  if (!rowRanRetiredProviders(source)) {
    return aiModels;
  }

  // Lowest first, catalog order breaking ties: keyless over metered, then
  // switched on over off, then one with a model already switched on.
  const rank = (id: AIProvider): number =>
    (providerRequiresApiKey(id) ? 4 : 0) +
    (providersEnabled[id] === true ? 0 : 2) +
    (aiModels.some((model) => model.provider === id && model.enabled) ? 0 : 1);
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
    // A seat gets its missing seed models, as 006 gives it them; a metered API
    // that already has models of its own gets one of THOSE back rather than
    // key-billed models nobody added. By id AND by provider and model name: the
    // reader refuses two records for one pair, so a seed beside a record the
    // operator created under their own id would break the row it is repairing.
    if (!providerRequiresApiKey(target) || own().length === 0) {
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
    }
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
  warnRetiredResidueOnce(
    `rescued:${target}`,
    '[ai] Nothing in the stored settings can run on this machine without the removed browser chat ' +
      `providers${locked.length ? ` (locked here: ${locked.join(', ')})` : ''}; reading ` +
      `"${getCatalogProviderLabel(target)}" as ` +
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
 * only a stored row is repaired in memory or reported as browser chat residue.
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
  // A stored default that named a browser model is replaced like any default
  // that no longer resolves - but this one is residue with a known cause, so it
  // is said once, as a stored profile preference or prompt override naming one
  // is. After the records are normalized, so an administrator's own browser
  // model, whose id only its dropped record could name, is recognised too.
  const storedDefault = typeof source.defaultModelId === 'string' ? source.defaultModelId.trim() : '';
  if (storedRow && storedDefault && isRetiredModelReference(storedDefault)) {
    warnRetiredResidueOnce(
      `default:${storedDefault}`,
      `[ai] The stored default model is "${storedDefault}", a model on the browser chat providers, which ` +
        `were removed; "${defaultModelId}" is the default instead. Migration 006 repoints it, and saving ` +
        'Admin -> Settings writes the new one.'
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
    creditPriceCents: normalizeBoundedInteger(
      source.creditPriceCents, fallback.creditPriceCents, 1, 1_000_000, 'creditPriceCents', strict
    ),
    creditMinCredits: normalizeBoundedInteger(
      source.creditMinCredits, fallback.creditMinCredits, 1, 1_000_000, 'creditMinCredits', strict
    ),
    creditMaxCredits: normalizeBoundedInteger(
      source.creditMaxCredits, fallback.creditMaxCredits, 1, 1_000_000, 'creditMaxCredits', strict
    ),
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

/** The flat booleans older clients still read, derived from the record. */
function toLegacyProviderFlags(settings: AppSettings): LegacyProviderFlags {
  return {
    claudeCliEnabled: settings.providersEnabled['claude-cli'],
    claudeEnabled: settings.providersEnabled.claude,
    openaiEnabled: settings.providersEnabled.openai,
    deepseekEnabled: settings.providersEnabled.deepseek,
  };
}

/**
 * The default model id the app actually OFFERS, which is not always the one
 * stored.
 *
 * They differ whenever the stored id is not runnable right now - a provider
 * locked since it was chosen, say. The public value has to be one of the models
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

function toPublicSettings(settings: AppSettings): PublicAppSettings {
  const runnable = getRunnableModels(settings);
  return {
    providersEnabled: { ...settings.providersEnabled },
    ...toLegacyProviderFlags(settings),
    defaultMode: settings.defaultMode,
    defaultTheme: settings.defaultTheme,
    defaultResumeSelection: settings.defaultResumeSelection,
    defaultGroupId: settings.defaultGroupId,
    defaultProfileId: settings.defaultProfileId,
    defaultModelId: effectiveDefaultModelId(settings),
    defaultResumeDocxEnabled: settings.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: settings.defaultCoverLetterDocxEnabled,
    aiModels: runnable.map((model) => ({ ...model })),
    googleSheetsSources: settings.googleSheetsSources,
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

function toPublicSettingsWithDerived(settings: AppSettings): PublicAppSettingsWithDerived {
  return {
    ...toPublicSettings(settings),
    outputPathUsesJobTitle: outputPathTemplateUsesJobTitle(settings.outputPathTemplate),
    providerLocks: describeProviderLocks(settings),
  };
}

function toAdminSettings(settings: AppSettings): AdminAppSettings {
  return {
    ...toPublicSettingsWithDerived(settings),
    aiModels: settings.aiModels.map((model) => ({ ...model })),
    outputBaseDir: settings.outputBaseDir,
    outputPathTemplate: settings.outputPathTemplate,
    outputPathPreview: buildOutputPathPreview(settings.outputPathTemplate),
    creditPriceCents: settings.creditPriceCents,
    creditMinCredits: settings.creditMinCredits,
    creditMaxCredits: settings.creditMaxCredits,
    paymentLimits: settings.paymentLimits,
    requireThreeDSecure: settings.requireThreeDSecure,
  };
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
 * Settings page. Both are gone - the environment is the only source now - so
 * an upgraded install has secrets sitting in a row nothing reads. Detected
 * here so `readSettings` can rewrite the row without them, once.
 */
function purgeStoredApiKeys(stored: unknown): boolean {
  if (!stored || typeof stored !== 'object') return false;
  if (!hasOwnProperty(stored as object, 'apiKeys')) return false;
  console.warn(
    '[settings] Removing API keys stored in the database. Keys now come from the environment ' +
      'only - set OPENAI_API_KEY, ANTHROPIC_API_KEY or DEEPSEEK_API_KEY in .env if you use a ' +
      'metered provider.'
  );
  return true;
}

async function readSettings(): Promise<AppSettings> {
  const path = getDatabasePath();
  const cached = settingsCache;
  if (cached && cached.path === path && Date.now() - cached.at < SETTINGS_CACHE_TTL_MS) {
    return cached.value;
  }

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
  // tolerating - browser chat records among them - before migration 006 has
  // snapshotted them, and would forget which profile preferences named them.
  if (purgeStoredApiKeys(stored)) {
    const { apiKeys: _discarded, ...withoutKeys } = stored as Record<string, unknown>;
    setSetting(APP_SETTINGS_KEY, withoutKeys);
  }
  assertAtLeastOneProviderEnabled(settings);
  assertAtLeastOneRunnableModel(settings);
  settingsCache = { path, value: settings, at: Date.now() };
  return settings;
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

export async function getPublicAppSettings(): Promise<PublicAppSettingsWithDerived> {
  return toPublicSettingsWithDerived(await readSettings());
}

export async function getAdminAppSettings(): Promise<AdminAppSettings> {
  return toAdminSettings(await readSettings());
}

export async function updateAppSettings(input: AppSettingsUpdate): Promise<AdminAppSettings> {
  const current = await readSettings();

  // A client that still sends the flat per-provider booleans has to be heard.
  // Merged naively they never would be: `current` always carries a
  // `providersEnabled` record, and the record wins over the flat fields, so an
  // older client's provider toggle would appear to save and change nothing.
  const legacyFlags = input as Record<string, unknown>;
  // A page loaded before the browser chat providers were removed still sends
  // their switches: a flag per retired provider, the master switch, the list of
  // debug browsers. Every one is dropped without a word - the normalizer below
  // names none of them, so nothing reaches the row - because refusing the save
  // would only stop a stale tab saving the settings it CAN still change. The
  // retired provider flags are taken out here as well rather than left to it:
  // a stored row whose only ticked providers are retired reads with the seat
  // switched on, and on a save that would silently undo an administrator
  // unticking everything else instead of telling them why it cannot be saved.
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

  const next = normalizeSettings(
    {
      ...current,
      ...input,
      providersEnabled,
    },
    current
  );

  assertAtLeastOneProviderEnabled(next);
  assertAtLeastOneRunnableModel(next);
  // A minimum above the maximum is a form nobody can submit: the buy page would
  // refuse every amount, and the reason would be invisible from the page.
  if (next.creditMinCredits > next.creditMaxCredits) {
    throw new Error('creditMinCredits cannot be greater than creditMaxCredits');
  }

  /*
   * The same check for the per-target rows, and it has to be here rather than
   * only inside the normalizer.
   *
   * This path normalizes NON-strict, which drops a bad row and falls back to
   * what was there before. For most fields that is the kind direction to fail
   * in; here it would tell an operator their save succeeded while the limit
   * they just typed was thrown away. So an inverted band is reported by name.
   */
  if (typeof input.paymentLimits !== 'undefined') {
    for (const row of input.paymentLimits ?? []) {
      if (!row || typeof row !== 'object') continue;
      const { target, minCents, maxCents } = row;
      if (
        typeof minCents === 'number' &&
        typeof maxCents === 'number' &&
        minCents > maxCents
      ) {
        throw new Error(`${target || 'a payment limit'}: the smallest amount cannot be larger than the largest`);
      }
    }
  }

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

export async function listAvailableAIModelOptions(): Promise<Array<{
  id: string;
  label: string;
  provider: AIProvider;
  modelName: string;
  description: string;
}>> {
  const models = await listAvailableAIModels();
  return models.map((model) => ({
    id: model.id,
    label: `${getProviderLabel(model.provider)} · ${model.name}`,
    provider: model.provider,
    modelName: model.modelName,
    description: model.description,
  }));
}

/**
 * Refuses a locked provider by name, before the generic "disabled by admin"
 * branch can claim it - the two have different fixes, and telling someone to
 * ask an admin to tick a box that will not help is worse than saying nothing.
 */
function assertProviderNotLocked(provider: AIProvider): void {
  const reason = getProviderLockReason(provider);
  if (reason) {
    throw new Error(`${getProviderLabel(provider)} is locked in this installation. ${reason}`);
  }
}

const warnedLockedPreferences = new Set<string>();

/**
 * Resolves a model id that was STORED rather than chosen for this run.
 *
 * A profile's model is a preference, and a preference for something this
 * deployment has since locked is stale, not wrong. Failing it would mean an
 * install that locks a provider breaks every generate for every profile that
 * had picked it - a change nobody using the app made and none of them can see
 * from the error. So it falls back to the app default, and says so once.
 *
 * An id named in the request keeps going through `resolveRequestedAIModel`,
 * where a lock IS an error: someone picked that model a moment ago and quietly
 * running a different one would be worse than refusing.
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
  // entry, or a browser chat record - is stale in the same way a locked one is
  // below, and more permanently. Checked before the lookup, because the record
  // is not in `aiModels` any more and the lookup would only report it missing.
  if (isRetiredModelReference(requested)) {
    warnOncePerPreference(
      requested,
      `[ai] A stored preference names "${requested}", a model on the browser chat providers, which ` +
        'were removed; those calls run on the default model instead. Pick a new model for it to ' +
        'silence this.'
    );
    return resolveRequestedAIModel();
  }

  const stored = settings.aiModels.find((model) => model.id === requested);
  /*
   * Two states, and only one of them is staleness.
   *
   * LOCKED - this deployment cannot run it - says the installation does not
   * offer the thing, through no act of the profile's owner and invisibly to
   * them, so the preference is stale and falls back.
   *
   * MERELY DISABLED by an administrator is deliberately still an error, and
   * that is a decision this file already made: it is real misconfiguration,
   * the admin who flipped it is the person who can see the failure, and
   * swallowing it would hide the case where they turned off the wrong one.
   */
  if (stored && isProviderLocked(stored.provider)) {
    warnOncePerPreference(
      requested,
      `[ai] A stored preference names "${stored.name}", whose provider is not offered in this ` +
        'installation; those calls run on the default model instead. Pick a new model for it to ' +
        'silence this.'
    );
    return resolveRequestedAIModel();
  }

  return resolveRequestedAIModel(requested);
}

/**
 * A request id that can only mean a retired provider: a retired model id, a
 * dropped record's id, a retired provider id on its own, or `provider:model`
 * with a retired provider - the four shapes `resolveRequestedAIModel` accepts.
 */
function namesRetiredModel(requested: string): boolean {
  if (isRetiredModelReference(requested) || isRetiredProviderId(requested)) return true;
  const separator = requested.indexOf(':');
  return separator > 0 && isRetiredProviderId(requested.slice(0, separator));
}

/** One line per stale preference, however many calls it makes. */
function warnOncePerPreference(key: string, message: string): void {
  if (warnedLockedPreferences.has(key)) return;
  warnedLockedPreferences.add(key);
  console.warn(message);
}

export async function resolveRequestedAIModel(requestedModelId?: string): Promise<AIModelRecord> {
  const settings = await readSettings();
  const runnableModels = getRunnableModels(settings);

  if (runnableModels.length === 0) {
    throw new Error('No enabled AI models are configured.');
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
  const retired = Boolean(named) && namesRetiredModel(named);
  if (retired) {
    warnOncePerPreference(
      `request:${named}`,
      `[ai] A request named "${named}", a model on the browser chat providers, which were removed; ` +
        'it runs on the default model instead. Reloading the page that sent it stops this.'
    );
  }
  const requested = retired ? '' : named;
  if (!requested) {
    return runnableModels.find((model) => model.id === settings.defaultModelId) ?? runnableModels[0];
  }

  const requestedModel = settings.aiModels.find((model) => model.id === requested);
  if (requestedModel) {
    if (!requestedModel.enabled) {
      throw new Error(`Selected AI model "${requestedModel.name}" is disabled.`);
    }
    assertProviderNotLocked(requestedModel.provider);
    if (!isProviderEnabled(requestedModel.provider, settings)) {
      throw new Error(`Selected AI model provider "${requestedModel.provider}" is disabled by admin.`);
    }
    return requestedModel;
  }

  const requestedProvider = coerceProviderId(requested);
  if (requestedProvider) {
    assertProviderNotLocked(requestedProvider);
    const providerModels = runnableModels.filter((model) => model.provider === requestedProvider);
    if (providerModels.length === 0) {
      throw new Error(`No enabled models are configured for provider "${getProviderLabel(requestedProvider)}".`);
    }
    return providerModels.find((model) => model.id === settings.defaultModelId) ?? providerModels[0];
  }

  const providerModelMatch = settings.aiModels.find(
    (model) => `${model.provider}:${model.modelName}` === requested
  );
  if (providerModelMatch) {
    if (!providerModelMatch.enabled) {
      throw new Error(`Selected AI model "${providerModelMatch.name}" is disabled.`);
    }
    assertProviderNotLocked(providerModelMatch.provider);
    if (!isProviderEnabled(providerModelMatch.provider, settings)) {
      throw new Error(`Selected AI model provider "${providerModelMatch.provider}" is disabled by admin.`);
    }
    return providerModelMatch;
  }

  throw new Error(`AI model "${requested}" was not found.`);
}

type AIModelMutationInput = {
  name?: string;
  provider?: AIProvider;
  modelName?: string;
  description?: string;
  enabled?: boolean;
};

function normalizeAIModelMutationInput(
  input: AIModelMutationInput,
  fallback?: AIModelRecord
): Omit<AIModelRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const provider = normalizeAIModelProvider(input.provider ?? fallback?.provider);
  if (!provider) {
    throw new Error(`Model provider must be one of: ${AI_PROVIDER_IDS.join(', ')}.`);
  }

  const modelName = normalizeAIModelText(input.modelName, fallback?.modelName || '');
  if (!modelName) {
    throw new Error('Model name is required.');
  }

  const name = normalizeAIModelText(input.name, fallback?.name || modelName);
  if (!name) {
    throw new Error('Display name is required.');
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
    throw new Error(`A model for ${candidate.provider} with name "${candidate.modelName}" already exists.`);
  }
}

export async function createAIModel(input: AIModelMutationInput): Promise<AdminAppSettings> {
  const settings = await readSettings();
  const normalized = normalizeAIModelMutationInput(input);
  assertNoDuplicateModel(settings.aiModels, normalized);

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

/**
 * The API key for a metered provider, from the environment.
 *
 * The app used to keep keys in its own database as well, managed from a panel
 * on the Settings page. Both are gone: a credential stored in the app's
 * database is one more copy of a secret to leak, back up and forget about, and
 * the environment already had to be supported anyway. `.env` is now the only
 * place a key comes from, which also means the value shown by `printenv` is
 * the value that will be used.
 */
export async function getProviderApiKey(provider: AIProvider): Promise<string> {
  // A subscription-seat provider has no key at all.
  if (!providerRequiresApiKey(provider)) {
    return '';
  }
  return getEnvironmentApiKey(provider);
}

/** What a credit costs and the bounds on one purchase. */
export async function getCreditPricingSettings(): Promise<{
  creditPriceCents: number;
  creditMinCredits: number;
  creditMaxCredits: number;
  paymentLimits: PaymentTargetLimits[];
  requireThreeDSecure: boolean;
  currency: string;
}> {
  const settings = await readSettings();
  return {
    creditPriceCents: settings.creditPriceCents,
    creditMinCredits: settings.creditMinCredits,
    creditMaxCredits: settings.creditMaxCredits,
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
 * What a caller that named no provider should run on.
 *
 * Keyless first, then catalog order. Catalog order alone used to say the same
 * thing - the subscription seat sits at the top of it - but only by accident
 * of the seat being first, and with that seat locked, plain catalog order
 * hands the fallback to the metered Anthropic API instead. A call nobody chose
 * a provider for should not be the one that starts billing tokens, so the
 * preference is stated rather than inherited from a sort key.
 *
 * Locked providers are skipped rather than returned and rejected later: this
 * is an answer to "what can this run on", and one that cannot run is not an
 * answer to it.
 */
export function getDefaultEnabledProvider(settings: AIModelSettings): AIProvider {
  const runnable = AI_PROVIDER_IDS.filter((id) => isProviderEnabled(id, settings));
  return (
    runnable.find((id) => !providerRequiresApiKey(id)) ??
    runnable[0] ??
    AI_PROVIDER_IDS.find((id) => settings.providersEnabled[id]) ??
    AI_PROVIDER_IDS[0]
  );
}
