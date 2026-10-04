import dotenv from 'dotenv';
import fs from 'fs';

/**
 * Reads a `.env` as text, whatever encoding Windows wrote it in.
 *
 * PowerShell 5.1 - still the default `powershell.exe` on Windows 10 and 11 -
 * writes UTF-16LE from both `>` and `Set-Content`. Handed such a file, dotenv
 * returns an empty object and this app silently runs on defaults: no error, no
 * warning, and a `.env` that visibly exists but does nothing. Measured: the
 * same two-variable file yields both variables as UTF-8 and `{}` as UTF-16LE.
 *
 * A UTF-8 BOM happens to survive dotenv already (`String.trim` treats U+FEFF
 * as whitespace), but it is stripped here so the first key is never a surprise.
 *
 * frontend/scripts/next.mjs decodes the same file for the frontend half and
 * must agree with this; change the two together.
 *
 * Kept in its own module so it can be tested without the import side effect of
 * config/env.ts, which loads the real `.env` into process.env on import.
 */
export type EnvFileSummary = {
  path: string;
  exists: boolean;
  bytes: number;
  encoding: 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'absent';
  /** Assignment names, in file order. NAMES ONLY - never the values. */
  keys: string[];
  /** Names assigned more than once. `dotenv.parse` keeps the LAST and cannot show this. */
  duplicates: string[];
  /**
   * Names whose value, as the loader will actually see it, is empty.
   *
   * `.env.example` ships dozens of bare `NAME=` lines, so a file copied from it
   * lists every one of those names in `keys` while setting none of them. A
   * doctor that reports `keys` alone says "GOOGLE_CREDENTIALS_PATH found" about
   * a variable that is not in effect - the very confusion it exists to end.
   * Taken from `dotenv.parse`, so the last assignment wins and quoting and
   * comments are read exactly as the loader reads them. NAMES ONLY, as above.
   */
  empty: string[];
  /**
   * Names the file sets that the ENVIRONMENT overrides: set there too, to a
   * different value. The environment wins (config/env.ts), so for these the
   * file's line is not what is in effect. NAMES ONLY, as above.
   */
  shadowed: string[];
};

/**
 * Copies a parsed `.env` into `env`, leaving every name `env` already has.
 *
 * The environment wins: a name already present keeps its value, and that
 * includes one exported EMPTY, which counts as set - the same rule as
 * frontend/scripts/next.mjs's `key in process.env`, so the two halves cannot
 * disagree about a variable. Returns the names it applied, and the names it
 * left because the environment holds a DIFFERENT value (one holding the same
 * value is not news). Names only, never values.
 */
export function applyEnvFile(
  parsed: Record<string, string>,
  env: NodeJS.ProcessEnv
): { applied: string[]; shadowed: string[] } {
  const applied: string[] = [];
  const shadowed: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      if (env[key] !== value) shadowed.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { applied, shadowed };
}

/**
 * The startup line for names set both in the environment and in the file, or
 * null when there are none.
 *
 * It takes NAMES and nothing else, so it cannot print a value: the line goes to
 * a terminal and a log, and one of these is a key. frontend/scripts/next.mjs,
 * which cannot import this, prints the same sentence - change the two together.
 */
export function describeShadowed(names: string[], envPath: string): string | null {
  if (names.length === 0) return null;
  return (
    `[env] ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} set both in the environment and in ` +
    `${envPath}; the environment's value is used.`
  );
}

/** Names `parsed` sets that `env` holds a different value for. */
function shadowedNames(parsed: Record<string, string>, env: NodeJS.ProcessEnv): string[] {
  return Object.entries(parsed)
    .filter(([key, value]) => Object.prototype.hasOwnProperty.call(env, key) && env[key] !== value)
    .map(([key]) => key);
}

/** The encoding `readEnvFileText` would decode this file as. */
function detectEncoding(buffer: Buffer): EnvFileSummary['encoding'] {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf16be';
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf8-bom';
  }
  return 'utf8';
}

/**
 * What is actually in the `.env`, for a tool that has to say why it is not working.
 *
 * "SMTP_HOST is not set" against a file that visibly contains it has four causes
 * that look identical from the outside: the loader read a DIFFERENT file (the path
 * resolves from the compiled module, so it is always the repo root, never
 * `backend/`), a later duplicate key won, the encoding did not decode, or the edit
 * was never saved. Reporting the path, the encoding and the key names separates
 * them in one line of output.
 *
 * NAMES ONLY, and that is a hard rule rather than tidiness: this prints to a
 * terminal and gets pasted into issues and chat threads, and one of these values
 * is an API key.
 *
 * Duplicates are counted from the text rather than taken from `dotenv.parse`,
 * which collapses them silently - so the one failure a parsed object cannot
 * express is the one this exists to show.
 */
export function summarizeEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): EnvFileSummary {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return {
      path: filePath,
      exists: false,
      bytes: 0,
      encoding: 'absent',
      keys: [],
      duplicates: [],
      empty: [],
      shadowed: [],
    };
  }

  const text = readEnvFileText(filePath);
  const keys: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    // The same shape dotenv accepts: an optional `export`, a name, then `=`.
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) duplicates.add(name);
    else keys.push(name);
    seen.add(name);
  }

  const parsed = dotenv.parse(text);
  return {
    path: filePath,
    exists: true,
    bytes: buffer.length,
    encoding: detectEncoding(buffer),
    keys,
    duplicates: [...duplicates],
    empty: Object.entries(parsed)
      .filter(([, value]) => value.trim() === '')
      .map(([name]) => name),
    // Read against the environment as it is NOW, after config/env.ts loaded
    // the file: a name it applied holds the file's value and is not listed, and
    // one the environment kept still differs from the file and is.
    shadowed: shadowedNames(parsed, env),
  };
}

export function readEnvFileText(filePath: string): string {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return '';
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  // UTF-16BE: Node has no decoder for it, so swap the byte pairs to LE first.
  // Buffer.from copies, because swap16 mutates in place.
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}
