import type { CalendarEvent } from '@/lib/calendar/types';

export type CalendarLinkKind = 'meeting' | 'other';

export type CalendarExtractedLink = {
  kind: CalendarLinkKind;
  url: string;
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gi;
const ENCODED_URL_PATTERN = /https?%3A%2F%2F[^\s<>"']+/gi;
const HTML_LINK_PATTERN = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const MEETING_HOST_PATTERNS = [
  /(^|\.)meet\.google\.com$/i,
  /(^|\.)zoom\.us$/i,
  /(^|\.)teams\.microsoft\.com$/i,
  /(^|\.)teams\.live\.com$/i,
  /(^|\.)lync\.com$/i,
  /(^|\.)webex\.com$/i,
  /(^|\.)gotomeeting\.com$/i,
  /(^|\.)goto\.com$/i,
  /(^|\.)ringcentral\.com$/i,
  /(^|\.)bluejeans\.com$/i,
  /(^|\.)chime\.aws$/i,
];
const URL_QUERY_KEYS = ['url', 'u', 'q', 'target', 'dest', 'destination', 'redirect', 'redirect_url', 'redirectUri'];

function cleanExtractedUrl(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/gi, '/')
    .replace(/[.,;!?]+$/g, '');
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unwrapTrackedUrl(value: string): string {
  let current = cleanExtractedUrl(value);
  let changed = true;

  while (changed) {
    changed = false;

    try {
      const parsed = new URL(current);

      for (const key of URL_QUERY_KEYS) {
        const next = parsed.searchParams.get(key);

        if (!next) {
          continue;
        }

        const decoded = cleanExtractedUrl(safeDecodeURIComponent(next));
        if (/^https?:\/\//i.test(decoded) && decoded !== current) {
          current = decoded;
          changed = true;
          break;
        }
      }
    } catch {
      return current;
    }
  }

  return current;
}

function collectUrlsFromString(value: string, urls: Set<string>) {
  const normalized = cleanExtractedUrl(value);

  for (const match of normalized.match(URL_PATTERN) ?? []) {
    urls.add(unwrapTrackedUrl(match));
  }

  for (const match of normalized.match(ENCODED_URL_PATTERN) ?? []) {
    const decoded = safeDecodeURIComponent(match);
    if (/^https?:\/\//i.test(decoded)) {
      urls.add(unwrapTrackedUrl(decoded));
    }
  }

  for (const match of normalized.matchAll(HTML_LINK_PATTERN)) {
    const candidate = cleanExtractedUrl(safeDecodeURIComponent(match[1]));
    if (/^https?:\/\//i.test(candidate)) {
      urls.add(unwrapTrackedUrl(candidate));
    }
  }
}

function collectUrlsFromUnknown(value: unknown, urls: Set<string>, seen: WeakSet<object>) {
  if (typeof value === 'string') {
    collectUrlsFromString(value, urls);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlsFromUnknown(item, urls, seen);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  for (const entry of Object.values(value)) {
    collectUrlsFromUnknown(entry, urls, seen);
  }
}

export function isMeetingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return MEETING_HOST_PATTERNS.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}

export function extractUrlsFromEvent(event: CalendarEvent): string[] {
  const urls = new Set<string>();
  collectUrlsFromUnknown(event, urls, new WeakSet<object>());
  return Array.from(urls).filter(Boolean);
}

export function extractLinksFromEvent(event: CalendarEvent): CalendarExtractedLink[] {
  return extractUrlsFromEvent(event).map((url) => ({
    url,
    kind: isMeetingUrl(url) ? 'meeting' : 'other',
  }));
}
