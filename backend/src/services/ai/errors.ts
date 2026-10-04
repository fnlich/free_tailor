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
  | 'locked'
  | 'misconfigured'
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
  locked: 409,
  misconfigured: 503,
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

/**
 * What an ADMINISTRATOR is told about each kind of failure.
 *
 * These were once the sentences every account was shown, and they are written
 * for whoever runs the server: they name the seat, the CLI and the command that
 * fixes it. That is exactly right in the log and in the `detail` an
 * administrator's response carries, and exactly wrong on the page of somebody
 * who has never seen the server - so a response body only ever takes one of the
 * four `PUBLIC_AI_MESSAGE` sentences below, and these go to `detail` and the log.
 */
export const ADMIN_MESSAGE_BY_KIND: Record<AIErrorKind, string> = {
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
  // Distinct from `disabled` because the fix is different: an admin can untick
  // and re-tick a disabled provider, and no amount of clicking unlocks one.
  locked: 'This AI provider is locked in this installation. Pick one of the unlocked models instead.',
  // A setting in .env that cannot be used, refused before anything was sent.
  // Not retryable: the same value is refused the same way until it is fixed.
  misconfigured:
    'This AI provider is not set up correctly on the server. An administrator needs to check its settings in .env.',
  failed: 'The AI request failed. Please try again.',
};

/**
 * The sentences that name a product, for every seat the defaults above do not
 * describe.
 *
 * Those defaults were written when the Claude seat was the only provider, and
 * three of them name it. The Codex and Gemini seats reach the same kinds - a
 * missing binary, a signed-out seat, a usage limit - and told the administrator
 * to sign the Claude seat in, on an install where that seat may well be locked.
 * Keyed on every provider, so adding one without deciding what it says is a
 * compile error; an empty entry means the defaults are its own.
 */
const ADMIN_MESSAGE_BY_PROVIDER: Record<AIProvider, Partial<Record<AIErrorKind, string>>> = {
  'claude-cli': {},
  'codex-cli': {
    auth:
      'The Codex subscription is not signed in on the server. An administrator needs to run ' +
      '`codex login --device-auth`.',
    rateLimited: 'The Codex subscription usage limit has been reached. Please try again once it resets.',
    binaryMissing: 'The Codex CLI is not installed or is not on the server PATH.',
  },
  'gemini-cli': {
    auth:
      'The Gemini seat is not signed in on the server. An administrator needs to run ' +
      '`NO_BROWSER=true gemini` there and sign in with Google.',
    rateLimited: 'The Gemini usage limit has been reached. Please try again once it resets.',
    binaryMissing: 'The Gemini CLI is not installed or is not on the server PATH.',
  },
};

/** The administrator's sentence for `kind` on `provider`, unless the thrower gives one. */
export function defaultAdminMessage(provider: AIProvider, kind: AIErrorKind): string {
  return ADMIN_MESSAGE_BY_PROVIDER[provider]?.[kind] ?? ADMIN_MESSAGE_BY_KIND[kind];
}

/**
 * The only four things anybody who is not an administrator hears about an AI
 * failure, whatever the seat, the model or the cause.
 *
 * Grouped by what the READER can do, which is all a sentence for them can
 * usefully carry: wait (`busy`), ask for less (`timeout`), simply try again
 * (`retry`), or tell somebody (`contactAdmin`). A signed-out seat, a missing
 * binary, a lock and a switched-off provider are four different fixes for an
 * administrator and one and the same thing for everybody else - so none of
 * them names a seat, a CLI, a command or a setting.
 */
export type PublicAiFailure = 'busy' | 'timeout' | 'retry' | 'contactAdmin';

export const PUBLIC_AI_MESSAGE: Record<PublicAiFailure, string> = {
  busy: 'AI generation is busy right now. Please try again in a few minutes.',
  timeout:
    'The request took too long and was cancelled. Try a shorter job description or fewer profiles at once.',
  retry: 'The AI request failed. Please try again.',
  contactAdmin: "AI generation isn't available right now. Please contact your administrator.",
};

/** Which of the four each kind is. A Record, so a new kind cannot go unclassified. */
export const PUBLIC_AI_FAILURE_BY_KIND: Record<AIErrorKind, PublicAiFailure> = {
  auth: 'contactAdmin',
  rateLimited: 'busy',
  unavailable: 'retry',
  modelUnavailable: 'contactAdmin',
  timeout: 'timeout',
  stalled: 'retry',
  truncated: 'retry',
  binaryMissing: 'contactAdmin',
  malformedOutput: 'retry',
  disabled: 'contactAdmin',
  locked: 'contactAdmin',
  misconfigured: 'contactAdmin',
  failed: 'retry',
};

export type AIProviderErrorOptions = {
  provider: AIProvider;
  kind: AIErrorKind;
  /** Operator-facing detail. Logged, and in an administrator's `detail`; never in anybody else's body. */
  detail?: string;
  /** What an admin should do about it, when there is a concrete action. */
  adminAction?: string;
  retryAfterSeconds?: number;
  cause?: unknown;
  /** Overrides the administrator's default sentence for this kind. */
  adminMessage?: string;
  /**
   * Overrides which of the four public sentences this is, when the kind alone
   * would say the wrong thing - a full semaphore is `unavailable` to the
   * transport and simply "busy" to the person waiting on it.
   */
  publicFailure?: PublicAiFailure;
};

export class AIProviderError extends Error {
  readonly kind: AIErrorKind;
  readonly provider: AIProvider;
  readonly httpStatus: number;
  /** The administrator's sentence. See ADMIN_MESSAGE_BY_KIND for who reads it. */
  readonly adminMessage: string;
  /** Which public sentence a response body carries. */
  readonly publicFailure: PublicAiFailure;
  readonly retryAfterSeconds?: number;
  readonly adminAction?: string;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(options: AIProviderErrorOptions) {
    const adminMessage = options.adminMessage ?? defaultAdminMessage(options.provider, options.kind);
    // `message` stays the operator's whole story, because it is what a stack
    // trace and every existing log line print. No route may send it: the
    // response bodies are built from `publicMessage` (middleware/publicError).
    super(options.detail ? `${adminMessage} (${options.detail})` : adminMessage);
    this.name = 'AIProviderError';
    this.kind = options.kind;
    this.provider = options.provider;
    this.httpStatus = HTTP_STATUS_BY_KIND[options.kind];
    this.adminMessage = adminMessage;
    this.publicFailure = options.publicFailure ?? PUBLIC_AI_FAILURE_BY_KIND[options.kind];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.adminAction = options.adminAction;
    this.detail = options.detail;
    this.retryable = RETRYABLE_KINDS.has(options.kind);
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /** The sentence anybody may be shown. */
  get publicMessage(): string {
    return PUBLIC_AI_MESSAGE[this.publicFailure];
  }

  /**
   * The status a response carries. A failure only an administrator can fix is
   * 503 whatever its kind: `disabled` and `locked` are 409 to the transport,
   * but "the request conflicts with something" is not what the reader's
   * problem is.
   */
  get publicStatus(): number {
    return this.publicFailure === 'contactAdmin' ? 503 : this.httpStatus;
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
