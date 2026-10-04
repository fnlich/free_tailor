import { envTimeZone } from '@/lib/env';

/**
 * The calendar's time zones: the list the page offers, and which one it starts on.
 *
 * Shared by the page (`CalendarWorkspace`) and the route handlers behind it
 * (`service.ts`), because both need the same default: the page sends the zone
 * it shows, and the server falls back to the default when a request carries
 * none. Two copies of 'America/Los_Angeles' were how those could drift apart.
 */

export type CalendarTimeZoneOption = { label: string; value: string };

/** What an installation that sets nothing gets - the zone this page always used. */
export const FALLBACK_CALENDAR_TIME_ZONE = 'America/Los_Angeles';

/** The zones the selectors always offer, with the short label each is shown by. */
export const BASE_CALENDAR_TIME_ZONES: readonly CalendarTimeZoneOption[] = [
  { label: 'PT', value: 'America/Los_Angeles' },
  { label: 'MT', value: 'America/Denver' },
  { label: 'CT', value: 'America/Chicago' },
  { label: 'ET', value: 'America/New_York' },
  { label: 'Vladivostok', value: 'Asia/Vladivostok' },
];

/**
 * The configured default zone, or the fallback when it is unset or unknown.
 *
 * Any zone the runtime's Intl knows is accepted, not only the five above: an
 * installation in Berlin should not have to edit source to start in Berlin
 * time. A value that is one of the five in other letter case takes that
 * entry's spelling, so `america/new_york` still selects "ET" in the list
 * rather than adding a second, lower-case copy of it.
 */
export function resolveCalendarTimeZone(value: string | undefined): string {
  const zone = envTimeZone(
    value,
    FALLBACK_CALENDAR_TIME_ZONE,
    'NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE'
  );
  const known = BASE_CALENDAR_TIME_ZONES.find(
    (option) => option.value.toLowerCase() === zone.toLowerCase()
  );
  return known ? known.value : zone;
}

/**
 * The selector's options, with `defaultZone` added when it is not one of them.
 *
 * Added, because a `<select>` whose value matches none of its options shows the
 * first option while the state holds another - the page would say "PT" and
 * fetch Berlin. Labelled by its city, like Vladivostok, since there is no
 * short abbreviation that is right for every zone.
 */
export function calendarTimeZoneOptions(defaultZone: string): CalendarTimeZoneOption[] {
  if (BASE_CALENDAR_TIME_ZONES.some((option) => option.value === defaultZone)) {
    return [...BASE_CALENDAR_TIME_ZONES];
  }
  const city = defaultZone.split('/').pop() || defaultZone;
  return [...BASE_CALENDAR_TIME_ZONES, { label: city.replace(/_/g, ' '), value: defaultZone }];
}

/**
 * NEXT_PUBLIC_, so it is compiled into the bundle by `next build` - changing it
 * needs a rebuild, like NEXT_PUBLIC_CALENDAR_SHARE_URL beside it. The literal
 * `process.env.NEXT_PUBLIC_...` expression is what Next inlines; it must stay
 * spelled out here rather than looked up by name.
 */
export const CALENDAR_DEFAULT_TIME_ZONE = resolveCalendarTimeZone(
  process.env.NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE
);

export const CALENDAR_TIME_ZONE_OPTIONS = calendarTimeZoneOptions(CALENDAR_DEFAULT_TIME_ZONE);

/** The short label for a zone in the list, or the zone itself. */
export function calendarTimeZoneLabel(
  zone: string,
  options: readonly CalendarTimeZoneOption[] = CALENDAR_TIME_ZONE_OPTIONS
): string {
  return options.find((option) => option.value === zone)?.label ?? zone;
}
