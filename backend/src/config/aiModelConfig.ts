import { randomUUID } from 'crypto';
import { getSetting, setSetting } from '../database/settingsRepository';
import { getDatabasePath } from '../database/sqlite';
import { AIProvider } from '../types/template';
import {
  AI_PROVIDER_IDS,
  coerceProviderId,
  getProviderDescriptor,
  getProviderLabel as getCatalogProviderLabel,
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

type ApiKeyEntry = {
  id: string;
  name: string;
  value: string;
  createdAt: string;
};

type ProviderKeyStore = {
  activeKeyId: string;
  entries: ApiKeyEntry[];
};

type ProviderKeyStores = Record<AIProvider, ProviderKeyStore>;

type ApiKeyUpdate = {
  activeKeyId?: string;
  add?: Array<{
    clientId?: string;
    name?: string;
    value: string;
  }>;
  removeIds?: string[];
  useEnvironmentFallback?: boolean;
};

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
  aiModels: AIModelRecord[];
  googleSheetsSources: GoogleSheetSource[];
  apiKeys: ProviderKeyStores;
};

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
export type PublicAppSettingsWithDerived = PublicAppSettings & {
  outputPathUsesJobTitle: boolean;
};

export type AdminAppSettings = Omit<PublicAppSettingsWithDerived, 'aiModels'> & {
  aiModels: AIModelRecord[];
  outputBaseDir: string;
  outputPathTemplate: string;
  outputPathPreview: string;
  apiKeys: {
    [K in AIProvider]: {
      /** false for a provider that authenticates without a key at all. */
      requiresApiKey: boolean;
      configured: boolean;
      activeSource: 'stored' | 'environment' | 'subscription' | 'none';
      activeKeyId: string | null;
      activePreview: string | null;
      environmentPreview: string | null;
      entries: Array<{
        id: string;
        name: string;
        preview: string | null;
        isActive: boolean;
        createdAt: string;
      }>;
    };
  };
};

export type AppSettingsUpdate = Partial<PublicAppSettings> & {
  /** Accepted for one release so a stale client can still save. */
  openrouterEnabled?: boolean;
  outputBaseDir?: string;
  outputPathTemplate?: string;
  apiKeys?: Partial<Record<AIProvider, ApiKeyUpdate | string>>;
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

function emptyProviderKeyStores(): ProviderKeyStores {
  return AI_PROVIDER_IDS.reduce((acc, id) => {
    acc[id] = { activeKeyId: '', entries: [] };
    return acc;
  }, {} as ProviderKeyStores);
}

const DEFAULT_SETTINGS: AppSettings = {
  providersEnabled: allProvidersEnabled(),
  defaultMode: 'preview',
  defaultTheme: 'light',
  defaultResumeSelection: 'single',
  defaultGroupId: '',
  defaultProfileId: '',
  defaultModelId: buildModelId('claude-cli', DEFAULT_CLAUDE_CLI_MODEL),
  defaultResumeDocxEnabled: true,
  defaultCoverLetterDocxEnabled: true,
  outputBaseDir: DEFAULT_GENERATED_RESUMES_DIR,
  outputPathTemplate: DEFAULT_OUTPUT_PATH_TEMPLATE,
  aiModels: createDefaultModelRecords(),
  googleSheetsSources: [],
  apiKeys: emptyProviderKeyStores(),
};

function cloneDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    providersEnabled: { ...DEFAULT_SETTINGS.providersEnabled },
    aiModels: DEFAULT_SETTINGS.aiModels.map((model) => ({ ...model })),
    googleSheetsSources: [...DEFAULT_SETTINGS.googleSheetsSources],
    apiKeys: AI_PROVIDER_IDS.reduce((acc, id) => {
      acc[id] = {
        activeKeyId: DEFAULT_SETTINGS.apiKeys[id].activeKeyId,
        entries: [...DEFAULT_SETTINGS.apiKeys[id].entries],
      };
      return acc;
    }, {} as ProviderKeyStores),
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

function normalizeApiKeyName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function createApiKeyEntry(value: string, name: string, createdAt?: string): ApiKeyEntry {
  return {
    id: randomUUID(),
    name,
    value,
    createdAt: createdAt || new Date().toISOString(),
  };
}

function normalizeProviderKeyStore(
  input: unknown,
  fallback: ProviderKeyStore,
  _provider: AIProvider,
  strict = false
): ProviderKeyStore {
  if (typeof input === 'string') {
    const value = input.trim();
    if (!value) {
      if (strict) {
        throw new Error('Stored API key values cannot be empty');
      }
      return { activeKeyId: '', entries: [] };
    }
    const entry = createApiKeyEntry(value, 'Primary key');
    return {
      activeKeyId: entry.id,
      entries: [entry],
    };
  }

  const source = typeof input === 'object' && input !== null ? input as Partial<ProviderKeyStore> & {
    entries?: unknown;
    activeKeyId?: unknown;
  } : {};

  if (strict && hasOwnProperty(source, 'entries') && !Array.isArray(source.entries)) {
    throw new Error('Stored API key entries must be an array');
  }

  const rawEntries: unknown[] = Array.isArray(source.entries) ? source.entries : fallback.entries;
  const entries = rawEntries
    .map((entry, index) => {
      if (typeof entry === 'string') {
        const value = entry.trim();
        if (!value) {
          if (strict) {
            throw new Error(`Stored API key entry ${index + 1} cannot be empty`);
          }
          return null;
        }
        return createApiKeyEntry(value, `Key ${index + 1}`);
      }
      if (typeof entry !== 'object' || entry === null) {
        if (strict) {
          throw new Error(`Stored API key entry ${index + 1} is invalid`);
        }
        return null;
      }
      const raw = entry as Partial<ApiKeyEntry>;
      const value = typeof raw.value === 'string' ? raw.value.trim() : '';
      if (!value) {
        if (strict) {
          throw new Error(`Stored API key entry ${index + 1} is missing a value`);
        }
        return null;
      }
      return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID(),
        name: normalizeApiKeyName(raw.name, `Key ${index + 1}`),
        value,
        createdAt: typeof raw.createdAt === 'string' && raw.createdAt.trim()
          ? raw.createdAt.trim()
          : new Date().toISOString(),
      } satisfies ApiKeyEntry;
    })
    .filter((entry): entry is ApiKeyEntry => Boolean(entry));

  if (strict && hasOwnProperty(source, 'activeKeyId') && typeof source.activeKeyId !== 'string') {
    throw new Error('Stored active API key id must be a string');
  }

  const activeKeyId = typeof source.activeKeyId === 'string' ? source.activeKeyId.trim() : fallback.activeKeyId;
  const hasActiveEntry = entries.some((entry) => entry.id === activeKeyId);

  if (strict && activeKeyId && !hasActiveEntry) {
    throw new Error('Stored active API key id does not match any saved key');
  }

  return {
    activeKeyId: entries.length === 0 ? '' : hasActiveEntry ? activeKeyId : entries[0].id,
    entries,
  };
}

function normalizeProviderKeyStores(input: unknown, fallback: ProviderKeyStores, strict = false): ProviderKeyStores {
  if (strict && typeof input !== 'undefined' && (typeof input !== 'object' || input === null)) {
    throw new Error('Stored API keys must be an object');
  }

  const source = typeof input === 'object' && input !== null
    ? input as Partial<Record<AIProvider, unknown>>
    : {};

  return AI_PROVIDER_IDS.reduce((acc, id) => {
    acc[id] = normalizeProviderKeyStore(source[id], fallback[id], id, strict);
    return acc;
  }, {} as ProviderKeyStores);
}

function normalizeGoogleSheetSourceName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
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

    const legacyField = getProviderDescriptor(id).legacyEnabledField;
    const fromLegacy = source[legacyField];
    if (typeof fromLegacy === 'boolean') {
      result[id] = fromLegacy;
      continue;
    }
    if (strict && hasOwnProperty(source, legacyField)) {
      throw new Error(`${legacyField} must be a boolean`);
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
    aiModels,
    googleSheetsSources: normalizeGoogleSheetsSources(source.googleSheetsSources, fallback.googleSheetsSources, strict),
    apiKeys: normalizeProviderKeyStores(source.apiKeys, fallback.apiKeys, strict),
  };
}

function assertAtLeastOneProviderEnabled(settings: AppSettings): void {
  if (!AI_PROVIDER_IDS.some((id) => settings.providersEnabled[id])) {
    throw new Error('At least one AI model must remain enabled');
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

function toPublicSettings(settings: AppSettings): PublicAppSettings {
  const runnableModels = getRunnableModels(settings);
  return {
    providersEnabled: { ...settings.providersEnabled },
    ...toLegacyProviderFlags(settings),
    defaultMode: settings.defaultMode,
    defaultTheme: settings.defaultTheme,
    defaultResumeSelection: settings.defaultResumeSelection,
    defaultGroupId: settings.defaultGroupId,
    defaultProfileId: settings.defaultProfileId,
    defaultModelId: runnableModels.some((model) => model.id === settings.defaultModelId)
      ? settings.defaultModelId
      : runnableModels[0]?.id ?? '',
    defaultResumeDocxEnabled: settings.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: settings.defaultCoverLetterDocxEnabled,
    aiModels: runnableModels.map((model) => ({ ...model })),
    googleSheetsSources: settings.googleSheetsSources,
  };
}

function toPublicSettingsWithDerived(settings: AppSettings): PublicAppSettingsWithDerived {
  return {
    ...toPublicSettings(settings),
    outputPathUsesJobTitle: outputPathTemplateUsesJobTitle(settings.outputPathTemplate),
  };
}

function maskApiKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function getStoredActiveApiKey(store: ProviderKeyStore): ApiKeyEntry | null {
  if (!store.entries.length) return null;
  return store.entries.find((entry) => entry.id === store.activeKeyId) ?? store.entries[0] ?? null;
}

function toAdminSettings(settings: AppSettings): AdminAppSettings {
  return {
    ...toPublicSettingsWithDerived(settings),
    aiModels: settings.aiModels.map((model) => ({ ...model })),
    outputBaseDir: settings.outputBaseDir,
    outputPathTemplate: settings.outputPathTemplate,
    outputPathPreview: buildOutputPathPreview(settings.outputPathTemplate),
    apiKeys: AI_PROVIDER_IDS.reduce((acc, id) => {
      acc[id] = toAdminProviderKeyState(id, settings.apiKeys[id]);
      return acc;
    }, {} as AdminAppSettings['apiKeys']),
  };
}

function toAdminProviderKeyState(provider: AIProvider, store: ProviderKeyStore): AdminAppSettings['apiKeys'][AIProvider] {
  // A subscription-seat provider has no key to configure. Reporting it as
  // "configured" via a credential it does not use is what stops the admin UI
  // rendering a password field and an inert "Add key" button for it.
  if (!providerRequiresApiKey(provider)) {
    return {
      requiresApiKey: false,
      configured: true,
      activeSource: 'subscription',
      activeKeyId: null,
      activePreview: null,
      environmentPreview: null,
      entries: [],
    };
  }

  const activeStoredEntry = getStoredActiveApiKey(store);
  const environmentValue = getEnvironmentApiKey(provider);
  const environmentPreview = maskApiKey(environmentValue);

  if (activeStoredEntry) {
    return {
      requiresApiKey: true,
      configured: true,
      activeSource: 'stored',
      activeKeyId: activeStoredEntry.id,
      activePreview: maskApiKey(activeStoredEntry.value),
      environmentPreview,
      entries: store.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        preview: maskApiKey(entry.value),
        isActive: entry.id === activeStoredEntry.id,
        createdAt: entry.createdAt,
      })),
    };
  }

  if (environmentValue) {
    return {
      requiresApiKey: true,
      configured: true,
      activeSource: 'environment',
      activeKeyId: null,
      activePreview: environmentPreview,
      environmentPreview,
      entries: [],
    };
  }

  return {
    requiresApiKey: true,
    configured: false,
    activeSource: 'none',
    activeKeyId: null,
    activePreview: null,
    environmentPreview: null,
    entries: [],
  };
}

/**
 * A short-lived cache of the parsed settings row.
 *
 * `readSettings` does a SQLite read, a JSON.parse and a full strict normalize
 * of the model list and every provider key store - and `getProviderApiKey`
 * called it on EVERY model request. A few seconds of cache takes that off the
 * hot path without letting an admin's change go unnoticed; every write path
 * invalidates it explicitly, so the TTL only covers changes made by another
 * process against the same database.
 */
const SETTINGS_CACHE_TTL_MS = 5_000;

/**
 * Keyed on the DATABASE PATH, not just held in a module variable.
 *
 * `getDatabasePath()` is resolved from `DB_DIR` on every call, so a single
 * process can legitimately address more than one database - which the test
 * suite does, giving each case a fresh temp directory. An unkeyed cache would
 * then serve one database's settings for another: reads that silently return
 * the wrong providers, models and keys.
 */
let settingsCache: { path: string; value: AppSettings; at: number } | null = null;

export function invalidateSettingsCache(): void {
  settingsCache = null;
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

function applyApiKeyUpdate(current: ProviderKeyStore, update: ApiKeyUpdate | string | undefined): ProviderKeyStore {
  if (typeof update === 'undefined') {
    return current;
  }

  if (typeof update === 'string') {
    const value = update.trim();
    if (!value) {
      return { activeKeyId: '', entries: [] };
    }
    const entry = createApiKeyEntry(value, 'Primary key');
    return {
      activeKeyId: entry.id,
      entries: [entry],
    };
  }

  const removeIds = new Set((update.removeIds ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0));
  const retainedEntries = current.entries.filter((entry) => !removeIds.has(entry.id));
  const addedEntries = (update.add ?? [])
    .map((entry, index) => {
      const value = typeof entry?.value === 'string' ? entry.value.trim() : '';
      if (!value) return null;
      return {
        clientId: typeof entry?.clientId === 'string' ? entry.clientId.trim() : '',
        stored: createApiKeyEntry(value, normalizeApiKeyName(entry?.name, `Key ${retainedEntries.length + index + 1}`)),
      };
    })
    .filter((entry): entry is { clientId: string; stored: ApiKeyEntry } => Boolean(entry));

  const entries = [...retainedEntries, ...addedEntries.map((entry) => entry.stored)];
  if (entries.length === 0 || update.useEnvironmentFallback) {
    return { activeKeyId: '', entries };
  }

  const requestedActiveKeyId = typeof update.activeKeyId === 'string' ? update.activeKeyId.trim() : current.activeKeyId;
  const matchingNewEntry = addedEntries.find((entry) => entry.clientId && entry.clientId === requestedActiveKeyId);
  const activeKeyId = entries.some((entry) => entry.id === requestedActiveKeyId)
    ? requestedActiveKeyId
    : matchingNewEntry?.stored.id || entries[0].id;

  return {
    activeKeyId,
    entries,
  };
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
  const nextBase = normalizeSettings(
    {
      ...current,
      ...input,
      apiKeys: current.apiKeys,
    },
    current
  );

  const next: AppSettings = {
    ...nextBase,
    apiKeys: AI_PROVIDER_IDS.reduce((acc, id) => {
      acc[id] = applyApiKeyUpdate(current.apiKeys[id], input.apiKeys?.[id]);
      return acc;
    }, {} as ProviderKeyStores),
  };

  assertAtLeastOneProviderEnabled(next);
  assertAtLeastOneRunnableModel(next);

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

export async function resolveRequestedAIModel(requestedModelId?: string): Promise<AIModelRecord> {
  const settings = await readSettings();
  const runnableModels = getRunnableModels(settings);

  if (runnableModels.length === 0) {
    throw new Error('No enabled AI models are configured.');
  }

  const requested = typeof requestedModelId === 'string' ? requestedModelId.trim() : '';
  if (!requested) {
    return runnableModels.find((model) => model.id === settings.defaultModelId) ?? runnableModels[0];
  }

  const requestedModel = settings.aiModels.find((model) => model.id === requested);
  if (requestedModel) {
    if (!requestedModel.enabled) {
      throw new Error(`Selected AI model "${requestedModel.name}" is disabled.`);
    }
    if (!isProviderEnabled(requestedModel.provider, settings)) {
      throw new Error(`Selected AI model provider "${requestedModel.provider}" is disabled by admin.`);
    }
    return requestedModel;
  }

  const requestedProvider = coerceProviderId(requested);
  if (requestedProvider) {
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

export async function getProviderApiKey(provider: AIProvider): Promise<string> {
  // A subscription-seat provider has no key, so it never reaches the database.
  if (!providerRequiresApiKey(provider)) {
    return '';
  }

  const settings = await readSettings();
  const activeStoredKey = getStoredActiveApiKey(settings.apiKeys[provider]);
  if (activeStoredKey?.value.trim()) {
    return activeStoredKey.value.trim();
  }

  return getEnvironmentApiKey(provider);
}

export async function getOutputStorageSettings(): Promise<Pick<AppSettings, 'outputBaseDir' | 'outputPathTemplate'>> {
  const settings = await readSettings();
  return {
    outputBaseDir: settings.outputBaseDir,
    outputPathTemplate: settings.outputPathTemplate,
  };
}

export function isProviderEnabled(provider: AIProvider, settings: AIModelSettings): boolean {
  return settings.providersEnabled[provider] === true;
}

/**
 * The first enabled provider in catalog order, which puts the keyless
 * subscription seat ahead of every metered one.
 */
export function getDefaultEnabledProvider(settings: AIModelSettings): AIProvider {
  return AI_PROVIDER_IDS.find((id) => settings.providersEnabled[id]) ?? AI_PROVIDER_IDS[0];
}
