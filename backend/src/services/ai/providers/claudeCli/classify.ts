import type { AIErrorKind } from '../../errors';

/**
 * What a CLI failure means, so the provider can react in the right direction.
 * An account that is signed out is not fixed by another model, and an
 * overloaded model is not fixed by another account.
 */

export const AUTH_MARKS = [
  'not logged in',
  'please run /login',
  'invalid authentication',
  'authentication_error',
  'oauth token',
  'invalid api key',
  'permission_error',
  'unauthorized',
] as const;

export const LIMIT_MARKS = [
  'rate limit',
  'rate_limit',
  'usage limit',
  'limit reached',
  'out of extra usage',
  'out_of_credits',
] as const;

/** A model the service will not serve: unknown, retired, or not on this plan. */
export const MODEL_MARKS = [
  'issue with the selected model',
  'may not exist',
  'unrecognized_model',
  'not_found_error',
] as const;

export const SERVER_MARKS = [
  'overloaded',
  'internal server error',
  'api_error',
  'fetch failed',
  'econnreset',
  'econnrefused',
  'etimedout',
  'socket hang up',
  'upstream',
  'timed out',
  'network error',
  'service unavailable',
  'bad gateway',
  'gateway time',
] as const;

/**
 * A three-digit number counts as a status only next to a word that makes it
 * one: "API Error: 529", "HTTP 500", "status 429", "error code 503".
 *
 * A bare `\d{3}` is actively harmful here. It matches the column of a stack
 * frame (`cli.js:512:98765`), a duration ("took 503 ms") and a port number -
 * and each of those would park a perfectly healthy model for ten minutes.
 */
export const STATUS_WORD_RE = /(?:status|error|http|code)\W{0,4}(\d{3})(?![\d:.])/g;

function kindForStatus(status: number): AIErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'modelUnavailable';
  if (status >= 500) return 'unavailable';
  return 'failed';
}

export type ClassifyInput = {
  /** `api_error_status` from the result event, when the CLI supplied one. */
  apiErrorStatus: number | null;
  isError: boolean;
  exitCode: number | null;
  stderrTail: string;
  resultText: string;
  errors?: readonly string[];
};

/**
 * Returns the failure kind, or null when nothing indicates a failure.
 *
 * NEVER classify on the result event's `subtype`. Verified against v2.1.261: a
 * hard model 404 arrives as `subtype: "success"` with `is_error: true`, so
 * folding the subtype into the evidence puts the word "success" into the text
 * used to diagnose a failure.
 */
export function classifyCliFailure(input: ClassifyInput): AIErrorKind | null {
  if (input.apiErrorStatus !== null && Number.isFinite(input.apiErrorStatus)) {
    return kindForStatus(input.apiErrorStatus);
  }

  const parts = [input.stderrTail, input.isError ? input.resultText : '', ...(input.errors ?? [])];
  const haystack = parts.filter(Boolean).join(' ').toLowerCase();

  if (haystack) {
    if (AUTH_MARKS.some((mark) => haystack.includes(mark))) return 'auth';
    if (LIMIT_MARKS.some((mark) => haystack.includes(mark))) return 'rateLimited';
    if (MODEL_MARKS.some((mark) => haystack.includes(mark))) return 'modelUnavailable';
    if (SERVER_MARKS.some((mark) => haystack.includes(mark))) return 'unavailable';

    const codes = new Set<number>();
    STATUS_WORD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STATUS_WORD_RE.exec(haystack)) !== null) {
      codes.add(Number(match[1]));
    }
    if (codes.has(401) || codes.has(403)) return 'auth';
    if (codes.has(429)) return 'rateLimited';
    if (codes.has(404)) return 'modelUnavailable';
    for (const code of codes) {
      if (code >= 500) return 'unavailable';
    }
  }

  if (input.isError) {
    return 'failed';
  }
  if (input.exitCode !== null && input.exitCode !== 0) {
    return 'failed';
  }
  return null;
}
