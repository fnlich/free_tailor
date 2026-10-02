/**
 * Reducing one `codex exec --json` stream.
 *
 * WHAT IS KNOWN AND WHAT IS INFERRED, because the difference matters when this
 * stops working. The envelope below was captured from a real run of
 * `@openai/codex` 0.157.1:
 *
 *   {"type":"thread.started","thread_id":"01a0e65e-..."}
 *   {"type":"turn.started"}
 *   {"type":"error","message":"Reconnecting... 2/5 (stream disconnected...)"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"..."}}
 *
 * The shape of a SUCCESSFUL turn's message item was not captured - this machine
 * has no ChatGPT credential and the proxy refuses wss://api.openai.com - so
 * every text-bearing key below is read permissively rather than pinned to one
 * spelling.
 *
 * That is affordable precisely because the answer does not come from here.
 * `codex exec` writes the final message to the file named by
 * `--output-last-message`, and the adapter reads it from there. This reducer
 * supplies metadata and, when there is no answer at all, the reason.
 *
 * THE ONE THING THAT WOULD BE A BUG TO GET WRONG: a bare `{"type":"error"}` is
 * NOT terminal. The captured stream shows the CLI emitting one per reconnection
 * attempt - five of them - and then falling back from WebSockets to HTTPS. A
 * reducer that treated the first as the outcome would abort turns that were
 * about to succeed on a flaky network. They are collected as diagnostics and
 * only ever used to explain an EMPTY answer.
 */

export type CodexTurnState = {
  threadId: string | null;
  /** Text seen in the stream. A fallback: the answer file is the real source. */
  text: string[];
  /** Every error line, in order. Transient reconnection notices included. */
  errors: string[];
  /** Set only by an event that explicitly ends the turn badly. */
  fatal: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

export function createCodexTurnState(): CodexTurnState {
  return { threadId: null, text: [], errors: [], fatal: null, usage: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readText(source: Record<string, unknown>): string {
  // Several spellings, because only the error item's was captured. Whichever
  // carries prose is taken; a key that is not a string is skipped rather than
  // stringified, so `[object Object]` can never reach an answer.
  for (const key of ['text', 'message', 'content', 'delta']) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** True for the reconnection notices, which say nothing about the outcome. */
function isTransientNotice(message: string): boolean {
  return /^\s*reconnecting\b/i.test(message) || /falling back from websockets/i.test(message);
}

export function createCodexEventReducer(state: CodexTurnState): (line: string) => void {
  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      // Not JSON. The CLI writes diagnostics to stderr, so a non-JSON line on
      // stdout is a version whose output this build does not understand -
      // ignored rather than failing the turn, because the answer file does not
      // depend on it.
      return;
    }
    if (!event) return;

    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'thread.started') {
      const id = event.thread_id;
      if (typeof id === 'string') state.threadId = id;
      return;
    }

    if (type === 'error') {
      const message = readText(event);
      if (message) state.errors.push(message);
      return;
    }

    if (type === 'turn.failed' || type === 'thread.failed') {
      // An event that explicitly ends the turn. Unlike the line above, this one
      // IS the outcome.
      state.fatal = readText(event) || 'the turn failed';
      return;
    }

    if (type === 'turn.completed' || type === 'turn.finished') {
      const usage = asRecord(event.usage);
      if (usage) {
        const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
        const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
        state.usage = {
          inputTokens: Number.isFinite(input) ? input : 0,
          outputTokens: Number.isFinite(output) ? output : 0,
        };
      }
      return;
    }

    if (type === 'item.completed' || type === 'item.updated') {
      const item = asRecord(event.item);
      if (!item) return;
      const itemType = typeof item.type === 'string' ? item.type : '';
      const message = readText(item);
      if (!message) return;

      if (itemType === 'error') {
        state.errors.push(message);
        return;
      }
      // Anything else carrying prose is treated as part of the answer. The
      // stream is a fallback for the answer file, so over-collecting here is
      // harmless and under-collecting would lose a message on a CLI whose item
      // types have moved on.
      state.text.push(message);
    }
  };
}

/** The stream's own idea of the answer. Second to the `--output-last-message` file. */
export function readCodexTurnText(state: CodexTurnState): string {
  return state.text.join('\n').trim();
}

/**
 * Why a turn produced nothing, in the words most likely to help.
 *
 * Prefers a real failure, then the last error that was not a reconnection
 * notice, and falls back to the notices only when they are all there is - at
 * which point "it could not reach the API" is exactly the right answer.
 */
export function describeCodexFailure(state: CodexTurnState): string {
  if (state.fatal) return state.fatal;
  const substantive = state.errors.filter((message) => !isTransientNotice(message));
  if (substantive.length) return substantive[substantive.length - 1];
  if (state.errors.length) {
    return `the CLI never reached the API: ${state.errors[state.errors.length - 1]}`;
  }
  return 'the CLI produced no answer and gave no reason';
}
