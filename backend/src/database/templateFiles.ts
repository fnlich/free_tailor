import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import { getStaticTemplatesDir } from '../config/staticPaths';
import type { Template, TemplateSource } from '../types/template';

/**
 * Saved templates, as JSON files beside the built-ins in `static/templates`.
 *
 * Every template an administrator imports, extracts from a PDF or builds in
 * the manual editor is a `<id>.json` file in `getStaticTemplatesDir()` - the
 * same shape as the shipped ones, plus `"source"`. So a template is a file
 * that can be copied to another install, read in a diff and committed to
 * ship it; it used to be a row in the `templates` table that only this
 * database could see.
 *
 * A file WITH a `source` is a saved template: editable and deletable here. A
 * file WITHOUT one is a built-in: read-only, and an administrator's edits to
 * it go to its `template_overrides` row, so a `git pull` that changes the
 * shipped file never conflicts with an edit.
 *
 * Writes are careful because this directory is not a database:
 *  - an id is checked BEFORE any path is built from it (`templateFileId`), so
 *    no id can name a file outside the directory;
 *  - a file is written to a temporary name and renamed over the old one, so a
 *    crash mid-write leaves the old file or the new one, never half of either;
 *  - a built-in's id is refused, so a saved template can never shadow or
 *    overwrite a shipped one;
 *  - the capability flags read off the markup are never written, as they never
 *    were in the table.
 *
 * Synchronous, like the better-sqlite3 calls it replaced: a template file is a
 * few kilobytes, and every caller already expected an answer, not a promise.
 */

export const TEMPLATE_SOURCES: readonly TemplateSource[] = ['uploaded', 'extracted', 'manual'];

export function isTemplateSource(value: unknown): value is TemplateSource {
  return typeof value === 'string' && (TEMPLATE_SOURCES as readonly string[]).includes(value);
}

/**
 * A failure to write or remove a template file. NOT a `PublicError`: its
 * message names a path and an errno, which is for the log and an
 * administrator's `detail`. A route answers it with the generic "Template
 * could not be saved" sentence and a ref.
 */
export class TemplateStoreError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'TemplateStoreError';
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isTemplateStoreError(value: unknown): value is TemplateStoreError {
  return value instanceof TemplateStoreError || (value instanceof Error && value.name === 'TemplateStoreError');
}

/** Lower-case letters, digits and hyphens, starting with a letter or digit: a uuid, `m-1a2b3c4d`, `navy-rule`. */
const TEMPLATE_FILE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * The MS-DOS device names Windows reserves whatever the extension (`con.json`
 * cannot be created there). Refused on every platform, so a templates folder
 * written on Linux can be copied to Windows as it is.
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/**
 * The id as a template file may carry it, or null. Strict: nothing is
 * rewritten, so what is saved is exactly what was asked for.
 *
 * Lower-case only, because the file systems Windows and macOS use by default
 * ignore case: `Resume` and `resume` would be one file there and two here.
 */
export function templateFileId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const stem = id.trim().replace(/\.json$/i, '');
  if (!TEMPLATE_FILE_ID.test(stem) || WINDOWS_RESERVED_NAME.test(stem)) return null;
  return stem;
}

function templatePath(fileId: string): string {
  return path.join(getStaticTemplatesDir(), `${fileId}.json`);
}

type ReadResult = { exists: false } | { exists: true; record: Record<string, unknown> | null };

/** A template file's parsed JSON; `record` is null when it is there but unreadable. */
function readTemplateFileRecord(fileId: string): ReadResult {
  let text: string;
  try {
    text = fs.readFileSync(templatePath(fileId), 'utf8');
  } catch (error) {
    // ENOTDIR too: the templates "directory" is something else, so there is
    // no such file in it - which a write will then say, by name.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false };
    return { exists: true, record: null };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return {
      exists: true,
      record: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null,
    };
  } catch {
    return { exists: true, record: null };
  }
}

/** True when a file of this id exists, saved or built-in, readable or not: the id is taken. */
export function templateFileExists(fileId: string): boolean {
  return readTemplateFileRecord(fileId).exists;
}

/** What is at this id: nothing, a saved template, a built-in, or a file that cannot be read. */
export function templateFileKind(fileId: string): 'none' | 'saved' | 'built-in' | 'unreadable' {
  const read = readTemplateFileRecord(fileId);
  if (!read.exists) return 'none';
  if (!read.record) return 'unreadable';
  return isTemplateSource(read.record.source) ? 'saved' : 'built-in';
}

/** A saved template's file as stored, with its id taken from the file name. Null for a built-in. */
export function readSavedTemplateFile(fileId: string): Template | null {
  const read = readTemplateFileRecord(fileId);
  if (!read.exists || !read.record || !isTemplateSource(read.record.source)) return null;
  return { ...(read.record as unknown as Template), id: fileId };
}

/** Every saved template file. Built-ins, unreadable files and stray names are skipped. */
export function listSavedTemplateFiles(): Template[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(getStaticTemplatesDir());
  } catch {
    return [];
  }
  const saved: Template[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const fileId = templateFileId(entry);
    if (!fileId) continue;
    const template = readSavedTemplateFile(fileId);
    if (template) saved.push(template);
  }
  return saved;
}

/** What goes in the file, in the order the shipped files use, and nothing derived. */
function fileContent(template: Template, fileId: string, source: TemplateSource): string {
  const {
    supportsSoftSkills: _soft,
    supportsStrengths: _strengths,
    isBuiltIn: _builtIn,
    id: _id,
    source: _source,
    name,
    description,
    disabled,
    htmlContent,
    cssContent,
    sections,
    skillsLayouts,
    manualConfig,
    createdAt,
    updatedAt,
    ...rest
  } = template;
  return `${JSON.stringify(
    {
      id: fileId,
      name,
      description,
      source,
      ...(disabled ? { disabled: true } : {}),
      htmlContent,
      cssContent,
      sections,
      ...(skillsLayouts ? { skillsLayouts } : {}),
      ...(manualConfig ? { manualConfig } : {}),
      // Anything a newer build added that this one does not know about, kept
      // rather than dropped by an edit made here.
      ...rest,
      createdAt,
      updatedAt,
    },
    null,
    2
  )}\n`;
}

/** Sleeps without an event loop, for the few milliseconds a rename retry needs. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Renames, retrying briefly on the errors Windows gives while another process
 * (an indexer, an antivirus scan, a reader of the old file) has the target
 * open. Elsewhere those codes mean a real refusal, which the last try reports.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error;
      pause(20 * attempt);
    }
  }
}

/**
 * Writes a saved template's file, replacing it whole. Throws
 * `TemplateStoreError` for an id no file may carry, an id a built-in already
 * has, or a directory that cannot be written - and leaves no temporary file
 * behind in any of those cases.
 */
export function writeTemplateFile(template: Template, source: TemplateSource): string {
  const fileId = templateFileId(template.id);
  if (!fileId) {
    throw new TemplateStoreError(
      `"${String(template.id)}" is not a template id: only lower-case letters, digits and hyphens, up to 100.`
    );
  }
  const existing = readTemplateFileRecord(fileId);
  if (existing.exists && !(existing.record && isTemplateSource(existing.record.source))) {
    throw new TemplateStoreError(
      `A template file "${fileId}.json" that is not a saved template - a built-in, or one that cannot be ` +
        'read - is already in the templates directory; it is never overwritten.'
    );
  }

  const directory = getStaticTemplatesDir();
  const target = templatePath(fileId);
  // Unique per write, so two saves of one template never share a scratch file,
  // and ending in `.tmp` rather than `.json`, so a reader never lists one.
  const scratch = path.join(directory, `${fileId}.json.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  let descriptor: number | null = null;
  try {
    fs.mkdirSync(directory, { recursive: true });
    descriptor = fs.openSync(scratch, 'wx');
    fs.writeSync(descriptor, fileContent(template, fileId, source));
    // On disk before it takes the real name: a rename that lands ahead of the
    // data after a power cut would be the half-written file this avoids.
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    renameWithRetry(scratch, target);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Already closed, or never usable; the unlink below is what matters.
      }
    }
    try {
      fs.unlinkSync(scratch);
    } catch {
      // Never created (a directory that cannot be written), or already renamed.
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new TemplateStoreError(`Could not write the template file ${target}: ${reason}`, { cause: error });
  }
  return fileId;
}

/**
 * Removes a saved template's file. False when there is no such saved template
 * - including a built-in, which is never removed from here.
 */
export function removeSavedTemplateFile(id: string): boolean {
  const fileId = templateFileId(id);
  if (!fileId || !readSavedTemplateFile(fileId)) return false;
  try {
    fs.unlinkSync(templatePath(fileId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    const reason = error instanceof Error ? error.message : String(error);
    throw new TemplateStoreError(`Could not remove the template file ${templatePath(fileId)}: ${reason}`, {
      cause: error,
    });
  }
  return true;
}

/**
 * Whether saved templates can be written, for the startup line beside the
 * database's: `{ dir, writable, reason? }`.
 *
 * Asked by writing and removing a probe file rather than by `access(W_OK)`,
 * which on Windows reads only the read-only attribute and on Linux misses a
 * read-only bind mount's quirks; a real write is the question a save asks.
 */
export function probeTemplatesDirectory(): { dir: string; writable: boolean; reason?: string } {
  const dir = getStaticTemplatesDir();
  const probe = path.join(dir, `.write-probe-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, '', { flag: 'wx' });
    fs.unlinkSync(probe);
    return { dir, writable: true };
  } catch (error) {
    try {
      fs.unlinkSync(probe);
    } catch {
      // Never written.
    }
    return { dir, writable: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A scratch file this module writes: a save's (`<id>.json.<pid>-<hex>.tmp`) or the probe's. */
const SCRATCH_FILE = /^(?:[a-z0-9][a-z0-9-]{0,99}\.json|\.write-probe)[.-]\d+-[0-9a-f]{8}\.tmp$/;

/**
 * Removes scratch files a process left behind by stopping mid-save, once they
 * are old enough that no save still running could own one. Never a `.json`:
 * a scratch file is never read, so all a leftover costs is clutter - and this
 * keeps it from accumulating. Returns how many it removed.
 */
export function sweepTemplateScratchFiles(now = Date.now(), olderThanMs = 10 * 60_000): number {
  const dir = getStaticTemplatesDir();
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!SCRATCH_FILE.test(entry)) continue;
    const file = path.join(dir, entry);
    try {
      if (now - fs.statSync(file).mtimeMs < olderThanMs) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      // Gone already, or not ours to remove; either way, nothing to report.
    }
  }
  return removed;
}

/**
 * The `.json` files in the templates directory that no template id can name -
 * `Company_Brand.json`, `My Template.json` - which are therefore not offered.
 * An older build offered a file copied in by hand under any name; this one
 * offers only `<id>.json`, so such a file would otherwise vanish in silence,
 * and a profile naming it be drawn with `default`.
 */
export function unusableTemplateFileNames(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(getStaticTemplatesDir());
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith('.json') && templateFileId(entry) === null).sort();
}

/** The startup line: where saved templates live, whether a save can work, and any file not offered. */
export function describeTemplatesDirectory(): { level: 'log' | 'warn'; line: string } {
  sweepTemplateScratchFiles();
  const probe = probeTemplatesDirectory();
  const unusable = unusableTemplateFileNames();
  const notOffered =
    unusable.length === 0
      ? ''
      : ` Not offered, because a template file is named <id>.json with an id of lower-case letters, digits ` +
        `and hyphens: ${unusable.join(', ')}. Rename each (Company_Brand.json -> company-brand.json) to offer it.`;
  if (probe.writable) {
    return {
      level: notOffered ? 'warn' : 'log',
      line: `Templates: ${probe.dir} (built-in and saved templates; writable).${notOffered}`,
    };
  }
  return {
    level: 'warn',
    line:
      `Templates: ${probe.dir} is NOT writable (${probe.reason}). Built-in templates still render, but ` +
      'importing, extracting, building, editing or deleting a template will fail until this user can write ' +
      `there.${notOffered}`,
  };
}
