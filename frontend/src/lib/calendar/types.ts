export type CalendarSubCalendar = {
  id: number;
  color: string;
  colorText: string;
  name: string;
  write: boolean;
  add: boolean;
  details: boolean;
  title: boolean;
  ics: string;
  activePlanner: boolean;
  eventTitlePlaceholder: string;
};

export type CalendarMetadata = {
  id: number;
  capabilityId: string;
  language: string;
  title: string;
  timeZone: string;
  timeFormat: string;
  twentyFourHours: boolean;
  firstHour: number;
  lastHour: number;
  timeStep: number;
  defaultView: number;
  firstWeekday: number;
  jumpToDate: string | null;
  branding: boolean;
  showIcalFeed: boolean;
  showNotifications: boolean;
  showReminder: boolean;
  showEventDeletionWarning: boolean;
  showSms: boolean;
  showTimeMarker: boolean;
  hideWeekends: boolean;
  logoFilename: string | null;
  accountStatus: number;
  unpaid: boolean;
  plannerSubCalendarCount: number;
  backupServer: boolean;
  darkMode: boolean;
  ics: string;
  subCalendars: CalendarSubCalendar[];
};

export type CalendarEvent = {
  id: string;
  start_date: string;
  end_date: string;
  title: string;
  text: string;
  who: string;
  where: string;
  subCalendars: number[];
  wholeDay: boolean;
  repeatSeriesId: string | null;
  repeatInterval: number;
  imported: boolean;
  hasReminder: boolean;
  hasRegistration: boolean;
} & Record<string, unknown>;

export type CalendarApiResponse<T> = {
  source: 'live';
  data: T;
};
