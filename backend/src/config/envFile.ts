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
