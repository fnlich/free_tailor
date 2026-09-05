import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The process seam.
 *
 * This is the ONLY module under services/ai that imports `child_process`.
 * Everything above it takes a `CliRunner`, so the provider - argv building,
 * event reduction, error classification, outage bookkeeping - is tested by
 * handing it a fake runner that replays recorded NDJSON, with no binary, no
 * network and no subprocess anywhere in the suite.
 */

export type CliRunSpec = {
  binary: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The prompt. Written to stdin, never placed in argv. */
  stdin: string;
  /** Total wall-clock budget for the whole turn. */
  deadlineMs: number;
  /** How long the turn may produce NO output at all before it is wedged. */
  firstEventMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Called once per complete NDJSON line, in order. */
  onLine: (line: string) => void;
};

export type CliRunOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Last non-empty line of stderr; the CLI puts its diagnosis there. */
  stderrTail: string;
  timedOut: boolean;
  /** No output at all arrived within `firstEventMs`. */
  stalled: boolean;
  aborted: boolean;
  spawnError: NodeJS.ErrnoException | null;
  bytesRead: number;
};

export interface CliRunner {
  run(spec: CliRunSpec): Promise<CliRunOutcome>;
}

/**
 * Splits a byte stream into NDJSON lines.
 *
 * Deliberately NOT `readline`: its stream-reader limit (64 KB by default)
 * silently breaks on the CLI's final `result` event, which repeats the entire
 * answer, so one long completion puts a single line over the cap. Sizing the
 * limit up only moves the cliff; buffering by hand removes it. Splitting on
 * the Buffer rather than a decoded string also keeps a multi-byte character
 * that straddles a chunk boundary intact.
 */
export class NdjsonSplitter {
  private buffer: Buffer = Buffer.alloc(0);
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get bytesRead(): number {
    return this.bytes;
  }

  /** Feeds a chunk and returns the complete lines it produced. */
  push(chunk: Buffer): string[] {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      throw new Error(
        `Claude CLI produced more than ${this.maxBytes} bytes of output; aborting to protect memory`
      );
    }

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = this.buffer.indexOf(0x0a, start);
      if (newline < 0) {
        break;
      }
      lines.push(this.buffer.subarray(start, newline).toString('utf8'));
      start = newline + 1;
    }

    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);
    return lines;
  }

  /**
   * The trailing partial line at end of stream. A child killed mid-event
   * leaves one behind, and it can still be a complete JSON object.
   */
  flush(): string | null {
    if (this.buffer.length === 0) {
      return null;
    }
    const rest = this.buffer.toString('utf8');
    this.buffer = Buffer.alloc(0);
    return rest.trim() ? rest : null;
  }
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

export function createSpawnRunner(): CliRunner {
  return {
    run(spec: CliRunSpec): Promise<CliRunOutcome> {
      return new Promise<CliRunOutcome>((resolve) => {
        // stderr goes to a FILE, not a pipe. A pipe is only drained after
        // stdout closes, so a child that fills the stderr buffer first blocks
        // on the write while this side blocks on the read - the classic
        // two-pipe deadlock. Nothing about the CLI promises small stderr.
        const errPath = path.join(
          os.tmpdir(),
          `claude-cli-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.err`
        );
        let errFd: number | null = null;
        try {
          errFd = fs.openSync(errPath, 'w+');
        } catch {
          errFd = null;
        }

        const splitter = new NdjsonSplitter(spec.maxOutputBytes);
        let settled = false;
        let timedOut = false;
        let stalled = false;
        let aborted = false;
        let sawOutput = false;
        let deadlineTimer: NodeJS.Timeout | undefined;
        let stallTimer: NodeJS.Timeout | undefined;

        const child = spawn(spec.binary, [...spec.argv], {
          cwd: spec.cwd,
          env: spec.env,
          stdio: ['pipe', 'pipe', errFd ?? 'ignore'],
        });

        const readStderr = (): string => {
          if (errFd === null) return '';
          try {
            const size = fs.fstatSync(errFd).size;
            if (size <= 0) return '';
            const cap = Math.min(size, 64 * 1024);
            const buffer = Buffer.alloc(cap);
            fs.readSync(errFd, buffer, 0, cap, Math.max(0, size - cap));
            return lastLine(buffer.toString('utf8'));
          } catch {
            return '';
          }
        };

        const cleanup = (): void => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          if (stallTimer) clearTimeout(stallTimer);
          spec.signal?.removeEventListener('abort', onAbort);
          if (errFd !== null) {
            try {
              fs.closeSync(errFd);
            } catch {
              /* already closed */
            }
          }
          try {
            fs.unlinkSync(errPath);
          } catch {
            /* never created, or already gone */
          }
        };

        const finish = (outcome: Omit<CliRunOutcome, 'stderrTail' | 'bytesRead'>): void => {
          if (settled) return;
          settled = true;
          const stderrTail = readStderr();
          cleanup();
          resolve({ ...outcome, stderrTail, bytesRead: splitter.bytesRead });
        };

        /** SIGTERM, then SIGKILL if it does not go. Never left unreaped. */
        const kill = (): void => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            child.kill('SIGTERM');
          } catch {
            return;
          }
          // Deliberately NOT unref'd: this timer is the only thing that
          // guarantees a child ignoring SIGTERM is actually killed, and it
          // lives for at most five seconds.
          const hard = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }, 5_000);
          child.once('exit', () => clearTimeout(hard));
        };

        function onAbort(): void {
          aborted = true;
          kill();
          finish({ exitCode: null, signal: null, timedOut: false, stalled: false, aborted: true, spawnError: null });
        }

        if (spec.signal) {
          if (spec.signal.aborted) {
            onAbort();
            return;
          }
          spec.signal.addEventListener('abort', onAbort, { once: true });
        }

        deadlineTimer = setTimeout(() => {
          timedOut = true;
          kill();
          finish({ exitCode: null, signal: null, timedOut: true, stalled: false, aborted: false, spawnError: null });
        }, Math.max(1, spec.deadlineMs));
        deadlineTimer.unref?.();

        // Armed until the FIRST byte only. The CLI emits `system/init` before
        // it has so much as called the model, so on a working turn something
        // arrives in well under a second. At the subscription's usage limit,
        // by contrast, the process blocks silently and forever rather than
        // failing - which without this timer burns the whole request budget
        // and leaves nothing in the log to explain it. Once output has
        // started, a pause is the model thinking and the deadline is the
        // right clock for that.
        stallTimer = setTimeout(() => {
          if (sawOutput) return;
          stalled = true;
          kill();
          finish({ exitCode: null, signal: null, timedOut: false, stalled: true, aborted: false, spawnError: null });
        }, Math.max(1, spec.firstEventMs));
        stallTimer.unref?.();

        child.on('error', (error: NodeJS.ErrnoException) => {
          finish({
            exitCode: null,
            signal: null,
            timedOut: false,
            stalled: false,
            aborted: false,
            spawnError: error,
          });
        });

        child.stdout?.on('data', (chunk: Buffer) => {
          if (settled) {
            return;
          }
          sawOutput = true;
          if (stallTimer) clearTimeout(stallTimer);
          try {
            for (const line of splitter.push(chunk)) {
              spec.onLine(line);
            }
          } catch (error) {
            kill();
            finish({
              exitCode: null,
              signal: null,
              timedOut: false,
              stalled: false,
              aborted: false,
              spawnError: error as NodeJS.ErrnoException,
            });
          }
        });

        child.stdout?.on('error', () => {
          /* the child may exit while a read is in flight */
        });

        // The prompt goes on STDIN, not in argv, and both halves matter.
        // A rendered tailor-resume prompt is tens of kilobytes of template
        // plus full profile and job-analysis JSON, which has no business
        // anywhere near the per-argument exec limit; and leaving stdin open
        // makes the CLI wait several seconds for input it is never given.
        child.stdin?.on('error', () => {
          /* the child may exit before the write lands */
        });
        try {
          child.stdin?.end(spec.stdin, 'utf8');
        } catch {
          /* handled by the error listener above */
        }

        child.on('close', (code, signalName) => {
          const trailing = settled ? null : splitter.flush();
          if (trailing) {
            try {
              spec.onLine(trailing);
            } catch {
              /* a malformed trailing line is not a crash */
            }
          }
          finish({
            exitCode: code,
            signal: signalName,
            timedOut,
            stalled,
            aborted,
            spawnError: null,
          });
        });
      });
    },
  };
}

/**
 * A warm process pool was considered and rejected. `--input-format stream-json`
 * can keep one child alive across many prompts and saves the node boot, but the
 * conversation accumulates: a second turn can see the first turn's content, and
 * input tokens grow with every turn. In this app that would mean one profile's
 * job description reaching another profile's resume - a correctness and privacy
 * defect that a few hundred milliseconds of saved boot cannot buy.
 */
export const WARM_POOL_REJECTED = true;

export function ensureCliWorkdir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
