/**
 * What scripts/next.mjs decides about launching Next, and nothing else.
 *
 * next.mjs starts Next the moment it is evaluated, so a test can only read it
 * as text. Every decision it makes therefore lives here, as functions with no
 * side effects - no process, file, environment or console - which
 * backend/test/devServer.test.js imports and runs. next.mjs is left a thin
 * loop: read what these need, run the step they name, do what they say when it
 * ends.
 */

/**
 * The wrapper's modes, as the Next command each one starts. No prototype, so
 * `node scripts/next.mjs constructor` is the usage line, not a crash.
 */
export const MODES = Object.freeze(
  Object.assign(Object.create(null), {
    // `next dev` with no bundler flag is Turbopack in Next 16; webpack is asked for.
    dev: Object.freeze(['dev']),
    'dev-webpack': Object.freeze(['dev', '--webpack']),
    build: Object.freeze(['build']),
    start: Object.freeze(['start']),
  })
);

/**
 * One Next command line: the command, then where a server listens.
 *
 * `next build` takes neither --hostname nor --port, and passing them would
 * fail the command. `next dev` and `next start` are always given both: left
 * out, `--port` defaults to the environment's PORT, which in this repository's
 * shared `.env` is the BACKEND's.
 */
export function nextArgs(command, { hostname, port }) {
  const args = [...command];
  if (args[0] !== 'build') {
    args.push('--hostname', hostname, '--port', port);
  }
  return args;
}

/** Windows' STATUS_ACCESS_VIOLATION: native code touched memory it may not. */
export const ACCESS_VIOLATION = 0xc0000005;

/** Turbopack's `next dev` dying with ACCESS_VIOLATION on Windows, right after "Ready". */
export const TURBOPACK_WINDOWS_CRASH = 'https://github.com/vercel/next.js/issues/95015';

/*
 * The few NTSTATUS codes a crashed Node or Rust process ends with, by name.
 * STACK_BUFFER_OVERRUN is also how a Rust abort (`__fastfail`) ends on
 * Windows, and CONTROL_C_EXIT is a Ctrl-C, not a crash - named so it never
 * reads as one.
 */
const NTSTATUS_NAMES = Object.freeze({
  [ACCESS_VIOLATION]: 'STATUS_ACCESS_VIOLATION',
  0xc000001d: 'STATUS_ILLEGAL_INSTRUCTION',
  0xc00000fd: 'STATUS_STACK_OVERFLOW',
  0xc0000135: 'STATUS_DLL_NOT_FOUND',
  0xc000013a: 'STATUS_CONTROL_C_EXIT',
  0xc0000374: 'STATUS_HEAP_CORRUPTION',
  0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN',
});

/**
 * Names an exit code that is a Windows NTSTATUS error (0xC0000000 and up), or
 * null for any other exit.
 *
 * A process Windows ends for a native fault exits with the fault's NTSTATUS,
 * a 32-bit value, and Node hands it on in two spellings:
 *
 * - UNSIGNED, 3221225477 for 0xC0000005, is what Node itself reports. libuv
 *   reads the code with GetExitCodeProcess into a DWORD and widens it to its
 *   int64 `exit_status` (src/win/process.c, `exit_code = status`), and Node's
 *   ProcessWrap::OnExit makes a double of that - so a child's 'exit' event,
 *   and therefore concurrently's "exited with code 3221225477" in the owner's
 *   log, is always the unsigned one.
 * - SIGNED, -1073741819, is the same 32 bits read as an int: what cmd's
 *   %ERRORLEVEL% and PowerShell's $LASTEXITCODE print, and what anything that
 *   keeps the code in an int32 hands on. Node's own process.exit(3221225477)
 *   passes through int32 (ReallyExit's Int32Value) on its way to the OS, which
 *   is why the code survives being passed up through `next dev`, this wrapper
 *   and npm: Windows reads the int back as the same DWORD.
 *
 * Both are accepted. 0xFFFFFFFF is left out: it is what `exit(-1)` produces,
 * a program choosing to fail, not a fault.
 */
export function describeNativeExit(code) {
  if (!Number.isInteger(code) || code < -0x80000000 || code > 0xffffffff) {
    return null;
  }
  const status = code >>> 0;
  if (status < 0xc0000000 || status === 0xffffffff) {
    return null;
  }
  const hex = `0x${status.toString(16).toUpperCase().padStart(8, '0')}`;
  const name = NTSTATUS_NAMES[status] ?? null;
  return {
    status,
    hex,
    name,
    label: name ? `${hex} ${name}` : `${hex}, a Windows NTSTATUS error`,
  };
}

/**
 * The steps that replace a Turbopack dev server Windows ended with
 * ACCESS_VIOLATION, or null when the ending is not that.
 *
 * Only `dev` (Turbopack), only on Windows, only that code and only once:
 * webpack's dev server (`dev-webpack`), `build` and `start` are not the
 * crash, a code from any other platform cannot be it, and the production-style
 * server's own ending is passed through like any other. A signal - Ctrl-C, a
 * kill - is never a reason to start anything.
 *
 * The replacement is the production-style server: `next build --webpack`,
 * then `next start` on the same host and port. webpack, because Turbopack has
 * just crashed natively on this machine; the production server, because
 * webpack's dev server reloads every other open tab when a new one connects,
 * which stops a Generate Immediately run going in it (test/e2e/dev-reload.js).
 */
export function fallbackSteps({ mode, platform, code, signal, alreadyFellBack, address }) {
  if (mode !== 'dev' || platform !== 'win32' || alreadyFellBack || signal != null) {
    return null;
  }
  if (describeNativeExit(code)?.status !== ACCESS_VIOLATION) {
    return null;
  }
  return [nextArgs(['build', '--webpack'], address), nextArgs(['start'], address)];
}

/**
 * What the wrapper does when the Next it started has ended.
 *
 * `state` is `{ mode, platform, address, fellBack, pending }`, `pending` the
 * steps still to run after this one; `ended` is `{ args, code, signal }` as
 * the child's 'exit' event gave them. The answer is either
 * `{ run, state, crash }` - start `run`, with `crash` (describeNativeExit's)
 * set when this is the fallback starting - or `{ end: true, note }`: end as
 * the child ended, after printing `note` when there is one.
 *
 * A step of the fallback goes on to the next only when it exited 0 with no
 * signal, so a build that failed ends the wrapper with the build's own code,
 * and a Ctrl-C during the build ends it rather than starting the server.
 */
export function afterExit(state, ended) {
  const { code, signal, args = [] } = ended;
  const succeeded = signal == null && code === 0;

  if (succeeded && state.pending.length > 0) {
    const [run, ...pending] = state.pending;
    return { run, state: { ...state, pending }, crash: null };
  }

  const steps = fallbackSteps({
    mode: state.mode,
    platform: state.platform,
    code,
    signal,
    alreadyFellBack: state.fellBack,
    address: state.address,
  });
  if (steps) {
    const [run, ...pending] = steps;
    return { run, state: { ...state, fellBack: true, pending }, crash: describeNativeExit(code) };
  }

  let note = null;
  if (state.fellBack && args[0] === 'build' && !succeeded && signal == null) {
    const native = describeNativeExit(code);
    note =
      `[next] The production-style build ended with exit code ${code}` +
      `${native ? ` (${native.label})` : ''}, so the server was not started.\n` +
      (native
        ? '[next] Windows ended the build natively too, so it printed nothing; '
        : "[next] The build's own output above says why; ") +
      "npm run dev:live from the repository root (webpack's dev server) is the other way " +
      'to run the frontend.';
  }
  return { end: true, note };
}

/**
 * The one explanation printed when the fallback starts: what the code is, the
 * upstream issue, the Next that crashed, what happens now and what to run
 * instead next time.
 */
export function fallbackExplanation({ code, crash, installed, address }) {
  const next = typeof installed === 'string' && installed ? `Next.js ${installed}` : 'Next.js';
  return [
    '',
    `[next] Turbopack's dev server stopped with exit code ${code}, ${crash.label}.`,
    `[next]   Native code in ${next} touched memory it may not, and Windows ended the`,
    '[next]   process before Node could print anything. This is Turbopack crashing on Windows,',
    `[next]   ${TURBOPACK_WINDOWS_CRASH}`,
    `[next] Building and starting the production-style server on port ${address.port} instead,`,
    '[next]   once: next build --webpack, then next start. The page will NOT hot-reload -',
    // Every command here is the ROOT package's: the fallback fires the same
    // way under `cd frontend && npm run dev:turbo`, where dev:backend does not
    // exist and `--prefix frontend` would look for frontend/frontend.
    '[next]   stop and run npm run dev again (from the repository root) to see a change to the frontend.',
    "[next] To choose for yourself, from the repository root: npm run dev:live (the backend with webpack's dev server,",
    '[next]   which hot-reloads but may reload other open tabs), or npm run dev:backend beside',
    '[next]   npm run dev --prefix frontend (the production-style server, built by Turbopack).',
    '',
  ].join('\n');
}

/*
 * An exact version as npm writes one into package.json - `16.3.8`, or a
 * prerelease such as `16.3.0-canary.49` - optionally after `=` or `v`. A
 * range, a tag, an alias or a path is not one.
 */
const EXACT_VERSION = /^(?:=|v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/**
 * The warning printed when the Next installed is not the one frontend/package.json
 * pins, or null.
 *
 * Only an EXACT pin is compared: a range or a tag says any of several versions
 * will do, and missing or unreadable data says nothing. Never throws - this
 * runs before every launch, and a check of the install must not stop one.
 *
 * It exists because the owner's Windows log said `Next.js 16.3.5` while the
 * repository pinned another release: Next had been moved by hand on that
 * machine, and nothing said so before its dev server crashed.
 */
export function installedVersionProblem(installed, pinned) {
  if (typeof installed !== 'string' || typeof pinned !== 'string') {
    return null;
  }
  const exact = EXACT_VERSION.exec(pinned.trim());
  const have = installed.trim();
  if (!exact || !have || exact[1] === have) {
    return null;
  }
  return (
    `[next] Next.js ${have} is installed, but frontend/package.json pins ${exact[1]}. ` +
    'Run npm run install:all.'
  );
}
