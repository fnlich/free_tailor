/*
 * One sentence carried from one Profiles page to the next: deleting a profile
 * on its own page leaves for the dashboard, which then says "Deleted Jane Doe
 * and its resumes." The tab's sessionStorage holds it for the one navigation.
 * Every access is guarded: storage can be blocked or full, and a notice is a
 * convenience that never matters enough to fail a page.
 */

const FLASH_KEY = 'freeTailor.profiles.flash';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Leaves `text` for the next Profiles page to show. */
export function setFlashNotice(text: string): void {
  try {
    storage()?.setItem(FLASH_KEY, text);
  } catch {
    // Not remembered, and not missed.
  }
}

/** The waiting sentence, or '' - without taking it, so a double-invoked initialiser reads it twice. */
export function peekFlashNotice(): string {
  try {
    return storage()?.getItem(FLASH_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Takes it away once the page has shown it. */
export function clearFlashNotice(): void {
  try {
    storage()?.removeItem(FLASH_KEY);
  } catch {
    // Left for the next page, which is harmless.
  }
}
