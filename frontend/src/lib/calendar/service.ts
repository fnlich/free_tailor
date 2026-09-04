import type { CalendarApiResponse, CalendarEvent, CalendarMetadata } from '@/lib/calendar/types';

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
  const payload = await fetchJson<CalendarMetadata>(
    `${CALENDAR_API}?capabilityId=${encodeURIComponent(shareId)}`
  );
  return { source: 'live', data: payload };
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
  const params = new URLSearchParams({
    capabilityId: shareId,
    startDate,
    endDate,
    timeZone: timeZone || 'America/Los_Angeles',
  });

  const payload = await fetchJson<CalendarEvent[]>(`${EVENTS_API}?${params.toString()}`);
  return { source: 'live', data: payload };
}

export async function getEvent(
  shareId: string,
  eventId: string,
  { timeZone }: { timeZone?: string }
): Promise<CalendarApiResponse<CalendarEvent>> {
  const params = new URLSearchParams({
    capabilityId: shareId,
    timeZone: timeZone || 'America/Los_Angeles',
  });

  const payload = await fetchJson<CalendarEvent>(
    `${EVENTS_API}/${encodeURIComponent(eventId)}?${params.toString()}`
  );
  return { source: 'live', data: payload };
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
