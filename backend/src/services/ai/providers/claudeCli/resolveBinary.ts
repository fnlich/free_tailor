import fs from 'fs';
import path from 'path';

/**
 * Turns a configured binary name into something `spawn` can actually execute,
 * on Windows as well as POSIX.
 *
 * WHY THIS EXISTS. npm installs `claude` on Windows as a `claude.cmd` shim, and
 * Node's `spawn` cannot execute a `.cmd` without a shell - it fails with
 * ENOENT, which is what "The Claude CLI is not installed or is not on the
 * server PATH" was really reporting on a machine where the CLI was installed
 * and on PATH.
 *
 * `shell: true` would make it run and is the wrong fix: arguments are then
 * concatenated into a command line rather than escaped, and this provider puts
 * a prompt's instruction block on the command line via `--system-prompt`. That
 * text is admin-editable, so a shell there is a command-injection hole. Node
 * deprecated the combination (DEP0190) for the same reason.
 *
 * So instead of reaching for a shell, resolve the shim to something that needs
 * none:
 *
 *   - a real executable (`claude.exe`, or any POSIX binary) is spawned directly;
 *   - an npm `.cmd`/`.ps1` shim is a wrapper around a Node script, so the
 *     script is found and run under this same Node.
 *
 * Both paths keep Node's own argument handling, which quotes correctly.
 */

export type CliExecPlan = {
  /** The program to spawn. */
  command: string;
  /** Arguments that must precede the CLI's own, e.g. the script path. */
  prefixArgs: string[];
  /** How it was resolved, for diagnostics. */
  kind: 'direct' | 'windows-exe' | 'node-script';
  /** What was resolved, for the error message when a later spawn fails. */
  resolvedFrom: string;
};

export type ResolveDeps = {
  platform: NodeJS.Platform;
  /** PATH, already split by the platform's delimiter. */
  pathEntries: string[];
  /** PATHEXT entries, upper-case with leading dots. Windows only. */
  pathExt: string[];
  exists: (filePath: string) => boolean;
  readFile: (filePath: string) => string;
  /** This Node, used to run a shim's underlying script. */
  execPath: string;
};

export function defaultResolveDeps(): ResolveDeps {
  const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);

  return {
    platform: process.platform,
    pathEntries: (process.env.PATH || '').split(path.delimiter).filter(Boolean),
    pathExt,
    exists: (filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    },
    readFile: (filePath) => {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        return '';
      }
    },
    execPath: process.execPath,
  };
}

/**
 * Path semantics follow the DECLARED platform, not the host's.
 *
 * The function already takes `platform` as an input; using the host's `path`
 * would make it silently disagree with that input, and would make the Windows
 * behaviour untestable anywhere but Windows.
 */
function pathFor(deps: ResolveDeps): path.PlatformPath {
  return deps.platform === 'win32' ? path.win32 : path.posix;
}

/** Every candidate file `binary` could name, in PATHEXT preference order. */
function candidatePaths(binary: string, deps: ResolveDeps): string[] {
  const p = pathFor(deps);
  const isWindows = deps.platform === 'win32';
  const hasDirectory = binary.includes('/') || binary.includes('\\');
  const bases = hasDirectory ? [binary] : deps.pathEntries.map((entry) => p.join(entry, binary));

  if (!isWindows) {
    return bases;
  }

  const out: string[] = [];
  for (const base of bases) {
    // An explicit extension is honoured as written.
    if (p.extname(base)) {
      out.push(base);
      continue;
    }
    for (const ext of deps.pathExt) {
      out.push(base + ext.toLowerCase());
      out.push(base + ext);
    }
    // Some installs drop an extensionless script next to the shims.
    out.push(base);
  }
  return out;
}

/**
 * The Node script an npm shim wraps.
 *
 * npm's `.cmd` template ends with the interpreter and the script path relative
 * to the shim: `"%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*`. The `.ps1` and
 * POSIX shims carry the same path against `$basedir`. Reading it back is far
 * more reliable than guessing the package layout, and if it is not there we
 * simply do not use this path.
 */
function scriptBehindShim(shimPath: string, deps: ResolveDeps): string | null {
  const text = deps.readFile(shimPath);
  if (!text) {
    return null;
  }

  const p = pathFor(deps);
  const shimDir = p.dirname(shimPath);
  const seen = new Set<string>();

  for (const match of text.matchAll(/(?:%dp0%|\$basedir|%~dp0)[\\/]?([^"'\s]+?\.[cm]?js)/g)) {
    const relative = match[1].split(/[\\/]/).join(p.sep);
    const candidate = p.resolve(shimDir, relative);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (deps.exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export class CliBinaryUnresolvableError extends Error {
  constructor(
    readonly binary: string,
    readonly reason: string
  ) {
    super(reason);
    this.name = 'CliBinaryUnresolvableError';
  }
}

/**
 * Successful Windows resolutions, keyed on everything that could change one.
 *
 * The search is a synchronous PATH scan: PATHEXT variants times PATH entries,
 * which on a normal Windows box is several hundred `statSync` calls. Doing
 * that on every completion would block the event loop for every concurrent
 * request, and the answer is the same every time. Only successes are cached -
 * a failure is re-scanned so that installing the CLI and re-checking health
 * does not require a restart - and a cached entry is confirmed with a single
 * stat, so an uninstall is noticed rather than spawned into.
 */
const planCache = new Map<string, CliExecPlan>();

function cacheKey(binary: string, deps: ResolveDeps): string {
  return [binary, deps.execPath, deps.pathExt.join(';'), deps.pathEntries.join(';')].join('\u0000');
}

/** Exposed for tests; nothing in the running server needs to call it. */
export function clearCliExecPlanCache(): void {
  planCache.clear();
}

export function resolveCliExecPlan(binary: string, deps: ResolveDeps = defaultResolveDeps()): CliExecPlan {
  // On POSIX, spawn resolves PATH itself and executes scripts by shebang, so
  // there is nothing to do. Keeping this branch trivial also keeps the
  // behaviour that has been running in production unchanged.
  if (deps.platform !== 'win32') {
    return { command: binary, prefixArgs: [], kind: 'direct', resolvedFrom: binary };
  }

  const key = cacheKey(binary, deps);
  const cached = planCache.get(key);
  if (cached) {
    if (deps.exists(cached.resolvedFrom)) {
      return cached;
    }
    planCache.delete(key);
  }

  const candidates = candidatePaths(binary, deps);
  const found = candidates.find(deps.exists);

  if (!found) {
    throw new CliBinaryUnresolvableError(
      binary,
      `No "${binary}" found on PATH (looked for ${deps.pathExt.join(', ')} variants).`
    );
  }

  const extension = pathFor(deps).extname(found).toLowerCase();

  // A real executable: spawn it, and let Node quote the arguments.
  if (extension === '.exe' || extension === '.com') {
    return remember(key, { command: found, prefixArgs: [], kind: 'windows-exe', resolvedFrom: found });
  }

  // A .js entry point named directly.
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    return remember(key, { command: deps.execPath, prefixArgs: [found], kind: 'node-script', resolvedFrom: found });
  }

  // A .cmd/.bat/.ps1 shim: run what it wraps, so no shell is involved.
  const script = scriptBehindShim(found, deps);
  if (script) {
    return remember(key, { command: deps.execPath, prefixArgs: [script], kind: 'node-script', resolvedFrom: found });
  }

  // Deliberately NOT falling back to cmd.exe. Doing so would put an
  // admin-editable system prompt on a command line that cmd re-parses, and an
  // actionable error is better than a quiet injection surface.
  throw new CliBinaryUnresolvableError(
    binary,
    `Found "${found}", but it is a shim this server cannot run safely and the script it wraps could not be located. ` +
      'Set AI_CLI_BIN to the claude executable (claude.exe) or to the CLI\'s cli.js.'
  );
}

function remember(key: string, plan: CliExecPlan): CliExecPlan {
  planCache.set(key, plan);
  return plan;
}
