import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

import type { AIProvider } from '../types/template';
import {
  geminiCliBinary,
  geminiCliConcurrency,
  geminiCliHome,
} from '../services/ai/providers/geminiCli/options';
import { AI_PROVIDER_IDS, getProviderLabel, getProviderLockReason, isProviderLocked } from './providerCatalog';

/**
 * Model PROVIDERS: each a CLI of one of the three types, signed in at a
 * location of its own (owner decisions P1-P4).
 *
 * A type - `claude-cli`, `codex-cli`, `gemini-cli` - is what a model names and
 * what a price belongs to. A PROVIDER is one place that type can run: a sign-in
 * folder (CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME, so it can be a
 * different account), optionally a binary of its own, and its own limit,
 * `concurrency_max_requests`, which sizes its semaphore and its queue lane. A
 * model's runs are spread over every enabled, signed-in, not-held provider of
 * its type (services/ai/providerPool.ts, services/queue).
 *
 * THE FIRST PROVIDER OF EACH TYPE IS THE BUILT-IN ONE, with the type's own id.
 * That is what keeps every stored model, prompt override, queued task and
 * profile working: each of them names a type id, and the type id is still a
 * provider - the one this install always had, configured from `.env` exactly
 * as before (`AI_CLI_BIN` / `CLAUDE_CONFIG_DIR` / `AI_CLI_CONCURRENCY` and the
 * Codex and Gemini equivalents) unless an administrator sets a value of their
 * own, which wins. An added provider has an id `prv-<8 hex>`, never a type id
 * and never a model id (those start with the type).
 *
 * Stored as `aiProviders` in the app-settings row, next to `aiModels`, holding
 * only what an administrator set: a built-in with nothing set is not even
 * stored. `AI_LOCKED_PROVIDERS` still locks a TYPE, and with it every provider
 * of the type.
 *
 * This module is pure apart from the filesystem checks an administrator's
 * paths go through; the settings row is read and written by aiModelConfig.ts.
 */

export type ProviderType = AIProvider;

/** A provider as the settings row stores it: only what an administrator set. */
export type StoredAIProvider = {
  id: string;
  type: ProviderType;
  label: string;
  /** The sign-in folder. Required on an added provider; null on a built-in means "what .env says". */
  homeDir: string | null;
  /** Null means the type's binary (a built-in's `.env` value, else the CLI's name on PATH). */
  binaryPath: string | null;
  /** Null on a built-in means "what .env says"; an added provider always has one. */
  concurrency_max_requests: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Where a value in effect came from: an administrator, `.env`, the code's
 * default, or - on an added provider with no binary of its own - the type's,
 * as its built-in provider runs it.
 */
export type ProviderSettingSource = 'admin' | 'env' | 'default' | 'type';

/** A provider with every value in effect worked out. */
export type ResolvedAIProvider = {
  id: string;
  type: ProviderType;
  label: string;
  builtIn: boolean;
  enabled: boolean;
  /** The folder the child is given; null leaves the CLI's own default. */
  homeDir: string | null;
  binaryPath: string;
  concurrency_max_requests: number;
  sources: {
    homeDir: ProviderSettingSource;
    binaryPath: ProviderSettingSource;
    concurrency_max_requests: ProviderSettingSource;
  };
  /** What `.env` (or the code) says, for a built-in: shown beside an administrator's own value. */
  envDefaults: { homeDir: string | null; binaryPath: string; concurrency_max_requests: number } | null;
  /** The administrator's own values, as stored (null: not set). */
  stored: { homeDir: string | null; binaryPath: string | null; concurrency_max_requests: number | null };
  createdAt: string | null;
  updatedAt: string | null;
};

export const PROVIDER_CONCURRENCY_MIN = 1;
export const PROVIDER_CONCURRENCY_MAX = 32;
const LABEL_MAX = 80;
const PATH_MAX = 4_096;

/** An added provider's id. Never a type id, never a model id, safe in a URL path and a slot id. */
export const ADDED_PROVIDER_ID = /^prv-[0-9a-f]{8}$/;

/** The variable each type's CLI reads its sign-in folder from - what the child env sets. */
export const PROVIDER_HOME_VARIABLE: Readonly<Record<ProviderType, string>> = Object.freeze({
  'claude-cli': 'CLAUDE_CONFIG_DIR',
  'codex-cli': 'CODEX_HOME',
  'gemini-cli': 'GEMINI_CLI_HOME',
});

/** The `.env` variables a built-in provider reads, by what they set. */
export const BUILT_IN_PROVIDER_ENV: Readonly<
  Record<ProviderType, { binaryPath: string; homeDir: string; concurrency_max_requests: string }>
> = Object.freeze({
  'claude-cli': { binaryPath: 'AI_CLI_BIN', homeDir: 'CLAUDE_CONFIG_DIR', concurrency_max_requests: 'AI_CLI_CONCURRENCY' },
  'codex-cli': { binaryPath: 'AI_CODEX_BIN', homeDir: 'CODEX_HOME', concurrency_max_requests: 'AI_CODEX_CONCURRENCY' },
  'gemini-cli': { binaryPath: 'AI_GEMINI_BIN', homeDir: 'AI_GEMINI_HOME', concurrency_max_requests: 'AI_GEMINI_CONCURRENCY' },
});

const DEFAULT_BINARY: Readonly<Record<ProviderType, string>> = Object.freeze({
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
});

function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

/** True for the id of a built-in provider - which is a type id. */
export function isBuiltInProviderId(id: unknown): id is ProviderType {
  return isProviderType(id);
}

/* ============================================================ .env readers */

function clampConcurrency(raw: number): number {
  return Math.min(PROVIDER_CONCURRENCY_MAX, Math.max(PROVIDER_CONCURRENCY_MIN, raw));
}

/**
 * `AI_CLI_CONCURRENCY`, as the Claude seat has always read it: 4 by default,
 * clamped to 1-32. The built-in Claude provider's limit when an administrator
 * has not set one. (Re-exported by services/ai/batchCapacity, where it lived.)
 */
export function cliConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.AI_CLI_CONCURRENCY || '', 10);
  return Number.isInteger(raw) ? clampConcurrency(raw) : 4;
}

/** `AI_CODEX_CONCURRENCY`, read like the Claude seat's and sized separately from it. */
export function codexConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.AI_CODEX_CONCURRENCY || '', 10);
  return Number.isInteger(raw) ? clampConcurrency(raw) : 4;
}

function envSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name] ?? '').trim() !== '';
}

type BuiltInDefaults = {
  homeDir: { value: string | null; source: ProviderSettingSource };
  binaryPath: { value: string; source: ProviderSettingSource };
  concurrency_max_requests: { value: number; source: ProviderSettingSource };
};

/**
 * What a built-in provider runs with when an administrator has set nothing:
 * the variables this app has always read, read the way the seats read them.
 */
export function builtInProviderDefaults(type: ProviderType, env: NodeJS.ProcessEnv = process.env): BuiltInDefaults {
  const names = BUILT_IN_PROVIDER_ENV[type];
  if (type === 'gemini-cli') {
    // AI_GEMINI_HOME first (the seat's own setting), else a GEMINI_CLI_HOME the
    // server already runs with - which the child inherits anyway.
    const ownHome = geminiCliHome(env);
    const inherited = (env.GEMINI_CLI_HOME ?? '').trim();
    return {
      homeDir: ownHome
        ? { value: ownHome, source: 'env' }
        : inherited
          ? { value: inherited, source: 'env' }
          : { value: null, source: 'default' },
      binaryPath: { value: geminiCliBinary(env), source: envSet(env, names.binaryPath) ? 'env' : 'default' },
      concurrency_max_requests: {
        value: geminiCliConcurrency(env),
        source: envSet(env, names.concurrency_max_requests) ? 'env' : 'default',
      },
    };
  }

  const home = (env[names.homeDir] ?? '').trim();
  const binary = (env[names.binaryPath] ?? '').trim();
  return {
    homeDir: home ? { value: home, source: 'env' } : { value: null, source: 'default' },
    binaryPath: binary ? { value: binary, source: 'env' } : { value: DEFAULT_BINARY[type], source: 'default' },
    concurrency_max_requests: {
      value: type === 'claude-cli' ? cliConcurrency(env) : codexConcurrency(env),
      source: envSet(env, names.concurrency_max_requests) ? 'env' : 'default',
    },
  };
}

/**
 * Where a type's CLI keeps its sign-in when nothing names a folder: the folder
 * a provider with `homeDir: null` really uses, so two providers cannot both
 * end up there by one naming it and the other leaving it unset.
 */
export function defaultProviderHome(type: ProviderType, homedir: () => string = os.homedir): string {
  if (type === 'claude-cli') return path.join(homedir(), '.claude');
  if (type === 'codex-cli') return path.join(homedir(), '.codex');
  // GEMINI_CLI_HOME is the PARENT of `.gemini`, so its default is the home itself.
  return homedir();
}

/* ======================================================= stored -> resolved */

function builtInRecord(type: ProviderType): StoredAIProvider {
  return {
    id: type,
    type,
    label: getProviderLabel(type),
    homeDir: null,
    binaryPath: null,
    concurrency_max_requests: null,
    enabled: true,
    createdAt: '',
    updatedAt: '',
  };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function storedConcurrency(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PROVIDER_CONCURRENCY_MIN &&
    value <= PROVIDER_CONCURRENCY_MAX
    ? value
    : null;
}

const warnedStored = new Set<string>();
function warnStoredOnce(key: string, message: string): void {
  if (warnedStored.has(key)) return;
  warnedStored.add(key);
  console.warn(message);
}

/**
 * The stored list, read leniently: a settings row is never refused over it.
 *
 * Every type gets its built-in provider, first among its type, whether or not
 * the row has one; added providers follow in stored order, grouped by type in
 * catalog order. An entry this build cannot use - an unknown type, a malformed
 * id, an added provider with no folder - is dropped with a warning rather than
 * failing every settings read (a hand-edited row, a restored backup). Paths are
 * NOT checked here: the filesystem can change after a save, and the health
 * check is what says a folder or a binary is gone.
 */
export function normalizeStoredProviders(input: unknown): StoredAIProvider[] {
  const builtIns = new Map<ProviderType, StoredAIProvider>();
  const added: StoredAIProvider[] = [];
  const seen = new Set<string>();

  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const id = text(entry.id, 64);
    const type = isProviderType(entry.type) ? entry.type : isProviderType(id) ? id : null;
    if (!type || !id || seen.has(id)) {
      if (id && !seen.has(id)) {
        warnStoredOnce(`type:${id}`, `[ai] Ignoring stored provider "${id}": its type is not one this build runs.`);
      }
      continue;
    }
    const builtIn = isProviderType(id);
    if (builtIn && id !== type) {
      warnStoredOnce(`mismatch:${id}`, `[ai] Ignoring stored provider "${id}": a built-in provider's type is its id.`);
      continue;
    }
    if (!builtIn && !ADDED_PROVIDER_ID.test(id)) {
      warnStoredOnce(`id:${id}`, `[ai] Ignoring stored provider "${id}": not an id this build gives a provider.`);
      continue;
    }
    const homeDir = text(entry.homeDir, PATH_MAX) || null;
    if (!builtIn && !homeDir) {
      warnStoredOnce(`home:${id}`, `[ai] Ignoring stored provider "${id}": it names no sign-in folder.`);
      continue;
    }
    seen.add(id);
    const record: StoredAIProvider = {
      id,
      type,
      label: text(entry.label, LABEL_MAX) || (builtIn ? getProviderLabel(type) : `${getProviderLabel(type)} (${id})`),
      homeDir,
      binaryPath: text(entry.binaryPath, PATH_MAX) || null,
      concurrency_max_requests: storedConcurrency(entry.concurrency_max_requests),
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
      createdAt: text(entry.createdAt, 64),
      updatedAt: text(entry.updatedAt, 64),
    };
    if (builtIn) builtIns.set(type, record);
    else added.push(record);
  }

  const out: StoredAIProvider[] = [];
  for (const type of AI_PROVIDER_IDS) {
    out.push(builtIns.get(type) ?? builtInRecord(type));
    out.push(...added.filter((entry) => entry.type === type));
  }
  return out;
}

/**
 * What a stored list is written back as: built-ins only where an
 * administrator set something, so an untouched install stores nothing and
 * keeps reading `.env`.
 */
export function storableProviders(list: readonly StoredAIProvider[]): StoredAIProvider[] {
  return list.filter(
    (entry) =>
      !isBuiltInProviderId(entry.id) ||
      entry.homeDir !== null ||
      entry.binaryPath !== null ||
      entry.concurrency_max_requests !== null ||
      !entry.enabled ||
      entry.label !== getProviderLabel(entry.type)
  );
}

/** Every value in effect, and where each came from. */
export function resolveProviders(
  stored: readonly StoredAIProvider[],
  env: NodeJS.ProcessEnv = process.env
): ResolvedAIProvider[] {
  const list = normalizeStoredProviders(stored);
  const defaults = new Map(AI_PROVIDER_IDS.map((type) => [type, builtInProviderDefaults(type, env)]));
  return list.map((entry) => {
    const builtIn = isBuiltInProviderId(entry.id);
    const typeDefaults = defaults.get(entry.type)!;
    const homeDir = entry.homeDir ?? (builtIn ? typeDefaults.homeDir.value : null);
    const binaryPath = entry.binaryPath ?? typeDefaults.binaryPath.value;
    const concurrency = entry.concurrency_max_requests ?? typeDefaults.concurrency_max_requests.value;
    return {
      id: entry.id,
      type: entry.type,
      label: entry.label,
      builtIn,
      enabled: entry.enabled,
      homeDir,
      binaryPath,
      concurrency_max_requests: concurrency,
      sources: {
        homeDir: entry.homeDir !== null ? 'admin' : builtIn ? typeDefaults.homeDir.source : 'default',
        binaryPath: entry.binaryPath !== null ? 'admin' : builtIn ? typeDefaults.binaryPath.source : 'type',
        concurrency_max_requests:
          entry.concurrency_max_requests !== null
            ? 'admin'
            : builtIn
              ? typeDefaults.concurrency_max_requests.source
              : 'type',
      },
      envDefaults: builtIn
        ? {
            homeDir: typeDefaults.homeDir.value,
            binaryPath: typeDefaults.binaryPath.value,
            concurrency_max_requests: typeDefaults.concurrency_max_requests.value,
          }
        : null,
      stored: {
        homeDir: entry.homeDir,
        binaryPath: entry.binaryPath,
        concurrency_max_requests: entry.concurrency_max_requests,
      },
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
    };
  });
}

/** A fresh id for an added provider, never one already in `taken`. */
export function newProviderId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `prv-${randomBytes(4).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}

/* ============================================================ the snapshot */

/**
 * The providers as the settings were last read, held synchronously.
 *
 * The queue's dispatcher and the pool that spreads a type's calls cannot await
 * a settings read in the middle of placing work, so aiModelConfig.ts hands
 * every list it reads or writes to `noteStoredProviders`, keyed by the database
 * it came from - the suite addresses many databases from one process, and a
 * list from one must never be read as another's. Until a read has happened
 * (and for any other database) it is the three built-ins from `.env`.
 */
let snapshot: { key: string; stored: StoredAIProvider[] } | null = null;
/**
 * The last resolution of the snapshot against the server's own environment.
 * The dispatcher asks for it once per lane per task it places, and the answer
 * only changes when the settings (`noteStoredProviders` drops it) or one of the
 * variables a built-in provider reads (part of the cache's key) do.
 */
let resolvedCache: { key: string; env: string; value: ResolvedAIProvider[] } | null = null;

/** The values of every variable `builtInProviderDefaults` reads, as one string. */
function envFingerprint(env: NodeJS.ProcessEnv): string {
  const names = [
    ...Object.values(BUILT_IN_PROVIDER_ENV).flatMap((entry) => Object.values(entry)),
    'GEMINI_CLI_HOME',
  ];
  return names.map((name) => env[name] ?? '').join('\u0000');
}
/** Every provider id ever seen in this process, with its type: a removed one's tasks still know theirs. */
const typeById = new Map<string, ProviderType>();

export function noteStoredProviders(key: string, stored: readonly StoredAIProvider[]): void {
  const list = normalizeStoredProviders(stored);
  snapshot = { key, stored: list };
  resolvedCache = null;
  for (const entry of list) typeById.set(entry.id, entry.type);
}

/** The providers in effect for the database at `key`, from the last read. */
export function currentProviders(key: string, env: NodeJS.ProcessEnv = process.env): ResolvedAIProvider[] {
  const stored = snapshot && snapshot.key === key ? snapshot.stored : [];
  if (env !== process.env) return resolveProviders(stored, env);
  const fingerprint = envFingerprint(env);
  if (resolvedCache && resolvedCache.key === key && resolvedCache.env === fingerprint) {
    return resolvedCache.value;
  }
  const value = resolveProviders(stored, env);
  resolvedCache = { key, env: fingerprint, value };
  return value;
}

/**
 * The type a provider id belongs to: a type id is its own, an added provider's
 * is remembered from any list this process has read - so the waiting work of a
 * provider removed since still finds its type. Null for anything else.
 */
export function providerTypeOf(id: unknown): ProviderType | null {
  if (isProviderType(id)) return id;
  return typeof id === 'string' ? typeById.get(id) ?? null : null;
}

/** Tests share one process. */
export function resetProviderSnapshotForTests(): void {
  snapshot = null;
  resolvedCache = null;
  typeById.clear();
  warnedStored.clear();
}

/* ============================================================== admin input */

/** Refused input, by field, in words for the administrator who typed it. */
export class AIProviderInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'AIProviderInputError';
  }
}

/** The filesystem as the checks see it; injected in the tests. */
export type ProviderPathDeps = {
  platform: NodeJS.Platform;
  stat: (filePath: string) => fs.Stats | null;
  realpath: (filePath: string) => string;
  isExecutable: (filePath: string) => boolean;
  homedir: () => string;
};

export function defaultProviderPathDeps(): ProviderPathDeps {
  return {
    platform: process.platform,
    stat: (filePath) => {
      try {
        return fs.statSync(filePath);
      } catch {
        return null;
      }
    },
    realpath: (filePath) => {
      try {
        return fs.realpathSync(filePath);
      } catch {
        return filePath;
      }
    },
    isExecutable: (filePath) => {
      if (process.platform === 'win32') {
        // Windows has no execute bit; what it runs is decided by extension,
        // and resolveBinary.ts turns an npm `.cmd`/`.ps1` shim into its script.
        const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toUpperCase().split(';');
        const ext = path.extname(filePath).toUpperCase();
        return Boolean(ext) && (pathExt.includes(ext) || ext === '.PS1');
      }
      try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    homedir: os.homedir,
  };
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** `inner` is `outer` or below it, in the platform's own case rule. */
export function isWithinDirectory(outer: string, inner: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathApi(platform);
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const relative = p.relative(fold(p.resolve(outer)), fold(p.resolve(inner)));
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
}

/** A path as compared: absolute, symlinks followed where it exists. */
function canonical(value: string, deps: ProviderPathDeps): string {
  const p = pathApi(deps.platform);
  return deps.realpath(p.resolve(value));
}

function checkAbsolute(value: string, field: string, deps: ProviderPathDeps): void {
  if (!pathApi(deps.platform).isAbsolute(value)) {
    throw new AIProviderInputError(
      'path-not-absolute',
      `${FIELD_NAMES[field] ?? field} must be an absolute path (it is "${value}").`,
      field
    );
  }
}

const FIELD_NAMES: Record<string, string> = {
  homeDir: 'The sign-in folder',
  binaryPath: 'The CLI binary',
  concurrency_max_requests: 'concurrency_max_requests',
  label: 'The name',
  type: 'The type',
};

function checkNotInApp(value: string, field: string, appDirectories: readonly string[], deps: ProviderPathDeps): void {
  const resolved = canonical(value, deps);
  for (const dir of appDirectories) {
    if (!dir) continue;
    const appDir = canonical(dir, deps);
    if (isWithinDirectory(appDir, resolved, deps.platform)) {
      throw new AIProviderInputError(
        'path-inside-app',
        `${FIELD_NAMES[field]} "${value}" is inside ${appDir}, one of this app's own directories. A provider's ` +
          'files live outside the app, where nothing the app writes, serves or deletes can reach them.',
        field
      );
    }
  }
}

/** Checks a sign-in folder an administrator typed; returns it trimmed. */
export function checkProviderHomeDir(
  value: string,
  appDirectories: readonly string[],
  deps: ProviderPathDeps = defaultProviderPathDeps()
): string {
  checkAbsolute(value, 'homeDir', deps);
  const stats = deps.stat(value);
  if (!stats) {
    throw new AIProviderInputError(
      'path-missing',
      `The sign-in folder "${value}" does not exist on this server. Create it, sign the CLI in there, then add it.`,
      'homeDir'
    );
  }
  if (!stats.isDirectory()) {
    throw new AIProviderInputError('not-a-directory', `The sign-in folder "${value}" is not a directory.`, 'homeDir');
  }
  checkNotInApp(value, 'homeDir', appDirectories, deps);
  return value;
}

/** Checks a CLI binary an administrator typed; returns it trimmed. */
export function checkProviderBinary(
  value: string,
  appDirectories: readonly string[],
  deps: ProviderPathDeps = defaultProviderPathDeps()
): string {
  checkAbsolute(value, 'binaryPath', deps);
  const stats = deps.stat(value);
  if (!stats) {
    throw new AIProviderInputError('path-missing', `The CLI binary "${value}" does not exist on this server.`, 'binaryPath');
  }
  if (!stats.isFile()) {
    throw new AIProviderInputError('not-a-file', `The CLI binary "${value}" is not a file.`, 'binaryPath');
  }
  if (!deps.isExecutable(value)) {
    throw new AIProviderInputError(
      'not-executable',
      `The CLI binary "${value}" is not executable by the user this server runs as.`,
      'binaryPath'
    );
  }
  checkNotInApp(value, 'binaryPath', appDirectories, deps);
  return value;
}

/** Reads `concurrency_max_requests` as typed: a whole number 1-32, as a number or its digits. */
export function readProviderConcurrency(value: unknown): number {
  const raw = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value.trim()) : value;
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < PROVIDER_CONCURRENCY_MIN ||
    raw > PROVIDER_CONCURRENCY_MAX
  ) {
    throw new AIProviderInputError(
      'bad-concurrency',
      `concurrency_max_requests must be a whole number from ${PROVIDER_CONCURRENCY_MIN} to ${PROVIDER_CONCURRENCY_MAX}.`,
      'concurrency_max_requests'
    );
  }
  return raw;
}

/** The folder a provider really signs in at, for comparing two of one type. */
function effectiveHome(entry: ResolvedAIProvider, deps: ProviderPathDeps): string {
  return canonical(entry.homeDir ?? defaultProviderHome(entry.type, deps.homedir), deps);
}

/** Refuses a folder another provider of the same type already signs in at. */
export function checkHomeNotShared(
  type: ProviderType,
  homeDir: string | null,
  selfId: string | null,
  others: readonly ResolvedAIProvider[],
  deps: ProviderPathDeps = defaultProviderPathDeps()
): void {
  const mine = canonical(homeDir ?? defaultProviderHome(type, deps.homedir), deps);
  const fold = (value: string) => (deps.platform === 'win32' ? value.toLowerCase() : value);
  for (const other of others) {
    if (other.type !== type || other.id === selfId) continue;
    if (fold(effectiveHome(other, deps)) === fold(mine)) {
      throw new AIProviderInputError(
        'home-in-use',
        `"${other.label}" already signs in at ${mine}. Two ${getProviderLabel(type)} providers at one folder ` +
          'are one account with two limits; give this one a folder of its own.',
        'homeDir',
        409
      );
    }
  }
}

function readLabel(value: unknown, others: readonly ResolvedAIProvider[], selfId: string | null): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AIProviderInputError('label-required', 'A provider needs a name.', 'label');
  }
  const label = value.trim();
  if (label.length > LABEL_MAX) {
    throw new AIProviderInputError('label-too-long', `A provider's name is at most ${LABEL_MAX} characters.`, 'label');
  }
  const clash = others.find((entry) => entry.id !== selfId && entry.label.toLowerCase() === label.toLowerCase());
  if (clash) {
    throw new AIProviderInputError('label-in-use', `Another provider is already called "${clash.label}".`, 'label', 409);
  }
  return label;
}

/** A path field as typed: a string, '' or null to clear, absent to leave alone. */
function readPathField(input: Record<string, unknown>, field: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, field)) return undefined;
  const value = input[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AIProviderInputError('bad-path', `${FIELD_NAMES[field]} must be a path.`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length > PATH_MAX) {
    throw new AIProviderInputError('bad-path', `${FIELD_NAMES[field]} is too long.`, field);
  }
  return trimmed || null;
}

export type ProviderCheckContext = {
  /** The other providers, resolved, for the shared-folder and the name checks. */
  providers: readonly ResolvedAIProvider[];
  /** This app's own directories; nothing a provider names may be inside one. */
  appDirectories: readonly string[];
  deps?: ProviderPathDeps;
  now?: Date;
};

/**
 * A new provider from an administrator's form: `{ type, label, homeDir,
 * binaryPath?, concurrency_max_requests?, enabled? }`. The folder is required -
 * a provider IS a location - and checked like every path an administrator
 * gives one; the limit defaults to the type's built-in one.
 */
export function buildNewProvider(input: unknown, context: ProviderCheckContext): StoredAIProvider {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const deps = context.deps ?? defaultProviderPathDeps();
  if (!isProviderType(body.type)) {
    throw new AIProviderInputError(
      'bad-type',
      `The type must be one of ${AI_PROVIDER_IDS.join(', ')}.`,
      'type'
    );
  }
  const type = body.type;
  const label = readLabel(body.label, context.providers, null);
  const homeDir = readPathField(body, 'homeDir');
  if (!homeDir) {
    throw new AIProviderInputError(
      'home-required',
      `An added provider needs a sign-in folder of its own (it is passed to the CLI as ${PROVIDER_HOME_VARIABLE[type]}).`,
      'homeDir'
    );
  }
  checkProviderHomeDir(homeDir, context.appDirectories, deps);
  checkHomeNotShared(type, homeDir, null, context.providers, deps);
  const binaryPath = readPathField(body, 'binaryPath') ?? null;
  if (binaryPath) checkProviderBinary(binaryPath, context.appDirectories, deps);
  const concurrency =
    body.concurrency_max_requests === undefined || body.concurrency_max_requests === null || body.concurrency_max_requests === ''
      ? builtInProviderDefaults(type).concurrency_max_requests.value
      : readProviderConcurrency(body.concurrency_max_requests);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new AIProviderInputError('bad-enabled', 'enabled must be true or false.', 'enabled');
  }
  const at = (context.now ?? new Date()).toISOString();
  return {
    id: newProviderId(new Set(context.providers.map((entry) => entry.id))),
    type,
    label,
    homeDir,
    binaryPath,
    concurrency_max_requests: concurrency,
    enabled: body.enabled !== false,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * An edit: any of `label`, `homeDir`, `binaryPath`, `concurrency_max_requests`,
 * `enabled`. The type never changes. On a built-in, '' or null CLEARS an
 * administrator's value and puts `.env`'s back; an added provider keeps a
 * folder and a limit of its own, and may clear only its binary.
 */
export function applyProviderEdit(
  current: StoredAIProvider,
  input: unknown,
  context: ProviderCheckContext
): StoredAIProvider {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const deps = context.deps ?? defaultProviderPathDeps();
  const builtIn = isBuiltInProviderId(current.id);
  if (body.type !== undefined && body.type !== current.type) {
    throw new AIProviderInputError('type-fixed', "A provider's type cannot change; add a provider of the other type instead.", 'type');
  }

  const next: StoredAIProvider = { ...current };
  if (body.label !== undefined) {
    next.label =
      builtIn && (body.label === null || body.label === '')
        ? getProviderLabel(current.type)
        : readLabel(body.label, context.providers, current.id);
  }

  const homeDir = readPathField(body, 'homeDir');
  if (homeDir !== undefined) {
    if (homeDir === null && !builtIn) {
      throw new AIProviderInputError('home-required', 'An added provider keeps a sign-in folder of its own.', 'homeDir');
    }
    if (homeDir !== null && homeDir !== current.homeDir) checkProviderHomeDir(homeDir, context.appDirectories, deps);
    next.homeDir = homeDir;
    // Checked against what the folder IS in effect - a cleared built-in falls
    // back to `.env`, which may be another provider's folder.
    const effective = homeDir ?? (builtIn ? builtInProviderDefaults(current.type).homeDir.value : null);
    checkHomeNotShared(current.type, effective, current.id, context.providers, deps);
  }

  const binaryPath = readPathField(body, 'binaryPath');
  if (binaryPath !== undefined) {
    if (binaryPath !== null && binaryPath !== current.binaryPath) {
      checkProviderBinary(binaryPath, context.appDirectories, deps);
    }
    next.binaryPath = binaryPath;
  }

  if (body.concurrency_max_requests !== undefined) {
    const clear = body.concurrency_max_requests === null || body.concurrency_max_requests === '';
    if (clear && !builtIn) {
      throw new AIProviderInputError(
        'bad-concurrency',
        'An added provider keeps a concurrency_max_requests of its own.',
        'concurrency_max_requests'
      );
    }
    next.concurrency_max_requests = clear ? null : readProviderConcurrency(body.concurrency_max_requests);
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new AIProviderInputError('bad-enabled', 'enabled must be true or false.', 'enabled');
    }
    next.enabled = body.enabled;
  }

  next.updatedAt = (context.now ?? new Date()).toISOString();
  if (!next.createdAt) next.createdAt = next.updatedAt;
  return next;
}

/* ================================================================== views */

/** One provider as Admin -> Models shows it. Administrators only: it names folders and binaries. */
export type AdminAIProvider = ResolvedAIProvider & {
  typeLabel: string;
  /** The variable the folder reaches the CLI as. */
  homeVariable: string;
  /** The type is locked in this installation (AI_LOCKED_PROVIDERS), and why. */
  locked: boolean;
  lockReason: string;
};

export function toAdminProvider(entry: ResolvedAIProvider): AdminAIProvider {
  return {
    ...entry,
    typeLabel: getProviderLabel(entry.type),
    homeVariable: PROVIDER_HOME_VARIABLE[entry.type],
    locked: isProviderLocked(entry.type),
    lockReason: getProviderLockReason(entry.type),
  };
}
