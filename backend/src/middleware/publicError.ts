import { randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

import { isAIProviderError, type AIProviderError } from '../services/ai/errors';

/**
 * What anybody may read about a failure, and what only an administrator may.
 *
 * THE RULE. Most people using Tailor do not run the server it is on, and every
 * response body used to be written as though they did: a signed-out seat told
 * them to run `claude auth login`, a Google refusal handed them the Cloud
 * project id and the path of the credential file, a body-parser error quoted
 * the JSON it choked on, and the generic handler sent whatever `err.message`
 * happened to be - a SQLite constraint, an `EACCES` with a directory in it. A
 * sentence about the server is only useful to whoever can change the server.
 *
 * So a response says one of two kinds of thing:
 *
 * - a SPECIFIC sentence, only when it is about something the caller sent or
 *   owns, they can act on it without server access, and it names nothing
 *   about how the installation is run. Those errors are `PublicError`s - the
 *   class is the promise that the message was written for anybody;
 * - otherwise a GENERIC one - "<what failed>. Please try again, or contact your
 *   administrator." - with a `ref` such as `ERR-7F3A9C`, and the real cause
 *   logged once under that ref, so the person can quote it and the operator
 *   can find it.
 *
 * An administrator additionally gets `detail`: the real cause, in the body.
 * The server knows the role, so no page has to - a page renders `detail` when
 * it is there and the omission is the control.
 *
 * Body shape, for every refusal that comes through here:
 * `{ error, code?, ref?, detail? (administrators only), ...extra }`.
 */

export type PublicErrorOptions = {
  /** The HTTP status. 400 unless said otherwise: most public errors are the request's. */
  status?: number;
  /** A machine-readable reason, so a page can branch without reading English. */
  code?: string;
  /** Fields sent beside the message - `needed` and `balance`, a plan `limit`. */
  extra?: Record<string, unknown>;
  /**
   * The cause, for an administrator and the log. A public error with a detail
   * is one whose sentence says "contact your administrator", and the detail is
   * what that administrator needs.
   */
  detail?: string;
  cause?: unknown;
};

/**
 * An error whose message is safe for anybody to read.
 *
 * Every user-actionable refusal in the app extends this - a sign-in code that
 * is wrong, a plan's profile limit, too few credits, a spreadsheet tab that is
 * not there - so `publicFailure` can tell them from a failure whose message
 * was never written for a person. Anything that is not one of these is treated
 * as unsafe, which is the direction a mistake should fail in: a forgotten
 * sentence becomes generic, never a leaked one.
 */
/**
 * The mark every PublicError carries, registered globally.
 *
 * `instanceof` alone is not enough: a module loaded twice - which the test
 * suite does on purpose, to start from fresh state - has two PublicError
 * classes, and an error built by one copy would fail the other's check and be
 * answered generically. A registered symbol is the same in every copy.
 */
const PUBLIC_ERROR_MARK = Symbol.for('tailor.public-error');

export class PublicError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly extra?: Record<string, unknown>;
  readonly detail?: string;

  constructor(message: string, options: PublicErrorOptions = {}) {
    super(message);
    this.name = 'PublicError';
    Object.defineProperty(this, PUBLIC_ERROR_MARK, { value: true });
    this.status = options.status ?? 400;
    if (options.code) this.code = options.code;
    if (options.extra) this.extra = options.extra;
    if (options.detail) this.detail = options.detail;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isPublicError(value: unknown): value is PublicError {
  return (
    value instanceof PublicError ||
    (typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[PUBLIC_ERROR_MARK] === true)
  );
}

/**
 * A reference a person can quote and an operator can search the log for.
 *
 * Six hex digits: short enough to read out over the phone, and with a few
 * thousand failures a day a collision is a curiosity rather than a problem,
 * because the log line also carries the time and the route.
 */
export function newErrorRef(): string {
  return `ERR-${randomBytes(3).toString('hex').toUpperCase()}`;
}

const CONTACT_ADMIN = 'Please try again, or contact your administrator.';

/** What anybody is told when the route says only what it was doing. */
export const GENERIC_ERROR_MESSAGE = `Something went wrong. ${CONTACT_ADMIN}`;

/**
 * "Failed to queue the batch" becomes "Failed to queue the batch. Please try
 * again, or contact your administrator." - the caller's own words for what it
 * was doing, and the one thing everybody can do about it.
 */
export function genericMessage(fallback?: string): string {
  const said = (fallback ?? '').trim().replace(/[.!?]+$/, '');
  return said ? `${said}. ${CONTACT_ADMIN}` : GENERIC_ERROR_MESSAGE;
}

export type PublicErrorBody = {
  error: string;
  code?: string;
  ref?: string;
  /** Administrators only. */
  detail?: string;
  retryAfterSeconds?: number;
  [field: string]: unknown;
};

export type PublicFailure = {
  status: number;
  body: PublicErrorBody;
  headers?: Record<string, string>;
};

export type PublicFailureOptions = {
  /** Whether the reader is an administrator, which is what earns `detail`. */
  admin?: boolean;
  /** What the route was doing, for the generic sentence: "Failed to fetch groups". */
  fallback?: string;
  /** The status for a failure that is not public. 500 unless the route knows better. */
  status?: number;
  /** Where it happened, for the log line: "POST /api/resume/analyze". */
  context?: string;
};

/** The raw text of anything thrown, for `detail` and the log. */
function rawText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === 'string' ? error : String(error);
}

function logWithRef(ref: string, context: string | undefined, error: unknown, detail?: string): void {
  // The error object itself, not only its message: Node prints the stack and
  // every own property (an AI failure's provider, kind and detail), which is
  // what the operator holding the ref actually needs.
  if (detail) {
    console.error(`[error ${ref}]`, context ?? '', detail, error);
  } else {
    console.error(`[error ${ref}]`, context ?? '', error);
  }
}

/** What an administrator is told about an AI failure: everything the transport knew. */
function describeAiForAdmin(error: AIProviderError): string {
  return [
    error.adminMessage,
    error.adminAction,
    error.detail ? `(${error.detail})` : '',
    `[${error.provider}: ${error.kind}]`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Turns anything thrown into a status and a body that is safe for its reader.
 *
 * In this order:
 *  1. A `PublicError`: its own message, status, code and fields. One that
 *     carries a `detail`, or a 5xx, is also logged under a ref.
 *  2. An AI failure: one of the four `PUBLIC_AI_MESSAGE` sentences, never the
 *     seat, with `Retry-After` when the seat said when.
 *  3. body-parser's own errors, which are the request's: 400 or 413, plain.
 *  4. Anything else: the generic sentence and a ref, and the cause logged.
 */
export function publicFailure(error: unknown, options: PublicFailureOptions = {}): PublicFailure {
  const admin = options.admin === true;

  if (isPublicError(error)) {
    const body: PublicErrorBody = {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.extra ?? {}),
    };
    if (error.detail || error.status >= 500) {
      const ref = newErrorRef();
      logWithRef(ref, options.context, error, error.detail);
      body.ref = ref;
    }
    if (admin && error.detail) body.detail = error.detail;
    return { status: error.status, body };
  }

  if (isAIProviderError(error)) {
    const ref = newErrorRef();
    logWithRef(ref, options.context, error);
    const body: PublicErrorBody = {
      error: error.publicMessage,
      code: `ai-${error.publicFailure === 'contactAdmin' ? 'unavailable' : error.publicFailure}`,
      ref,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(admin ? { detail: describeAiForAdmin(error) } : {}),
    };
    return {
      status: error.publicStatus,
      body,
      ...(error.retryAfterSeconds ? { headers: { 'Retry-After': String(error.retryAfterSeconds) } } : {}),
    };
  }

  // body-parser marks its errors with `type`. Both are about what the caller
  // sent, so they are the caller's 4xx - they used to arrive here as a 500
  // quoting the JSON the parser choked on.
  const type = (error as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed' || type === 'entity.too.large') {
    return {
      status: type === 'entity.too.large' ? 413 : 400,
      body: {
        error: type === 'entity.too.large' ? 'That request is too large.' : 'The request could not be read.',
        ...(admin ? { detail: rawText(error) } : {}),
      },
    };
  }

  const ref = newErrorRef();
  logWithRef(ref, options.context, error);
  return {
    status: options.status ?? 500,
    body: {
      error: genericMessage(options.fallback),
      ref,
      ...(admin ? { detail: rawText(error) } : {}),
    },
  };
}

/** Whether the signed-in reader is an administrator. Inline so this module stays a leaf. */
function readerIsAdmin(req: Request): boolean {
  return req.user?.role === 'admin';
}

function describeRequest(req: Request): string {
  return `${req.method} ${req.originalUrl || req.url}`;
}

/**
 * Answers a failed request. Replaces every
 * `res.status(..).json({ error: error instanceof Error ? error.message : '...' })`
 * on a route somebody other than an administrator can reach.
 *
 * `fallback` names what failed ("Failed to fetch groups"); `status` is for a
 * failure that is not public and is not the server's fault either.
 */
export function sendPublicError(
  req: Request,
  res: Response,
  error: unknown,
  fallback: string,
  status?: number
): void {
  const failure = publicFailure(error, {
    admin: readerIsAdmin(req),
    fallback,
    status,
    context: describeRequest(req),
  });
  // Logged above either way. A stream that has already started cannot change
  // its status, and writing a second body would corrupt the first.
  if (res.headersSent) return;
  for (const [name, value] of Object.entries(failure.headers ?? {})) res.setHeader(name, value);
  res.status(failure.status).json(failure.body);
}

/**
 * The sentence for ONE item in a list a response carries - a profile that could
 * not be tailored, a job that could not be analysed.
 *
 * Public errors and AI failures say their own public sentence; anything else is
 * the generic one with a ref, logged. The item stays in the list either way, so
 * the rest of the batch is unaffected.
 */
export function publicItemError(error: unknown, fallback: string, context?: string): string {
  if (isPublicError(error) && !error.detail && error.status < 500) return error.message;
  const failure = publicFailure(error, { fallback, context });
  return withRef(failure.body.error, failure.body.ref);
}

function withRef(message: string, ref: string | undefined): string {
  return ref ? `${message} (Ref: ${ref})` : message;
}

/**
 * The text stored for a failure that outlives its request - a queued resume's
 * error, which is persisted, copied onto its order item, and read back by the
 * owner's page days later with no request to say who is reading.
 *
 * So what is stored is already safe for anybody: the public sentence and a
 * ref, ALWAYS with the ref, and the cause logged once under it. The ref is
 * also what marks the text as written here (see `publicStoredError`).
 */
export function publicTaskError(error: unknown, fallback: string, context?: string): string {
  const failure = publicFailure(error, { fallback, context });
  if (failure.body.ref) return withRef(failure.body.error, failure.body.ref);
  // A public error that had no reason to log: logged now, because a stored
  // failure is read long after the request, and the ref is what ties the two.
  const ref = newErrorRef();
  logWithRef(ref, context, error);
  return withRef(failure.body.error, ref);
}

const STORED_REF = /\(Ref: ERR-[0-9A-F]{6}\)$/;

/** Stored failure texts that were always written for the owner, and carry no ref. */
const STORED_PUBLIC_TEXTS: ReadonlySet<string> = new Set([
  'Cancelled before it started',
  'Cancelled while it was running',
  'The order could not be queued.',
]);

/**
 * A STORED failure as somebody who is not an administrator may read it.
 *
 * Rows written before this module existed hold whatever `err.message` was - an
 * AI seat's stderr, a path, `Profile <uuid> no longer exists`. They are not
 * rewritten in the database: an administrator still reads them as stored, and
 * a migration that guessed which ones were safe would guess wrong somewhere.
 * Instead every read for anybody else passes through here, and anything that
 * is not recognisably written by `publicTaskError` - which always ends in a
 * ref - or one of the fixed public texts becomes the generic sentence.
 */
export function publicStoredError(text: string, fallback: string): string {
  const trimmed = text.trim();
  if (STORED_REF.test(trimmed) || STORED_PUBLIC_TEXTS.has(trimmed)) return trimmed;
  return genericMessage(fallback);
}

/**
 * The last error handler. Anything a route passed to `next(err)`, or threw
 * synchronously, lands here: a multer refusal, a body-parser error, a bug.
 */
export function publicErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  sendPublicError(req, res, err, 'Something went wrong');
}

