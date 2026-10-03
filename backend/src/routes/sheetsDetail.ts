import type { Request } from 'express';

import { GoogleSheetsRequestError } from '../integrations/googleSheets';
import { isAdmin } from '../middleware/auth';

/**
 * The operator half of a Google failure, for any route that reports one.
 *
 * `GoogleSheetsRequestError` keeps what names a command, a file on the
 * server's disk or an environment variable in `detail`, so an account holder's
 * page never shows it - and promises that a route decides who does see it,
 * and that the log always does. Only `routes/sheet.ts` kept that promise: the
 * import, jobs, bid assistant and admin routes sent `message` alone and logged
 * nothing, so once a refusal's specifics moved into `detail` they reached
 * nobody at all - not even the administrator on an admin-only route.
 *
 * Spread into the JSON body: `{ error: message, ...sheetsOperatorDetail(req, error) }`.
 */
export function sheetsOperatorDetail(req: Request, error: unknown): { detail?: string } {
  if (!(error instanceof GoogleSheetsRequestError) || !error.detail) return {};
  console.error(`[sheets] ${error.message} ${error.detail}`);
  return isAdmin(req) ? { detail: error.detail } : {};
}
