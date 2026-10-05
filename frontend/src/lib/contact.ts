import { apiFetch } from './api';

/**
 * How to reach whoever runs this installation (owner decision A2): a short
 * list of channels an administrator writes under Settings -> General, shown to
 * EVERYBODY - the sign-in screen, the account-disabled screen, the account
 * menu, and every sentence that says "contact your administrator".
 *
 * `GET /api/contact` needs no session for that reason, and answers the
 * channels and nothing else. Every `href` in it is the server's: a page
 * renders that (through lib/appLinks.ts's `safeContactHref`) or the plain
 * `value`, and never makes a link of its own out of a value.
 */

export type ContactChannelType = 'email' | 'telegram' | 'discord' | 'whatsapp' | 'other';

/** A channel as anybody reads it. `href` is null for text to show and copy - a Discord name, a phone line. */
export type ContactChannel = {
  type: ContactChannelType;
  label: string;
  value: string;
  href: string | null;
};

/** A channel as an administrator sends it. The server normalises it (`@name`, `+digits`) and builds the link. */
export type ContactChannelInput = {
  type: ContactChannelType;
  label: string;
  value: string;
};

/**
 * One refusal of a save, pinned to the channel (`index`, -1 for the list as a
 * whole) and the field that caused it, so the editor can show it there.
 */
export type ContactFieldError = {
  index: number;
  field: 'type' | 'label' | 'value' | 'channels';
  message: string;
};

/** What the editor draws itself from: the channels, and the rules it is held to. */
export type ContactEditorPayload = {
  channels: ContactChannel[];
  types: ContactChannelType[];
  limits: { channels: number; label: number; value: number };
};

export const contactApi = {
  /** Public: works signed out. */
  get: () => apiFetch<{ channels: ContactChannel[] }>('/contact'),
};

export const adminContactApi = {
  get: () => apiFetch<ContactEditorPayload>('/admin/contact'),
  /**
   * Replaces the whole list. Refused as a whole when any channel fails: 400
   * `contact-invalid` with every failure in `fieldErrors` (read them with
   * lib/contactChannels.ts's `readContactFieldErrors`).
   */
  save: (channels: ContactChannelInput[]) =>
    apiFetch<ContactEditorPayload>('/admin/contact', {
      method: 'PUT',
      body: JSON.stringify({ channels }),
    }),
};
