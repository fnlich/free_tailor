import type { AIProvider } from './api';
import type { PillTone } from '@/components/ui/kit';

/**
 * Model PROVIDERS as Admin -> Models shows them, with no React in it: the
 * shapes the admin API sends (read leniently), what the Add / Edit provider
 * form may send and the sentences it refuses with, what a save sends, where
 * each value in effect came from, and how a provider's live state reads.
 *
 * A provider is one place a type runs (backend config/aiProviders.ts): a CLI
 * of one of the three types, signed in at a folder of its own, optionally with
 * a binary of its own, and its own `concurrency_max_requests`, which sizes its
 * queue lane. The first of each type is the BUILT-IN one, whose id is the
 * type's and which reads `.env` until an administrator sets a value here.
 *
 * Administrators only. Everything here names folders and binaries on the
 * server, which no other page ever shows; the server sends it to nobody else.
 *
 * Imports nothing at runtime - the API and kit types come in as types - so
 * backend/test/frontendProviders.test.js loads it and runs every copy of a
 * server rule here (the limit's range, the name and path checks, the env
 * variables, the hold kinds, which types can run) against the server's own.
 */

/* ===================================================================== shapes */

/** The three types, in the catalog's order. The server's AI_PROVIDER_IDS. */
export const PROVIDER_TYPES: readonly AIProvider[] = ['claude-cli', 'codex-cli', 'gemini-cli'];

/** What the type select calls each one. */
export const PROVIDER_TYPE_NAMES: Readonly<Record<AIProvider, string>> = {
  'claude-cli': 'Claude',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini',
};

/**
 * The variable each type's CLI reads its sign-in folder from - what the
 * server sets in the child's environment. The server's PROVIDER_HOME_VARIABLE.
 */
export const PROVIDER_HOME_VARIABLES: Readonly<Record<AIProvider, string>> = {
  'claude-cli': 'CLAUDE_CONFIG_DIR',
  'codex-cli': 'CODEX_HOME',
  'gemini-cli': 'GEMINI_CLI_HOME',
};

/**
 * The `.env` variables a built-in provider reads, by what they set - so a
 * value "from .env" can say which line of `.env` it is. The server's
 * BUILT_IN_PROVIDER_ENV.
 */
export const BUILT_IN_PROVIDER_ENV: Readonly<
  Record<AIProvider, { binaryPath: string; homeDir: string; concurrency_max_requests: string }>
> = {
  'claude-cli': { binaryPath: 'AI_CLI_BIN', homeDir: 'CLAUDE_CONFIG_DIR', concurrency_max_requests: 'AI_CLI_CONCURRENCY' },
  'codex-cli': { binaryPath: 'AI_CODEX_BIN', homeDir: 'CODEX_HOME', concurrency_max_requests: 'AI_CODEX_CONCURRENCY' },
  'gemini-cli': { binaryPath: 'AI_GEMINI_BIN', homeDir: 'AI_GEMINI_HOME', concurrency_max_requests: 'AI_GEMINI_CONCURRENCY' },
};

/** The server's PROVIDER_CONCURRENCY_MIN / _MAX. */
export const PROVIDER_CONCURRENCY_MIN = 1;
export const PROVIDER_CONCURRENCY_MAX = 32;
/** The longest name the server keeps. */
export const PROVIDER_LABEL_MAX = 80;

/**
 * Where a value in effect came from: set on this page, `.env`, the code's
 * default, or - for an added provider with no binary of its own - its type's,
 * as the built-in provider runs it.
 */
export type ProviderSettingSource = 'admin' | 'env' | 'default' | 'type';

export type ProviderValueField = 'homeDir' | 'binaryPath' | 'concurrency_max_requests';

/** One provider, as GET /api/admin/settings (`aiProviders`) and every /admin/ai/providers route send it. */
export interface AdminAIProvider {
  /** The type's own id for a built-in; `prv-` and eight hex digits for one added. */
  id: string;
  type: AIProvider;
  typeLabel: string;
  label: string;
  builtIn: boolean;
  enabled: boolean;
  /** The folder in effect; null leaves the CLI its own default. */
  homeDir: string | null;
  /** The variable the folder reaches the CLI as. */
  homeVariable: string;
  /** The binary in effect - a path, or a name looked up on the server's PATH. */
  binaryPath: string;
  concurrency_max_requests: number;
  sources: Record<ProviderValueField, ProviderSettingSource>;
  /** A built-in's `.env` values (or the code's), shown beside one set here. Null on an added provider. */
  envDefaults: { homeDir: string | null; binaryPath: string; concurrency_max_requests: number } | null;
  /** What an administrator set; null where nothing was. */
  stored: { homeDir: string | null; binaryPath: string | null; concurrency_max_requests: number | null };
  /** The TYPE is locked in this installation (AI_LOCKED_PROVIDERS), and why. */
  locked: boolean;
  lockReason: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A hold a provider put on itself - signed out, a spent quota, a CLI that will not start. */
export interface ProviderHold {
  kind: string;
  reason: string;
  until: string;
}

export interface ProviderOutage {
  scope: string;
  reason: string;
  expiresAt: string;
}

/** A provider's queue lane: what waits on it, what it is building, its width, and whether it takes work now. */
export interface ProviderLane {
  queued: number;
  running: number;
  width: number;
  serving: boolean;
}

export interface ProviderCalls {
  limit: number;
  inFlight: number;
  queued: number;
}

/**
 * One provider's live card, from GET /api/admin/ai/health (one per provider)
 * and POST /api/admin/ai/providers/:id/check: the provider, what a FRESH check
 * says, whether the queue can give it work, and how busy it is.
 */
export interface ProviderCard extends AdminAIProvider {
  summary: string;
  ok: boolean;
  detail: string;
  warning: string | null;
  authMethod: string | null;
  /** Null for a provider switched off, which is not asked. */
  checkedAt: string | null;
  /** Switched on, its type not locked, not signed out, and no hold on it. */
  ready: boolean;
  held: ProviderHold | null;
  outages: ProviderOutage[];
  queue: ProviderLane | null;
  concurrency: ProviderCalls | null;
}

/* ================================================================== reading */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function storedLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function isType(value: unknown): value is AIProvider {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value);
}

function source(value: unknown, fallback: ProviderSettingSource): ProviderSettingSource {
  return value === 'admin' || value === 'env' || value === 'default' || value === 'type' ? value : fallback;
}

/**
 * One provider as the server sent it, or null for something that is not one.
 * Lenient on everything else - a settings page must not go blank over a field
 * an older or newer server spells differently.
 */
export function normalizeAdminProvider(value: unknown): AdminAIProvider | null {
  const entry = record(value);
  if (!entry) return null;
  const id = str(entry.id);
  const type = isType(entry.type) ? entry.type : isType(id) ? id : null;
  if (!id || !type) return null;
  const sources = record(entry.sources) ?? {};
  const stored = record(entry.stored) ?? {};
  const env = record(entry.envDefaults);
  return {
    id,
    type,
    typeLabel: str(entry.typeLabel) || PROVIDER_TYPE_NAMES[type],
    label: str(entry.label) || id,
    builtIn: typeof entry.builtIn === 'boolean' ? entry.builtIn : id === type,
    enabled: entry.enabled !== false,
    homeDir: strOrNull(entry.homeDir),
    homeVariable: str(entry.homeVariable) || PROVIDER_HOME_VARIABLES[type],
    binaryPath: str(entry.binaryPath),
    concurrency_max_requests: count(entry.concurrency_max_requests),
    sources: {
      homeDir: source(sources.homeDir, 'default'),
      binaryPath: source(sources.binaryPath, 'default'),
      concurrency_max_requests: source(sources.concurrency_max_requests, 'default'),
    },
    envDefaults: env
      ? {
          homeDir: strOrNull(env.homeDir),
          binaryPath: str(env.binaryPath),
          concurrency_max_requests: count(env.concurrency_max_requests),
        }
      : null,
    stored: {
      homeDir: strOrNull(stored.homeDir),
      binaryPath: strOrNull(stored.binaryPath),
      concurrency_max_requests: storedLimit(stored.concurrency_max_requests),
    },
    locked: entry.locked === true,
    lockReason: str(entry.lockReason),
    createdAt: strOrNull(entry.createdAt),
    updatedAt: strOrNull(entry.updatedAt),
  };
}

export function normalizeAdminProviders(value: unknown): AdminAIProvider[] {
  return Array.isArray(value)
    ? value.map(normalizeAdminProvider).filter((entry): entry is AdminAIProvider => entry !== null)
    : [];
}

function hold(value: unknown): ProviderHold | null {
  const entry = record(value);
  if (!entry) return null;
  return { kind: str(entry.kind), reason: str(entry.reason), until: str(entry.until) };
}

function lane(value: unknown): ProviderLane | null {
  const entry = record(value);
  if (!entry) return null;
  return {
    queued: count(entry.queued),
    running: count(entry.running),
    width: count(entry.width),
    serving: entry.serving === true,
  };
}

function calls(value: unknown): ProviderCalls | null {
  const entry = record(value);
  if (!entry) return null;
  return { limit: count(entry.limit), inFlight: count(entry.inFlight), queued: count(entry.queued) };
}

/** One health card as the server sent it, or null. */
export function normalizeProviderCard(value: unknown): ProviderCard | null {
  const provider = normalizeAdminProvider(value);
  const entry = record(value);
  if (!provider || !entry) return null;
  return {
    ...provider,
    summary: str(entry.summary),
    ok: entry.ok === true,
    detail: str(entry.detail),
    warning: strOrNull(entry.warning),
    authMethod: strOrNull(entry.authMethod),
    checkedAt: strOrNull(entry.checkedAt),
    ready: entry.ready === true,
    held: hold(entry.held),
    outages: Array.isArray(entry.outages)
      ? entry.outages
          .map(record)
          .filter((outage): outage is Record<string, unknown> => outage !== null)
          .map((outage) => ({ scope: str(outage.scope), reason: str(outage.reason), expiresAt: str(outage.expiresAt) }))
      : [],
    queue: lane(entry.queue),
    concurrency: calls(entry.concurrency),
  };
}

export function normalizeProviderCards(value: unknown): ProviderCard[] {
  return Array.isArray(value)
    ? value.map(normalizeProviderCard).filter((entry): entry is ProviderCard => entry !== null)
    : [];
}

/* ======================================================= which types can run */

/**
 * Whether any provider of the type is switched on - the third clause of the
 * server's `isProviderEnabled`: a type whose every provider an administrator
 * switched off runs nothing, exactly as if its own switch were off. An empty
 * list says nothing (a server from before providers sent none), so it counts
 * as on, as the server's does for a settings object without the list.
 */
export function hasEnabledProviderOfType(providers: readonly Pick<AdminAIProvider, 'type' | 'enabled'>[], type: AIProvider): boolean {
  if (providers.length === 0) return true;
  return providers.some((entry) => entry.type === type && entry.enabled);
}

/* =================================================================== the form */

/** The fields the Add / Edit provider form has - the server's own names, so a refusal's `field` is one of them. */
export type ProviderField = 'type' | 'label' | 'homeDir' | 'binaryPath' | 'concurrency_max_requests' | 'enabled';

const PROVIDER_FIELDS: readonly ProviderField[] = [
  'type',
  'label',
  'homeDir',
  'binaryPath',
  'concurrency_max_requests',
  'enabled',
];

/** The form as typed. Every box is text, sent as typed once it passes the same checks the server makes. */
export type ProviderDraft = {
  type: AIProvider;
  label: string;
  homeDir: string;
  binaryPath: string;
  concurrency_max_requests: string;
  enabled: boolean;
};

export type ProviderProblems = Partial<Record<ProviderField, string>>;

/** An empty Add provider form, on the first type. */
export function blankProviderDraft(type: AIProvider = PROVIDER_TYPES[0]): ProviderDraft {
  return { type, label: '', homeDir: '', binaryPath: '', concurrency_max_requests: '', enabled: true };
}

/**
 * The Edit form for a provider: what an ADMINISTRATOR set, not what is in
 * effect. On a built-in an empty box is "use .env", which is what it holds
 * until somebody sets a value - so saving the form untouched changes nothing,
 * and clearing a box puts `.env` back. An added provider always has a folder
 * and a limit of its own.
 */
export function draftFromProvider(provider: AdminAIProvider): ProviderDraft {
  const limit = provider.stored.concurrency_max_requests ?? (provider.builtIn ? null : provider.concurrency_max_requests);
  return {
    type: provider.type,
    label: provider.label,
    homeDir: provider.stored.homeDir ?? (provider.builtIn ? '' : provider.homeDir ?? ''),
    binaryPath: provider.stored.binaryPath ?? '',
    concurrency_max_requests: limit === null ? '' : String(limit),
    enabled: provider.enabled,
  };
}

const FIELD_NAMES: Record<'homeDir' | 'binaryPath', string> = {
  homeDir: 'The sign-in folder',
  binaryPath: 'The CLI binary',
};

/**
 * Whether a path is absolute on SOME platform the server could be running on.
 * The server checks with its own platform's rule; the page cannot know which,
 * so it refuses only what no platform takes ("relative", "~/x", "./x") and
 * leaves a Windows path on a Linux server to the server, which says so.
 */
export function looksAbsolute(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * `concurrency_max_requests` as typed, read the way the server reads it
 * (`readProviderConcurrency`): a whole number from 1 to 32, as digits - in
 * the server's words when it is not one.
 */
export function readConcurrencyDraft(text: string): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(value) || value < PROVIDER_CONCURRENCY_MIN || value > PROVIDER_CONCURRENCY_MAX) {
    return {
      ok: false,
      message: `concurrency_max_requests must be a whole number from ${PROVIDER_CONCURRENCY_MIN} to ${PROVIDER_CONCURRENCY_MAX}.`,
    };
  }
  return { ok: true, value };
}

/**
 * What the server would refuse in this form, by field, in the server's own
 * sentences (backend config/aiProviders.ts) - so a box that cannot be saved
 * says why before it is sent. Not everything: whether a folder exists, is a
 * directory, sits inside the app or is another provider's, and whether a
 * binary is executable, only the server can see, and its refusal is pinned
 * to the same box (`refusalField`).
 *
 * `provider` is the one being edited (null for Add); `providers` the list, for
 * the name check.
 */
export function providerDraftProblems(
  draft: ProviderDraft,
  provider: AdminAIProvider | null,
  providers: readonly Pick<AdminAIProvider, 'id' | 'label'>[]
): ProviderProblems {
  const problems: ProviderProblems = {};
  const builtIn = provider?.builtIn === true;

  const label = draft.label.trim();
  if (!label) {
    // A built-in's name may be cleared: it goes back to its type's.
    if (!builtIn) problems.label = 'A provider needs a name.';
  } else if (label.length > PROVIDER_LABEL_MAX) {
    problems.label = `A provider's name is at most ${PROVIDER_LABEL_MAX} characters.`;
  } else if (!provider || label !== provider.label) {
    const clash = providers.find(
      (entry) => entry.id !== provider?.id && entry.label.toLowerCase() === label.toLowerCase()
    );
    if (clash) problems.label = `Another provider is already called "${clash.label}".`;
  }

  const homeDir = draft.homeDir.trim();
  if (!homeDir) {
    if (!provider) {
      problems.homeDir =
        `An added provider needs a sign-in folder of its own (it is passed to the CLI as ${PROVIDER_HOME_VARIABLES[draft.type]}).`;
    } else if (!builtIn) {
      problems.homeDir = 'An added provider keeps a sign-in folder of its own.';
    }
  } else if (!looksAbsolute(homeDir)) {
    problems.homeDir = `${FIELD_NAMES.homeDir} must be an absolute path (it is "${homeDir}").`;
  }

  const binaryPath = draft.binaryPath.trim();
  if (binaryPath && !looksAbsolute(binaryPath)) {
    problems.binaryPath = `${FIELD_NAMES.binaryPath} must be an absolute path (it is "${binaryPath}").`;
  }

  const limit = draft.concurrency_max_requests.trim();
  if (!limit) {
    // Empty on Add takes the type's limit, and on a built-in puts `.env`'s back.
    if (provider && !builtIn) problems.concurrency_max_requests = 'An added provider keeps a concurrency_max_requests of its own.';
  } else {
    const read = readConcurrencyDraft(limit);
    if (!read.ok) problems.concurrency_max_requests = read.message;
  }

  return problems;
}

/**
 * A limit box as a body sends it: the number when it reads as one, else the
 * text as typed - so the server refuses it in the same sentence the box
 * already shows, rather than a body quietly leaving it out and the server
 * taking a default nobody chose.
 */
function limitForBody(text: string): number | string {
  const read = readConcurrencyDraft(text);
  return read.ok ? read.value : text.trim();
}

/** POST /api/admin/ai/providers: the form, trimmed; an empty binary or limit left out (the type's). */
export function addProviderBody(draft: ProviderDraft): Record<string, unknown> {
  const binaryPath = draft.binaryPath.trim();
  const limit = draft.concurrency_max_requests.trim();
  return {
    type: draft.type,
    label: draft.label.trim(),
    homeDir: draft.homeDir.trim(),
    ...(binaryPath ? { binaryPath } : {}),
    ...(limit ? { concurrency_max_requests: limitForBody(limit) } : {}),
    enabled: draft.enabled,
  };
}

/**
 * PUT /api/admin/ai/providers/:id: ONLY what changed, so an edit can never
 * move a value nobody touched - a built-in's `.env` value stays `.env`'s
 * unless its box was changed. On a built-in '' clears a value set here and
 * puts `.env`'s (or the type's name) back. `enabled` is the table's switch,
 * never the form's. Empty when nothing changed.
 */
export function editProviderBody(provider: AdminAIProvider, draft: ProviderDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const label = draft.label.trim();
  if (label !== provider.label) body.label = label;

  const homeDir = draft.homeDir.trim();
  const homeBefore = provider.stored.homeDir ?? (provider.builtIn ? '' : provider.homeDir ?? '');
  if (homeDir !== homeBefore) body.homeDir = homeDir;

  const binaryPath = draft.binaryPath.trim();
  if (binaryPath !== (provider.stored.binaryPath ?? '')) body.binaryPath = binaryPath;

  const limitText = draft.concurrency_max_requests.trim();
  const limitBefore = provider.stored.concurrency_max_requests ?? (provider.builtIn ? null : provider.concurrency_max_requests);
  if (!limitText) {
    if (limitBefore !== null) body.concurrency_max_requests = '';
  } else {
    const limit = limitForBody(limitText);
    if (limit !== limitBefore) body.concurrency_max_requests = limit;
  }
  return body;
}

/**
 * The box a refusal belongs to: the server names it (`field`) on every input
 * it refuses. Null for a refusal about the provider as a whole - it is
 * building something, it is a built-in, it is gone - which the form shows
 * above its fields.
 */
export function refusalField(body: Record<string, unknown> | null | undefined): ProviderField | null {
  const field = body?.field;
  return typeof field === 'string' && (PROVIDER_FIELDS as readonly string[]).includes(field)
    ? (field as ProviderField)
    : null;
}

/* =========================================================== how a row reads */

const plural = (n: number, noun: string, many = `${noun}s`): string => `${n} ${n === 1 ? noun : many}`;

/** The folder in effect, or what a provider with none uses. */
export function describeHomeDir(provider: Pick<AdminAIProvider, 'homeDir'>): string {
  return provider.homeDir ?? "The CLI's own default folder";
}

/**
 * Where one value in effect came from, for the table: set on this page, which
 * `.env` line, the code's default, or its type's built-in provider.
 */
export function sourceNote(
  provider: Pick<AdminAIProvider, 'type' | 'sources'>,
  field: ProviderValueField
): string {
  const from = provider.sources[field];
  if (from === 'admin') return 'Set here';
  if (from === 'env') return `From .env (${BUILT_IN_PROVIDER_ENV[provider.type][field]})`;
  if (from === 'type') return `The built-in ${PROVIDER_TYPE_NAMES[provider.type]} provider's`;
  // A folder nobody set is the CLI's own - the row's folder cell says so; here, that nothing names one.
  return field === 'homeDir' ? 'Not set' : field === 'binaryPath' ? 'Default, found on PATH' : 'Default';
}

/**
 * What an EMPTY box means, for the form's hint: on a built-in, the `.env`
 * value it falls back to; on Add, the type's binary and limit.
 */
export function emptyMeans(
  provider: AdminAIProvider | null,
  field: ProviderValueField,
  builtInOfType: AdminAIProvider | null
): string {
  if (provider && !provider.builtIn) {
    return field === 'binaryPath'
      ? `Empty runs the built-in ${PROVIDER_TYPE_NAMES[provider.type]} provider's binary${builtInOfType ? ` (${builtInOfType.binaryPath})` : ''}.`
      : '';
  }
  if (!provider) {
    if (field === 'binaryPath') {
      return `Empty runs the built-in provider's binary${builtInOfType ? ` (${builtInOfType.binaryPath})` : ''}.`;
    }
    if (field === 'concurrency_max_requests') {
      const variable = BUILT_IN_PROVIDER_ENV[builtInOfType?.type ?? PROVIDER_TYPES[0]].concurrency_max_requests;
      return builtInOfType?.envDefaults
        ? `Empty takes ${builtInOfType.envDefaults.concurrency_max_requests}, the type's limit from .env (${variable}) or its default.`
        : "Empty takes the type's limit from .env or its default.";
    }
    return '';
  }
  const env = provider.envDefaults;
  const variable = BUILT_IN_PROVIDER_ENV[provider.type][field];
  if (field === 'homeDir') {
    return env?.homeDir
      ? `Empty uses .env: ${env.homeDir} (${variable}).`
      : `Empty leaves the CLI its own default folder (${variable} is not set).`;
  }
  if (field === 'binaryPath') {
    return env ? `Empty uses ${env.binaryPath} (${variable}, or the CLI's name on PATH).` : '';
  }
  return env ? `Empty uses ${env.concurrency_max_requests} (${variable}, or the default).` : '';
}

/**
 * How to sign a type's CLI in at a folder, as the server's user - the README's
 * commands, so the form's hint and the docs say the same thing. Each one
 * needs no browser on the server.
 */
export function signInCommand(type: AIProvider, folder: string): string {
  const at = folder.trim() || '<folder>';
  if (type === 'codex-cli') return `CODEX_HOME=${at} codex login --device-auth`;
  if (type === 'gemini-cli') return `GEMINI_CLI_HOME=${at} NO_BROWSER=true gemini`;
  return `CLAUDE_CONFIG_DIR=${at} claude auth login`;
}

/** What a hold's kind is called. The kinds the seats record (OutageKind, GeminiHoldKind). */
export const HOLD_KIND_LABELS: Readonly<Record<string, string>> = {
  auth: 'Signed out',
  rateLimited: 'Usage limit reached',
  unavailable: 'Unavailable',
  modelUnavailable: 'Model unavailable',
};

export type ProviderStatus = {
  tone: PillTone;
  label: string;
  /** The sentence under the pill: the check's own words, a hold's reason, a lock's reason. */
  detail: string;
  /** When a hold lifts, for the page to format in the reader's own time. */
  until: string | null;
};

/**
 * A provider's state, as one pill and a sentence. In order of what decides:
 * a locked type runs nothing; a provider switched off takes no work; a hold
 * says what kind and until when; then what the last fresh check said.
 */
export function providerStatus(
  provider: AdminAIProvider,
  card: ProviderCard | null,
  reading: { loading?: boolean; failed?: boolean } = {}
): ProviderStatus {
  if (provider.locked) {
    return { tone: 'grey', label: 'Locked', detail: provider.lockReason, until: null };
  }
  if (!provider.enabled) {
    return {
      tone: 'grey',
      label: 'Switched off',
      detail: `Takes no work; the other ${PROVIDER_TYPE_NAMES[provider.type]} providers carry on.`,
      until: null,
    };
  }
  if (!card) {
    return reading.loading
      ? { tone: 'grey', label: 'Checking', detail: 'Asking the CLI on the server...', until: null }
      : {
          tone: 'amber',
          label: 'Unknown',
          detail: reading.failed ? 'Its status could not be read. Check now asks again.' : 'Not checked yet.',
          until: null,
        };
  }
  if (card.held) {
    const label = HOLD_KIND_LABELS[card.held.kind] ?? `Held (${card.held.kind || 'unknown'})`;
    return {
      tone: card.held.kind === 'auth' ? 'red' : 'amber',
      label,
      detail: card.held.reason || card.detail,
      until: card.held.until || null,
    };
  }
  if (!card.ok) return { tone: 'red', label: 'Not ready', detail: card.detail, until: null };
  if (!card.ready) {
    return { tone: 'amber', label: 'Not taking work', detail: card.detail, until: null };
  }
  if (card.warning) return { tone: 'amber', label: 'Ready', detail: `${card.detail} ${card.warning}`, until: null };
  return { tone: 'green', label: 'Ready', detail: card.detail, until: null };
}

/** A provider's lane, in a line: "1 building, 2 waiting". Empty when it has nothing. */
export function describeLane(lane: ProviderLane | null): string {
  if (!lane || (lane.running === 0 && lane.queued === 0)) return '';
  const parts: string[] = [];
  if (lane.running > 0) parts.push(`${lane.running} building`);
  if (lane.queued > 0) parts.push(`${lane.queued} waiting`);
  return parts.join(', ');
}

/** What a switch-off, an edit or a removal did to the work that was waiting on it. */
export function describeMoved(moved: unknown, type: AIProvider): string {
  const n = typeof moved === 'number' && Number.isSafeInteger(moved) && moved > 0 ? moved : 0;
  if (n === 0) return '';
  return `${plural(n, 'waiting resume')} moved to another ${PROVIDER_TYPE_NAMES[type]} provider.`;
}

/** What Remove asks first. */
export function removeQuestion(provider: Pick<AdminAIProvider, 'label' | 'type'>): string {
  return (
    `Remove the provider "${provider.label}"? Resumes waiting on it move to another ` +
    `${PROVIDER_TYPE_NAMES[provider.type]} provider. Its sign-in folder on the server is left as it is.`
  );
}

/** A built-in provider is what every stored model names; it can be switched off, never removed. */
export function canRemove(provider: Pick<AdminAIProvider, 'builtIn'>): boolean {
  return !provider.builtIn;
}

/**
 * A type's row on Settings -> General, from its providers' cards: the one
 * provider's own words, or how many of several can take work.
 */
export function describeTypeHealth(cards: readonly ProviderCard[], type: AIProvider): string {
  const own = cards.filter((card) => card.type === type);
  if (own.length === 0) return 'No status reported.';
  if (own.length === 1) {
    const [card] = own;
    return card.warning ? `${card.detail} ${card.warning}` : card.detail;
  }
  const ready = own.filter((card) => card.ready).length;
  return (
    `${ready} of ${own.length} ${PROVIDER_TYPE_NAMES[type]} providers can take work now. ` +
    'Each has its own card above; add, change or remove them on Models.'
  );
}

/**
 * Which provider built a resume, on an order's page - sent for an
 * administrator only (the server leaves the field out for everybody else).
 */
export function describeRanOn(ranOn: { id: string; label: string; type: string | null } | null | undefined): string {
  if (!ranOn) return '';
  // A provider removed since is named by its id, which the server keeps.
  const name = ranOn.label || ranOn.id;
  const typeName = isType(ranOn.type) ? PROVIDER_TYPE_NAMES[ranOn.type] : '';
  return typeName && !name.includes(typeName) ? `Built on ${name} (${typeName})` : `Built on ${name}`;
}
