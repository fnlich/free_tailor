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
};

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
 * terminal and gets pasted into issues and chat windows, and one of these values
 * is an API key.
 *
 * Duplicates are counted from the text rather than taken from `dotenv.parse`,
 * which collapses them silently - so the one failure a parsed object cannot
 * express is the one this exists to show.
 */
export function summarizeEnvFile(filePath: string): EnvFileSummary {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return { path: filePath, exists: false, bytes: 0, encoding: 'absent', keys: [], duplicates: [] };
  }

  const keys: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const line of readEnvFileText(filePath).split(/\r?\n/)) {
    // The same shape dotenv accepts: an optional `export`, a name, then `=`.
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) duplicates.add(name);
    else keys.push(name);
    seen.add(name);
  }

  return {
    path: filePath,
    exists: true,
    bytes: buffer.length,
    encoding: detectEncoding(buffer),
    keys,
    duplicates: [...duplicates],
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
