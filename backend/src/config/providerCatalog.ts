import type { AIProvider } from '../types/template';

export type ProviderDescriptor = {
  id: AIProvider;
  /** Shown in every UI that names a provider. Never render a raw id. */
  label: string;
  /** Short line under the label in the admin provider list. */
  summary: string;
  /**
   * The flat wire field an already-loaded browser tab reads for this provider.
   *
   * Null for a provider added after those flags stopped being written: nothing
   * older than it can be asking about it, so inventing a flag would only be a
   * field with no reader.
   */
  legacyEnabledField: 'claudeCliEnabled' | null;
  /**
   * True when this build does not offer the provider to run on.
   *
   * A LOCK IS NOT THE ADMIN'S DISABLE SWITCH. `providersEnabled` records what
   * the operator chose and is theirs to change from the Settings page; a lock
   * is a property of the deployment - the thing the provider needs is not
   * present here - and no amount of ticking a box makes it runnable. Which is
   * why the UI keeps a locked provider's models on screen with a padlock
   * rather than hiding them: "you cannot pick this, and here is why" is
   * information, and a model that silently vanishes is a bug report.
   *
   * Escapable at the deployment level, never from the UI: see
   * `AI_UNLOCKED_PROVIDERS` below.
   */
  locked: boolean;
  /**
   * Why it is locked, and what would unlock it. Shown verbatim next to the
   * padlock, so it is written for the person reading the screen.
   */
  lockReason: string;
  /** Sort order in menus; also the order getDefaultEnabledProvider walks. */
  order: number;
};

/**
 * The single source of truth for "which AI providers exist".
 *
 * Before this table the same four-way branch was hand-written in eleven places
 * across aiModelConfig.ts, and four of those ended in an unguarded `else` that
 * returned the last provider's answer - so a provider added without touching
 * all four silently reported as another one, gated by its flag and handed its
 * key. `satisfies Record<AIProvider, ...>` turns that class of bug into a
 * compile error.
 *
 * Only subscription seats are left: CLIs the operator signed in on this
 * machine, with no API key for this app to hold and nothing billed per token.
 * The metered APIs that used to sit below them are retired - see
 * `RETIRED_PROVIDER_IDS`.
 */
export const PROVIDER_CATALOG = {
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude (Subscription)',
    summary: 'Runs the local `claude` CLI on the signed-in subscription seat. No API key, no metered tokens.',
    legacyEnabledField: 'claudeCliEnabled',
    // Offered. It was locked while this installation had no seat signed in, and
    // that is not a build-time fact - whether the `claude` binary is on PATH and
    // signed in is something only the machine can answer, and the health check
    // asks it. A lock would say "this deployment cannot run it", which is now
    // simply untrue and left the one keyless, unmetered provider unpickable.
    //
    // The reason survives the unlock: an operator on a box with no seat can put
    // this provider back behind a padlock with AI_LOCKED_PROVIDERS, and the
    // sentence they want shown then is this one, not a generic "turned off".
    locked: false,
    lockReason:
      'Needs the `claude` CLI installed and a subscription seat signed in on this machine. ' +
      'Run `claude login` there, then remove it from AI_LOCKED_PROVIDERS.',
    order: 0,
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex (Subscription)',
    summary:
      'Runs the local `codex` CLI on the signed-in ChatGPT subscription. No API key, no metered tokens.',
    // Nothing older than this provider can be asking about it, so a flat wire
    // flag would be a field with no reader.
    legacyEnabledField: null,
    locked: false,
    lockReason:
      'Needs the `codex` CLI installed and a ChatGPT subscription signed in on this machine. ' +
      'Run `codex login --device-auth` there, then remove it from AI_LOCKED_PROVIDERS.',
    order: 1,
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini (Subscription)',
    summary:
      'Runs the local `gemini` CLI on the signed-in Google account. No API key, no metered tokens.',
    legacyEnabledField: null,
    // Offered, like the other two: whether `gemini` is installed and signed in
    // is the health check's question, not the build's.
    locked: false,
    lockReason:
      'Needs the `gemini` CLI installed (`npm i -g @google/gemini-cli`) and a Google account signed in on ' +
      'this machine. Run `NO_BROWSER=true gemini` there once as the user this server runs as, then remove ' +
      'it from AI_LOCKED_PROVIDERS.',
    order: 2,
  },
} as const satisfies Record<AIProvider, ProviderDescriptor>;

/** Every provider id, in menu order. */
export const AI_PROVIDER_IDS: readonly AIProvider[] = (
  Object.values(PROVIDER_CATALOG) as ProviderDescriptor[]
)
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((descriptor) => descriptor.id);

export function getProviderDescriptor(id: AIProvider): ProviderDescriptor {
  return PROVIDER_CATALOG[id];
}

export function getProviderLabel(id: AIProvider): string {
  return (PROVIDER_CATALOG[id] as ProviderDescriptor | undefined)?.label ?? id;
}

/**
 * The env var that lifts a lock, as a comma or space separated list of
 * provider ids: `AI_UNLOCKED_PROVIDERS=claude-cli`.
 *
 * A deployment-level escape hatch on purpose. The lock says "the thing this
 * provider needs is not here", and the only person who can know that has
 * changed is whoever installed the CLI or signed the seat in - not a user
 * clicking around the admin pages, which is why there is no button for it.
 * Read on every call rather than captured at import, so a test can set it and
 * so a restart is the only thing needed to apply it.
 */
export const UNLOCKED_PROVIDERS_ENV_VAR = 'AI_UNLOCKED_PROVIDERS';

/**
 * The env var that ADDS a lock: `AI_LOCKED_PROVIDERS=claude-cli`.
 *
 * The mirror of the one above, and it earns its place for the same reason that
 * one does. No provider is locked in the shipped catalog any more, but whether a
 * provider can run here is still a fact only the machine knows - a box with no
 * `claude` binary, or a shared install whose operator does not want the
 * subscription seat spent, wants the seat gone from the picker with a padlock
 * and a reason rather than present and failing at generate time.
 *
 * Unlock wins over lock when a provider is named in both, so the escape hatch
 * stays an escape hatch.
 */
export const LOCKED_PROVIDERS_ENV_VAR = 'AI_LOCKED_PROVIDERS';

function envProviderList(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

/**
 * True when this deployment cannot run the provider.
 *
 * Deliberately NOT a function of the settings row: a lock and the admin's
 * enable flag answer different questions, and merging them would make
 * "unticked because I do not want it" indistinguishable from "cannot run
 * here". `isProviderEnabled` in aiModelConfig is where the two meet.
 */
export function isProviderLocked(id: AIProvider): boolean {
  if (envProviderList(UNLOCKED_PROVIDERS_ENV_VAR).has(id)) {
    return false;
  }
  if (envProviderList(LOCKED_PROVIDERS_ENV_VAR).has(id)) {
    return true;
  }
  return (PROVIDER_CATALOG[id] as ProviderDescriptor | undefined)?.locked ?? false;
}

/** Why `id` is locked, or '' when it is not locked right now. */
export function getProviderLockReason(id: AIProvider): string {
  if (!isProviderLocked(id)) {
    return '';
  }
  const descriptor = PROVIDER_CATALOG[id] as ProviderDescriptor | undefined;
  // A catalog reason when the catalog is what locked it; otherwise the operator
  // did, and saying so points at the fix rather than at a condition the
  // deployment does not actually have.
  return (
    descriptor?.lockReason ||
    `Turned off for this installation (${LOCKED_PROVIDERS_ENV_VAR}). ` +
      'Remove it from that list to offer it again.'
  );
}

/** Every provider locked right now, in menu order. */
export function listLockedProviderIds(): AIProvider[] {
  return AI_PROVIDER_IDS.filter((id) => isProviderLocked(id));
}

/**
 * Provider ids that were valid in an older release, and what they became.
 *
 * This map is PERMANENT, not a migration step. A boot migration rewrites the
 * settings row once, but stored provider strings reach typed code from places
 * a migration cannot cover: a restored backup, a hand-edited row, and
 * scripts/migrateLegacyData.ts, which writes a legacy `ai-models.json`
 * verbatim at any later time. Coercing on read means none of those can brick
 * the app; the migration is then an improvement rather than a prerequisite.
 */
export const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, AIProvider>> = Object.freeze(
  // Null prototype: a plain object would resolve "constructor", "toString" and
  // every other inherited name to an Object.prototype member, and a stored
  // provider string of that shape would then be handed back as a provider id.
  Object.assign(Object.create(null) as Record<string, AIProvider>, {
    openrouter: 'claude-cli' as AIProvider,
  })
);

/**
 * Which removal retired an id, so a warning about one names the right one.
 *
 * `browser-chat`: `claude-web` and `chatgpt-web`, which drove claude.ai and
 * chatgpt.com in a debug Chrome the operator started and signed in to.
 * `metered-api`: `claude` (the Anthropic Messages API), `openai` and
 * `deepseek`, which billed every token to an API key in `.env`. The app runs on
 * subscription seats only now, and holds no key for anything.
 */
export type RetiredProviderFamily = 'browser-chat' | 'metered-api';

/** How a log line names each removal: "...on the <this>, which were removed". */
export const RETIRED_FAMILY_DESCRIPTION: Readonly<Record<RetiredProviderFamily, string>> = Object.freeze({
  'browser-chat': 'browser chat providers',
  'metered-api': 'metered API providers',
});

/** The migration that removes each family's residue from the database. */
export const RETIRED_FAMILY_MIGRATION: Readonly<Record<RetiredProviderFamily, string>> = Object.freeze({
  'browser-chat': '006',
  'metered-api': '007',
});

/** A null-prototype map, for the reason given on `LEGACY_PROVIDER_ALIASES`. */
function familyMap(entries: Record<string, RetiredProviderFamily>): Readonly<Record<string, RetiredProviderFamily>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, RetiredProviderFamily>, entries));
}

/**
 * Provider ids an older release offered, retired with nothing to replace them,
 * and which removal retired each.
 *
 * Deliberately NOT in `LEGACY_PROVIDER_ALIASES`, either family. A browser
 * record carries `modelName: 'chat'`, and aliasing one onto a CLI seat would
 * run `claude --model chat` or `codex -m chat` - a model neither has. A metered
 * record carries an API model name, and `gpt-5-nano` or a dated Anthropic id is
 * not a seat alias either: Codex refuses API-only names, and the price of the
 * run would change behind the owner's back. Turning a value that can be read
 * harmlessly into a failure at generate time helps nobody. So
 * `coerceProviderId` returns null for them like any unknown id, and every read
 * path that would otherwise THROW on that null asks this map first and treats
 * the value as absent: a model record is skipped, an enable flag is ignored, a
 * prompt override is no override, and a stored preference falls back to the app
 * default.
 *
 * PERMANENT, for the reason the alias map above is. Migrations 006 and 007
 * remove them from the database once, but a restored backup, a hand-edited row
 * or a page left open from before the upgrade can put them back at any time -
 * and both migrations sit behind 003 in the chain, which waits for the first
 * administrator. Tolerating them on read is what keeps any of those from taking
 * every settings read down with "invalid provider".
 */
export const RETIRED_PROVIDER_IDS: Readonly<Record<string, RetiredProviderFamily>> = familyMap({
  'claude-web': 'browser-chat',
  'chatgpt-web': 'browser-chat',
  claude: 'metered-api',
  openai: 'metered-api',
  deepseek: 'metered-api',
});

/** Which removal retired the provider id `value`, or null when it was not retired. */
export function retiredProviderFamily(value: unknown): RetiredProviderFamily | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return Object.prototype.hasOwnProperty.call(RETIRED_PROVIDER_IDS, trimmed) ? RETIRED_PROVIDER_IDS[trimmed] : null;
}

export function isRetiredProviderId(value: unknown): boolean {
  return retiredProviderFamily(value) !== null;
}

/**
 * Model ids that only ever meant one of the retired providers.
 *
 * Browser chat: `free-hybrid` was the synthesized "any free chat browser" entry
 * in the model picker - never a stored row - and `claude-web-chat` /
 * `chatgpt-web-chat` the seeded records for the two sites. Metered: every seed
 * id a release ever shipped for the three APIs. A profile, the stored default,
 * or a request from a page loaded before the upgrade can still name any of
 * them, and a row with no model list of its own inherited the seeds, so its
 * references to them have no record to be dropped with. They read as "the app
 * default" rather than as an unknown model: refusing would break every stale
 * tab and every profile that picked one, on a change their owners did not make.
 *
 * Only shipped ids are listed, and no prefix rule: `claude-` would swallow every
 * `claude-cli-*` seat model. A retired model an administrator created has a
 * random id; `normalizeAIModelRecords` in aiModelConfig remembers those as it
 * drops their records, and the migrations log the ones they delete.
 */
export const RETIRED_MODEL_IDS: Readonly<Record<string, RetiredProviderFamily>> = familyMap({
  'free-hybrid': 'browser-chat',
  'claude-web-chat': 'browser-chat',
  'chatgpt-web-chat': 'browser-chat',
  'openai-gpt-5-1': 'metered-api',
  'openai-gpt-5': 'metered-api',
  'openai-gpt-5-mini': 'metered-api',
  'openai-gpt-5-nano': 'metered-api',
  'claude-claude-sonnet-4-20250514': 'metered-api',
  'deepseek-deepseek-v4-flash': 'metered-api',
  'deepseek-deepseek-v4-pro': 'metered-api',
});

/**
 * The variables an older release named a metered seed model after, and the
 * provider each seeded.
 *
 * With one set, the seed list held `<provider>-<slug of its value>` in place of
 * the shipped default - an id only this machine's `.env` can say. Nothing reads
 * these variables any more (startup says to delete them), but while one is
 * still there a reference to the model it named reads as retired rather than
 * "not found". Migration 007 logs the same ids it derives this way.
 */
export const RETIRED_SEED_MODEL_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  OPENAI_MODEL: 'openai',
  CLAUDE_MODEL: 'claude',
  DEEPSEEK_MODEL: 'deepseek',
});

/** `<provider>-<slug>`, the id a seed record was built with. */
function seedModelId(provider: string, modelName: string): string {
  const slug = modelName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${provider}-${slug || 'model'}`;
}

/**
 * The metered seed ids this environment's leftover `*_MODEL` variables would
 * have produced. Read per call. An id that would look like a live seat's
 * (`CLAUDE_MODEL=cli-sonnet` gives `claude-cli-sonnet`) is left out: that one
 * belongs to the seat.
 */
export function envDerivedRetiredModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const ids: string[] = [];
  for (const [variable, provider] of Object.entries(RETIRED_SEED_MODEL_VARIABLES)) {
    const value = (env[variable] ?? '').trim();
    if (!value) continue;
    const id = seedModelId(provider, value);
    if (AI_PROVIDER_IDS.some((live) => id.startsWith(`${live}-`))) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Which removal retired the model id `value`, or null when it was not retired. */
export function retiredModelFamily(value: unknown): RetiredProviderFamily | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (Object.prototype.hasOwnProperty.call(RETIRED_MODEL_IDS, trimmed)) return RETIRED_MODEL_IDS[trimmed];
  return trimmed && envDerivedRetiredModelIds().includes(trimmed) ? 'metered-api' : null;
}

export function isRetiredModelId(value: unknown): boolean {
  return retiredModelFamily(value) !== null;
}

/**
 * Variables an older release read for the metered API providers or for the
 * switches that let a seat bill an API key. Nothing reads any of them now.
 */
export const RETIRED_PROVIDER_VARIABLES: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'CLAUDE_BASE_URL',
  'OPENAI_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'CLAUDE_MODEL',
  'OPENAI_MODEL',
  'DEEPSEEK_MODEL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'CLAUDE_MAX_ATTEMPTS',
  'AI_CLI_ALLOW_API_KEY',
  'AI_CODEX_ALLOW_API_KEY',
]);

/**
 * The startup line for any of those still set, or null when none is.
 *
 * Said because a variable nothing reads looks exactly like one that works: an
 * operator who sets `AI_CLI_ALLOW_API_KEY=1` or rotates `OPENAI_API_KEY` would
 * otherwise believe it does something. Names only, never a value - three of
 * them are keys. An empty value (`NAME=` copied from an old `.env.example`) is
 * not "set" and is not named.
 */
export function describeRetiredProviderVariables(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = RETIRED_PROVIDER_VARIABLES.filter((name) => (env[name] ?? '').trim() !== '');
  if (set.length === 0) return null;
  return (
    `[ai] ${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} still set, and nothing reads ` +
    `${set.length === 1 ? 'it' : 'them'}: the metered API providers were removed, and every AI provider ` +
    'is a subscription seat signed in on this server, with no API key. Delete ' +
    `${set.length === 1 ? 'it' : 'them'} from .env. (The seats strip any API key from their CLI's ` +
    'environment either way.)'
  );
}

const warnedAliases = new Set<string>();

/**
 * Narrows an untrusted string to a provider id, following legacy aliases.
 * Returns null for anything unrecognised so callers can decide between
 * "fall back to the default" and "reject the request".
 */
export function coerceProviderId(value: unknown): AIProvider | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, trimmed)) {
    return trimmed as AIProvider;
  }

  const alias = Object.prototype.hasOwnProperty.call(LEGACY_PROVIDER_ALIASES, trimmed)
    ? LEGACY_PROVIDER_ALIASES[trimmed]
    : undefined;
  if (alias) {
    if (!warnedAliases.has(trimmed)) {
      warnedAliases.add(trimmed);
      console.warn(
        `[ai] Provider "${trimmed}" no longer exists; reading it as "${alias}". ` +
          'Stored records are rewritten by the provider migration on next boot.'
      );
    }
    return alias;
  }

  return null;
}
