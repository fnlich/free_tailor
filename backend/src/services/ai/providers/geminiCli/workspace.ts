import fs from 'fs';
import path from 'path';
import { warnOnce } from '../../telemetry';

/**
 * The files this provider keeps on disk, and the ones the CLI leaves behind.
 *
 * Two directories, deliberately apart:
 *
 *   WORKDIR (the CLI's "workspace", its cwd) holds only `.gemini/.env` and
 *   `.gemini/settings.json`. The CLI reads files a prompt names with `@` when
 *   they resolve inside the workspace, and loads a GEMINI.md found there into
 *   the system prompt, so nothing else may ever be put in it.
 *
 *   STATE DIR holds the deny-all policy and one directory per turn (its system
 *   prompt, and the temp dir the CLI dumps the full conversation into on an
 *   API error). It must be outside the workspace for the reason above.
 *
 * Everything here is synchronous, like the runner's own scratch-file handling:
 * these are a handful of small files, written once per process or once per
 * turn, next to a child process that takes seconds.
 */

/**
 * The workspace settings, verified file-for-file against 0.62.0 (the copy in
 * test/fixtures/gemini is the one that was run). Workspace settings outrank the
 * operator's ~/.gemini/settings.json, so this is what decides how a turn runs:
 *
 *   - security.auth: the Google sign-in, and ONLY that - `enforcedType` makes
 *     any other auth type exit 41 before a network call (verified with a
 *     GEMINI_API_KEY in place);
 *   - tools.core [] registers no built-in tools at all (verified: the request
 *     carries an empty functionDeclarations), skills and hooks are off;
 *   - MCP servers and extensions are NOT turned off here, whatever the keys
 *     below look like: 0.62.0 rebuilds `admin.*` from remote admin controls
 *     only, so it is ignored in any settings file, and an empty `mcp.allowed`
 *     means "no limit". The pinned `--allowed-mcp-server-names` and
 *     `--extensions none` in argv.ts are what keep the operator's own servers
 *     and extensions out of a turn. The keys stay because this is the file
 *     that was verified, and they cost nothing;
 *   - billing.overageStrategy 'never': a seat whose quota is spent fails rather
 *     than spending the account's paid AI Credits;
 *   - usage statistics and telemetry off, checkpointing and auto-update off;
 *   - general.maxAttempts bounds the silent 429/5xx retry loop (see options.ts);
 *   - sessionRetention 1d, so a transcript the per-turn cleanup missed does not
 *     sit there for the CLI's default 30 days;
 *   - context: no directory tree in the prompt, and no GEMINI.md discovery
 *     below the workspace;
 *   - model.maxSessionTurns 2: one answer is a turn, and a model that tried to
 *     loop has nowhere to go.
 */
export function geminiWorkspaceSettings(maxAttempts: number): Record<string, unknown> {
  return {
    security: {
      auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal' },
      folderTrust: { enabled: false },
    },
    tools: { core: [], sandbox: false },
    mcp: { allowed: [] },
    admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } },
    skills: { enabled: false },
    hooksConfig: { enabled: false },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    billing: { overageStrategy: 'never' },
    general: {
      checkpointing: { enabled: false },
      enableAutoUpdate: false,
      enableAutoUpdateNotification: false,
      maxAttempts,
      sessionRetention: { enabled: true, maxAge: '1d' },
    },
    context: { includeDirectoryTree: false, discoveryMaxDirs: 1 },
    model: { maxSessionTurns: 2 },
    experimental: { autoMemory: false },
    ide: { enabled: false },
  };
}

/** Denies every tool, whatever it is called. Passed as `--policy <dir>`. */
export const GEMINI_DENY_ALL_POLICY = '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n';

/** Thrown for a layout that would put turn files where a prompt can read them. */
export class GeminiWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiWorkspaceError';
  }
}

export type GeminiWorkspace = {
  workdir: string;
  stateDir: string;
  policyDir: string;
  turnsDir: string;
};

/** True when `child` is `parent` or anywhere below it. */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * How old a turn directory has to be before the prep sweep deletes it: twice
 * the longest budget a turn can be given (AI_*_TIMEOUT_MS tops out at an hour),
 * so a second process sharing the directory never loses a live turn.
 */
const STALE_TURN_MS = 2 * 60 * 60 * 1000;

/**
 * The one-time setup, run before the first turn of each process. Idempotent:
 * every file is rewritten to what it must contain, so a settings file someone
 * edited, or a key someone put in the workspace `.env`, is put right.
 */
export function prepareGeminiWorkspace(options: {
  workdir: string;
  stateDir: string;
  maxAttempts: number;
  now?: () => number;
}): GeminiWorkspace {
  const workdir = path.resolve(options.workdir);
  const stateDir = path.resolve(options.stateDir);
  const now = options.now ?? Date.now;

  if (isWithin(workdir, stateDir)) {
    throw new GeminiWorkspaceError(
      `AI_GEMINI_STATE_DIR (${stateDir}) is inside AI_GEMINI_WORKDIR (${workdir}). The CLI reads files a ` +
        "prompt names with @ when they are inside its workspace, and the state directory holds each turn's " +
        'system prompt and error dumps. Point the two at separate directories.'
    );
  }

  const dotGemini = path.join(workdir, '.gemini');
  fs.mkdirSync(dotGemini, { recursive: true });
  // EMPTY, and that is the point: the CLI's `.env` search stops at the first
  // file it finds, so this one keeps it from walking up to the repository's
  // .env or the operator's ~/.env, either of which may hold a GEMINI_API_KEY.
  fs.writeFileSync(path.join(dotGemini, '.env'), '', 'utf8');
  fs.writeFileSync(
    path.join(dotGemini, 'settings.json'),
    `${JSON.stringify(geminiWorkspaceSettings(options.maxAttempts), null, 2)}\n`,
    'utf8'
  );

  const stray = fs.readdirSync(workdir).filter((entry) => entry !== '.gemini');
  if (stray.length > 0) {
    warnOnce(
      `gemini-workdir-not-empty:${workdir}`,
      `The Gemini CLI workspace ${workdir} holds ${stray.slice(0, 5).join(', ')}` +
        `${stray.length > 5 ? ', ...' : ''}. A prompt that names a file there with @ gets its ` +
        'contents, and a GEMINI.md there joins every system prompt. Point AI_GEMINI_WORKDIR at an ' +
        'empty directory of its own.'
    );
  }

  const policyDir = path.join(stateDir, 'policy');
  fs.mkdirSync(policyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(policyDir, 'deny-all.toml'), GEMINI_DENY_ALL_POLICY, 'utf8');

  const turnsDir = path.join(stateDir, 'turns');
  fs.mkdirSync(turnsDir, { recursive: true, mode: 0o700 });
  // A process that died mid-turn leaves its turn directory behind, error dumps
  // and all. Swept once here rather than never.
  for (const entry of fs.readdirSync(turnsDir)) {
    const dir = path.join(turnsDir, entry);
    try {
      if (now() - fs.statSync(dir).mtimeMs > STALE_TURN_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best effort: a leftover is untidy, not a reason to refuse the seat.
    }
  }

  return { workdir, stateDir, policyDir, turnsDir };
}

export type GeminiTurnFiles = {
  dir: string;
  systemPromptFile: string;
  tmpDir: string;
};

/** One turn's directory: its system prompt and its own temp dir. */
export function openGeminiTurn(workspace: GeminiWorkspace, turnId: string, systemPrompt: string): GeminiTurnFiles {
  const dir = path.join(workspace.turnsDir, turnId);
  const tmpDir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const systemPromptFile = path.join(dir, 'system.md');
  fs.writeFileSync(systemPromptFile, systemPrompt, 'utf8');
  return { dir, systemPromptFile, tmpDir };
}

/** Removes a turn's directory. Never throws: it runs in a `finally`. */
export function closeGeminiTurn(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignored on purpose
  }
}

/**
 * The CLI's key for a project directory in projects.json: absolute, forward
 * slashes, and lower case where the file system is case-insensitive.
 */
function projectKey(dir: string, platform: NodeJS.Platform): string {
  const absolute = path.resolve(dir).replace(/\\/g, '/');
  return platform === 'win32' || platform === 'darwin' ? absolute.toLowerCase() : absolute;
}

function readProjectId(geminiDir: string, workdir: string, platform: NodeJS.Platform): string | null {
  let registry: unknown;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(geminiDir, 'projects.json'), 'utf8'));
  } catch {
    return null;
  }
  const projects = (registry as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== 'object') return null;

  const wanted = new Set([projectKey(workdir, platform)]);
  try {
    wanted.add(projectKey(fs.realpathSync(workdir), platform));
  } catch {
    // The workdir may already be gone; the resolved spelling is still tried.
  }
  for (const [key, id] of Object.entries(projects as Record<string, unknown>)) {
    const comparable = platform === 'win32' || platform === 'darwin' ? key.toLowerCase() : key;
    if (wanted.has(comparable) && typeof id === 'string' && id && !id.includes('/') && !id.includes('\\')) {
      return id;
    }
  }
  return null;
}

/** The first few KB of a file, where a transcript names its session. */
function readHead(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(4_096);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Removes one project temp dir's artifacts of `sessionId`; returns how many transcripts went. */
function removeFromProjectTemp(projectTemp: string, sessionId: string): number {
  let removed = 0;
  const chats = path.join(projectTemp, 'chats');
  const suffixes = [`-${sessionId.slice(0, 8)}.jsonl`, `-${sessionId.slice(0, 8)}.json`];
  let names: string[] = [];
  try {
    names = fs.readdirSync(chats);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.startsWith('session-') || !suffixes.some((suffix) => name.endsWith(suffix))) continue;
    const file = path.join(chats, name);
    // The name carries only 8 characters of the id. The file's own header
    // carries all of it, so another session that happens to share the prefix
    // - the operator's own, say - is never the one deleted.
    if (!readHead(file).includes(sessionId)) continue;
    try {
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch {
      // ignored on purpose
    }
  }
  // The CLI's other per-session leftovers, which it names by the full id.
  for (const leftover of [
    path.join(projectTemp, 'logs', `session-${sessionId}.jsonl`),
    path.join(projectTemp, 'tool-outputs', `session-${sessionId}`),
    path.join(projectTemp, sessionId),
  ]) {
    try {
      fs.rmSync(leftover, { recursive: true, force: true });
    } catch {
      // ignored on purpose
    }
  }
  return removed;
}

/**
 * Deletes the transcript the CLI wrote for one turn.
 *
 * Every headless turn writes the full prompt and answer to
 * `<home>/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<id[0:8]>.jsonl`
 * (verified on 0.62.0, `--session-id` included), and there is no flag to stop
 * it. That is a copy of a user's resume and job description per call in the
 * operator's home directory, so it goes when the turn does. `<project>` is
 * looked up in the CLI's projects.json; when that fails, every project's chats
 * are searched, and a file is only deleted once its header names this session.
 *
 * Best effort and never throws. The file layout is the CLI's, not a contract,
 * and `sessionRetention` in the workspace settings is the backstop.
 */
export function removeGeminiSessionTranscript(options: {
  home: string;
  workdir: string;
  sessionId: string;
  platform?: NodeJS.Platform;
}): number {
  try {
    const geminiDir = path.join(options.home, '.gemini');
    const tmpRoot = path.join(geminiDir, 'tmp');
    const platform = options.platform ?? process.platform;

    const projectId = readProjectId(geminiDir, options.workdir, platform);
    if (projectId) {
      const removed = removeFromProjectTemp(path.join(tmpRoot, projectId), options.sessionId);
      if (removed > 0) return removed;
    }

    let removed = 0;
    let projects: string[] = [];
    try {
      projects = fs.readdirSync(tmpRoot);
    } catch {
      projects = [];
    }
    for (const project of projects) {
      if (project === projectId) continue;
      removed += removeFromProjectTemp(path.join(tmpRoot, project), options.sessionId);
    }
    return removed;
  } catch {
    return 0;
  }
}
