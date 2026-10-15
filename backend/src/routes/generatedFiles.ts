import path from 'path';
import type { Request, Response } from 'express';
import { ownersOfGeneratedFile } from '../database/orderRepository';
import { resolveGeneratedFile } from '../utils/generatedPath';

/**
 * The download route's one question: may this account have the file at this
 * path? Answered with the file to send, or null for 404.
 *
 * `/api/generated/:filename(*)` (index.ts, below) takes a path out of the URL.
 * Whose file it is is decided on the path as the server will OPEN it
 * (`resolveGeneratedFile`), never on the parameter as typed - `a//b`, `./a/b`
 * and `x/../a/b` open the same file as `a/b`, and the raw string only ever
 * matched one of them. The file must be the asker's and nobody else's
 * (`ownersOfGeneratedFile`: a run of theirs recorded it, or it sits in one of
 * their runs' folders): any other account's claim answers 404 - not 403, for
 * the same reason the order routes use it - an administrator's request
 * included. So does a file NOBODY claims: every resume is filed by a queued
 * run now, which records its folder, so a file no run claims is a run's
 * placed before folders were recorded that its item never recorded either
 * (the partial PDF of a build that failed) or something put there by hand -
 * served to every builder, either could be anybody's. (The synchronous
 * `POST /api/resume/generate`, whose builds were nobody's, is gone.)
 */
async function generatedFileFor(viewerId: string, requested: string): Promise<string | null> {
  const file = await resolveGeneratedFile(requested);
  if (!file) return null;
  const owners = ownersOfGeneratedFile(file.spellings, file.absolutes);
  if (!owners.includes(viewerId) || owners.some((owner) => owner !== viewerId)) return null;
  return file.absolute;
}

/**
 * GET /api/generated/:filename(*), mounted by index.ts behind `requireUser` (a
 * user or an administrator, never a reporter). Here rather than inline there so
 * a test mounts this handler and not a copy of it.
 */
export async function downloadGeneratedFile(req: Request, res: Response): Promise<void> {
  try {
    // Express 4 exposes `:filename(*)` as `params.filename`; the bracketed key
    // is Express 5's shape. Reading the wrong one made this route answer 404
    // for every path.
    const params = req.params as Record<string, string | undefined>;
    const filepath = await generatedFileFor(req.user!.id, params.filename ?? '');
    if (!filepath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.download(filepath, path.basename(filepath));
  } catch {
    res.status(500).json({ error: 'Failed to download file' });
  }
}
