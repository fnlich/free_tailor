'use client';

import type { CSSProperties, FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import styles from '@/components/CalendarWorkspace.module.css';
import type { CalendarExtractedLink } from '@/lib/calendar/linkExtractor';
import type { CalendarApiResponse, CalendarEvent, CalendarMetadata } from '@/lib/calendar/types';

const DEFAULT_SHARE_URL =
  process.env.NEXT_PUBLIC_CALENDAR_SHARE_URL ?? 'https://calendar.online/ec52dc9ed413134fcc88';
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_ZONE_OPTIONS = [
  { label: 'PT', value: 'America/Los_Angeles' },
  { label: 'MT', value: 'America/Denver' },
  { label: 'CT', value: 'America/Chicago' },
  { label: 'ET', value: 'America/New_York' },
  { label: 'Vladivostok', value: 'Asia/Vladivostok' },
] as const;

type SupportedTimeZone = (typeof TIME_ZONE_OPTIONS)[number]['value'];
type RgbColor = { r: number; g: number; b: number };
type EventSlotColor = { color: string; name: string };
type AvailabilityWindow = { startMinutes: number; endMinutes: number };
type AvailabilityDay = { dayKey: string; date: Date; windows: AvailabilityWindow[] };
type JobLinkResult = {
  event: CalendarEvent;
  links: CalendarExtractedLink[];
};
type CalendarDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const TIME_INPUT_OPTIONS = Array.from({ length: 48 }, (_, index) => {
  const hours = Math.floor(index / 2);
  const minutes = index % 2 === 0 ? 0 : 30;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  const label = `${displayHour}:${String(minutes).padStart(2, '0')} ${suffix}`;
  const value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  return { label, value };
});
const PREPARE_TIME_OPTIONS = [
  { label: '0', value: 0 },
  { label: '5 mins', value: 5 },
  { label: '10 mins', value: 10 },
  { label: '15 mins', value: 15 },
  { label: '20 mins', value: 20 },
  { label: '30 mins', value: 30 },
] as const;
const MINIMUM_TIME_OPTIONS = [
  { label: '0 mins', value: 0 },
  { label: '15 mins', value: 15 },
  { label: '30 mins', value: 30 },
  { label: '45 mins', value: 45 },
  { label: '1 hour', value: 60 },
] as const;

function parseShareId(value: string): string {
  if (!value) return '';

  try {
    const url = new URL(value);
    const [firstSegment] = url.pathname.split('/').filter(Boolean);
    return firstSegment || '';
  } catch {
    return value.trim().replace(/^\/+|\/+$/g, '');
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toApiDate(date: Date, endOfDay = false): string {
  const normalized = new Date(date);
  if (endOfDay) {
    normalized.setHours(23, 59, 59, 0);
  } else {
    normalized.setHours(0, 0, 0, 0);
  }

  return `${normalized.getFullYear()}-${pad(normalized.getMonth() + 1)}-${pad(normalized.getDate())} ${pad(normalized.getHours())}:${pad(normalized.getMinutes())}:${pad(normalized.getSeconds())}`;
}

function parseEventDate(value: string): Date {
  const [datePart, timePart = '00:00:00'] = value.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0));
}

function parseCalendarDateParts(value: string): CalendarDateParts {
  const [datePart, timePart = '00:00:00'] = value.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);

  return {
    year,
    month,
    day,
    hour,
    minute,
    second: second || 0,
  };
}

function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(date.getFullYear(), date.getMonth(), 15));
}

function formatDayLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatEventTime(value: string): string {
  const { hour, minute } = parseCalendarDateParts(value);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function currentMonthStart(): Date {
  return startOfMonth(new Date());
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function parseDateKey(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function toDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function utcDateFromDayKey(value: string): Date {
  const { year, month, day } = parseDateKey(value);
  return new Date(Date.UTC(year, month - 1, day));
}

function parseTimeInput(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(minutes: number): string {
  const normalizedHours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const suffix = normalizedHours >= 12 ? 'PM' : 'AM';
  const displayHour = normalizedHours % 12 === 0 ? 12 : normalizedHours % 12;
  return `${displayHour}:${String(remainder).padStart(2, '0')} ${suffix}`;
}

function formatCompactMinutes(minutes: number): string {
  const normalizedHours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const suffix = normalizedHours >= 12 ? 'pm' : 'am';
  const displayHour = normalizedHours % 12 === 0 ? 12 : normalizedHours % 12;
  if (remainder === 0) {
    return `${displayHour}${suffix}`;
  }

  return `${displayHour}:${String(remainder).padStart(2, '0')} ${suffix}`;
}

function formatAvailabilityDayText(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

function enumerateDayKeys(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = utcDateFromDayKey(start);
  const endDate = utcDateFromDayKey(end);

  while (cursor <= endDate) {
    dates.push(
      `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

function wallClockTimestampForValue(value: string): number {
  const { year, month, day, hour, minute, second } = parseCalendarDateParts(value);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function wallClockTimestampForDayKey(dayKey: string, minutes: number): number {
  const { year, month, day } = parseDateKey(dayKey);
  return Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60, 0);
}

function hexToRgb(color: string): RgbColor | null {
  const normalized = color.trim().replace('#', '');

  if (!/^[\da-f]{3}([\da-f]{3})?$/i.test(normalized)) {
    return null;
  }

  const expanded = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;
  const value = Number.parseInt(expanded, 16);

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgbToHex({ r, g, b }: RgbColor): string {
  const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function darkenColor(color: string, ratio: number): string {
  const rgb = hexToRgb(color);
  if (!rgb) return color;

  return rgbToHex({
    r: rgb.r * (1 - ratio),
    g: rgb.g * (1 - ratio),
    b: rgb.b * (1 - ratio),
  });
}

function averageColors(colors: string[]): string {
  const rgbs = colors.map(hexToRgb).filter((value): value is RgbColor => value !== null);
  if (rgbs.length === 0) return '#475569';

  const total = rgbs.reduce(
    (accumulator, current) => ({
      r: accumulator.r + current.r,
      g: accumulator.g + current.g,
      b: accumulator.b + current.b,
    }),
    { r: 0, g: 0, b: 0 },
  );

  return rgbToHex({
    r: total.r / rgbs.length,
    g: total.g / rgbs.length,
    b: total.b / rgbs.length,
  });
}

function buildMonthGrid(date: Date, firstWeekday: number): Date[] {
  const monthStart = startOfMonth(date);
  const monthEnd = endOfMonth(date);
  const leading = (monthStart.getDay() - firstWeekday + 7) % 7;
  const firstCell = new Date(monthStart);
  firstCell.setDate(monthStart.getDate() - leading);

  const trailing = 41 - ((monthEnd.getTime() - firstCell.getTime()) / 86400000);
  const lastCell = new Date(monthEnd);
  lastCell.setDate(monthEnd.getDate() + trailing);

  const days: Date[] = [];
  const cursor = new Date(firstCell);

  while (cursor <= lastCell) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function colorForEvent(event: CalendarEvent, metadata: CalendarMetadata | null): string {
  const firstSubCalendarId = event.subCalendars?.[0];
  return metadata?.subCalendars.find((item) => item.id === firstSubCalendarId)?.color || '#5575a7';
}

function slotColorsForEvent(event: CalendarEvent, metadata: CalendarMetadata | null): EventSlotColor[] {
  if (!metadata) return [{ color: '#5575a7', name: '' }];

  const subCalendarMap = new Map(metadata.subCalendars.map((item) => [item.id, item]));
  const resolvedSlots = event.subCalendars
    .map((id) => subCalendarMap.get(id))
    .filter((item): item is CalendarMetadata['subCalendars'][number] => Boolean(item))
    .map((item) => ({ color: item.color, name: item.name }));

  const uniqueSlots = Array.from(
    new Map(resolvedSlots.map((item) => [`${item.name}:${item.color}`.toLowerCase(), item])).values()
  ).slice(0, 2);

  if (uniqueSlots.length !== 2) {
    return uniqueSlots.length > 0 ? uniqueSlots : [{ color: '#5575a7', name: '' }];
  }

  const leftPriorityNames = ['radmin', 'ralf'];
  const preferredLeft = uniqueSlots.find((slot) => leftPriorityNames.includes(slot.name.toLowerCase()));

  if (!preferredLeft) {
    return uniqueSlots;
  }

  const rightSlot = uniqueSlots.find((slot) => slot !== preferredLeft);
  return rightSlot ? [preferredLeft, rightSlot] : [preferredLeft];
}

function reorderWeekdayLabels(firstWeekday: number): string[] {
  return WEEKDAY_LABELS.slice(firstWeekday).concat(WEEKDAY_LABELS.slice(0, firstWeekday));
}

function getTimeZoneLabel(timeZone: SupportedTimeZone): string {
  return TIME_ZONE_OPTIONS.find((option) => option.value === timeZone)?.label ?? 'PT';
}

export default function CalendarWorkspace() {
  const initialShareId = parseShareId(DEFAULT_SHARE_URL);
  const defaultAvailabilityStart = toDateInputValue(addDays(new Date(), 1));
  const defaultAvailabilityEnd = toDateInputValue(addDays(new Date(), 8));
  const defaultJobLinkFromDate = toDateInputValue(currentMonthStart());
  const defaultJobLinkToDate = toDateInputValue(endOfMonth(currentMonthStart()));

  const [shareInput, setShareInput] = useState(DEFAULT_SHARE_URL);
  const [shareId, setShareId] = useState(initialShareId);
  const [metadata, setMetadata] = useState<CalendarMetadata | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState('');
  const [isLoadingMeta, setIsLoadingMeta] = useState(true);
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [currentView, setCurrentView] = useState<'month' | 'agenda'>('month');
  const [currentMonth, setCurrentMonth] = useState(() => currentMonthStart());
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [selectedTimeZone, setSelectedTimeZone] = useState<SupportedTimeZone>('America/Los_Angeles');
  const [searchTerm, setSearchTerm] = useState('');
  const [activeSubCalendars, setActiveSubCalendars] = useState<Set<number>>(new Set());
  const [isAvailabilityOpen, setIsAvailabilityOpen] = useState(false);
  const [isJobLinksOpen, setIsJobLinksOpen] = useState(false);
  const [availabilityTimeZone, setAvailabilityTimeZone] = useState<SupportedTimeZone>('America/Los_Angeles');
  const [availabilityFromDate, setAvailabilityFromDate] = useState(defaultAvailabilityStart);
  const [availabilityToDate, setAvailabilityToDate] = useState(defaultAvailabilityEnd);
  const [availabilityFromTime, setAvailabilityFromTime] = useState('09:00');
  const [availabilityToTime, setAvailabilityToTime] = useState('17:00');
  const [availabilityPrepareMinutes, setAvailabilityPrepareMinutes] = useState(0);
  const [availabilityMinimumMinutes, setAvailabilityMinimumMinutes] = useState(0);
  const [availabilityUserIds, setAvailabilityUserIds] = useState<Set<number>>(new Set());
  const [availabilityResults, setAvailabilityResults] = useState<AvailabilityDay[]>([]);
  const [availabilityError, setAvailabilityError] = useState('');
  const [isLoadingAvailability, setIsLoadingAvailability] = useState(false);
  const [hasAvailabilitySearched, setHasAvailabilitySearched] = useState(false);
  const [availabilityViewMode, setAvailabilityViewMode] = useState<'list' | 'text'>('text');
  const [availabilityCopyState, setAvailabilityCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [jobLinksFromDate, setJobLinksFromDate] = useState(defaultJobLinkFromDate);
  const [jobLinksToDate, setJobLinksToDate] = useState(defaultJobLinkToDate);
  const [jobLinkResults, setJobLinkResults] = useState<JobLinkResult[]>([]);
  const [jobLinksError, setJobLinksError] = useState('');
  const [isLoadingJobLinks, setIsLoadingJobLinks] = useState(false);
  const [hasJobLinksSearched, setHasJobLinksSearched] = useState(false);
  const [jobLinksCopyState, setJobLinksCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    let cancelled = false;

    async function loadCalendar() {
      setIsLoadingMeta(true);
      setError('');

      try {
        const response = await fetch(`/api/calendars/${shareId}`);
        const payload = (await response.json()) as CalendarApiResponse<CalendarMetadata> & { message?: string };

        if (!response.ok) {
          throw new Error(payload.message || 'Failed to load calendar');
        }

        if (!cancelled) {
          setMetadata(payload.data);
          setActiveSubCalendars(new Set(payload.data.subCalendars.map((item) => item.id)));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load calendar');
          setMetadata(null);
          setEvents([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingMeta(false);
        }
      }
    }

    loadCalendar();

    return () => {
      cancelled = true;
    };
  }, [shareId]);

  useEffect(() => {
    if (!metadata) return;

    let cancelled = false;

    async function loadEvents() {
      setIsLoadingEvents(true);

      const monthStart = startOfMonth(currentMonth);
      const monthEnd = endOfMonth(currentMonth);
      const params = new URLSearchParams({
        startDate: toApiDate(monthStart),
        endDate: toApiDate(monthEnd, true),
        timeZone: selectedTimeZone,
      });

      try {
        const response = await fetch(`/api/calendars/${shareId}/events?${params.toString()}`);
        const payload = (await response.json()) as CalendarApiResponse<CalendarEvent[]> & { message?: string };

        if (!response.ok) {
          throw new Error(payload.message || 'Failed to load events');
        }

        if (!cancelled) {
          setEvents(payload.data);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load events');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingEvents(false);
        }
      }
    }

    loadEvents();

    return () => {
      cancelled = true;
    };
  }, [shareId, metadata, currentMonth, selectedTimeZone]);

  useEffect(() => {
    if (!selectedEvent && !isAvailabilityOpen && !isJobLinksOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectedEvent) {
          setSelectedEvent(null);
        } else if (isAvailabilityOpen) {
          setIsAvailabilityOpen(false);
        } else {
          setIsJobLinksOpen(false);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAvailabilityOpen, isJobLinksOpen, selectedEvent]);

  const weekdayLabels = useMemo(
    () => reorderWeekdayLabels(metadata?.firstWeekday ?? 0),
    [metadata]
  );

  const gridDays = useMemo(() => {
    if (!metadata) return [];
    return buildMonthGrid(currentMonth, metadata.firstWeekday ?? 0);
  }, [currentMonth, metadata]);

  const visibleEvents = useMemo(() => {
    return events
      .filter((event) => {
        const haystack = [event.title, event.text, event.who, event.where].join(' ').toLowerCase();
        const matchesSearch = searchTerm.trim() === '' || haystack.includes(searchTerm.toLowerCase());
        const matchesCalendar = event.subCalendars?.some((id) => activeSubCalendars.has(id));
        return matchesSearch && matchesCalendar;
      })
      .sort((left, right) => parseEventDate(left.start_date).getTime() - parseEventDate(right.start_date).getTime());
  }, [activeSubCalendars, events, searchTerm]);

  const eventsByDay = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();

    for (const event of visibleEvents) {
      const date = event.start_date.slice(0, 10);
      const bucket = grouped.get(date) || [];
      bucket.push(event);
      grouped.set(date, bucket);
    }

    return grouped;
  }, [visibleEvents]);

  const agendaGroups = useMemo(() => {
    return Array.from(eventsByDay.entries()).map(([day, dayEvents]) => ({
      day,
      date: parseEventDate(`${day} 00:00:00`),
      events: dayEvents,
    }));
  }, [eventsByDay]);

  const availabilityUserNames = useMemo(() => {
    if (!metadata) return [];
    return metadata.subCalendars
      .filter((item) => availabilityUserIds.has(item.id))
      .map((item) => item.name);
  }, [availabilityUserIds, metadata]);

  const availabilityTextOutput = useMemo(() => {
    if (availabilityResults.length === 0) return '';

    return [
      `All times in ${getTimeZoneLabel(availabilityTimeZone)}`,
      ...availabilityResults.map((day) =>
        `${formatAvailabilityDayText(day.date)}: ${day.windows
          .map((window) => `${formatCompactMinutes(window.startMinutes)} - ${formatCompactMinutes(window.endMinutes)}`)
          .join(', ')}`
      ),
    ].join('\n');
  }, [availabilityResults, availabilityTimeZone]);

  const jobLinksTextOutput = useMemo(() => {
    if (jobLinkResults.length === 0) return '';

    return jobLinkResults
      .flatMap((result) =>
        result.links.map((link) => {
          const day = formatDayLabel(parseEventDate(result.event.start_date));
          const time = `${formatEventTime(result.event.start_date)} - ${formatEventTime(result.event.end_date)}`;
          return `${day} | ${time} | ${result.event.title} | ${link.kind} | ${link.url}`;
        })
      )
      .join('\n');
  }, [jobLinkResults]);

  const totalJobLinkCount = useMemo(
    () => jobLinkResults.reduce((count, result) => count + result.links.length, 0),
    [jobLinkResults]
  );

  function submitShareId(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextShareId = parseShareId(shareInput);

    if (nextShareId) {
      setShareId(nextShareId);
      setSelectedEvent(null);
      setCurrentMonth(currentMonthStart());
    }
  }

  function toggleSubCalendar(id: number) {
    setActiveSubCalendars((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function legendStyle(color: string): CSSProperties {
    return { '--legend-color': color } as CSSProperties;
  }

  function toggleAvailabilityUser(id: number) {
    setAvailabilityCopyState('idle');
    setAvailabilityUserIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function copyAvailability() {
    if (!availabilityTextOutput) return;

    try {
      await navigator.clipboard.writeText(availabilityTextOutput);
      setAvailabilityCopyState('copied');
    } catch {
      setAvailabilityCopyState('failed');
    }
  }

  async function copyJobLinks() {
    if (!jobLinksTextOutput) return;

    try {
      await navigator.clipboard.writeText(jobLinksTextOutput);
      setJobLinksCopyState('copied');
    } catch {
      setJobLinksCopyState('failed');
    }
  }

  async function findAvailability() {
    if (!metadata) return;
    setAvailabilityCopyState('idle');

    if (availabilityUserIds.size === 0) {
      setAvailabilityError('Select at least one user.');
      setAvailabilityResults([]);
      setHasAvailabilitySearched(false);
      return;
    }

    if (!availabilityFromDate || !availabilityToDate) {
      setAvailabilityError('Select both From Day and To Day.');
      setAvailabilityResults([]);
      setHasAvailabilitySearched(false);
      return;
    }

    const fromMinutes = parseTimeInput(availabilityFromTime);
    const toMinutes = parseTimeInput(availabilityToTime);

    if (availabilityFromDate > availabilityToDate) {
      setAvailabilityError('From Day must be on or before To Day.');
      setAvailabilityResults([]);
      setHasAvailabilitySearched(false);
      return;
    }

    if (fromMinutes >= toMinutes) {
      setAvailabilityError('From Time must be earlier than To Time.');
      setAvailabilityResults([]);
      setHasAvailabilitySearched(false);
      return;
    }

    setIsLoadingAvailability(true);
    setAvailabilityError('');
    setHasAvailabilitySearched(true);

    try {
      const params = new URLSearchParams({
        startDate: `${availabilityFromDate} 00:00:00`,
        endDate: `${availabilityToDate} 23:59:59`,
        timeZone: availabilityTimeZone,
      });
      const response = await fetch(`/api/calendars/${shareId}/events?${params.toString()}`);
      const payload = (await response.json()) as CalendarApiResponse<CalendarEvent[]> & { message?: string };

      if (!response.ok) {
        throw new Error(payload.message || 'Failed to load availability.');
      }

      const selectedIds = availabilityUserIds;
      const relevantEvents = payload.data.filter((event) => event.subCalendars.some((id) => selectedIds.has(id)));

      const nextResults = enumerateDayKeys(availabilityFromDate, availabilityToDate).map((dayKey) => {
        const dayDate = utcDateFromDayKey(dayKey);
        const dayStartTimestamp = wallClockTimestampForDayKey(dayKey, 0);
        const windowStartTimestamp = wallClockTimestampForDayKey(dayKey, fromMinutes);
        const windowEndTimestamp = wallClockTimestampForDayKey(dayKey, toMinutes);

        const busyWindows = relevantEvents
          .map((event) => {
            const eventStartTimestamp = wallClockTimestampForValue(event.start_date);
            const eventEndTimestamp = wallClockTimestampForValue(event.end_date);
            const overlapStart = Math.max(eventStartTimestamp, windowStartTimestamp);
            const overlapEnd = Math.min(eventEndTimestamp, windowEndTimestamp);

            if (overlapStart >= overlapEnd) {
              return null;
            }

            return {
              startMinutes: Math.round((overlapStart - dayStartTimestamp) / 60000),
              endMinutes: Math.round((overlapEnd - dayStartTimestamp) / 60000),
            };
          })
          .filter((window): window is AvailabilityWindow => Boolean(window))
          .sort((left, right) => left.startMinutes - right.startMinutes);

        const mergedBusy = busyWindows.reduce<AvailabilityWindow[]>((merged, current) => {
          const previous = merged[merged.length - 1];

          if (!previous || current.startMinutes > previous.endMinutes) {
            merged.push({ ...current });
            return merged;
          }

          previous.endMinutes = Math.max(previous.endMinutes, current.endMinutes);
          return merged;
        }, []);

        const freeWindows: AvailabilityWindow[] = [];
        let cursor = fromMinutes;

        for (const busy of mergedBusy) {
          if (busy.startMinutes > cursor) {
            freeWindows.push({ startMinutes: cursor, endMinutes: busy.startMinutes });
          }
          cursor = Math.max(cursor, busy.endMinutes);
        }

        if (cursor < toMinutes) {
          freeWindows.push({ startMinutes: cursor, endMinutes: toMinutes });
        }

        const adjustedWindows = freeWindows
          .map((window) => {
            const touchesRangeStart = window.startMinutes === fromMinutes;
            const touchesRangeEnd = window.endMinutes === toMinutes;

            return {
              startMinutes: touchesRangeStart
                ? window.startMinutes
                : window.startMinutes + availabilityPrepareMinutes,
              endMinutes: touchesRangeEnd
                ? window.endMinutes
                : window.endMinutes - availabilityPrepareMinutes,
            };
          })
          .filter((window) => window.startMinutes < window.endMinutes)
          .filter((window) => window.endMinutes - window.startMinutes >= availabilityMinimumMinutes);

        return {
          dayKey,
          date: dayDate,
          windows: adjustedWindows,
        };
      }).filter((day) => day.windows.length > 0);

      setAvailabilityResults(nextResults);
    } catch (loadError) {
      setAvailabilityError(loadError instanceof Error ? loadError.message : 'Failed to load availability.');
      setAvailabilityResults([]);
    } finally {
      setIsLoadingAvailability(false);
    }
  }

  async function findJobLinks() {
    setJobLinksCopyState('idle');

    if (!jobLinksFromDate || !jobLinksToDate) {
      setJobLinksError('Select both From Day and To Day.');
      setJobLinkResults([]);
      setHasJobLinksSearched(false);
      return;
    }

    if (jobLinksFromDate > jobLinksToDate) {
      setJobLinksError('From Day must be on or before To Day.');
      setJobLinkResults([]);
      setHasJobLinksSearched(false);
      return;
    }

    setIsLoadingJobLinks(true);
    setJobLinksError('');
    setHasJobLinksSearched(true);

    try {
      const params = new URLSearchParams({
        startDate: `${jobLinksFromDate} 00:00:00`,
        endDate: `${jobLinksToDate} 23:59:59`,
        timeZone: selectedTimeZone,
      });
      const response = await fetch(`/api/calendars/${shareId}/links?${params.toString()}`);
      const payload = (await response.json()) as {
        data?: {
          results: JobLinkResult[];
        };
        message?: string;
      };

      if (!response.ok) {
        throw new Error(payload.message || 'Failed to load links.');
      }

      setJobLinkResults(payload.data?.results ?? []);
    } catch (loadError) {
      setJobLinksError(loadError instanceof Error ? loadError.message : 'Failed to load links.');
      setJobLinkResults([]);
    } finally {
      setIsLoadingJobLinks(false);
    }
  }

  function eventStyle(event: CalendarEvent): CSSProperties {
    const colors = slotColorsForEvent(event, metadata).map((slot) => darkenColor(slot.color, 0.28));
    const background = colors.length === 1
      ? colors[0]
      : `linear-gradient(120deg, ${colors[0]} 0 50%, ${colors[1]} 50% 100%)`;
    const borderColor = darkenColor(averageColors(colors), 0.34);

    return {
      '--event-color': colors[0],
      '--event-background': background,
      '--event-border-color': borderColor,
      '--event-text-color': '#ffffff',
    } as CSSProperties;
  }

  if (isLoadingMeta && !metadata) {
    return <div className="border border-gray-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-950">Loading calendar...</div>;
  }

  return (
    <div className={styles.pageShell}>
      {error ? <div className={styles.errorBanner}>{error}</div> : null}

      <section className={styles.appFrame}>
        <aside className={styles.sidebar}>
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>Load a calendar share link</h2>
            <form className={styles.shareForm} onSubmit={submitShareId}>
              <div>
                <label className={styles.shareLabel} htmlFor="share-link">Share Link</label>
                <div className={styles.shareRow}>
                  <input
                    id="share-link"
                    className={styles.input}
                    value={shareInput}
                    onChange={(event) => setShareInput(event.target.value)}
                    placeholder="https://calendar.online/..."
                  />
                  <button className={styles.primaryButton} type="submit">Load Calendar</button>
                </div>
              </div>
            </form>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Calendar</h2>
              <span className={styles.pill}>{getTimeZoneLabel(selectedTimeZone)}</span>
            </div>
            <div className={styles.metaGrid}>
              <div>
                <span className={styles.metaLabel}>Display Zone</span>
                <div className={styles.selectWrap}>
                  <select
                    className={styles.select}
                    value={selectedTimeZone}
                    onChange={(event) => setSelectedTimeZone(event.target.value as SupportedTimeZone)}
                  >
                    {TIME_ZONE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <span className={styles.metaLabel}>Events This Range</span>
                <span className={styles.metaValue}>{visibleEvents.length}</span>
              </div>
              <div>
                <span className={styles.metaLabel}>iCal Feed</span>
                <a className={`${styles.metaValue} ${styles.metaLink}`} href={metadata?.ics} target="_blank" rel="noreferrer">
                  Open feed
                </a>
              </div>
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Sub-calendars</h2>
              <button
                className={styles.ghostButton}
                type="button"
                onClick={() => setActiveSubCalendars(new Set(metadata?.subCalendars.map((item) => item.id) ?? []))}
              >
                Reset
              </button>
            </div>
            <div className={styles.legendList}>
              {metadata?.subCalendars.map((subCalendar) => {
                const isActive = activeSubCalendars.has(subCalendar.id);
                return (
                  <button
                    key={subCalendar.id}
                    type="button"
                    className={`${styles.legendItem} ${isActive ? styles.legendItemActive : ''}`}
                    onClick={() => toggleSubCalendar(subCalendar.id)}
                    style={legendStyle(subCalendar.color)}
                  >
                    <span className={styles.legendSwatch} />
                    <span>{subCalendar.name}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Filters</h2>
            </div>
            <input
              className={styles.searchInput}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search title, notes, person or place"
            />
          </section>

          <section className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Availability</h2>
            </div>
            <button className={styles.primaryButton} type="button" onClick={() => setIsAvailabilityOpen(true)}>
              Availability
            </button>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Links</h2>
            </div>
            <button className={styles.primaryButton} type="button" onClick={() => setIsJobLinksOpen(true)}>
              Deep Scrape Links
            </button>
          </section>
        </aside>

        <div className={styles.calendarStage}>
          <div className={styles.toolbar}>
            <div className={styles.navGroup}>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))}
              >
                Prev
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => setCurrentMonth(currentMonthStart())}
              >
                Current
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))}
              >
                Next
              </button>
            </div>

            <div className={styles.toolbarTitle}>
              <h2>{formatMonthLabel(currentMonth)}</h2>
              <span>{isLoadingEvents ? 'Refreshing events...' : `${visibleEvents.length} visible events`}</span>
            </div>

            <div className={styles.viewSwitcher}>
              <button
                className={`${styles.secondaryButton} ${currentView === 'month' ? styles.isActive : ''}`}
                type="button"
                onClick={() => setCurrentView('month')}
              >
                Month
              </button>
              <button
                className={`${styles.secondaryButton} ${currentView === 'agenda' ? styles.isActive : ''}`}
                type="button"
                onClick={() => setCurrentView('agenda')}
              >
                Agenda
              </button>
            </div>
          </div>

          {currentView === 'month' ? (
            <div className={styles.monthGrid}>
              {weekdayLabels.map((label) => (
                <div key={label} className={styles.monthGridHeader}>{label}</div>
              ))}

              {gridDays.map((day) => {
                const key = day.toISOString().slice(0, 10);
                const dayEvents = eventsByDay.get(key) || [];
                const isCurrentMonth = day.getMonth() === currentMonth.getMonth();

                return (
                  <article key={key} className={`${styles.dayCard} ${isCurrentMonth ? '' : styles.dayCardMuted}`}>
                    <div className={styles.dayCardHeader}>
                      <span>{day.getDate()}</span>
                      {dayEvents.length > 0 ? <small>{dayEvents.length}</small> : null}
                    </div>
                    <div className={styles.dayCardEvents}>
                      {dayEvents.map((event) => (
                        <button
                          key={event.id}
                          className={styles.eventChip}
                          type="button"
                          onClick={() => setSelectedEvent(event)}
                          style={eventStyle(event)}
                          title={`${formatEventTime(event.start_date)} ${event.title}`}
                        >
                          <strong>{formatEventTime(event.start_date)}</strong>
                          <span>{event.title}</span>
                        </button>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className={styles.agendaList}>
              {agendaGroups.map((group) => (
                <section key={group.day} className={styles.agendaDay}>
                  <div className={styles.agendaDayTitle}>{formatDayLabel(group.date)}</div>
                  <div className={styles.agendaDayEvents}>
                    {group.events.map((event) => (
                      <button
                        key={event.id}
                        className={styles.agendaEvent}
                        type="button"
                        onClick={() => setSelectedEvent(event)}
                        style={eventStyle(event)}
                        title={`${formatEventTime(event.start_date)} - ${formatEventTime(event.end_date)} ${event.title}`}
                      >
                        <div className={styles.agendaEventContent}>
                          <div className={styles.agendaEventTime}>
                            {formatEventTime(event.start_date)} - {formatEventTime(event.end_date)}
                          </div>
                          <div className={styles.agendaEventTitle}>{event.title}</div>
                          {event.who || event.where ? (
                            <div className={styles.agendaEventMeta}>{[event.who, event.where].filter(Boolean).join(' · ')}</div>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

      </section>

      {selectedEvent ? (
        <div className={styles.modalBackdrop} onClick={() => setSelectedEvent(null)} role="presentation">
          <section
            className={styles.modalPanel}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="calendar-event-title"
          >
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Event Details</h2>
              <button className={styles.ghostButton} type="button" onClick={() => setSelectedEvent(null)}>
                Close
              </button>
            </div>
            <div
              className={styles.detailsAccent}
              style={{ backgroundColor: colorForEvent(selectedEvent, metadata) }}
            />
            <h3 className={styles.detailsHeading} id="calendar-event-title">{selectedEvent.title}</h3>
            <p className={styles.detailsTime}>
              {formatDayLabel(parseEventDate(selectedEvent.start_date))} ·{' '}
              {formatEventTime(selectedEvent.start_date)} -{' '}
              {formatEventTime(selectedEvent.end_date)}
            </p>
            <p className={styles.detailsMeta}><strong>Time Zone:</strong> {getTimeZoneLabel(selectedTimeZone)}</p>
            {selectedEvent.who ? <p className={styles.detailsMeta}><strong>Who:</strong> {selectedEvent.who}</p> : null}
            {selectedEvent.where ? <p className={styles.detailsMeta}><strong>Where:</strong> {selectedEvent.where}</p> : null}
            {selectedEvent.text ? <p className={styles.detailsCopy}>{selectedEvent.text}</p> : null}
          </section>
        </div>
      ) : null}

      {isAvailabilityOpen ? (
        <div className={styles.modalBackdrop} onClick={() => setIsAvailabilityOpen(false)} role="presentation">
          <section
            className={`${styles.modalPanel} ${styles.availabilityModal}`}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="availability-modal-title"
          >
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle} id="availability-modal-title">Availability</h2>
              <button className={styles.ghostButton} type="button" onClick={() => setIsAvailabilityOpen(false)}>
                Close
              </button>
            </div>

            <div className={styles.availabilityFields}>
              <div>
                <label className={styles.shareLabel} htmlFor="availability-from-day">From Day</label>
                <input
                  id="availability-from-day"
                  className={styles.input}
                  type="date"
                  value={availabilityFromDate}
                  onChange={(event) => {
                    setAvailabilityFromDate(event.target.value);
                    setAvailabilityCopyState('idle');
                  }}
                />
              </div>
              <div>
                <label className={styles.shareLabel} htmlFor="availability-to-day">To Day</label>
                <input
                  id="availability-to-day"
                  className={styles.input}
                  type="date"
                  value={availabilityToDate}
                  onChange={(event) => {
                    setAvailabilityToDate(event.target.value);
                    setAvailabilityCopyState('idle');
                  }}
                />
              </div>
              <div className={styles.availabilityTimeRange}>
                <div>
                  <label className={styles.shareLabel} htmlFor="availability-from-time">From Time</label>
                  <select
                    id="availability-from-time"
                    className={styles.select}
                    value={availabilityFromTime}
                    onChange={(event) => {
                      setAvailabilityFromTime(event.target.value);
                      setAvailabilityCopyState('idle');
                    }}
                  >
                    {TIME_INPUT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={styles.shareLabel} htmlFor="availability-to-time">To Time</label>
                  <select
                    id="availability-to-time"
                    className={styles.select}
                    value={availabilityToTime}
                    onChange={(event) => {
                      setAvailabilityToTime(event.target.value);
                      setAvailabilityCopyState('idle');
                    }}
                  >
                    {TIME_INPUT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className={styles.shareLabel} htmlFor="availability-prepare-time">Prepare Time</label>
                <select
                  id="availability-prepare-time"
                  className={styles.select}
                  value={String(availabilityPrepareMinutes)}
                  onChange={(event) => {
                    setAvailabilityPrepareMinutes(Number(event.target.value));
                    setAvailabilityCopyState('idle');
                  }}
                >
                  {PREPARE_TIME_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={styles.shareLabel} htmlFor="availability-minimum-time">Minimum Time</label>
                <select
                  id="availability-minimum-time"
                  className={styles.select}
                  value={String(availabilityMinimumMinutes)}
                  onChange={(event) => {
                    setAvailabilityMinimumMinutes(Number(event.target.value));
                    setAvailabilityCopyState('idle');
                  }}
                >
                  {MINIMUM_TIME_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.availabilityControlRow}>
                <div>
                  <label className={styles.shareLabel} htmlFor="availability-time-zone">Time Zone</label>
                  <select
                    id="availability-time-zone"
                    className={styles.select}
                    value={availabilityTimeZone}
                    onChange={(event) => {
                      setAvailabilityTimeZone(event.target.value as SupportedTimeZone);
                      setAvailabilityCopyState('idle');
                    }}
                  >
                    {TIME_ZONE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={styles.shareLabel} htmlFor="availability-view-mode">View</label>
                  <select
                    id="availability-view-mode"
                    className={styles.select}
                    value={availabilityViewMode}
                    onChange={(event) => {
                      setAvailabilityViewMode(event.target.value as 'list' | 'text');
                      setAvailabilityCopyState('idle');
                    }}
                  >
                    <option value="list">List style</option>
                    <option value="text">Text style</option>
                  </select>
                </div>
              </div>
            </div>

            <div className={styles.availabilityUsers}>
              <div className={styles.panelTitleRow}>
                <h3 className={styles.panelTitle}>Users</h3>
                <button
                  className={styles.ghostButton}
                  type="button"
                  onClick={() => {
                    setAvailabilityUserIds(new Set(metadata?.subCalendars.map((item) => item.id) ?? []));
                    setAvailabilityCopyState('idle');
                  }}
                >
                  Select All
                </button>
              </div>
              <div className={styles.availabilityUserList}>
                {metadata?.subCalendars.map((subCalendar) => {
                  const isSelected = availabilityUserIds.has(subCalendar.id);

                  return (
                    <label key={subCalendar.id} className={`${styles.availabilityUserItem} ${isSelected ? styles.availabilityUserItemActive : ''}`}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleAvailabilityUser(subCalendar.id)}
                      />
                      <span className={styles.legendSwatch} style={legendStyle(subCalendar.color)} />
                      <span>{subCalendar.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className={styles.availabilityActions}>
              <button className={styles.primaryButton} type="button" onClick={findAvailability} disabled={isLoadingAvailability}>
                {isLoadingAvailability ? 'Checking...' : 'Find Availability'}
              </button>
              <span className={styles.availabilitySummary}>
                {availabilityFromDate} - {availabilityToDate} · {getTimeZoneLabel(availabilityTimeZone)} · {formatMinutes(parseTimeInput(availabilityFromTime))} - {formatMinutes(parseTimeInput(availabilityToTime))} · Prep {availabilityPrepareMinutes} min · Min {availabilityMinimumMinutes} min
              </span>
            </div>

            {availabilityUserNames.length > 0 ? (
              <p className={styles.availabilityUsersText}>{availabilityUserNames.join(', ')}</p>
            ) : null}
            {availabilityError ? <div className={styles.errorBanner}>{availabilityError}</div> : null}

            <div className={styles.availabilityResults}>
              {availabilityResults.length === 0 && !isLoadingAvailability && !availabilityError && !hasAvailabilitySearched ? (
                <p className={styles.emptyState}>Select users and click Find Availability.</p>
              ) : null}
              {availabilityViewMode === 'list'
                ? availabilityResults.map((day) => (
                    <section key={day.dayKey} className={styles.availabilityDay}>
                      <h3 className={styles.availabilityDayTitle}>{formatDayLabel(day.date)}</h3>
                      <div className={styles.availabilityWindowList}>
                        {day.windows.map((window) => (
                          <span key={`${day.dayKey}-${window.startMinutes}-${window.endMinutes}`} className={styles.availabilityWindow}>
                            {formatMinutes(window.startMinutes)} - {formatMinutes(window.endMinutes)}
                          </span>
                        ))}
                      </div>
                    </section>
                  ))
                : null}
              {availabilityViewMode === 'text' && availabilityResults.length > 0 ? (
                <div className={styles.availabilityTextBlock}>
                  <p className={styles.availabilityTextHeader}>All times in {getTimeZoneLabel(availabilityTimeZone)}</p>
                  {availabilityResults.map((day) => (
                    <p key={day.dayKey} className={styles.availabilityTextLine}>
                      {formatAvailabilityDayText(day.date)}: {day.windows.map((window) => `${formatCompactMinutes(window.startMinutes)} - ${formatCompactMinutes(window.endMinutes)}`).join(', ')}
                    </p>
                  ))}
                </div>
              ) : null}
              {availabilityResults.length === 0 && !isLoadingAvailability && availabilityUserNames.length > 0 && !availabilityError && hasAvailabilitySearched ? (
                <p className={styles.emptyState}>No shared availability found for the selected range.</p>
              ) : null}
            </div>

            <div className={styles.availabilityFooter}>
              {availabilityCopyState === 'copied' ? <span className={styles.availabilityCopyStatus}>Copied</span> : null}
              {availabilityCopyState === 'failed' ? <span className={styles.availabilityCopyStatus}>Copy failed</span> : null}
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={copyAvailability}
                disabled={!availabilityTextOutput}
              >
                Copy Availability
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isJobLinksOpen ? (
        <div className={styles.modalBackdrop} onClick={() => setIsJobLinksOpen(false)} role="presentation">
          <section
            className={`${styles.modalPanel} ${styles.jobLinksModal}`}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="job-links-modal-title"
          >
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle} id="job-links-modal-title">All Links</h2>
              <button className={styles.ghostButton} type="button" onClick={() => setIsJobLinksOpen(false)}>
                Close
              </button>
            </div>

            <div className={styles.jobLinksFields}>
              <div>
                <label className={styles.shareLabel} htmlFor="job-links-from-day">From Day</label>
                <input
                  id="job-links-from-day"
                  className={styles.input}
                  type="date"
                  value={jobLinksFromDate}
                  onChange={(event) => {
                    setJobLinksFromDate(event.target.value);
                    setJobLinksCopyState('idle');
                  }}
                />
              </div>
              <div>
                <label className={styles.shareLabel} htmlFor="job-links-to-day">To Day</label>
                <input
                  id="job-links-to-day"
                  className={styles.input}
                  type="date"
                  value={jobLinksToDate}
                  onChange={(event) => {
                    setJobLinksToDate(event.target.value);
                    setJobLinksCopyState('idle');
                  }}
                />
              </div>
            </div>

            <div className={styles.jobLinksActions}>
              <button className={styles.primaryButton} type="button" onClick={findJobLinks} disabled={isLoadingJobLinks}>
                {isLoadingJobLinks ? 'Scraping...' : 'Deep Scrape Links'}
              </button>
              <span className={styles.jobLinksSummary}>
                {jobLinksFromDate} - {jobLinksToDate} · {getTimeZoneLabel(selectedTimeZone)} · All slots
              </span>
            </div>

            {jobLinksError ? <div className={styles.errorBanner}>{jobLinksError}</div> : null}

            <div className={styles.jobLinksResults}>
              {jobLinkResults.length === 0 && !isLoadingJobLinks && !jobLinksError && !hasJobLinksSearched ? (
                <p className={styles.emptyState}>Choose a range and click Deep Scrape Links.</p>
              ) : null}
              {jobLinkResults.length === 0 && !isLoadingJobLinks && !jobLinksError && hasJobLinksSearched ? (
                <p className={styles.emptyState}>No links were found in the selected range.</p>
              ) : null}
              {jobLinkResults.length > 0 ? (
                <>
                  <p className={styles.jobLinksCount}>
                    Found {totalJobLinkCount} link{totalJobLinkCount === 1 ? '' : 's'} across {jobLinkResults.length} event{jobLinkResults.length === 1 ? '' : 's'}.
                  </p>
                  {jobLinkResults.map((result) => (
                    <section key={result.event.id} className={styles.jobLinkCard}>
                      <div className={styles.jobLinkCardHeader}>
                        <h3 className={styles.jobLinkEventTitle}>{result.event.title}</h3>
                        <span className={styles.jobLinkEventTime}>
                          {formatDayLabel(parseEventDate(result.event.start_date))} · {formatEventTime(result.event.start_date)} - {formatEventTime(result.event.end_date)}
                        </span>
                      </div>
                      <div className={styles.jobLinkList}>
                        {result.links.map((link) => (
                          <a
                            key={`${result.event.id}-${link.url}`}
                            className={styles.jobLinkAnchor}
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            [{link.kind}] {link.url}
                          </a>
                        ))}
                      </div>
                    </section>
                  ))}
                </>
              ) : null}
            </div>

            <div className={styles.availabilityFooter}>
              {jobLinksCopyState === 'copied' ? <span className={styles.availabilityCopyStatus}>Copied</span> : null}
              {jobLinksCopyState === 'failed' ? <span className={styles.availabilityCopyStatus}>Copy failed</span> : null}
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={copyJobLinks}
                disabled={!jobLinksTextOutput}
              >
                Copy Links
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
