import type { ContactChannelType, ContactFieldError } from './contact';

/**
 * The decisions behind "Contact admin" with no request in them: what each
 * channel type is called and asks for, how the editor's rows move and where a
 * refusal of a save is shown, and which sentences get a Contact admin link.
 *
 * Imports nothing at runtime, so backend/test/frontendRefunds.test.js can load
 * it - and does, to check the type list against the server's and the link rule
 * against the server's own "contact your administrator" sentences.
 */

/** The server's closed list, in its order (services/contact.ts `CONTACT_CHANNEL_TYPES`). */
export const CONTACT_TYPES: readonly ContactChannelType[] = ['email', 'telegram', 'discord', 'whatsapp', 'other'];

/** What the type select says. */
export const CONTACT_TYPE_LABELS: Record<ContactChannelType, string> = {
  email: 'Email',
  telegram: 'Telegram',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  other: 'Other',
};

/**
 * The label the server gives a channel saved without one - shown as the label
 * box's placeholder, so leaving it empty is a visible choice rather than a
 * surprise after saving.
 */
export const DEFAULT_CONTACT_LABELS: Record<ContactChannelType, string> = {
  email: 'Email',
  telegram: 'Telegram',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  other: 'Contact',
};

/** What each type's value box asks for, and what people will get from it. */
export const CONTACT_VALUE_HINTS: Record<ContactChannelType, { placeholder: string; hint: string }> = {
  email: {
    placeholder: 'support@example.com',
    hint: 'An email address. People get a link that opens their mail app.',
  },
  telegram: {
    placeholder: '@username',
    hint: 'A Telegram username: @name, or a t.me/name link. People get a t.me link.',
  },
  discord: {
    placeholder: 'username',
    hint: 'A Discord username or numeric user id. Shown with a Copy button: Discord has no link that opens a person.',
  },
  whatsapp: {
    placeholder: '+1 555 123 4567',
    hint: 'A number with its country code. People get a wa.me link.',
  },
  other: {
    placeholder: 'https://example.com/help',
    hint: 'A web address (http or https) becomes a link. Anything else - a phone line, office hours - is shown as text.',
  },
};

/** One row of the editor. `key` is the page's own, so an error stays on its row when rows move. */
export type ChannelDraft = {
  key: string;
  type: ContactChannelType;
  label: string;
  value: string;
};

/** Saved channels as editor rows, each with a fresh key. */
export function toChannelDrafts(
  channels: ReadonlyArray<{ type: ContactChannelType; label: string; value: string }>,
  nextKey: () => string
): ChannelDraft[] {
  return channels.map((channel) => ({
    key: nextKey(),
    type: channel.type,
    label: channel.label,
    value: channel.value,
  }));
}

/** True when the rows say the same as what was saved, in the same order. */
export function sameChannels(
  drafts: ReadonlyArray<{ type: ContactChannelType; label: string; value: string }>,
  saved: ReadonlyArray<{ type: ContactChannelType; label: string; value: string }>
): boolean {
  return (
    drafts.length === saved.length &&
    drafts.every(
      (draft, index) =>
        draft.type === saved[index].type && draft.label === saved[index].label && draft.value === saved[index].value
    )
  );
}

/** The list with one row moved a place up (-1) or down (1). At either end it is unchanged. */
export function moveDraft<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  const next = [...list];
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

const FIELDS = new Set(['type', 'label', 'value', 'channels']);

/**
 * The per-field refusals out of a 400 `contact-invalid` body, each checked to
 * be the shape the server sends - an older server, or anything else that
 * answered, yields none, and the page falls back to the sentence alone.
 */
export function readContactFieldErrors(body: unknown): ContactFieldError[] {
  const list = (body && typeof body === 'object' ? (body as { fieldErrors?: unknown }).fieldErrors : null) ?? null;
  if (!Array.isArray(list)) return [];
  const errors: ContactFieldError[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { index, field, message } = entry as Record<string, unknown>;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < -1) continue;
    if (typeof field !== 'string' || !FIELDS.has(field)) continue;
    if (typeof message !== 'string' || !message.trim()) continue;
    errors.push({ index, field: field as ContactFieldError['field'], message: message.trim() });
  }
  return errors;
}

export type ChannelFieldErrors = Partial<Record<'type' | 'label' | 'value', string>>;

/**
 * The refusals pinned to the rows that were SENT - by key, so that moving or
 * removing a row afterwards does not leave its error under its neighbour - and
 * the ones about the list as a whole (too many channels) or naming a row that
 * is not there, which are shown above the list.
 */
export function pinContactErrors(
  sent: ReadonlyArray<{ key: string }>,
  errors: readonly ContactFieldError[]
): { byKey: Record<string, ChannelFieldErrors>; list: string[] } {
  const byKey: Record<string, ChannelFieldErrors> = {};
  const list: string[] = [];
  for (const error of errors) {
    const row = error.index >= 0 ? sent[error.index] : undefined;
    if (!row || error.field === 'channels') {
      list.push(error.message);
      continue;
    }
    const fields = (byKey[row.key] ??= {});
    const field = error.field;
    fields[field] = fields[field] ? `${fields[field]} ${error.message}` : error.message;
  }
  return { byKey, list };
}

/**
 * True for a sentence that tells its reader to reach an administrator - "Please
 * try again, or contact your administrator.", "Ask an administrator of this
 * installation to re-enable it." - which is where a Contact admin link belongs.
 *
 * A verb aimed at an administrator, not the word alone: "An administrator
 * needs to run `claude auth login`" is said TO an administrator, and "an
 * administrator can add credit to your account" describes one; neither asks the
 * reader to get in touch.
 */
export function asksForAdministrator(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return /\b(?:contact|ask|tell|reach)\s+(?:your|an|the|any|this installation's)\s+administrators?\b/i.test(text);
}
