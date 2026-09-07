import type { NextFunction, Request, Response } from 'express';
import { isAIProviderError, type AIErrorKind } from '../services/ai';

/**
 * Turns an AI transport failure into a response a person can act on.
 *
 * Every AI failure used to reach the browser as an opaque 500 carrying the raw
 * provider message. The difference that matters is not the wording: a spent
 * usage window is a 429 with a `Retry-After`, a missing binary is a 503 an
 * admin must fix, and a truncated answer is worth retrying - and a client
 * cannot tell those apart from a 500.
 */

export type AiErrorBody = {
  error: string;
  code: AIErrorKind;
  provider: string;
  retryAfterSeconds?: number;
  adminAction?: string;
};

export function describeAiError(error: unknown): { status: number; body: AiErrorBody } | null {
  if (!isAIProviderError(error)) {
    return null;
  }
  return {
    status: error.httpStatus,
    body: {
      error: error.userMessage,
      code: error.kind,
      provider: error.provider,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.adminAction ? { adminAction: error.adminAction } : {}),
    },
  };
}

/**
 * The sentence to show a user for any failure.
 *
 * For an AIProviderError that is `userMessage`, NOT `message` - `message`
 * appends the operator-facing detail, which the single-error path already
 * takes care to withhold. The per-item failure lists in batch responses reach
 * the same browser and must withhold it too.
 */
export function describeFailure(error: unknown, fallback: string): string {
  if (isAIProviderError(error)) {
    return error.userMessage;
  }
  return error instanceof Error ? error.message : fallback;
}

/** Sends an AI error on a response, or returns false if it is not one. */
export function sendAiError(res: Response, error: unknown): boolean {
  const described = describeAiError(error);
  if (!described) {
    return false;
  }
  if (described.body.retryAfterSeconds) {
    res.setHeader('Retry-After', String(described.body.retryAfterSeconds));
  }
  // The operator-facing detail stays in the log; only `userMessage` is sent.
  console.error(`[ai] ${described.body.code}:`, error instanceof Error ? error.message : error);
  res.status(described.status).json(described.body);
  return true;
}

export function aiErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (!sendAiError(res, err)) {
    next(err);
  }
}
