import { NextResponse } from 'next/server';

/**
 * A failed call to the calendar service, as the browser hears about it.
 *
 * What went wrong upstream - "Upstream request failed with 503", whatever
 * `msg` calendar.online put in its body, a timeout's AbortError - is for
 * whoever runs this server, so it goes to the server's log. The page gets a
 * sentence saying what did not load and the two things its reader can do: the
 * likeliest cause they control is a mistyped share link, and the rest pass.
 *
 * `what` is the thing being loaded ("calendar events"), used in both.
 */
export function calendarFailure(what: string, error: unknown): NextResponse {
  console.error(`[calendar] loading the ${what} failed:`, error);
  return NextResponse.json(
    { message: `The ${what} could not be loaded. Check the calendar link, or try again later.` },
    { status: 502 }
  );
}
