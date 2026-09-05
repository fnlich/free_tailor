import type { AIProvider } from '../../types/template';

/**
 * One error type for every way an AI call can fail, so routes can map failures
 * to a status and a sentence a person can act on. Before this, every AI
 * failure reached the browser as an opaque 500 with the raw provider message.
 */
export type AIErrorKind =
  | 'auth'
  | 'rateLimited'
  | 'unavailable'
  | 'modelUnavailable'
  | 'timeout'
  | 'stalled'
  | 'truncated'
  | 'binaryMissing'
  | 'malformedOutput'
  | 'disabled'
  | 'failed';

export const HTTP_STATUS_BY_KIND: Record<AIErrorKind, number> = {
  auth: 503,
  rateLimited: 429,
  unavailable: 503,
  modelUnavailable: 503,
  timeout: 504,
  stalled: 504,
  truncated: 502,
  binaryMissing: 503,
  malformedOutput: 502,
  disabled: 409,
  failed: 502,
};

const RETRYABLE_KINDS: ReadonlySet<AIErrorKind> = new Set<AIErrorKind>([
  'rateLimited',
  'unavailable',
  'timeout',
  'stalled',
  'truncated',
  'malformedOutput',
  'failed',
]);

export const USER_MESSAGE_BY_KIND: Record<AIErrorKind, string> = {
  auth: 'The Claude subscription is not signed in on the server. An administrator needs to run `claude auth login`.',
  rateLimited:
    'The Claude subscription usage limit has been reached. Generation resumes automatically when the window resets.',
  unavailable: 'The AI provider is temporarily unavailable. Please try again in a moment.',
  modelUnavailable:
    'The selected model is not available. Pick a different model under Admin -> Models.',
  timeout: 'The request took too long and was cancelled. Try a shorter job description or fewer profiles at once.',
  stalled: 'The AI provider stopped responding and the request was cancelled. Please try again.',
  truncated: 'The response was cut off before it finished. Try again, or split this into smaller requests.',
  binaryMissing: 'The Claude CLI is not installed or is not on the server PATH.',
  malformedOutput: 'The model returned a response that could not be read. Please try again.',
  disabled: 'This AI provider is disabled by an administrator.',
  failed: 'The AI request failed. Please try again.',
};

export type AIProviderErrorOptions = {
  provider: AIProvider;
  kind: AIErrorKind;
  /** Operator-facing detail. Logged; never returned to a browser. */
  detail?: string;
  /** What an admin should do about it, when there is a concrete action. */
  adminAction?: string;
  retryAfterSeconds?: number;
  cause?: unknown;
  /** Overrides the default sentence for this kind. */
  userMessage?: string;
};

export class AIProviderError extends Error {
  readonly kind: AIErrorKind;
  readonly provider: AIProvider;
  readonly httpStatus: number;
  readonly userMessage: string;
  readonly retryAfterSeconds?: number;
  readonly adminAction?: string;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(options: AIProviderErrorOptions) {
    const userMessage = options.userMessage ?? USER_MESSAGE_BY_KIND[options.kind];
    super(options.detail ? `${userMessage} (${options.detail})` : userMessage);
    this.name = 'AIProviderError';
    this.kind = options.kind;
    this.provider = options.provider;
    this.httpStatus = HTTP_STATUS_BY_KIND[options.kind];
    this.userMessage = userMessage;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.adminAction = options.adminAction;
    this.detail = options.detail;
    this.retryable = RETRYABLE_KINDS.has(options.kind);
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isAIProviderError(value: unknown): value is AIProviderError {
  return value instanceof AIProviderError;
}

/**
 * Wraps anything thrown below the transport layer so callers only ever have to
 * handle AIProviderError. An error that already is one passes through.
 */
export function asAIProviderError(
  error: unknown,
  provider: AIProvider,
  kind: AIErrorKind = 'failed'
): AIProviderError {
  if (isAIProviderError(error)) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new AIProviderError({ provider, kind, detail, cause: error });
}
