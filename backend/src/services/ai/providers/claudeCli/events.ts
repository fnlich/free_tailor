/**
 * Reduces the CLI's NDJSON event stream into one turn's outcome.
 *
 * Unknown event types are ignored BY CONSTRUCTION. Version 2.1.261 already
 * emits `active_goal` and `autocompact_state` that this app has no use for, and
 * a parser that rejects what it does not recognise breaks on the next release.
 */

export type CliRateLimitInfo = {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
};

export type CliTurnState = {
  /** Text assembled from `text_delta` events, used only if no result arrives. */
  deltaText: string;
  /** The authoritative answer, from the final `result` event. */
  resultText: string | null;
  sawResult: boolean;
  isError: boolean;
  /** `api_error_status` on the result event, when the CLI supplies one. */
  apiErrorStatus: number | null;
  /** From the last `assistant` message, then the result event as a fallback. */
  stopReason: string | null;
  subtype: string | null;
  terminalReason: string | null;
  errors: string[];
  model: string | null;
  /**
   * `apiKeySource` from `system/init`. Anything but 'none' means the child
   * found an API key and this call is being billed per token.
   */
  apiKeySource: string | null;
  rateLimit: CliRateLimitInfo | null;
  retries: number;
  lastRetryDelayMs: number;
  lastRetryError: string;
  lastRetryStatus: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  costUsd: number;
  events: number;
  firstTextAtMs: number | null;
};

export function createTurnState(): CliTurnState {
  return {
    deltaText: '',
    resultText: null,
    sawResult: false,
    isError: false,
    apiErrorStatus: null,
    stopReason: null,
    subtype: null,
    terminalReason: null,
    errors: [],
    model: null,
    apiKeySource: null,
    rateLimit: null,
    retries: 0,
    lastRetryDelayMs: 0,
    lastRetryError: '',
    lastRetryStatus: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    events: 0,
    firstTextAtMs: null,
  };
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

type Reducer = (line: string, elapsedMs: number) => void;

export function createEventReducer(state: CliTurnState): Reducer {
  return (line: string, elapsedMs: number): void => {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      event = parsed as Record<string, unknown>;
    } catch {
      // Not every line is JSON: a banner, a blank line, a warning. Skipping is
      // correct; throwing here would turn cosmetic output into a failed call.
      return;
    }

    state.events += 1;
    const kind = event.type;

    if (kind === 'system') {
      const subtype = event.subtype;
      if (subtype === 'init') {
        state.model = asString(event.model) ?? state.model;
        state.apiKeySource = typeof event.apiKeySource === 'string' ? event.apiKeySource : state.apiKeySource;
        return;
      }
      if (subtype === 'api_retry') {
        // A retry restarts the message, so text that arrived before it is no
        // longer the beginning of the answer and must be dropped.
        state.deltaText = '';
        state.retries += 1;
        state.lastRetryDelayMs = asNumber(event.retry_delay_ms) ?? 0;
        state.lastRetryStatus = asNumber(event.error_status);
        state.lastRetryError = asString(event.error) ?? '';
      }
      return;
    }

    if (kind === 'stream_event') {
      const inner = event.event as Record<string, unknown> | undefined;
      const delta = inner?.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        if (state.firstTextAtMs === null) {
          state.firstTextAtMs = elapsedMs;
        }
        state.deltaText += delta.text;
      }
      return;
    }

    if (kind === 'assistant') {
      const message = event.message as Record<string, unknown> | undefined;
      // The assistant message is an Anthropic Messages payload, where
      // `stop_reason` is guaranteed. The result event may or may not repeat it,
      // so this is the primary source for truncation detection.
      const stop = asString(message?.stop_reason);
      if (stop) {
        state.stopReason = stop;
      }
      const errorMark = asString(event.error);
      if (errorMark) {
        state.errors.push(errorMark);
      }
      return;
    }

    if (kind === 'rate_limit_event') {
      const info = event.rate_limit_info;
      if (info && typeof info === 'object') {
        state.rateLimit = info as CliRateLimitInfo;
      }
      return;
    }

    if (kind === 'result') {
      state.sawResult = true;
      state.subtype = asString(event.subtype);
      state.isError = event.is_error === true;
      state.apiErrorStatus = asNumber(event.api_error_status);
      state.terminalReason = asString(event.terminal_reason);
      state.stopReason = state.stopReason ?? asString(event.stop_reason);
      state.costUsd = asNumber(event.total_cost_usd) ?? 0;
      state.resultText = typeof event.result === 'string' ? event.result : null;

      if (Array.isArray(event.errors)) {
        for (const entry of event.errors) {
          if (typeof entry === 'string' && entry.trim()) {
            state.errors.push(entry);
          }
        }
      }

      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        state.usage = {
          inputTokens: asNumber(usage.input_tokens) ?? 0,
          outputTokens: asNumber(usage.output_tokens) ?? 0,
          cacheReadTokens: asNumber(usage.cache_read_input_tokens) ?? 0,
          cacheWriteTokens: asNumber(usage.cache_creation_input_tokens) ?? 0,
        };
      }
    }
  };
}

/**
 * The answer for this turn.
 *
 * The result event's `result` field is authoritative: it carries the whole
 * answer, so the delta buffer is only a fallback for a turn that produced text
 * and then died before its result event. That ordering also makes the
 * drop-buffer-on-retry rule self-healing rather than load-bearing.
 */
export function readTurnText(state: CliTurnState): string {
  // Only when the turn SUCCEEDED. On a failure the `result` field carries the
  // CLI's explanation ("There's an issue with the selected model ..."), and
  // returning that as the answer would hand a diagnosis to a JSON parser.
  if (!state.isError && typeof state.resultText === 'string' && state.resultText.trim()) {
    return state.resultText;
  }
  return state.deltaText;
}
