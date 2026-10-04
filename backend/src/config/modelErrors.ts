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
export class ModelUnavailableError extends Error {
  readonly status = 400;
  readonly code = 'model-unavailable';
  readonly detail: string;

  constructor(detail: string) {
    super(MODEL_UNAVAILABLE_MESSAGE);
    this.name = 'ModelUnavailableError';
    this.detail = detail;
  }
}

/**
 * The response body for one, with the detail only for an administrator.
 *
 * A route that catches this answers `error.status` with this body. Kept beside
 * the class, so every route says it the same way.
 */
export function modelUnavailableBody(
  error: ModelUnavailableError,
  admin: boolean
): { error: string; code: string; detail?: string } {
  return { error: error.message, code: error.code, ...(admin ? { detail: error.detail } : {}) };
}
