import { PublicError } from '../middleware/publicError';

/**
 * The one sentence anybody gets when a run, a quote or a profile names a model
 * it may not use.
 *
 * Deliberately the same sentence whatever the cause. The causes - a model
 * switched off, its seat switched off or locked on this machine, an id that was
 * never a model, a provider form only administrators may send - are all the
 * administrator's to see and fix, and naming them would put seat names, lock
 * reasons and model ids in front of people who can do nothing with them.
 */
export const MODEL_UNAVAILABLE_MESSAGE =
  "That model isn't available. Choose another, or contact your administrator.";

/**
 * A model somebody picked for THIS request (or is saving onto a profile) that
 * cannot run.
 *
 * Refused rather than swapped for the default, unlike a STORED preference that
 * went stale: the price of a resume is the price of its model, so quietly
 * running another one would also quietly charge another amount.
 *
 * `message` is the public sentence; `detail` says what actually happened, for an
 * administrator's response body and for the log, and for nobody else. A 400,
 * because it is the request's choice that is wrong and choosing again fixes it.
 */
export class ModelUnavailableError extends PublicError {
  declare readonly detail: string;

  constructor(detail: string) {
    super(MODEL_UNAVAILABLE_MESSAGE, { status: 400, code: 'model-unavailable', detail });
    this.name = 'ModelUnavailableError';
  }
}

/**
 * Nothing at all can run: every model is switched off, or every seat behind
 * the enabled ones is locked on this machine.
 *
 * Not the request's fault, so not `ModelUnavailableError`'s 400 - choosing
 * another model cannot help when there is none. A 503 with the sentence the
 * frontend uses for the same state, and the operator's reason (which names
 * AI_LOCKED_PROVIDERS and the seats) as `detail`.
 */
export const AI_UNAVAILABLE_MESSAGE =
  "AI generation isn't available right now. Please contact your administrator.";

export class AiUnavailableError extends PublicError {
  declare readonly detail: string;

  constructor(detail: string) {
    super(AI_UNAVAILABLE_MESSAGE, { status: 503, code: 'ai-unavailable', detail });
    this.name = 'AiUnavailableError';
  }
}
