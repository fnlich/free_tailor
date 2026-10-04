/**
 * Reducing one `gemini --output-format stream-json` stream.
 *
 * The envelope below was CAPTURED from the real 0.62.0 binary, run with its
 * hidden fake-response hook so no Google account was needed (the fixtures in
 * test/fixtures/gemini are those captures):
 *
 *   {"type":"init","session_id":"...","model":"auto"}           requested name
 *   {"type":"message","role":"user","content":"<the WHOLE prompt>"}
 *   {"type":"message","role":"assistant","content":"<chunk>","delta":true}  ...
 *   {"type":"error","severity":"warning"|"error","message":"..."}          some
 *   {"type":"result","status":"success"|"error","error"?:{type,message},"stats":{...}}
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG, each verified:
 *
 *   - The answer is the concatenation of the assistant deltas. The result event
 *     does NOT repeat it, unlike the Claude CLI's.
 *   - Exit code 0 is not success. A safety block or an empty response is
 *     retried inside the CLI, then reported as an `error` event and a result
 *     with status "error" - and the process exits 0. A run stopped by SIGTERM
 *     exits 0 with no result at all. Only `status: "success"` is an answer.
 *   - A response cut off by the model's output limit is ALSO status "success",
 *     with the fragment as its text. Nothing in the envelope says so, so it
 *     cannot be detected here; downstream JSON parsing is the remaining guard.
 *
 * One more, read from the source rather than captured: when the connection
 * drops MID-answer, the CLI retries the request and streams the new answer
 * after the deltas it already printed, with no marker in stream-json. The
 * concatenation is then garbled; that is also left to downstream parsing,
 * and the workspace's small `general.maxAttempts` keeps it rare.
 *
 * Unknown event types and non-JSON lines are ignored, so a release that adds an
 * event does not break the provider.
 */

export type GeminiTurnState = {
  sessionId: string | null;
  /** The model the CLI was asked for (`init.model`), e.g. "auto". */
  requestedModel: string | null;
  /** Assistant text chunks, in order. Joined, they are the answer - on success only. */
  deltas: string[];
  /**
   * Tool calls the model asked for. Must stay 0: the workspace registers no
   * tools and the policy denies every one, so a call here means the lockdown
   * did not hold and the turn is not trusted.
   */
  toolUses: number;
  errors: Array<{ severity: string; message: string }>;
  sawResult: boolean;
  status: string | null;
  resultError: { type: string | null; message: string } | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
  /** The model that actually answered: the stats entry with the most output. */
  resolvedModel: string | null;
  events: number;
};

export function createGeminiTurnState(): GeminiTurnState {
  return {
    sessionId: null,
    requestedModel: null,
    deltas: [],
    toolUses: 0,
    errors: [],
    sawResult: false,
    status: null,
    resultError: null,
    usage: null,
    resolvedModel: null,
    events: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * `auto` lists the classifier's model beside the one that answered, so the
 * answering one is the entry that produced the most output.
 */
function answeringModel(models: unknown): string | null {
  const table = asRecord(models);
  if (!table) return null;
  let best: string | null = null;
  let bestOutput = -1;
  for (const [name, entry] of Object.entries(table)) {
    const output = asNumber(asRecord(entry)?.output_tokens);
    if (output > bestOutput) {
      best = name;
      bestOutput = output;
    }
  }
  return best;
}

export function createGeminiEventReducer(state: GeminiTurnState): (line: string) => void {
  return (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      // stderr carries the CLI's diagnostics; a non-JSON line on stdout is
      // noise from a version this build does not know, not a failed turn.
      return;
    }
    if (!event) return;
    state.events += 1;

    switch (event.type) {
      case 'init': {
        state.sessionId = asText(event.session_id) ?? state.sessionId;
        state.requestedModel = asText(event.model) ?? state.requestedModel;
        return;
      }
      case 'message': {
        // The `user` message is the CLI echoing the prompt back - skipped, or
        // the whole prompt would be read as the start of the answer.
        if (event.role === 'assistant' && typeof event.content === 'string') {
          state.deltas.push(event.content);
        }
        return;
      }
      case 'tool_use': {
        state.toolUses += 1;
        return;
      }
      case 'error': {
        const message = asText(event.message);
        if (message) {
          state.errors.push({
            severity: typeof event.severity === 'string' ? event.severity : 'error',
            message,
          });
        }
        return;
      }
      case 'result': {
        state.sawResult = true;
        state.status = typeof event.status === 'string' ? event.status : null;
        const error = asRecord(event.error);
        const message = error ? asText(error.message) : null;
        if (message) {
          state.resultError = { type: typeof error?.type === 'string' ? error.type : null, message };
        }
        const stats = asRecord(event.stats);
        if (stats) {
          state.usage = {
            inputTokens: asNumber(stats.input_tokens),
            outputTokens: asNumber(stats.output_tokens),
            cacheReadTokens: asNumber(stats.cached),
          };
          state.resolvedModel = answeringModel(stats.models) ?? state.resolvedModel;
        }
        return;
      }
      default:
        return;
    }
  };
}

/** The answer, or '' when the turn did not succeed. Never a fragment of a failure. */
export function readGeminiTurnText(state: GeminiTurnState): string {
  if (!state.sawResult || state.status !== 'success') return '';
  return state.deltas.join('');
}

/**
 * Why a turn failed, in the CLI's own words: the result's error message, else
 * the last error-severity event (a safety block or an empty response arrives
 * that way, with no error on the result), else the last warning.
 */
export function describeGeminiFailure(state: GeminiTurnState): string {
  if (state.resultError) return state.resultError.message;
  const serious = state.errors.filter((entry) => entry.severity === 'error');
  if (serious.length > 0) return serious[serious.length - 1].message;
  if (state.errors.length > 0) return state.errors[state.errors.length - 1].message;
  return '';
}
