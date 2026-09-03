import { NextResponse } from 'next/server';
import { extractLinksFromEvent } from '@/lib/calendar/linkExtractor';
import { getEvent, getEvents } from '@/lib/calendar/service';
import type { CalendarEvent } from '@/lib/calendar/types';

export const dynamic = 'force-dynamic';

type DeepScrapeResult = {
  event: CalendarEvent;
  links: ReturnType<typeof extractLinksFromEvent>;
};

async function mapWithConcurrency<T, TResult>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ shareId: string }> }
) {
  const { shareId } = await context.params;
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const timeZone = searchParams.get('timeZone') ?? undefined;

  if (!startDate || !endDate) {
    return NextResponse.json(
      { message: 'Both startDate and endDate are required.' },
      { status: 400 }
    );
  }

  try {
    const eventList = await getEvents(shareId, {
      startDate,
      endDate,
      timeZone,
    });

    const detailedEvents = await mapWithConcurrency(eventList.data, 12, async (event) => {
      try {
        const detail = await getEvent(shareId, event.id, { timeZone });
        return detail.data;
      } catch {
        return event;
      }
    });

    const results = detailedEvents
      .map<DeepScrapeResult>((event) => ({
        event,
        links: extractLinksFromEvent(event),
      }))
      .filter((result) => result.links.length > 0)
      .sort(
        (left, right) =>
          new Date(left.event.start_date.replace(' ', 'T')).getTime() -
          new Date(right.event.start_date.replace(' ', 'T')).getTime()
      );

    const totalLinks = results.reduce((count, result) => count + result.links.length, 0);

    return NextResponse.json({
      source: eventList.source,
      range: {
        startDate,
        endDate,
      },
      data: {
        scannedEvents: eventList.data.length,
        detailedEvents: detailedEvents.length,
        eventsWithLinks: results.length,
        totalLinks,
        results,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Failed to deep scrape calendar links.' },
      { status: 502 }
    );
  }
}
