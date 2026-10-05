import { getSetting, setSetting } from '../database/settingsRepository';

/**
 * How to reach whoever runs this installation (owner decision A2): a short list
 * of channels an administrator writes under Admin -> Settings -> General, shown
 * to EVERYBODY - the sign-in page, the account-disabled page and every
 * "contact your administrator" sentence included, which is why it is served
 * without a session (GET /api/contact).
 *
 * Shown to people who are not signed in means written for a page that renders
 * links from it, so nothing typed here reaches a page as a link unchecked:
 *
 * - the TYPES are closed, and each has its own rule for its value;
 * - every link (`href`) is BUILT HERE, from a value that passed its type's
 *   rule - `mailto:` an address, `https://t.me/<username>`,
 *   `https://wa.me/<digits>` - and an `other` value becomes a link only when
 *   it is an `http(s)` address with a host and no credentials in it.
 *   `javascript:`, `data:` and every other link scheme are refused, not
 *   escaped; a label with a colon in it ("Hours:9-5") is plain text. A
 *   Discord name is never a link: there is no address that opens a person on
 *   Discord, so the page shows the name to copy;
 * - the page never builds a link itself - it renders `href` or plain text;
 * - and what is STORED is checked again on every read, so a row edited by
 *   hand in the database cannot put a script link in front of anybody.
 *
 * Stored in its own app_settings row (`contact`), not in the app settings
 * document: it is the one setting read by people who are not signed in, and
 * keeping it apart keeps that read from touching anything else.
 */

export const CONTACT_SETTING_KEY = 'contact';

export const CONTACT_CHANNEL_TYPES = ['email', 'telegram', 'discord', 'whatsapp', 'other'] as const;
export type ContactChannelType = (typeof CONTACT_CHANNEL_TYPES)[number];

/** How many channels may be listed. A dialog, not a directory. */
export const MAX_CONTACT_CHANNELS = 10;
export const MAX_CONTACT_LABEL = 60;
export const MAX_CONTACT_VALUE = 200;
/** RFC 5321's longest address. */
const MAX_EMAIL = 254;

/** A channel as stored and as the administrators' editor reads it. */
export type ContactChannel = { type: ContactChannelType; label: string; value: string };

/** A channel as anybody reads it: `href` is the server's, or null for text to show (and copy). */
export type PublicContactChannel = ContactChannel & { href: string | null };

export type ContactSettings = { channels: ContactChannel[] };

/** One refusal, pinned to the field that caused it so the editor can show it there. */
export type ContactFieldError = { index: number; field: 'type' | 'label' | 'value' | 'channels'; message: string };

const DEFAULT_LABELS: Record<ContactChannelType, string> = {
  email: 'Email',
  telegram: 'Telegram',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  other: 'Contact',
};

export function isContactChannelType(value: unknown): value is ContactChannelType {
  return typeof value === 'string' && (CONTACT_CHANNEL_TYPES as readonly string[]).includes(value);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * An address a `mailto:` can carry as it is: a plain local part (letters,
 * digits, `.`, `_`, `+`, `-`) and a dotted domain ending in letters. Narrower
 * than RFC 5322 on purpose - a `?`, `&`, `#` or `%` in the local part is
 * legal there and would start a mailto query here, and nobody's support
 * address needs one.
 */
const EMAIL = /^[A-Za-z0-9._+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** A Telegram username: 5-32 of letters, digits and underscores, starting with a letter. */
const TELEGRAM = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/**
 * A Discord name: today's usernames (2-32 of lowercase letters, digits, `_`
 * and `.`, never two dots together), a legacy `name#1234`, or a numeric user
 * id.
 */
const DISCORD_USERNAME = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;
const DISCORD_LEGACY = /^[A-Za-z0-9_.]{2,32}#\d{4}$/;
const DISCORD_ID = /^\d{17,20}$/;

/** A scheme followed by `//` - `ftp://`, `ssh://` - which only a link has. */
const SCHEME_WITH_SLASHES = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/**
 * Schemes a link starts with but a line of text does not: what a browser or an
 * app would open. `Phone:+1-555-0100` and `Hours:9-5` are not among them, so
 * they stay text - a word and a colon is how people write labels.
 */
const LINK_SCHEME = /^(?:https?|mailto|tel|sms|callto|facetime|ftps?|sftp|ssh|irc|ircs|news|nntp|ws|wss|sip|sips|xmpp|magnet|intent|market|itms|itms-apps):/i;
/** Schemes refused anywhere in an `other` value's start, spaces or not. */
const DANGEROUS_SCHEME = /^\s*(?:javascript|data|vbscript|file|blob)\s*:/i;

type ValueCheck = { ok: true; value: string; href: string | null } | { ok: false; message: string };

/** `@name`, `t.me/name` or `https://t.me/name` -> `name`. */
function telegramName(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^(?:www\.)?(?:t|telegram)\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '');
}

/** `+1 (555) 123-4567` or `https://wa.me/15551234567` -> `15551234567`, or '' when it is not a number. */
function whatsappDigits(raw: string): string {
  const stripped = raw.replace(/^https?:\/\//i, '').replace(/^(?:www\.)?wa\.me\//i, '').replace(/\/+$/, '');
  if (!/^\+?[\d\s().-]+$/.test(stripped)) return '';
  return stripped.replace(/\D/g, '');
}

/**
 * An `other` value: text to show, or - when it reads as an address - an
 * `http(s)` link with a host and no user name or password in it.
 */
function checkOther(raw: string): ValueCheck {
  if (DANGEROUS_SCHEME.test(raw)) {
    return { ok: false, message: 'A link must start with http:// or https://.' };
  }
  // A web address is meant as a link even when it was typed wrong; so is
  // anything starting with a link's scheme. Everything else is text, shown as
  // it is and never a link: "Phone: +1 555 0100", and "Hours:9-5" or
  // "Skype:live:tailor" too - a word and a colon is a label, not an address,
  // and treating it as one refused ordinary text with a sentence about links.
  const webLike = /^https?:\/\//i.test(raw) || raw.startsWith('//') || /^www\./i.test(raw);
  const looksLikeLink =
    webLike || (!/\s/.test(raw) && (LINK_SCHEME.test(raw) || SCHEME_WITH_SLASHES.test(raw)));
  if (!looksLikeLink) return { ok: true, value: raw, href: null };
  if (/\s/.test(raw)) return { ok: false, message: 'That link is not a web address.' };

  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw.startsWith('//') ? `https:${raw}` : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, message: 'That link is not a web address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, message: 'A link must start with http:// or https://.' };
  }
  if (!url.hostname) return { ok: false, message: 'That link has no web site in it.' };
  if (url.username || url.password) {
    return { ok: false, message: 'A link cannot carry a user name or password.' };
  }
  return { ok: true, value: raw, href: url.href };
}

/**
 * One channel's value under its type's rule: the value as it will be shown,
 * and the link built from it.
 */
export function checkContactValue(type: ContactChannelType, rawValue: string): ValueCheck {
  const raw = rawValue.trim();
  if (!raw) return { ok: false, message: 'Enter how to reach you here.' };
  if (CONTROL.test(raw)) return { ok: false, message: 'Remove the line breaks and control characters.' };
  if (raw.length > (type === 'email' ? MAX_EMAIL : MAX_CONTACT_VALUE)) {
    return { ok: false, message: `Keep it under ${type === 'email' ? MAX_EMAIL : MAX_CONTACT_VALUE} characters.` };
  }

  switch (type) {
    case 'email': {
      const address = raw.replace(/^mailto:/i, '');
      if (!EMAIL.test(address)) return { ok: false, message: 'That does not look like an email address.' };
      return { ok: true, value: address, href: `mailto:${address}` };
    }
    case 'telegram': {
      const name = telegramName(raw);
      if (!TELEGRAM.test(name)) {
        return {
          ok: false,
          message: 'A Telegram username is 5 to 32 letters, digits or underscores, starting with a letter.',
        };
      }
      return { ok: true, value: `@${name}`, href: `https://t.me/${name}` };
    }
    case 'discord': {
      const name = raw.replace(/^@/, '');
      const lower = name.toLowerCase();
      if (DISCORD_ID.test(name) || DISCORD_LEGACY.test(name)) return { ok: true, value: name, href: null };
      if (DISCORD_USERNAME.test(lower)) return { ok: true, value: lower, href: null };
      return {
        ok: false,
        message: 'A Discord username is 2 to 32 lowercase letters, digits, "_" or "." (or a numeric user id).',
      };
    }
    case 'whatsapp': {
      const digits = whatsappDigits(raw);
      if (digits.length < 7 || digits.length > 15) {
        return { ok: false, message: 'Enter a WhatsApp number with its country code, like +1 555 123 4567.' };
      }
      return { ok: true, value: `+${digits}`, href: `https://wa.me/${digits}` };
    }
    case 'other':
      return checkOther(raw);
  }
}

function checkLabel(type: ContactChannelType, raw: unknown): { ok: true; label: string } | { ok: false; message: string } {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { ok: false, message: 'The label must be text.' };
  }
  const label = (raw ?? '').trim();
  if (!label) return { ok: true, label: DEFAULT_LABELS[type] };
  if (CONTROL.test(label)) return { ok: false, message: 'Remove the line breaks and control characters.' };
  if (label.length > MAX_CONTACT_LABEL) return { ok: false, message: `Keep the label under ${MAX_CONTACT_LABEL} characters.` };
  return { ok: true, label };
}

export type ContactValidation =
  | { ok: true; settings: ContactSettings; channels: PublicContactChannel[] }
  | { ok: false; errors: ContactFieldError[] };

/**
 * What an administrator sent, checked whole: every refusal at once, each
 * pinned to its channel and field, so the editor can mark them all rather
 * than one per save.
 */
export function validateContactSettings(input: unknown): ContactValidation {
  const raw = (input ?? {}) as { channels?: unknown };
  if (!Array.isArray(raw.channels)) {
    return { ok: false, errors: [{ index: -1, field: 'channels', message: 'Send the channels as a list.' }] };
  }
  if (raw.channels.length > MAX_CONTACT_CHANNELS) {
    return {
      ok: false,
      errors: [{ index: -1, field: 'channels', message: `List at most ${MAX_CONTACT_CHANNELS} ways to reach you.` }],
    };
  }

  const errors: ContactFieldError[] = [];
  const channels: PublicContactChannel[] = [];
  raw.channels.forEach((entry, index) => {
    const candidate = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (!isContactChannelType(candidate.type)) {
      errors.push({
        index,
        field: 'type',
        message: `Choose one of: ${CONTACT_CHANNEL_TYPES.join(', ')}.`,
      });
      return;
    }
    const type = candidate.type;
    const label = checkLabel(type, candidate.label);
    if (!label.ok) errors.push({ index, field: 'label', message: label.message });
    const value =
      typeof candidate.value === 'string'
        ? checkContactValue(type, candidate.value)
        : ({ ok: false, message: 'Enter how to reach you here.' } as const);
    if (!value.ok) errors.push({ index, field: 'value', message: value.message });
    if (label.ok && value.ok) channels.push({ type, label: label.label, value: value.value, href: value.href });
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: { channels: channels.map(({ type, label, value }) => ({ type, label, value })) },
    channels,
  };
}

/**
 * The stored channels as anybody may read them - each re-checked, and one
 * that no longer passes (a row edited by hand, a rule tightened since) left
 * out rather than shown, with a line in the log for the operator.
 */
export function readContactChannels(): PublicContactChannel[] {
  let stored: unknown;
  try {
    stored = getSetting<unknown>(CONTACT_SETTING_KEY);
  } catch (error) {
    console.error('[contact] The stored contact details are not valid JSON; showing none.', error);
    return [];
  }
  const list = (stored as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(list)) return [];

  const channels: PublicContactChannel[] = [];
  for (const entry of list.slice(0, MAX_CONTACT_CHANNELS)) {
    const checked = validateContactSettings({ channels: [entry] });
    if (checked.ok) channels.push(checked.channels[0]);
    else console.warn('[contact] A stored contact channel no longer passes its check and is not shown.');
  }
  return channels;
}

/** Saves what `validateContactSettings` accepted, and answers with what everybody will now read. */
export function saveContactSettings(input: unknown): ContactValidation {
  const checked = validateContactSettings(input);
  if (!checked.ok) return checked;
  setSetting(CONTACT_SETTING_KEY, checked.settings);
  return checked;
}
