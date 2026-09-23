import { randomUUID } from 'crypto';

import { describeAiPreferenceDefaults, type AiPreferenceDefaults } from './aiPreferences';
import { getSetting, setSetting } from '../database/settingsRepository';
import { planRoute } from '../services/ai/freeChatRouting';
import { getDatabasePath } from '../database/sqlite';
import { AIProvider } from '../types/template';
import {
  AI_PROVIDER_IDS,
  coerceProviderId,
  getProviderDescriptor,
  getProviderLabel as getCatalogProviderLabel,
  BROWSER_CHAT_SITE_IDS,
  getProviderLockReason,
  isBrowserChatSiteId,
  type BrowserChatSiteId,
  HYBRID_MODEL_DESCRIPTION,
  HYBRID_MODEL_ID,
  HYBRID_MODEL_LABEL,
  isHybridModelId,
  isProviderLocked,
  listLockedProviderIds,
  providerRequiresApiKey,
  providerSupportsEffort,
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
   * What each payment method, and optionally each coin, may be bought in.
   *
   * One flat list rather than a field per method, because the targets are not
   * a fixed set: every asset an operator enables is another one. A row's
   * `target` is a method (`card`, `crypto`) or a single asset
   * (`ethereum:USDT`), and lookup is exact-asset first, then method, then the
   * hard defaults - so per-coin limits are possible without demanding a row
   * for every coin the operator is happy to treat like the rest.
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
  /**
   * The debug browsers the free chat providers drive, one tab apiece.
   *
   * A list, not a port, and that is the whole design. A chat tab holds ONE
   * conversation, so the only way to run two free calls at once is to have two
   * tabs - which means two browsers, because a second tab in the same window is
   * a background tab and Chrome freezes those. Each entry is therefore one
   * browser, on its own debug port, showing one site.
   *
   * How many entries a site has IS its concurrency; the queue behind them is
   * unbounded and first-come-first-served.
   */
  browserChatEndpoints: BrowserChatEndpoint[];
};

/** One debug browser: which chat site it shows, and the port it listens on. */
export type BrowserChatEndpoint = {
  siteId: BrowserChatSiteId;
  port: number;
};

// Defined in the provider catalog, re-exported here because this is where
// every existing caller imports them from.
export { BROWSER_CHAT_SITE_IDS, isBrowserChatSiteId } from './providerCatalog';
export type { BrowserChatSiteId } from './providerCatalog';

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

/**
 * Which tuning knobs actually reach a given provider's model.
 *
 * Sent with the settings rather than fetched from `/ai/health`, because the
 * pickers need it on every render and that endpoint probes every provider -
 * seconds of work to answer a question whose answer is fixed at build time.
 */
export type ProviderTuningSupport = {
  provider: AIProvider;
  effort: boolean;
};

export function listProviderTuningSupport(): ProviderTuningSupport[] {
  return AI_PROVIDER_IDS.map((provider) => ({
    provider,
    effort: providerSupportsEffort(provider),
  }));
}

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
  | 'browserChatEndpoints'
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
  /** Which providers honour effort at all. */
  providerTuning: ProviderTuningSupport[];
  outputPathUsesJobTitle: boolean;
  /**
   * The effort a run uses when nothing overrides it, plus the
   * values that may be chosen. Sent rather than hard-coded in the client so
   * that the "use the app default" option can name the value it will really
   * use, and so a new effort level does not need a matching frontend release.
   */
  aiPreferenceDefaults: AiPreferenceDefaults;
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
  /** A method (`card`, `crypto`) or one asset id (`ethereum:USDT`). */
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
 * Card takes no fee and starts at $2.50; crypto starts at $50 because a chain
 * payment costs the buyer a network fee whatever we do, and a $2.50 purchase
 * that costs $4 to send is not a kindness.
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
    // Browser-driven chat. Ranked after the seat and before the metered APIs:
    // both cost nothing to run, but a chat window answers at reading speed and
    // one conversation at a time, so neither should be what an unset default
    // falls back to.
    {
      name: 'Claude (free)',
      provider: 'claude-web',
      modelName: 'chat',
      description:
        'Free. Drives claude.ai in a Chrome you started and signed in to - no API key, nothing metered.',
    },
    {
      name: 'ChatGPT (free)',
      provider: 'chatgpt-web',
      modelName: 'chat',
      description:
        'Free. Drives chatgpt.com in a Chrome you started and signed in to - no API key, nothing metered.',
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

/**
 * The debug port a fresh install starts with.
 *
 * Read from the environment so an operator who already configured
 * `AI_WEB_CDP_PORT` does not have to set it again in two places, and so a
 * deployment can ship a default. Once saved on the Settings page the stored
 * value wins - which is the whole point of putting it there.
 */
export const BROWSER_CHAT_PORT_MIN = 1024;
export const BROWSER_CHAT_PORT_MAX = 65535;

function envPort(): number {
  const raw = Number.parseInt((process.env.AI_WEB_CDP_PORT ?? '').trim(), 10);
  return Number.isInteger(raw) && raw >= BROWSER_CHAT_PORT_MIN && raw <= BROWSER_CHAT_PORT_MAX
    ? raw
    : 9222;
}

/**
 * The browsers a fresh install expects, before anything is saved.
 *
 * One per site, on adjacent ports, because a browser here shows ONE chat tab -
 * two sites on one port would put one of them in a background tab, and Chrome
 * freezes those. `AI_WEB_CDP_PORT` names the first; the second follows it.
 * Either can be changed, and more added, on the Settings page.
 */
function defaultBrowserChatEndpoints(): BrowserChatEndpoint[] {
  const first = envPort();
  const second = first < BROWSER_CHAT_PORT_MAX ? first + 1 : first - 1;
  return [
    { siteId: 'claude-web', port: first },
    { siteId: 'chatgpt-web', port: second },
  ];
}

/** Most browsers one site may have. A guard against a paste, not a policy. */
export const BROWSER_CHAT_MAX_ENDPOINTS = 16;

const DEFAULT_MODEL_RECORDS = createDefaultModelRecords();

/**
 * What a fresh install defaults to, skipping anything locked here.
 *
 * The seed list is ordered cheapest-and-most-capable first, so "the first
 * unlocked seed" is the right answer rather than a fallback: on a build with
 * the subscription seat locked it lands on Claude (free), which costs nothing
 * and needs no key either.
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
  browserChatEndpoints: defaultBrowserChatEndpoints(),
};

function cloneDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    providersEnabled: { ...DEFAULT_SETTINGS.providersEnabled },
    aiModels: DEFAULT_SETTINGS.aiModels.map((model) => ({ ...model })),
    googleSheetsSources: [...DEFAULT_SETTINGS.googleSheetsSources],
  };
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

  // Hybrid is pickable but is not a row, so the membership test below would
  // reject it and quietly rewrite the admin's choice to a real model - a
  // setting that does not stick, with nothing to say it did not.
  if (isHybridModelId(preferredId)) {
    const freeSites = BROWSER_CHAT_SITE_IDS.filter((site) =>
      availableModels.some((model) => model.provider === site)
    );
    if (freeSites.length > 0) return preferredId;
  }

  if (preferredId && availableModels.some((model) => model.id === preferredId)) {
    return preferredId;
  }

  if (availableModels.some((model) => model.id === fallbackDefaultModelId)) {
    return fallbackDefaultModelId;
  }

  return availableModels[0]?.id ?? aiModels[0]?.id ?? '';
}

function getRunnableModels(settings: AppSettings): AIModelRecord[] {
  return settings.aiModels.filter(
    (model) => model.enabled && isProviderEnabled(model.provider, settings)
  );
}

/**
 * The hybrid pseudo-model, offered only when there is something to be hybrid
 * BETWEEN.
 *
 * On an install with one free provider enabled it would be a choice that
 * behaves identically to the model already above it in the menu, which is worse
 * than not offering it: someone picks it expecting two accounts and gets one,
 * with nothing anywhere to say why.
 *
 * `provider` and `modelName` are the Claude site only so the record type is
 * satisfied. Nothing reads them - the choice resolver recognises the id first
 * and asks the router which account this call should go to.
 */
function synthesizeHybridModel(settings: AppSettings): AIModelRecord[] {
  const runnable = getRunnableModels(settings);
  const sites = BROWSER_CHAT_SITE_IDS.filter((site) =>
    runnable.some((model) => model.provider === site)
  );
  // ONE is enough, where it used to take two. This is no longer an extra option
  // beside the per-site ones - it is the only way to pick browser mode at all,
  // so requiring both would leave an install that runs a single platform with no
  // browser option in the menu.
  if (sites.length === 0) return [];

  const now = new Date(0).toISOString();
  return [
    {
      id: HYBRID_MODEL_ID,
      name: HYBRID_MODEL_LABEL,
      provider: 'claude-web',
      modelName: 'chat',
      description: HYBRID_MODEL_DESCRIPTION,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * The models a profile or a request may pick.
 *
 * The per-site free models are NOT among them. "Claude (free)" and "ChatGPT
 * (free)" were a choice with no good answer: the queue hands a task to whichever
 * browser comes free, so pinning one to a platform only meant waiting longer for
 * the same resume. They are replaced by the single "Default (browser)" entry,
 * which means "any of them".
 *
 * They stay in `aiModels` rather than being deleted, so Admin -> Models can
 * still manage them and - the part that matters - a profile that picked one
 * before this change keeps resolving to exactly what it picked.
 */
export function getPickableModels(settings: AppSettings): AIModelRecord[] {
  const offered = getRunnableModels(settings).filter(
    (model) => !isBrowserChatSiteId(model.provider)
  );
  return [...synthesizeHybridModel(settings), ...offered];
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
 * Clamped rather than rejected outside strict mode, because these two arrive
 * from a number input in a browser and the useful behaviour for "70000" is the
 * highest port there is, not a settings file that will not load. Strict mode -
 * which is how the stored file is read - still refuses, so a hand-edited value
 * out of range is reported instead of silently becoming something else.
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
 * The endpoint list, and the one-port-one-browser rule it has to keep.
 *
 * Two entries on the same port would be two sites in one browser, which is the
 * shape this list exists to replace: the second tab is a background tab, Chrome
 * freezes it, and a DOM read against a frozen renderer never returns at all. So
 * a port appears at most once, and the first claim on it wins.
 *
 * Also migrates the field this replaced. An install that saved a single
 * `browserChatDebugPort` gets both sites on that port - not because it is a
 * good arrangement but because it is the arrangement they already have, and
 * silently moving one site to a port with no browser on it would break a setup
 * that was working.
 */
function normalizeBrowserChatEndpoints(
  source: Partial<AppSettings> & Record<string, unknown>,
  fallback: AppSettings,
  strict: boolean
): BrowserChatEndpoint[] {
  const raw = source.browserChatEndpoints;

  if (typeof raw === 'undefined') {
    const legacy = source.browserChatDebugPort;
    if (typeof legacy !== 'undefined') {
      const port = normalizeBoundedInteger(
        legacy,
        fallback.browserChatEndpoints[0]?.port ?? envPort(),
        BROWSER_CHAT_PORT_MIN,
        BROWSER_CHAT_PORT_MAX,
        'browserChatDebugPort',
        strict
      );
      return [
        { siteId: 'claude-web', port },
        { siteId: 'chatgpt-web', port },
      ];
    }
    return fallback.browserChatEndpoints.map((entry) => ({ ...entry }));
  }

  if (!Array.isArray(raw)) {
    if (strict) throw new Error('browserChatEndpoints must be an array');
    return fallback.browserChatEndpoints.map((entry) => ({ ...entry }));
  }

  if (raw.length > BROWSER_CHAT_MAX_ENDPOINTS) {
    throw new Error(`browserChatEndpoints may hold at most ${BROWSER_CHAT_MAX_ENDPOINTS} browsers`);
  }

  const seen = new Set<number>();
  const out: BrowserChatEndpoint[] = [];
  for (const entry of raw) {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    // Refused, never quietly dropped - like the port beside it and the
    // duplicate check below. A list that saves with an entry silently missing
    // is a browser the operator believes they configured and the providers
    // have never heard of.
    if (!isBrowserChatSiteId(record.siteId)) {
      throw new Error(
        `"${String(record.siteId)}" is not a chat site this app knows; expected one of ` +
          `${BROWSER_CHAT_SITE_IDS.join(', ')}`
      );
    }
    const port = normalizeBoundedInteger(
      record.port,
      Number.NaN,
      BROWSER_CHAT_PORT_MIN,
      BROWSER_CHAT_PORT_MAX,
      'browserChatEndpoints[].port',
      true
    );
    if (seen.has(port)) {
      throw new Error(
        `port ${port} is listed twice: one browser shows one chat tab, so each port belongs to ` +
          'exactly one site'
      );
    }
    seen.add(port);
    out.push({ siteId: record.siteId, port });
  }
  return out;
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

  const providersEnabled = normalizeProvidersEnabled(source, fallback.providersEnabled, strict);

  const aiModels = normalizeAIModelRecords(source.aiModels, fallback.aiModels, strict);
  const providerSettings: AIModelSettings = { providersEnabled };
  const defaultModelId = resolveDefaultModelId(
    source.defaultModelId,
    aiModels,
    providerSettings,
    fallback.defaultModelId
  );

  return {
    browserChatEndpoints: normalizeBrowserChatEndpoints(source, fallback, strict),
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
    requireThreeDSecure: typeof source.requireThreeDSecure === 'boolean'
      ? source.requireThreeDSecure
      : strict && hasOwnProperty(source, 'requireThreeDSecure')
        ? (() => { throw new Error('requireThreeDSecure must be a boolean'); })()
      : fallback.requireThreeDSecure,
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
 * They differ whenever the stored id is not pickable - most often a default the
 * browser-chat migration repointed at `claude-web-chat`, which the picker now
 * shows as the single browser entry. Anything reading the stored value directly
 * would disagree with what the user is looking at; `isHybridSelection` did, and
 * the result was an install whose picker said "Default (browser)" while its
 * runs were pinned to Claude and used half the browsers available.
 */
function effectiveDefaultModelId(settings: AppSettings): string {
  const pickable = getPickableModels(settings);
  return pickable.some((model) => model.id === settings.defaultModelId)
    ? settings.defaultModelId
    : pickable[0]?.id ?? '';
}

function toPublicSettings(settings: AppSettings): PublicAppSettings {
  const pickable = getPickableModels(settings);
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
    aiModels: pickable.map((model) => ({ ...model })),
    googleSheetsSources: settings.googleSheetsSources,
    browserChatEndpoints: settings.browserChatEndpoints.map((entry) => ({ ...entry })),
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
    aiPreferenceDefaults: describeAiPreferenceDefaults(),
    providerLocks: describeProviderLocks(settings),
    providerTuning: listProviderTuningSupport(),
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

  const settings = normalizeSettings(stored, cloneDefaultSettings(), true);
  // A database written before keys moved to the environment still holds them.
  // Normalizing drops them from what this process uses, but the row on disk
  // would keep the secrets indefinitely with nothing left that can manage
  // them, so they are written out rather than merely ignored.
  if (purgeStoredApiKeys(stored)) {
    setSetting(APP_SETTINGS_KEY, settings);
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
  const providersEnabled = input.providersEnabled
    ? { ...current.providersEnabled, ...input.providersEnabled }
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
  return getPickableModels(settings).map((model) => ({ ...model }));
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
  const stored = settings.aiModels.find((model) => model.id === requested);
  if (stored && isProviderLocked(stored.provider)) {
    if (!warnedLockedPreferences.has(requested)) {
      warnedLockedPreferences.add(requested);
      console.warn(
        `[ai] A stored preference names "${stored.name}", whose provider is locked in this ` +
          'installation; those calls run on the default model instead. Pick a new model for it to ' +
          'silence this.'
      );
    }
    return resolveRequestedAIModel();
  }

  return resolveRequestedAIModel(requested);
}

/**
 * Which free account a hybrid call goes to THIS time.
 *
 * The router decides; this only turns its answer back into a model record, so
 * everything downstream - the log line, the prompt config, the adapter lookup -
 * sees an ordinary model and needs to know nothing about routing.
 *
 * A hybrid preference on an install that has since lost one of the two free
 * providers resolves to whichever is left rather than failing. Hybrid stops
 * being offered in that state, but a profile that picked it while both were
 * there still has to generate.
 */
/**
 * Was Hybrid actually chosen - by this id, or by the default it inherits?
 *
 * Read separately from the resolved record, because by the time Hybrid has
 * resolved it is indistinguishable from having picked that account outright.
 * And read through the DEFAULT too: a profile that names no model inherits the
 * app default, so an install whose default is Hybrid has every such profile on
 * Hybrid - and checking only the stored id said otherwise. Measured: a batch
 * with three browsers ran two at a time, because the tasks were pinned to the
 * one site Hybrid happened to resolve to instead of being eligible for both.
 */
export async function isHybridSelection(storedModelId?: string): Promise<boolean> {
  const requested = typeof storedModelId === 'string' ? storedModelId.trim() : '';
  const settings = await readSettings();

  if (requested) {
    if (isHybridModelId(requested)) return true;

    // The stored id does not always survive. `resolveStoredAIModelPreference`
    // DROPS it when its provider is locked and falls back to the app default -
    // so a profile pinned to the subscription seat on a machine that locked it
    // runs on the default, and if that default is the browser entry the run is
    // hybrid even though the stored id is not.
    //
    // This mirrors that function's decision deliberately. The two must agree:
    // if they drift, a run lands on a browser but is pinned to whichever site
    // it resolved to, instead of being eligible for both - which reads as the
    // batch mysteriously using half the browsers it has.
    const stored = settings.aiModels.find((model) => model.id === requested);
    if (stored && !isProviderLocked(stored.provider)) return false;
  }

  // The EFFECTIVE default, not the stored one - see effectiveDefaultModelId.
  return isHybridModelId(effectiveDefaultModelId(settings));
}

export function resolveHybridModel(settings: AppSettings): AIModelRecord {
  const runnable = getRunnableModels(settings);
  for (const site of planRoute('hybrid')) {
    const model = runnable.find((candidate) => candidate.provider === site);
    if (model) return model;
  }
  throw new Error(
    'The Hybrid (free) option needs at least one of the free chat providers enabled, and none is. ' +
      'Pick a different model for this profile, or enable Claude (browser) or ChatGPT (browser) ' +
      'under Admin -> Models.'
  );
}

export async function resolveRequestedAIModel(requestedModelId?: string): Promise<AIModelRecord> {
  const settings = await readSettings();
  const runnableModels = getRunnableModels(settings);

  if (runnableModels.length === 0) {
    throw new Error('No enabled AI models are configured.');
  }

  const requested = typeof requestedModelId === 'string' ? requestedModelId.trim() : '';
  if (!requested) {
    // The app default can itself be hybrid, so this has to go through the same
    // door rather than assume a row exists with that id.
    if (isHybridModelId(settings.defaultModelId)) {
      return resolveHybridModel(settings);
    }
    return runnableModels.find((model) => model.id === settings.defaultModelId) ?? runnableModels[0];
  }

  if (isHybridModelId(requested)) {
    return resolveHybridModel(settings);
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
  return { providersEnabled: { ...settings.providersEnabled } };
}

export async function updateAIModelSettings(input: Partial<AIModelSettings>): Promise<AIModelSettings> {
  const updated = await updateAppSettings(input);
  return { providersEnabled: { ...updated.providersEnabled } };
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

/**
 * The browser-chat settings, for the code paths that cannot wait on a read.
 *
 * `readSettings` is async and cached; the browser-chat adapter needs the port
 * and the queue bound at call time. Exposed as one accessor so there is a
 * single place that decides what wins - the stored value, then the
 * environment, then the built-in default.
 */
/**
 * The browsers the free chat providers may use, for the call path that needs
 * them at call time rather than at startup.
 *
 * One accessor so there is a single place that decides what wins: the stored
 * list, and nothing else - the environment only supplies the default a fresh
 * install begins with.
 */
export async function getBrowserChatEndpoints(): Promise<BrowserChatEndpoint[]> {
  const settings = await readSettings();
  return settings.browserChatEndpoints.map((entry) => ({ ...entry }));
}

/** What a fresh install would use, before anything is saved. */
export function getBrowserChatEnvDefaults(): BrowserChatEndpoint[] {
  return defaultBrowserChatEndpoints();
}
