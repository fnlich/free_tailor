import type { Response } from 'express';

/**
 * Progress for a batch that is running somewhere else.
 *
 * A batch used to be one HTTP request per resume, so the page knew where it had
 * got to because it was the thing doing the counting. The queue took that away:
 * thirty resumes are now one submission that returns immediately, and the work
 * happens on the server afterwards. This is how the page finds out.
 *
 * NDJSON rather than Server-Sent Events. The payloads are already JSON, and a
 * plain `fetch` reader handles a line-delimited body without an EventSource and
 * the extra connection it holds.
 *
 * Reconnecting is deliberately trivial: the FIRST line is always a complete
 * snapshot, so a reader that joins late - or rejoins after a reload - never has
 * to reconcile the events it missed. That is worth more than SSE's `Last-Event-ID`
 * and costs one extra line per connection.
 *
 * Closing the connection does NOT cancel anything. The work belongs to the queue
 * rather than to any request, which is the whole point of the queue; a page that
 * navigates away is not a reason to stop building somebody's resumes. Cancelling
 * is its own endpoint, because it has to be asked for.
 */

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

export type BatchStream = {
  /** Writes one line. A no-op once the response has ended. */
  send(payload: Record<string, unknown>): void;
  end(): void;
};

export function openBatchStream(res: Response): BatchStream {
  res.setHeader('Content-Type', `${NDJSON_CONTENT_TYPE}; charset=utf-8`);
  // Nothing here is worth buffering, and a proxy that holds a few hundred bytes
  // back turns a live progress bar into one that jumps at the end.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  return {
    send(payload) {
      // A batch outlives its readers often enough to matter - a reload is the
      // ordinary way out of a long run - and writing to a closed socket throws.
      if (res.writableEnded) return;
      res.write(`${JSON.stringify(payload)}\n`);
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}
