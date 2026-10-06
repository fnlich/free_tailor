import path from 'path';
import type { Request, Response } from 'express';
import { ownersOfGeneratedFile } from '../database/orderRepository';
import { resolveGeneratedFile } from '../utils/generatedPath';

/**
 * The two older download routes' one question: may this account have the file
 * at this path? Answered with the file to send, or null for 404.
 *
 * `/api/generated/:filename(*)` (index.ts, below) and
 * `/api/resume/download/:filename(*)` (routes/resume.ts) both take a path out of
 * the URL. Whose file it is is decided on the path as the server will OPEN it
 * (`resolveGeneratedFile`), never on the parameter as typed - `a//b`, `./a/b`
 * and `x/../a/b` open the same file as `a/b`, and the raw string only ever
 * matched one of them. A file any OTHER account owns
 * (`ownersOfGeneratedFile`: an order or a Generate Immediately run recorded it,
 * or it sits in that run's folder) answers 404 - not 403, for the same reason
 * the order routes use it - an administrator's request included, as it always
 * has. A path nothing claims is a resume built by the older synchronous
 * `POST /api/resume/generate`, under the administrator's template, and is
 * served to any builder exactly as before; narrowing those is a separate change
 * with a separate blast radius.
 */
export async function generatedFileFor(viewerId: string, requested: string): Promise<string | null> {
  const file = await resolveGeneratedFile(requested);
  if (!file) return null;
  if (ownersOfGeneratedFile(file.spellings).some((owner) => owner !== viewerId)) return null;
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
