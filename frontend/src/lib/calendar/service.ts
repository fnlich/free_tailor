import { sampleCalendar } from '@/lib/calendar/sampleCalendar';
import { sampleEvents } from '@/lib/calendar/sampleEvents';
import type { CalendarApiResponse, CalendarEvent, CalendarMetadata } from '@/lib/calendar/types';

export const SAMPLE_SHARE_ID = sampleCalendar.capabilityId;

const CALENDAR_API = 'https://api.calendar.online/calendar';
const EVENTS_API = 'https://api.calendar.online/event';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function asApiDate(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseEventDate(value: string): Date {
  return new Date(value.replace(' ', 'T'));
}

function filterSampleEvents(events: CalendarEvent[], startDate: string, endDate: string): CalendarEvent[] {
  const start = parseEventDate(startDate);
  const end = parseEventDate(endDate);

  return events.filter((event) => {
    const eventStart = parseEventDate(event.start_date);
    const eventEnd = parseEventDate(event.end_date);
    return eventStart <= end && eventEnd >= start;
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    throw new Error(`Upstream request failed with ${response.status}`);
  }

  const payload = (await response.json()) as T & { success?: boolean; msg?: string };
  if (payload && payload.success === false) {
    throw new Error(payload.msg || 'Upstream API returned an error');
  }

  return payload;
}

export async function getCalendar(shareId: string): Promise<CalendarApiResponse<CalendarMetadata>> {
  try {
    const payload = await fetchJson<CalendarMetadata>(
      `${CALENDAR_API}?capabilityId=${encodeURIComponent(shareId)}`
    );
    return { source: 'live', data: payload };
  } catch (error) {
    if (shareId === SAMPLE_SHARE_ID) {
      return { source: 'fixture', data: sampleCalendar };
    }
    throw error;
  }
}

export async function getEvents(
  shareId: string,
  {
    startDate,
    endDate,
    timeZone,
  }: {
    startDate: string;
    endDate: string;
    timeZone?: string;
  }
): Promise<CalendarApiResponse<CalendarEvent[]>> {
  try {
    const params = new URLSearchParams({
      capabilityId: shareId,
      startDate,
      endDate,
      timeZone: timeZone || 'America/Los_Angeles',
    });

    const payload = await fetchJson<CalendarEvent[]>(`${EVENTS_API}?${params.toString()}`);
    return { source: 'live', data: payload };
  } catch (error) {
    if (shareId === SAMPLE_SHARE_ID) {
      return {
        source: 'fixture',
        data: filterSampleEvents(sampleEvents, startDate, endDate),
      };
    }
    throw error;
  }
}

export async function getEvent(
  shareId: string,
  eventId: string,
  { timeZone }: { timeZone?: string }
): Promise<CalendarApiResponse<CalendarEvent>> {
  try {
    const params = new URLSearchParams({
      capabilityId: shareId,
      timeZone: timeZone || 'America/Los_Angeles',
    });

    const payload = await fetchJson<CalendarEvent>(
      `${EVENTS_API}/${encodeURIComponent(eventId)}?${params.toString()}`
    );
    return { source: 'live', data: payload };
  } catch (error) {
    if (shareId === SAMPLE_SHARE_ID) {
      const event = sampleEvents.find((item) => item.id === eventId);

      if (event) {
        return {
          source: 'fixture',
          data: event,
        };
      }
    }

    throw error;
  }
}

export function getDefaultRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  return {
    startDate: asApiDate(start),
    endDate: asApiDate(end),
  };
}
